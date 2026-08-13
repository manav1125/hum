import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/**
 * Result type shared by both sandbox and host path policies.
 */
export type PathFailureReason = "not_absolute" | "out_of_bounds" | "denied";

/**
 * Basenames that must never be read or written by the assistant, regardless
 * of where they resolve. Defense-in-depth: even if a key file is accidentally
 * placed inside the workspace boundary, the assistant cannot access it.
 */
const DENIED_BASENAMES = new Set([
  ".backup.key",
  "backup.key",
  "actor-token-signing-key",
]);

/**
 * Environment variables naming directories whose entire contents are trust
 * material: the gateway's security directory (actor-token signing key, backup
 * key, the gateway SQLite database holding trust rules and tokens) and the
 * credential-execution store (credential keys).
 *
 * These are denied as whole directories rather than by filename. `hostPolicy`
 * applies no boundary at all, so before this existed `host_file_read` could
 * open `$GATEWAY_SECURITY_DIR/actor-token-signing-key` — the key that signs
 * actor tokens, i.e. the authentication system's root — behind nothing but a
 * risk-based approval prompt, and behind no prompt at all while a temporary
 * approval grant was active. The basename list could not cover it: the files
 * are named for their role, not with a recognisable secret suffix, and
 * `gateway.sqlite` looks like any other database.
 *
 * Read from the environment on each call rather than cached at module load,
 * so a daemon that resolves these late (and tests that set them per-case) are
 * both covered.
 */
const SECURITY_DIR_ENV_VARS = [
  "GATEWAY_SECURITY_DIR",
  "CREDENTIAL_SECURITY_DIR",
] as const;

/**
 * Whether a path falls inside one of the configured security directories.
 * Compares against both the literal and the symlink-resolved directory so a
 * link into the store is caught too. Unset variables contribute nothing.
 */
export function isSecurityDirPath(path: string): boolean {
  for (const envVar of SECURITY_DIR_ENV_VARS) {
    const dir = process.env[envVar];
    if (!dir || !isAbsolute(dir)) continue;
    const candidates = new Set([resolve(dir)]);
    try {
      candidates.add(realpathSync(dir));
    } catch {
      // Directory does not exist on this host — the literal form still applies.
    }
    for (const candidate of candidates) {
      if (path === candidate || path.startsWith(candidate + "/")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Anything under a per-process `/proc` directory — `/proc/<pid>/…` and the
 * `self` / `thread-self` aliases. The whole subtree is denied rather than a
 * list of sensitive leaves, because the leaf list is not something we can keep
 * complete: `environ` alone is reachable at `/proc/<pid>/environ`,
 * `/proc/self/environ` AND `/proc/<pid>/task/<tid>/environ` (every thread
 * directory republishes the process environment, and the main thread's tid
 * equals the pid, which `/proc/self/status` will happily tell you). Alongside
 * it sit `cmdline` (argv), `mem` (the address space), `fd/<n>` (any open
 * file, boundary or no boundary), `root` and `cwd` (symlinks that resolve
 * anywhere). Enumerating those is a game we would lose eventually.
 *
 * System-wide entries — `/proc/cpuinfo`, `/proc/meminfo`, `/proc/loadavg` —
 * are not per-process and stay readable.
 */
const PROC_PER_PROCESS_PATTERN = /^\/proc\/(?:\d+|self|thread-self)(?:\/|$)/;

/**
 * Whether a path reaches into a process's private `/proc` directory.
 *
 * The daemon's own environment carries credential material the file tools must
 * never hand back: the actor token signing key, the CES service token, the
 * guardian bootstrap secret, GATEWAY_SECURITY_DIR / CREDENTIAL_SECURITY_DIR,
 * and any provider API keys forwarded in at launch. The bash tool already
 * strips those from the child processes it spawns via the `SAFE_ENV_VARS`
 * allowlist (see `tools/terminal/safe-env.ts`), so denying them here keeps the
 * file tools from becoming the looser path to the same secrets.
 *
 * Checked on both the logical and the symlink-resolved path, so a symlink with
 * an innocuous name pointing into one of these directories is still caught.
 */
export function isProcessPrivatePath(path: string): boolean {
  return PROC_PER_PROCESS_PATTERN.test(path);
}

export type PathResult =
  | { ok: true; resolved: string }
  | { ok: false; reason: PathFailureReason; error: string };

// The Docker sandbox mounts the host workspace at /workspace inside the
// container. The model generates container-scoped paths (e.g.
// "/workspace/scratch/file.png") that need to be remapped to the host
// boundary directory before validation.
const CONTAINER_WORKSPACE_PREFIX = "/workspace/";
const CONTAINER_WORKSPACE_EXACT = "/workspace";

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path against a boundary directory and verify
 * that the result stays within it.
 *
 * For existing paths, symlinks are resolved via realpathSync so a symlink
 * pointing outside the boundary is caught. For new paths (e.g. file_write),
 * pass `mustExist: false` - the nearest existing ancestor directory is
 * resolved via realpathSync to catch symlinks in parent dirs.
 *
 * Paths starting with `/workspace/` are treated as container-scoped and
 * remapped relative to the boundary directory (the Docker sandbox mounts
 * the host workspace at /workspace).
 */
export function sandboxPolicy(
  rawPath: string,
  boundaryDir: string,
  options?: { mustExist?: boolean },
): PathResult {
  const mustExist = options?.mustExist ?? true;

  // Remap container-scoped /workspace paths to the host boundary dir.
  // Skip remapping if the path already starts with boundaryDir to avoid
  // double-nesting (e.g. /workspace/project/file.ts → /workspace/project/project/file.ts
  // when boundaryDir is /workspace/project).
  let effectivePath = rawPath;
  if (!rawPath.startsWith(boundaryDir + "/") && rawPath !== boundaryDir) {
    if (rawPath.startsWith(CONTAINER_WORKSPACE_PREFIX)) {
      effectivePath = rawPath.slice(CONTAINER_WORKSPACE_PREFIX.length);
    } else if (rawPath === CONTAINER_WORKSPACE_EXACT) {
      effectivePath = ".";
    }
  }

  const resolved = resolve(boundaryDir, effectivePath);

  // Resolve symlinks to catch symlink-based escapes.
  // For mustExist=false, walk up to the nearest existing ancestor and
  // resolve it, then re-append the trailing components.
  let realResolved = resolved;
  if (mustExist) {
    try {
      realResolved = realpathSync(resolved);
    } catch {
      // File doesn't exist - will be caught by the tool's own existence check
      realResolved = resolved;
    }
  } else {
    let current = resolved;
    const trailing: string[] = [];
    while (current !== dirname(current)) {
      try {
        const real = realpathSync(current);
        realResolved = trailing.length > 0 ? join(real, ...trailing) : real;
        break;
      } catch {
        trailing.unshift(basename(current));
        current = dirname(current);
      }
    }
  }

  // Resolve the boundary directory's real path too (in case it's a symlink)
  let realBoundary: string;
  try {
    realBoundary = realpathSync(boundaryDir);
  } catch {
    realBoundary = boundaryDir;
  }

  const rel = relative(realBoundary, realResolved);
  if (rel.startsWith("..") || resolve(realBoundary, rel) !== realResolved) {
    return {
      ok: false,
      reason: "out_of_bounds",
      error: `Path "${rawPath}" resolves to "${realResolved}" which is outside the working directory "${realBoundary}"`,
    };
  }

  // Check both the logical path and the symlink-resolved path so a symlink
  // with a non-denied name pointing at a denied file is still caught.
  if (
    DENIED_BASENAMES.has(basename(resolved)) ||
    DENIED_BASENAMES.has(basename(realResolved))
  ) {
    return {
      ok: false,
      reason: "denied",
      error: `Access to "${basename(resolved)}" is denied`,
    };
  }

  if (isProcessPrivatePath(resolved) || isProcessPrivatePath(realResolved)) {
    return {
      ok: false,
      reason: "denied",
      error: "Access to process-private /proc entries is denied",
    };
  }

  if (isSecurityDirPath(resolved) || isSecurityDirPath(realResolved)) {
    return {
      ok: false,
      reason: "denied",
      error: "Access to the security directory is denied",
    };
  }

  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

/**
 * Validate a path for host filesystem access.
 * Only requirement: the path must be absolute. No sandbox boundary check.
 */
export function hostPolicy(rawPath: string): PathResult {
  if (!isAbsolute(rawPath)) {
    return {
      ok: false,
      reason: "not_absolute",
      error: `path must be absolute for host file access: ${rawPath}`,
    };
  }
  if (DENIED_BASENAMES.has(basename(rawPath))) {
    return {
      ok: false,
      reason: "denied",
      error: `Access to "${basename(rawPath)}" is denied`,
    };
  }
  // The host policy applies no boundary at all, so this denial is the only
  // thing standing between `host_file_read` and the daemon's environment.
  // Resolve symlinks too: a link with an innocuous name must not be a way in.
  let realPath = rawPath;
  try {
    realPath = realpathSync(rawPath);
  } catch {
    realPath = rawPath;
  }
  if (isProcessPrivatePath(rawPath) || isProcessPrivatePath(realPath)) {
    return {
      ok: false,
      reason: "denied",
      error: "Access to process-private /proc entries is denied",
    };
  }
  if (isSecurityDirPath(resolve(rawPath)) || isSecurityDirPath(realPath)) {
    return {
      ok: false,
      reason: "denied",
      error: "Access to the security directory is denied",
    };
  }
  return { ok: true, resolved: rawPath };
}
