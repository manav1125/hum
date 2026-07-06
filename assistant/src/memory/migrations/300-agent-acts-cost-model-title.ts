import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_agent_acts_cost_model_title_v1";

/**
 * Guardrails R2 — make the act ledger fully honest about what each act was
 * and what it cost. Three nullable columns on agent_acts, all stamped at the
 * runner's completion choke point (see agent-act-store):
 *
 * - `cost_cents` — the run's real attributable LLM cost, summed from
 *   llm_usage_events over the run conversation and rounded to cents at the
 *   aggregate (matching agent-store.getAgentSpend). Null = the act predates
 *   this migration or had no run conversation to attribute from — unknown,
 *   NOT zero.
 * - `model` — the dominant model of the run (highest summed cost across the
 *   run conversation's usage rows; ties break by call count). Null = unknown.
 * - `title` — the human title of what the act actually did (the work item's
 *   title, e.g. "Drafted the pricing one-pager") so the ledger shows real
 *   names instead of kind-derived labels. Null = no natural title source.
 *
 * Nullable by design, NO backfill: existing rows keep null (honest "wasn't
 * measured"), matching the ledger's observed-only contract. Idempotent — each
 * ALTER is guarded by a PRAGMA column check so re-runs are no-ops.
 */
export function migrateAgentActsCostModelTitle(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const columns = raw
      .prepare(/*sql*/ `PRAGMA table_info(agent_acts)`)
      .all() as Array<{ name: string }>;
    const has = (name: string) => columns.some((c) => c.name === name);

    if (!has("cost_cents")) {
      raw.exec(/*sql*/ `ALTER TABLE agent_acts ADD COLUMN cost_cents INTEGER`);
    }
    if (!has("model")) {
      raw.exec(/*sql*/ `ALTER TABLE agent_acts ADD COLUMN model TEXT`);
    }
    if (!has("title")) {
      raw.exec(/*sql*/ `ALTER TABLE agent_acts ADD COLUMN title TEXT`);
    }
  });
}
