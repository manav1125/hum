/**
 * Config-as-code recorder (WS5) — public entry point.
 *
 * `recordConfigChange()` is the single hook the mutating call sites fire
 * (skill install/uninstall, schedule create/update/delete, saveRawConfig).
 * It is:
 *
 *  - Flag-gated: `configRepo.enabled` (default OFF) — disabled means an
 *    immediate return, no repo, no I/O.
 *  - Fire-and-forget: work is appended to a serialized promise chain; the
 *    caller never awaits and never observes a failure. A broken exporter
 *    must NEVER block or fail the mutating operation (observe-only v1).
 *  - Review-lane aware: commits caused by an autonomous actor
 *    (`actor: "assistant"`) emit an `awaiting_review` work item whose notes
 *    carry the diff bullets. Approve rides the existing complete route;
 *    Redo rides the existing run route, which maps to `revertConfigCommit()`
 *    for `config_repo`-sourced items.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getConfigReadOnly } from "../config/loader.js";
import type { ConfigRepoConfig } from "../config/schemas/config-repo.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { buildConfigExportTree, writeConfigExportTree } from "./export.js";
import {
  commitAll,
  commitChangeSummary,
  ensureRepo,
  revertCommit,
} from "./git.js";

const log = getLogger("config-repo");

export type ConfigChangeActor = "user" | "assistant" | "system";

export interface ConfigChangeEvent {
  /** What changed, for the commit message ("skill installed: foo"). */
  cause: string;
  /** Who caused it. "assistant" (autonomous) changes emit a Review item. */
  actor: ConfigChangeActor;
}

export function getConfigRepoDir(): string {
  return join(getWorkspaceDir(), "config-repo");
}

function getSettings(): ConfigRepoConfig | null {
  try {
    const settings = getConfigReadOnly().configRepo;
    return settings ?? null;
  } catch {
    return null;
  }
}

export function isConfigRepoEnabled(): boolean {
  return getSettings()?.enabled === true;
}

// Serialized job chain: exports never run concurrently (git worktree races),
// and a failure in one job never poisons the next.
let chain: Promise<void> = Promise.resolve();

/**
 * Record a config mutation: export the durable config surface and commit it.
 * Fire-and-forget by contract — returns immediately, swallows all failures.
 */
export function recordConfigChange(event: ConfigChangeEvent): void {
  if (!isConfigRepoEnabled()) return;
  chain = chain
    .then(() => runExport(event))
    .catch((err) => {
      log.warn(
        { err: String(err), cause: event.cause },
        "config-repo export failed (mutation unaffected)",
      );
    });
}

/**
 * Await all queued export jobs. Test/diagnostic helper — production call
 * sites must never await the recorder.
 */
export function flushConfigRepo(): Promise<void> {
  return chain.then(
    () => undefined,
    () => undefined,
  );
}

async function runExport(event: ConfigChangeEvent): Promise<void> {
  const settings = getSettings();
  if (settings?.enabled !== true) return;

  const repoDir = getConfigRepoDir();
  if (!ensureRepo(repoDir)) {
    log.warn({ repoDir }, "config-repo: could not initialize git repo");
    return;
  }

  const tree = await buildConfigExportTree({
    maxMemoryFiles: settings.maxMemoryFiles,
    maxFileBytes: settings.maxFileBytes,
  });
  writeConfigExportTree(repoDir, tree);

  const message = `config: ${event.cause} (${event.actor})`;
  const { hash, error } = commitAll(repoDir, message);
  if (error) {
    log.warn({ error, cause: event.cause }, "config-repo commit failed");
    return;
  }
  if (!hash) {
    // Deterministic serialize: identical state ⇒ no commit.
    return;
  }

  log.info({ hash, cause: event.cause, actor: event.actor }, "config commit");

  if (event.actor === "assistant" && settings.reviewItems) {
    try {
      await emitReviewWorkItem(event, repoDir, hash);
    } catch (err) {
      log.warn(
        { err: String(err), hash },
        "config-repo: failed to emit review work item",
      );
    }
  }
}

/**
 * Surface an autonomous config change in the Review lane. Reuses the
 * existing work-item pipeline with NO schema changes: sourceType
 * "config_repo", sourceId = the commit hash, diff bullets in notes.
 */
async function emitReviewWorkItem(
  event: ConfigChangeEvent,
  repoDir: string,
  hash: string,
): Promise<void> {
  // Dynamic imports keep the DB/work-items layer out of this module's static
  // graph — the recorder is reached via dynamic import from low-level stores
  // (loader, schedule-store) and must not create import cycles.
  const [{ createTask }, { createWorkItem, updateWorkItem }] =
    await Promise.all([
      import("../tasks/task-store.js"),
      import("../work-items/work-item-store.js"),
    ]);

  const bullets = commitChangeSummary(repoDir, hash)
    .slice(0, 8)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return `- ${status} ${rest.join("\t") || status}`;
    });
  const shortHash = hash.slice(0, 10);
  const title = `Config change: ${event.cause}`;
  const notes = [
    `Cue autonomously changed its configuration (${event.cause}).`,
    "",
    ...bullets,
    "",
    `Committed as ${shortHash} in the local config repo. Approve to accept, Redo to revert this change.`,
  ].join("\n");

  const task = createTask({
    title,
    template: `Review the autonomous config change committed as ${shortHash} (${event.cause}).`,
  });
  const item = createWorkItem({
    taskId: task.id,
    title,
    notes,
    sourceType: "config_repo",
    sourceId: hash,
    actor: "system",
  });
  updateWorkItem(item.id, { status: "awaiting_review" }, { actor: "system" });

  // Nudge connected clients to refetch the Review lane. Best-effort.
  try {
    const [{ assistantEventHub }, { buildAssistantEvent }] = await Promise.all([
      import("../runtime/assistant-event-hub.js"),
      import("../runtime/assistant-event.js"),
    ]);
    void assistantEventHub.publish(
      buildAssistantEvent({ type: "tasks_changed" }),
    );
  } catch {
    // Event hub unavailable (tests, early startup) — polling still catches up.
  }
}

/**
 * Revert a config commit (Review-lane "Redo" for `config_repo` items).
 * Creates a revert commit in the local repo. Deliberately NOT flag-gated:
 * reverting an existing commit must keep working even if the flag was
 * turned off after the item was created.
 */
export function revertConfigCommit(commitHash: string): {
  success: boolean;
  revertHash?: string;
  error?: string;
} {
  const repoDir = getConfigRepoDir();
  if (!existsSync(join(repoDir, ".git"))) {
    return { success: false, error: "config repo not initialized" };
  }
  const result = revertCommit(repoDir, commitHash);
  if (result.success) {
    log.info(
      { commitHash, revertHash: result.revertHash },
      "config commit reverted",
    );
  } else {
    log.warn({ commitHash, error: result.error }, "config revert failed");
  }
  return result;
}
