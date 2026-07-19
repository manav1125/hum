import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { runAsyncSqlite } from "../db-async-query.js";
import { getDb } from "../db-connection.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { rawAll, rawRun } from "../raw-query.js";

const log = getLogger("memory-jobs-worker");

const PRUNE_BATCH_LIMIT = 100;
const PRUNE_LOG_BATCH_LIMIT = 1000;

/**
 * Delete LLM request/response logs older than the configured retention period.
 * Processes in batches to avoid long DB locks and excessive WAL growth.
 * Re-enqueues itself if more rows remain.
 *
 * The DELETE is dispatched through `runAsyncSqlite` so it runs in a
 * sqlite3 subprocess (when available) and does not block the daemon's
 * main event loop. The two bind parameters (`cutoffMs`, batch limit)
 * are integers — they're inlined directly into the SQL after a
 * `Math.floor` + `Number.isFinite` guard so there is no string
 * interpolation surface.
 */
export async function pruneOldLlmRequestLogsJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const rawRetention = job.payload.retentionMs;
  const retentionMs =
    rawRetention === null
      ? null
      : typeof rawRetention === "number" &&
          Number.isFinite(rawRetention) &&
          rawRetention >= 0
        ? rawRetention
        : config.memory.cleanup.llmRequestLogRetentionMs;

  // null means "keep forever" — skip pruning entirely
  if (retentionMs === null || retentionMs === undefined) return;

  const cutoffMs = Math.floor(Date.now() - retentionMs);
  if (!Number.isFinite(cutoffMs)) return;

  // Inline the cutoff and batch limit (both integers, both validated)
  // and chain `SELECT changes()` so we can read the row count from the
  // subprocess's stdout. The sqlite3 CLI prints `changes()` as a bare
  // integer on its own line in default output mode; the in-process
  // fallback backend in `db-async-query.ts` synthesizes the same shape
  // by capturing `changes()` atomically after `exec()`. Both backends
  // end up on the parser path below.
  const result = await runAsyncSqlite(
    `DELETE FROM llm_request_logs WHERE rowid IN (SELECT rowid FROM llm_request_logs WHERE created_at < ${cutoffMs} LIMIT ${PRUNE_LOG_BATCH_LIMIT});
SELECT changes();`,
  );
  if (!result.ok) {
    log.warn(
      { error: result.error, backend: result.backend },
      "pruneOldLlmRequestLogsJob: DELETE failed",
    );
    return;
  }

  const deleted = parseDeletedCount(result.stdout);

  if (deleted >= PRUNE_LOG_BATCH_LIMIT) {
    enqueueMemoryJob("prune_old_llm_request_logs", { retentionMs });
  }

  log.info(
    {
      deleted,
      retentionMs,
      cutoffMs,
    },
    "Pruned old LLM request logs",
  );
}

/**
 * Delete trace events older than the configured retention period.
 * Processes in batches to avoid long DB locks and excessive WAL growth.
 * Re-enqueues itself if more rows remain.
 *
 * Same async dispatch + integer inlining shape as
 * {@link pruneOldLlmRequestLogsJob}.
 */
export async function pruneOldTraceEventsJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const rawRetention = job.payload.retentionDays;
  const retentionDays =
    typeof rawRetention === "number" &&
    Number.isFinite(rawRetention) &&
    rawRetention >= 0
      ? rawRetention
      : config.memory.cleanup.traceEventRetentionDays;

  // 0 means disabled
  if (retentionDays === 0) return;

  const cutoffMs = Math.floor(Date.now() - retentionDays * 86_400_000);
  if (!Number.isFinite(cutoffMs)) return;

  const result = await runAsyncSqlite(
    `DELETE FROM trace_events WHERE rowid IN (SELECT rowid FROM trace_events WHERE created_at < ${cutoffMs} LIMIT ${PRUNE_LOG_BATCH_LIMIT});
SELECT changes();`,
  );
  if (!result.ok) {
    log.warn(
      { error: result.error, backend: result.backend },
      "pruneOldTraceEventsJob: DELETE failed",
    );
    return;
  }

  const deleted = parseDeletedCount(result.stdout);

  if (deleted >= PRUNE_LOG_BATCH_LIMIT) {
    enqueueMemoryJob("prune_old_trace_events", { retentionDays });
  }

  log.info(
    {
      deleted,
      retentionDays,
      cutoffMs,
    },
    "Pruned old trace events",
  );
}

/**
 * Parse the `SELECT changes()` result emitted by the sqlite3 CLI after
 * the prune DELETE. Returns 0 if stdout is missing or unparseable —
 * callers treat that the same as "no rows deleted, do not re-enqueue".
 *
 * In the CLI's default output mode the value is a bare integer on its
 * own line. We tolerate trailing whitespace/blank lines and pick the
 * last numeric line so any incidental output (warnings, etc.) above it
 * doesn't throw the parse off.
 */
export function _parseDeletedCount(stdout: string | undefined): number {
  return parseDeletedCount(stdout);
}

function parseDeletedCount(stdout: string | undefined): number {
  if (!stdout) return 0;
  const lines = stdout.split(/\r?\n/).filter((s) => s.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = parseInt(lines[i].trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Delete conversations that have had no activity (updatedAt) for longer than
 * the configured retention period. Processes in batches so a single job doesn't
 * hold the DB lock for too long.
 *
 * Tables with onDelete cascade on conversation FK (memory_segments,
 * conversation_keys, channel_inbound_events, message_runs, call_sessions,
 * external_conversation_bindings, assistant_inbox_conversation_state) are handled
 * automatically. Tables without cascade (messages, tool_invocations,
 * llm_request_logs, skill_loaded_events) are deleted explicitly before
 * removing the conversation row.
 */
export function pruneOldConversationsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  const retentionDays =
    typeof job.payload.retentionDays === "number" &&
    Number.isFinite(job.payload.retentionDays) &&
    job.payload.retentionDays >= 0
      ? job.payload.retentionDays
      : config.memory.cleanup.conversationRetentionDays;

  pruneConversationsCore({
    retentionDays,
    backgroundOnly: false,
    reEnqueueType: "prune_old_conversations",
    logLabel: "Pruned old conversations",
  });
}

/**
 * Delete stale system-generated background conversations
 * (`conversation_type = 'background'`: heartbeat runs, watcher/background
 * jobs) and their dependent rows. These accumulate one conversation per
 * background run — a heartbeat every 30–60 minutes persists ~25–50
 * conversations/day, each dragging messages (+FTS), memory_segments,
 * activation_state, and a large memory_v2_activation_logs row along.
 * User conversations (`conversation_type = 'standard'`) are never touched.
 *
 * Uses the same batched, re-checked transaction shape as
 * {@link pruneOldConversationsJob} with a type filter.
 */
export function pruneOldBackgroundConversationsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  const retentionDays =
    typeof job.payload.retentionDays === "number" &&
    Number.isFinite(job.payload.retentionDays) &&
    job.payload.retentionDays >= 0
      ? job.payload.retentionDays
      : config.memory.cleanup.backgroundConversationRetentionDays;

  pruneConversationsCore({
    retentionDays,
    backgroundOnly: true,
    reEnqueueType: "prune_old_background_conversations",
    logLabel: "Pruned old background conversations",
  });
}

function pruneConversationsCore(args: {
  retentionDays: number;
  backgroundOnly: boolean;
  reEnqueueType:
    | "prune_old_conversations"
    | "prune_old_background_conversations";
  logLabel: string;
}): void {
  const { retentionDays, backgroundOnly, reEnqueueType, logLabel } = args;

  // 0 means disabled
  if (retentionDays === 0) return;

  const cutoffMs = Date.now() - retentionDays * 86_400_000;
  const typeFilter = backgroundOnly
    ? ` AND conversation_type = 'background'`
    : "";

  const stale = rawAll<{ id: string }>(
    `SELECT id FROM conversations WHERE updated_at < ?${typeFilter} ORDER BY updated_at ASC LIMIT ?`,
    cutoffMs,
    PRUNE_BATCH_LIMIT,
  );
  if (stale.length === 0) return;

  const db = getDb();
  let pruned = 0;
  for (const { id } of stale) {
    db.transaction(() => {
      // Re-check staleness inside the transaction to avoid racing with a conversation
      // that became active again between the initial SELECT and this DELETE.
      const still = rawAll<{ id: string }>(
        `SELECT id FROM conversations WHERE id = ? AND updated_at < ?`,
        id,
        cutoffMs,
      );
      if (still.length === 0) return;

      // Non-cascading tables
      rawRun(`DELETE FROM llm_request_logs WHERE conversation_id = ?`, id);
      rawRun(`DELETE FROM tool_invocations WHERE conversation_id = ?`, id);
      rawRun(`DELETE FROM messages WHERE conversation_id = ?`, id);
      rawRun(`DELETE FROM skill_loaded_events WHERE conversation_id = ?`, id);
      rawRun(
        `DELETE FROM memory_v2_activation_logs WHERE conversation_id = ?`,
        id,
      );
      rawRun(`DELETE FROM memory_recall_logs WHERE conversation_id = ?`, id);
      // Conversation row deletion cascades to remaining dependent tables
      rawRun(`DELETE FROM conversations WHERE id = ?`, id);
      pruned++;
    });
  }

  if (stale.length === PRUNE_BATCH_LIMIT) {
    enqueueMemoryJob(reEnqueueType, { retentionDays });
  }

  log.info(
    {
      pruned,
      skipped: stale.length - pruned,
      retentionDays,
      cutoffMs,
    },
    logLabel,
  );
}

/**
 * Delete memory-v2 activation telemetry (`memory_v2_activation_logs`) and
 * recall telemetry (`memory_recall_logs`) older than the configured
 * retention. Both tables are inspector/debug-only — no runtime state is
 * reconstructed from them — yet activation rows average ~100KB+ each when
 * `ann_candidate_limit` is unlimited, making the table the single largest
 * driver of assistant.db growth. Neither table has an FK cascade, so
 * time-based pruning is the only bound for rows whose conversation
 * outlives the retention window.
 *
 * Same async dispatch + integer inlining shape as
 * {@link pruneOldLlmRequestLogsJob}; re-enqueues itself while either
 * table still has a full batch to drain.
 */
export async function pruneOldActivationLogsJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const rawRetention = job.payload.retentionDays;
  const retentionDays =
    typeof rawRetention === "number" &&
    Number.isFinite(rawRetention) &&
    rawRetention >= 0
      ? rawRetention
      : config.memory.cleanup.activationLogRetentionDays;

  // 0 means disabled
  if (retentionDays === 0) return;

  const cutoffMs = Math.floor(Date.now() - retentionDays * 86_400_000);
  if (!Number.isFinite(cutoffMs)) return;

  let deletedTotal = 0;
  let saturated = false;
  for (const table of ["memory_v2_activation_logs", "memory_recall_logs"]) {
    const result = await runAsyncSqlite(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE created_at < ${cutoffMs} LIMIT ${PRUNE_LOG_BATCH_LIMIT});
SELECT changes();`,
    );
    if (!result.ok) {
      log.warn(
        { error: result.error, backend: result.backend, table },
        "pruneOldActivationLogsJob: DELETE failed",
      );
      continue;
    }
    const deleted = parseDeletedCount(result.stdout);
    deletedTotal += deleted;
    if (deleted >= PRUNE_LOG_BATCH_LIMIT) saturated = true;
  }

  if (saturated) {
    enqueueMemoryJob("prune_old_activation_logs", { retentionDays });
  }

  log.info(
    {
      deleted: deletedTotal,
      retentionDays,
      cutoffMs,
    },
    "Pruned old memory-v2 activation/recall telemetry",
  );
}
