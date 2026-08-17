import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_ritual_snapshots_v1";

/**
 * Migration 330 — `ritual_snapshots` + `ritual_snapshot_reads`, the durable
 * record of what the Morning Brief and the Weekly review said on the day they
 * said it.
 *
 * Slot 330 is the next free one after 329 (memory node injection events).
 *
 * ## Which database, and why the MAIN one
 *
 * The main DB (`assistant.db`), not `assistant-memory.db`.
 *
 * Migrations 324–328 relocated the memory cluster — graph nodes, v2/v3 pages,
 * conversation memory state, telemetry logs, memory jobs — into the separate
 * memory file. That cluster is what a memory export/restore has to carry, and
 * it is defined by "things the memory subsystem owns", not by "things that
 * accumulate".
 *
 * A brief is not memory. Every figure in a snapshot is computed from
 * `work_items`, `agent_acts`, `work_item_events` and the pending-interaction
 * tracker — all main-DB tables — and the archive read sits beside the same
 * work-item reads the rest of the ritual surfaces make. Putting the log in
 * the memory file would mean a cross-file read on the archive's hot path and
 * a restore semantics ("re-importing my memories brought back last week's
 * briefs") that nobody asked for. Read-state has the same answer for the same
 * reason.
 *
 * ## No backfill — the load-bearing property
 *
 * This migration creates two empty tables and stops. There is deliberately no
 * INSERT here and there must never be one. The numbers for last Tuesday
 * cannot be reconstructed: the brief composes over a sliding window of live
 * stores that have since moved on, so any row dated before this table existed
 * would be today's numbers wearing an old date. "Nothing before today" is the
 * honest first state of a log; the archive states the absence in words and
 * that line stops being true on its own within a week.
 *
 * Idempotent: `IF NOT EXISTS` throughout, wrapped in the standard checkpoint
 * so a crash mid-migration re-runs cleanly.
 */
export function migrateRitualSnapshots(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS ritual_snapshots (
        id TEXT PRIMARY KEY,
        ritual TEXT NOT NULL,
        period_key TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        composed_at INTEGER NOT NULL,
        headline TEXT NOT NULL,
        facts TEXT NOT NULL
      )
    `);

    // One row per ritual per period. This index is not an optimisation — it
    // is what makes the write idempotent: the store inserts OR IGNOREs
    // against it, so the FIRST compose of a day is the one that survives and
    // a re-read at 11pm cannot rewrite what the morning said.
    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ritual_snapshots_period
        ON ritual_snapshots (ritual, period_key)
    `);
    // The archive read: newest first, both rituals interleaved.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_ritual_snapshots_composed
        ON ritual_snapshots (composed_at)
    `);
    // The comparison read: "the weekly before this one".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_ritual_snapshots_ritual_composed
        ON ritual_snapshots (ritual, composed_at)
    `);

    // Read-state rides on the snapshot (design N1: no separate read-receipt
    // store), keyed by device so R4's device-locality survives — a Mac and a
    // phone are allowed to disagree about what has been read.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS ritual_snapshot_reads (
        snapshot_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (snapshot_id, device_id)
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_ritual_snapshot_reads_device
        ON ritual_snapshot_reads (device_id)
    `);
  });
}
