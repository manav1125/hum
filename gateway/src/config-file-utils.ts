import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getWorkspaceDir } from "./credential-reader.js";
import { getLogger } from "./logger.js";

const log = getLogger("config-file-utils");

export const CONFIG_FILENAME = "config.json";

/**
 * Serializes config writes so concurrent config mutations don't race on
 * read-modify-write. Each write awaits the previous one before proceeding.
 *
 * This chain is shared across all gateway config mutations to prevent
 * concurrent writes to the same config.json from overwriting each other's
 * changes.
 */
let configWriteChain: Promise<void> = Promise.resolve();

/**
 * Enqueue a write operation onto the shared config write chain.
 * The callback runs only after all previously enqueued writes have finished.
 */
export function enqueueConfigWrite(
  fn: () => void | Promise<void>,
): Promise<void> {
  const run = configWriteChain.then(fn);
  configWriteChain = run.catch(() => {});
  return run;
}

export type ConfigMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "malformed"; detail: string };

export function mutateConfigFile<T>(
  mutate: (data: Record<string, unknown>) => T,
  options?: {
    shouldWrite?: (value: T) => boolean;
    onWritten?: () => void;
  },
): Promise<ConfigMutationResult<T>> {
  let mutationResult: ConfigMutationResult<T> | undefined;

  return enqueueConfigWrite(() => {
    const result = readConfigFile();
    if (!result.ok) {
      mutationResult = result;
      return;
    }

    const value = mutate(result.data);
    const shouldWrite = options?.shouldWrite?.(value) ?? true;
    if (shouldWrite) {
      writeConfigFileAtomic(result.data);
      options?.onWritten?.();
    }
    mutationResult = { ok: true, value };
  }).then(() => {
    if (!mutationResult) {
      throw new Error("Config mutation did not produce a result");
    }
    return mutationResult;
  });
}

export function getConfigPath(): string {
  return join(getWorkspaceDir(), CONFIG_FILENAME);
}

export type ConfigReadResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "malformed"; detail: string };

export function readConfigFile(): ConfigReadResult {
  const cfgPath = getConfigPath();
  if (!existsSync(cfgPath)) {
    return { ok: true, data: {} };
  }
  try {
    const raw = readFileSync(cfgPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: "malformed",
        detail: "Config file is not a JSON object",
      };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, reason: "malformed", detail: String(err) };
  }
}

export function readConfigFileOrEmpty(options?: {
  onMalformed?: (detail: string) => void;
}): Record<string, unknown> {
  const result = readConfigFile();
  if (result.ok) return result.data;
  options?.onMalformed?.(result.detail);
  return {};
}

/**
 * The `node:fs` calls the ownership-preserving step makes, as an injectable
 * seam. Production never passes this — the default is `node:fs` itself.
 *
 * It exists because the behaviour worth testing (do we chown, to what, and do
 * we survive it failing) cannot be exercised for real by a non-root test
 * process: `chown(2)` to another uid is root-only, so a test that needed a
 * genuine cross-uid file could only ever be skipped.
 */
export interface OwnershipFsOps {
  statSync: (path: string) => { uid: number; gid: number; mode: number };
  chownSync: (path: string, uid: number, gid: number) => void;
  chmodSync: (path: string, mode: number) => void;
}

const nodeOwnershipFsOps: OwnershipFsOps = {
  statSync: (path) => statSync(path),
  chownSync,
  chmodSync,
};

/**
 * Carry the ownership (and mode) of the file we are about to replace onto its
 * replacement, before the rename makes the swap visible.
 *
 * Why this matters: `config.json` has two writers. The gateway replaces it
 * atomically (tmp file + rename) and the daemon writes it in place
 * (`assistant/src/config/loader.ts` `saveRawConfig`). Under
 * `CUE_DROP_DAEMON_PRIVILEGES=1` those are different uids — gateway root,
 * daemon 1001 — so a rename hands the daemon back a root-owned 0644 file and
 * every subsequent daemon-side config write fails EACCES. Several of those
 * call sites swallow the error, so the user-visible symptom is "settings
 * silently don't stick", not a crash. Preserving the owner keeps the file
 * belonging to whoever it belonged to before we touched it.
 *
 * The mode is preserved on the same principle and for the same price: the tmp
 * file is born at the writer's umask (0644 under root's usual 022), so without
 * this a rename would silently *widen* a config the owner had deliberately
 * narrowed. Copying the mode can only ever reproduce the state the other
 * writer was already living with.
 *
 * Both steps are skipped when the values already match, which is every
 * deployment where the two processes share a uid — i.e. every deployment
 * today. In that case this function issues no `chown`/`chmod` at all and the
 * write is byte-for-byte what it was before.
 *
 * Nothing here may fail the write. Losing the ownership is a latent
 * permissions problem; losing the write is a lost user setting right now.
 */
function preserveOwnershipAndMode(
  targetPath: string,
  tmpPath: string,
  ops: OwnershipFsOps,
): void {
  let target: { uid: number; gid: number; mode: number };
  let replacement: { uid: number; gid: number; mode: number };
  try {
    target = ops.statSync(targetPath);
    replacement = ops.statSync(tmpPath);
  } catch (err) {
    log.warn(
      { err, path: targetPath },
      "could not stat config.json before replacing it — the replacement " +
        "keeps this process's default ownership",
    );
    return;
  }

  if (target.uid !== replacement.uid || target.gid !== replacement.gid) {
    try {
      ops.chownSync(tmpPath, target.uid, target.gid);
    } catch (err) {
      // Non-fatal by design; see the note above. Warn rather than error: on a
      // same-uid deployment this branch is unreachable, so when it does fire
      // it is worth reading, but the write itself still succeeded.
      log.warn(
        { err, path: targetPath, uid: target.uid, gid: target.gid },
        "could not preserve config.json ownership across the atomic replace " +
          "— a differently-privileged writer (the daemon under " +
          "CUE_DROP_DAEMON_PRIVILEGES) may start failing with EACCES",
      );
    }
  }

  const targetMode = target.mode & 0o7777;
  if (targetMode !== (replacement.mode & 0o7777)) {
    try {
      ops.chmodSync(tmpPath, targetMode);
    } catch (err) {
      log.warn(
        { err, path: targetPath, mode: targetMode.toString(8) },
        "could not preserve config.json mode across the atomic replace",
      );
    }
  }
}

/**
 * Atomically write the config file: write to a temporary file in the same
 * directory, then rename. This avoids partial-file corruption if the process
 * crashes mid-write.
 *
 * The replacement inherits the ownership and mode of the file it replaces —
 * see {@link preserveOwnershipAndMode}. `ops` is a test seam only.
 */
export function writeConfigFileAtomic(
  data: Record<string, unknown>,
  ops: OwnershipFsOps = nodeOwnershipFsOps,
): void {
  const cfgPath = getConfigPath();
  const dir = dirname(cfgPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.config.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  // Only when there is an existing file to inherit from. The first-ever write
  // has no prior owner, and creating the file as this process is correct.
  if (existsSync(cfgPath)) {
    preserveOwnershipAndMode(cfgPath, tmpPath, ops);
  }
  renameSync(tmpPath, cfgPath);
}
