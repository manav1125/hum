import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Per-AGENT usage attribution — add `agent_id` to the LLM usage ledger.
 *
 * Background work-item runs execute in a dedicated conversation whose id
 * lands on `work_items.last_run_conversation_id`; the item's `assignee`
 * names the staffed agent (roster row in `agents`, matched
 * case-insensitively). `recordUsageEvent` resolves that chain at WRITE time
 * and stamps the roster agent's id here, so per-agent spend stays truthful
 * even after the work item is re-run (a read-time join through
 * last_run_conversation_id only sees the LATEST run).
 *
 * Nullable by design: chat, schedules, and house ("cue") work stay NULL and
 * read as "Cue" in the usage breakdown. Existing rows are NOT backfilled —
 * honest zero-start, matching agent_acts.
 */
export function migrateLlmUsageAgentAttribution(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  if (!tableHasColumn(database, "llm_usage_events", "agent_id")) {
    raw.exec(/*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN agent_id TEXT`);
  }
}
