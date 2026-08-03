import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_push_budget_ledger_v1";

/**
 * Push budget ledger — the durable count behind design's "three a day is the
 * ceiling unless something breaks" (v28 push spec §5).
 *
 * Migration slot 321 — the next free slot after 320 (arrival occurred_at).
 *
 * One row per remote-push decision, delivered or suppressed. A table rather
 * than an in-memory counter because the ceiling is a property of the user's
 * day, not of the daemon's uptime: a restart at lunchtime must not hand the
 * afternoon a fresh budget.
 *
 * A row per decision rather than a per-day tally because a suppressed push is
 * acknowledged, never dropped — the tier and the reason are what make the
 * suppression auditable afterwards, and what keep any count shown to the user
 * a real one.
 *
 * Content-free by construction: event name, tier, and a throttle key. No
 * device token, no address, no message body ever reaches this table.
 *
 * Idempotent: table and indexes are `IF NOT EXISTS`. No backfill — the ledger
 * starts honestly at the moment it was installed rather than inventing a
 * history of sends it did not observe.
 */
export function migratePushBudgetLedger(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS push_budget_ledger (
        id TEXT PRIMARY KEY,
        day_key TEXT NOT NULL,
        tier TEXT NOT NULL,
        source_event_name TEXT NOT NULL,
        subject_key TEXT,
        delivered INTEGER NOT NULL,
        reason TEXT NOT NULL,
        broke_quiet_hours INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    // The ceiling check is "how many delivered today"; the audit read is the
    // day's rows newest-first; the prune is by age.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_push_budget_ledger_day
        ON push_budget_ledger (day_key)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_push_budget_ledger_day_delivered
        ON push_budget_ledger (day_key, delivered)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_push_budget_ledger_created
        ON push_budget_ledger (created_at)
    `);
  });
}
