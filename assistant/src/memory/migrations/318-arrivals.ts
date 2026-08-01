import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_arrivals_v1";

/**
 * Arrivals — the relevance gate at the arrival → work-item boundary.
 *
 * Migration slot 318 — the next free slot after 317 (life lens + waiting).
 *
 * ## The table
 *
 * `arrivals` records EVERY hit a watcher saw and which of two dispositions it
 * got: `surfaced` (a work item exists, the Came-in lane behaves exactly as
 * before) or `filed` (recorded, browsable, reversible — but not something the
 * owner must look at). It exists because the only filter at arrival used to be
 * `labelIds.includes("INBOX")`, so every newsletter, receipt and build
 * notification became a work item.
 *
 * A sibling table rather than a flag on `work_items`, because a filed arrival
 * is not work: modelling it as a work item would make correctness depend on
 * every existing query remembering to exclude it, and the first query that
 * forgot would put the noise straight back in the owner's lane. Here the
 * exclusion is structural — filed arrivals never become work items.
 *
 * No foreign keys (the same reference-by-convention rule as
 * `work_items.project_id`): deleting a work item must not erase the record of
 * why it was kept, and deleting a watcher must not erase what it saw.
 *
 * ## The work-item link
 *
 *   - `work_items.arrival_id TEXT` — the arrival a surfaced item came from.
 *     Null on every pre-318 row and on every item captured any other way, so
 *     a client that has never heard of arrivals reads exactly as before.
 *     Deliberately separate from `auto_filed_by` / `auto_file_confidence`,
 *     which mean "assigned to a project" — conflating a relevance decision
 *     with a filing decision is what made the digest's counts dishonest.
 *
 * ## Indexes
 *
 *   - `idx_arrivals_channel_external` (UNIQUE) — re-intake of the same hit is
 *     idempotent, so a replayed watcher poll cannot double-count "arrived".
 *   - `idx_arrivals_created_at` / `idx_arrivals_disposition_created_at` — the
 *     summary is a windowed count per disposition, and the "Where it went ›"
 *     list is newest-first filed rows.
 *   - `idx_arrivals_sender` — repeated reversals for one sender are the
 *     learning signal; that read is a point lookup per sender.
 *   - `idx_work_items_arrival` — the arrival → work item hop on a reversal.
 *
 * Idempotent: the table and every index are `IF NOT EXISTS`, and the one ALTER
 * is column-guarded. No backfill by design — the ledger starts honestly at the
 * moment it was installed rather than inventing dispositions for history.
 */
export function migrateArrivals(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS arrivals (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        external_id TEXT NOT NULL,
        watcher_id TEXT,
        event_id TEXT,
        title TEXT NOT NULL,
        sender_address TEXT,
        sender_name TEXT,
        snippet TEXT,
        source_context TEXT,
        disposition TEXT NOT NULL,
        reason TEXT,
        decided_by TEXT NOT NULL,
        rule_id TEXT,
        confidence REAL,
        work_item_id TEXT,
        reversed_at INTEGER,
        reversed_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // One row per (channel, provider id). Dedupe already happens upstream in
    // `watcher_events`, but a UNIQUE index here means a replayed or repaired
    // poll can never inflate the "arrived" number the owner is shown.
    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_arrivals_channel_external
        ON arrivals (channel, external_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_arrivals_created_at
        ON arrivals (created_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_arrivals_disposition_created_at
        ON arrivals (disposition, created_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_arrivals_sender
        ON arrivals (sender_address)
    `);

    if (!tableHasColumn(database, "work_items", "arrival_id")) {
      raw.exec(/*sql*/ `ALTER TABLE work_items ADD COLUMN arrival_id TEXT`);
    }
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_items_arrival
        ON work_items (arrival_id)
    `);
  });
}
