import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_agent_acts_v1";

/**
 * Create the agent_acts table — the act/reversal ledger behind the trust
 * evidence line ("214 acts · 0 reversed") and the TIME BACK "~N hrs" chip.
 *
 * One row is one autonomous act the agent completed on the owner's behalf
 * (today: a completed background work-item run; kind leaves headroom for
 * drafted messages, fired schedules, …). `reversed` flips to 1 when the
 * owner undoes the act — re-runs the work item or rejects its reviewed
 * output — so the ratio of acts to reversals is an honest, observable
 * trust signal. `est_minutes_saved` carries the conservative per-act
 * time-back estimate (see agent-act-store's documented heuristic).
 *
 * mission_id is denormalized at write time from the owning work item's
 * project (matching work_outputs) so mission rollups are one indexed read.
 * References are by convention (store-enforced, no FKs), matching
 * work_items.project_id / work_outputs.
 *
 * Deliberately NO backfill: the ledger starts at zero and only counts acts
 * it actually observed — the UI's "measuring…" state expects an honest
 * zero-start, not synthesized history.
 */
export function migrateCreateAgentActs(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS agent_acts (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL DEFAULT 'cue',
        work_item_id TEXT,
        mission_id TEXT,
        kind TEXT NOT NULL,
        reversed INTEGER NOT NULL DEFAULT 0,
        reversed_at INTEGER,
        est_minutes_saved INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    // Per-agent summary reads "this agent's acts in the trailing window".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS agent_acts_agent_created_idx
      ON agent_acts (agent, created_at)
    `);
    // The all-agents summary + recent-acts list read by time alone.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS agent_acts_created_idx
      ON agent_acts (created_at)
    `);
  });
}
