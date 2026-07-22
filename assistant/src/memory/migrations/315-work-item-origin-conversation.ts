import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_item_origin_conversation_v1";

/**
 * How close a work item's creation must be to its task template's for the
 * backfill to treat them as minted by the same enqueue call. The real paths
 * (`createWorkItemFast`, `task_list_add`, commitment capture) create both
 * within the same function call — milliseconds apart — so a minute is a
 * generous belt.
 */
const BACKFILL_WINDOW_MS = 60_000;

/**
 * The originating-conversation link for a work item.
 *
 * Migration slot 315 — the next free slot after 314 (work-item assessment).
 *
 * A commitment captured in a conversation (voice, desktop chat, a channel
 * message) becomes a work item that runs in its OWN run conversation. That
 * separation is deliberate — a long research run must not block or flood the
 * live thread — but until now the originating thread had no way back: the
 * enqueue path threw the conversation id away, because `source_type` /
 * `source_id` mean "which external CHANNEL did this come from", and a local
 * desktop/voice task legitimately has no channel. The result was a thread that
 * did not know what it had spawned, and an agent that happily re-did research
 * that had already run.
 *
 *   - work_items.origin_conversation_id TEXT — the conversation the item was
 *     created FROM. Distinct from `last_run_conversation_id` (where the run
 *     happened) and from `source_type`/`source_id` (which channel it arrived
 *     on, absent for local tasks). Nullable: items created outside any
 *     conversation (CLI, project quick-add, mission cycles) have none.
 *   - idx_work_items_origin_conversation_id — the read path is a point lookup
 *     per conversation turn (the `spawned-work` injector) and per thread
 *     render, so it must be an index seek.
 *
 * ## Backfill
 *
 * The link already exists one level down for items created before this column:
 * the ad-hoc enqueue paths mint a lightweight task template in the same call
 * and stamp `tasks.created_from_conversation_id`. This migration copies that
 * value onto the work item — but ONLY where it cannot be wrong:
 *
 *   - the task has exactly ONE work item — task templates are reusable and
 *     `createTask` is idempotent on (normalized title, template), so a shared
 *     template's `created_from_conversation_id` names whichever conversation
 *     defined it FIRST, not the one that enqueued each item; and
 *   - the work item was created within {@link BACKFILL_WINDOW_MS} of the task
 *     — i.e. the two were minted together by one enqueue call, rather than the
 *     item being queued later against a pre-existing template.
 *
 * Anything ambiguous is left null. A missing link renders as "no spawned work"
 * (quiet, honest); a wrong link would attribute another thread's work to this
 * one, which the product must never do.
 *
 * Idempotent: the ALTER is column-guarded and the backfill only writes rows
 * where `origin_conversation_id IS NULL`.
 */
export function migrateWorkItemOriginConversation(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    if (!tableHasColumn(database, "work_items", "origin_conversation_id")) {
      raw.exec(
        /*sql*/ `ALTER TABLE work_items ADD COLUMN origin_conversation_id TEXT`,
      );
    }

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_items_origin_conversation_id
      ON work_items (origin_conversation_id)
    `);

    raw.exec(/*sql*/ `
      UPDATE work_items
      SET origin_conversation_id = (
        SELECT t.created_from_conversation_id
        FROM tasks t
        WHERE t.id = work_items.task_id
      )
      WHERE origin_conversation_id IS NULL
        AND EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.id = work_items.task_id
            AND t.created_from_conversation_id IS NOT NULL
            AND ABS(work_items.created_at - t.created_at) <= ${BACKFILL_WINDOW_MS}
        )
        AND (
          SELECT COUNT(*) FROM work_items peer
          WHERE peer.task_id = work_items.task_id
        ) = 1
    `);
  });
}
