import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_item_events_v1";

/**
 * Create the work_item_events audit trail: one row per lifecycle transition
 * (created / status_changed / run_started / run_finished / approved) with the
 * from/to statuses and the actor (user / runner / triage / system). Powers
 * per-item history views and cycle-time metrics. Cascades with its work item.
 */
export function migrateCreateWorkItemEvents(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS work_item_events (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        actor TEXT,
        at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS work_item_events_item_at_idx
      ON work_item_events (work_item_id, at)
    `);
  });
}
