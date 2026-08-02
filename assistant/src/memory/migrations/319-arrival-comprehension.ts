import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_arrival_comprehension_v1";

/**
 * Comprehension and grouping for arrivals — migration slot 319, the next free
 * slot after 318 (arrivals / the relevance gate).
 *
 * 318 answered "should the owner see this". These two tables answer the half
 * that was missing: "what IS this, and is it the same thing as something they
 * already have".
 *
 * ## `work_item_comprehension`
 *
 * One row per work item, written whether comprehension succeeded or not. A
 * silent no-op is the failure mode this codebase keeps rediscovering, so the
 * row exists even when the answer was "I could not do better than the subject
 * line" — `status` says which, `note` says why, and `original_title` keeps
 * what the item was called before anything touched it.
 *
 * ## `arrival_group_members`
 *
 * One row per message folded into a work item, including the message that
 * created it (`is_anchor = 1`). Grouping is therefore visible (list the rows)
 * and reversible (stamp `detached_at` and mint the item back) without ever
 * deleting anything. `idx_arrival_group_members_key` is the lookup the intake
 * path does per arrival: "is there already a live item for this thread /
 * sender on this channel".
 *
 * No foreign keys, matching the convention of `arrivals` and
 * `work_items.project_id`: deleting a work item must not erase the record of
 * what was combined into it or what Cue understood it to be.
 *
 * Idempotent — every statement is `IF NOT EXISTS`. No backfill: the 116 items
 * already in the queue predate the Gmail watcher recording a thread id, so
 * "grouping" them would mean guessing at conversations, and inventing history
 * is the exact failure this feature exists to avoid.
 */
export function migrateArrivalComprehension(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS work_item_comprehension (
        work_item_id TEXT PRIMARY KEY,
        arrival_id TEXT,
        status TEXT NOT NULL,
        original_title TEXT NOT NULL,
        action_title TEXT,
        due_at INTEGER,
        due_quote TEXT,
        amount_text TEXT,
        asked_by TEXT,
        decision_needed TEXT,
        confidence REAL,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_item_comprehension_status
        ON work_item_comprehension (status)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_item_comprehension_arrival
        ON work_item_comprehension (arrival_id)
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS arrival_group_members (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        group_key TEXT NOT NULL,
        group_kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        arrival_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT,
        sender_address TEXT,
        is_anchor INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        detached_at INTEGER,
        detached_by TEXT,
        detached_work_item_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    // One member row per arrival: an arrival is one message, and a message
    // belongs to at most one group. A replayed poll must not add a second row
    // and inflate the count the owner is shown.
    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_arrival_group_members_arrival
        ON arrival_group_members (arrival_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_arrival_group_members_item
        ON arrival_group_members (work_item_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_arrival_group_members_key
        ON arrival_group_members (channel, group_key)
    `);
  });
}
