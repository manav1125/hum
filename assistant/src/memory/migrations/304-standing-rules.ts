import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_standing_rules_v1";

/**
 * Standing auto-confirm rules — the persisted "Make it a rule" decisions behind
 * the in-context rule card.
 *
 * After the owner confirms a one-off inbound commitment, they can promote the
 * decision into a STANDING rule ("auto-confirm anything from Rachel" /
 * "auto-confirm anything from Slack"). Matching work items then clear the
 * per-category autonomy policy's `policy_ask` deferral in the auto-run gate
 * (work-items/work-item-triage.ts → maybeAutoRunWorkItem) instead of parking
 * for approval. The rule never overrides the hard-deny safety floor.
 *
 * Creates the `standing_rules` table if absent, plus a lookup index on the
 * enabled flag (the gate reads enabled rules on every capture). Idempotent:
 * CREATE TABLE / CREATE INDEX are IF NOT EXISTS.
 */
export function migrateStandingRules(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS standing_rules (
        id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        trigger_value TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'auto_confirm',
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source_work_item_id TEXT,
        source_task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_standing_rules_enabled
        ON standing_rules (enabled)
    `);
  });
}
