import { getLogger } from "../util/logger.js";
import { memRawAll, memRawRun, rawAll, rawGet } from "./raw-query.js";

const log = getLogger("task-memory-cleanup");

/**
 * Batch size for cross-DB id handoffs (main-side id reads fed into
 * memory-side `IN (...)` statements). Bounds statement size and lock time.
 */
const CROSS_DB_ID_BATCH = 500;

/**
 * Check whether a conversation belongs to a failed task run or failed
 * schedule run. Derived from durable storage (task_runs / cron_runs)
 * so the check survives daemon restarts.
 */
export function isConversationFailed(conversationId: string): boolean {
  // For reused schedule conversations the same conversation_id appears in
  // multiple cron_runs. A single failed run should NOT mark the conversation
  // as permanently failed — only the *most recent* run for that conversation
  // matters. We therefore check whether the latest cron_run (by created_at,
  // which is a monotonically increasing epoch timestamp) has an error status.
  // Note: cron_runs.id is a UUID v4 (random), so we cannot use MAX(id).
  const row = rawGet<{ found: number }>(
    `SELECT 1 AS found
       FROM (
         SELECT 1 FROM task_runs WHERE conversation_id = ? AND status = 'failed'
         UNION ALL
         SELECT 1 FROM cron_runs
          WHERE conversation_id = ?
            AND status = 'error'
            AND id = (
              SELECT id FROM cron_runs WHERE conversation_id = ?
              ORDER BY created_at DESC LIMIT 1
            )
       )
      LIMIT 1`,
    conversationId,
    conversationId,
    conversationId,
  );
  return row != null;
}

/**
 * Invalidate assistant-inferred memory graph nodes sourced *exclusively* from
 * the given conversation. Called when a background task or schedule fails —
 * the assistant's optimistic claims are not trustworthy if the task didn't
 * complete.
 *
 * Nodes that also have sources from other non-failed conversations are left
 * alone (corroboration). Uses the `source_conversations` JSON array to
 * determine provenance.
 *
 * The graph lives in the dedicated memory DB while task_runs / cron_runs
 * stay in the main DB, so the old single-statement anti-join is split:
 * candidate nodes come off the memory connection, each *other* source is
 * checked for failure against the main connection (memoized — sources
 * repeat heavily across a conversation's nodes), and the invalidation
 * UPDATE goes back to the memory connection.
 */
export function invalidateAssistantInferredItemsForConversation(
  conversationId: string,
): number {
  cancelPendingExtractionJobsForConversation(conversationId);

  const candidates = memRawAll<{ id: string; source_conversations: string }>(
    `SELECT id, source_conversations
       FROM memory_graph_nodes
      WHERE source_type = 'inferred'
        AND fidelity != 'gone'
        AND EXISTS (
          SELECT 1 FROM json_each(source_conversations) jc
           WHERE jc.value = ?
        )`,
    conversationId,
  );
  if (candidates.length === 0) return 0;

  // A source corroborates unless its own conversation also failed. Sources
  // that never appear in task_runs / cron_runs (chat conversations, legacy
  // sourceKey markers) are non-failed by definition — same semantics the
  // single-statement version had.
  const failedCache = new Map<string, boolean>();
  const isFailedSource = (id: string): boolean => {
    const cached = failedCache.get(id);
    if (cached !== undefined) return cached;
    const failed = isConversationFailed(id);
    failedCache.set(id, failed);
    return failed;
  };

  const toInvalidate: string[] = [];
  for (const candidate of candidates) {
    let sources: unknown;
    try {
      sources = JSON.parse(candidate.source_conversations);
    } catch {
      sources = [];
    }
    const others = Array.isArray(sources)
      ? sources.filter(
          (v): v is string => typeof v === "string" && v !== conversationId,
        )
      : [];
    const hasLiveCorroborator = others.some((v) => !isFailedSource(v));
    if (!hasLiveCorroborator) {
      toInvalidate.push(candidate.id);
    }
  }
  if (toInvalidate.length === 0) return 0;

  const now = Date.now();
  let affected = 0;
  for (let i = 0; i < toInvalidate.length; i += CROSS_DB_ID_BATCH) {
    const batch = toInvalidate.slice(i, i + CROSS_DB_ID_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    affected += memRawRun(
      `UPDATE memory_graph_nodes
          SET fidelity = 'gone',
              last_accessed = ?
        WHERE id IN (${placeholders})
          AND fidelity != 'gone'`,
      now,
      ...batch,
    );
  }

  if (affected > 0) {
    log.info(
      { conversationId, affected },
      "Invalidated assistant-inferred memory graph nodes after task failure",
    );
  }

  return affected;
}

/**
 * Fail pending/running memory jobs whose payload id is in `ids`, batched so
 * the memory-side statement stays bounded. Returns rows updated.
 */
function failJobsByPayloadIds(
  payloadKey: "messageId" | "segmentId",
  ids: string[],
  reason: string,
  now: number,
): number {
  let total = 0;
  for (let i = 0; i < ids.length; i += CROSS_DB_ID_BATCH) {
    const batch = ids.slice(i, i + CROSS_DB_ID_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    total += memRawRun(
      `UPDATE memory_jobs
          SET status = 'failed',
              last_error = ?,
              updated_at = ?
        WHERE status IN ('pending', 'running')
          AND json_extract(payload, '$.${payloadKey}') IN (${placeholders})`,
      reason,
      now,
      ...batch,
    );
  }
  return total;
}

/**
 * Cancel all pending/running memory jobs referencing the given conversation.
 * Covers every job type: `embed_attachment` (keyed by messageId),
 * `embed_segment` (keyed by segmentId via memory_segments),
 * `graph_extract`, `build_conversation_summary` (keyed by conversationId),
 * and `embed_graph_node` (keyed by nodeId sourced from the conversation).
 *
 * The job queue and graph nodes live in the memory DB; messages and
 * memory_segments stay in main — so the message/segment-keyed passes read
 * ids off the main connection first and hand them to the memory-side
 * UPDATE, while the conversation- and node-keyed passes run entirely on
 * the memory connection.
 */
export function cancelPendingJobsForConversation(
  conversationId: string,
  reason: string = "conversation_wiped",
): number {
  const now = Date.now();
  let total = 0;

  // Jobs keyed by messageId: embed_attachment
  const messageIds = rawAll<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = ?`,
    conversationId,
  ).map((r) => r.id);
  total += failJobsByPayloadIds("messageId", messageIds, reason, now);

  // Jobs keyed by conversationId: graph_extract, build_conversation_summary
  total += memRawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND json_extract(payload, '$.conversationId') = ?`,
    reason,
    now,
    conversationId,
  );

  // Jobs keyed by segmentId: embed_segment (segments belong to the conversation)
  const segmentIds = rawAll<{ id: string }>(
    `SELECT id FROM memory_segments WHERE conversation_id = ?`,
    conversationId,
  ).map((r) => r.id);
  total += failJobsByPayloadIds("segmentId", segmentIds, reason, now);

  // Jobs keyed by nodeId: embed_graph_node (nodes sourced from this
  // conversation). Jobs and nodes share the memory DB, so the subselect
  // still works as one statement.
  total += memRawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND json_extract(payload, '$.nodeId') IN (
          SELECT mgn.id
            FROM memory_graph_nodes mgn, json_each(mgn.source_conversations) jc
           WHERE jc.value = ?
        )`,
    reason,
    now,
    conversationId,
  );

  if (total > 0) {
    log.info(
      { conversationId, cancelled: total },
      "Cancelled pending memory jobs for conversation",
    );
  }

  return total;
}

/**
 * Cancel only pending/running `graph_extract` jobs for the given
 * conversation. Used by the task-failure path where we want to
 * stop new extractions but must NOT cancel `embed_graph_node` jobs —
 * those nodes may be multi-sourced and still valid.
 */
function cancelPendingExtractionJobsForConversation(
  conversationId: string,
): number {
  const now = Date.now();
  const cancelled = memRawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = 'conversation_failed',
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND type = 'graph_extract'
        AND json_extract(payload, '$.conversationId') = ?`,
    now,
    conversationId,
  );

  if (cancelled > 0) {
    log.info(
      { conversationId, cancelled },
      "Cancelled pending extraction jobs for failed conversation",
    );
  }

  return cancelled;
}
