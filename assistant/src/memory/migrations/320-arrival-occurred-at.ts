import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_arrival_occurred_at_v1";

/**
 * When the thing actually HAPPENED, as distinct from when Cue noticed it.
 *
 * Migration slot 320 — the next free slot after 319 (arrival comprehension).
 *
 * ## The bug this fixes
 *
 * `arrivals.created_at` and `watcher_events.created_at` are both stamped
 * `Date.now()` at insert. They are honest about what they are — the moment the
 * row was written — but any question about a PERSON ("how long since they
 * wrote") read off them is really a question about the daemon. The gap is not
 * academic: on the owner's instance 344 of 425 arrivals share a single
 * calendar day, and the longest span between any one sender's first and last
 * message is one day. That is the shape of a watcher catching up, not the
 * shape of 170 people corresponding.
 *
 * The true event time was never unavailable — it was discarded. Every provider
 * already resolves it (`WatcherItem.timestamp`: Gmail's `internalDate`,
 * Outlook's `receivedDateTime`, GitHub's `updated_at`) and, before this
 * migration, not one line of code read it back. Both persistence boundaries
 * dropped it on the floor.
 *
 * Why it matters beyond tidiness: a cadence measure built on the observation
 * clock would fire for every correspondent at once the first time the daemon
 * was down for a weekend — a public wrong answer about everybody the owner
 * knows, delivered simultaneously.
 *
 *   - arrivals.occurred_at INTEGER — epoch ms the message/event was sent or
 *     last changed at the source.
 *   - watcher_events.occurred_at INTEGER — the same value at the earlier
 *     boundary, so the arrival path is not the only thing that can recover it.
 *   - idx_arrivals_sender_occurred_at — the shape any per-person time question
 *     asks: this sender's rows, in event order.
 *
 * ## Why nullable, and why there is no backfill
 *
 * NULL means "not known", and it must stay distinguishable from a real time.
 * Defaulting it to `created_at` would be the original bug wearing a new column
 * name: every pre-320 row would claim an event time it never had, and it would
 * claim the one value that is systematically wrong. So old rows keep NULL,
 * readers skip what they cannot date, and the column earns its history forward
 * from here.
 *
 * A backfill was checked rather than assumed. The Gmail payload does retain a
 * `Date` header, so a join from `arrivals.event_id` to `watcher_events` can
 * recover the true time for some rows — but only 208 of 425 arrivals carry
 * one, the recoverable dates span three days, and the per-provider header
 * parsing would be a second, divergent implementation of a value the provider
 * already hands us correctly. Partial history bought at the price of a parser
 * that can disagree with the live path is a bad trade.
 *
 * Idempotent: both ALTERs are column-guarded, the index is IF NOT EXISTS.
 */
export function migrateArrivalOccurredAt(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const columns: Array<[table: string, column: string]> = [
      ["arrivals", "occurred_at"],
      ["watcher_events", "occurred_at"],
    ];
    for (const [table, column] of columns) {
      if (!tableHasColumn(database, table, column)) {
        raw.exec(/*sql*/ `ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
      }
    }

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_arrivals_sender_occurred_at
      ON arrivals (sender_address, occurred_at)
    `);
  });
}
