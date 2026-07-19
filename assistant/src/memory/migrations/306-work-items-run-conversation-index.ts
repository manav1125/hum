import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_items_run_conversation_index_v1";

/**
 * Index for the spend-attribution join key.
 *
 * `work_items.last_run_conversation_id` is the attribution key that links a
 * background run's LLM usage to its work item. It is probed on several read
 * paths that previously full-scanned work_items:
 *
 *   - agent-store.getAgentSpend / guardrails usage-rollup: join
 *     llm_usage_events → work_items ON last_run_conversation_id — when the
 *     planner picks llm_usage_events as the outer table (large usage windows)
 *     every usage row re-scanned work_items.
 *   - guardrails checkpoint-enforcement: `WHERE last_run_conversation_id = ?`
 *     point lookup on every gated tool call inside a background run.
 *   - guardrails-routes act attribution: same point lookup per request.
 *
 * work_items is small today, but these are hot paths (per-tool-call, per
 * ledger read) and the table grows with the work loop; the index makes each
 * probe an index seek regardless of planner choice.
 *
 * IF NOT EXISTS keeps this idempotent and safe to re-run.
 */
export function migrateWorkItemsRunConversationIndex(
  database: DrizzleDb,
): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_items_last_run_conversation_id
      ON work_items (last_run_conversation_id)
    `);
  });
}
