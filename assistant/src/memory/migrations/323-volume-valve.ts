import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_volume_valve_v1";

/**
 * The volume valve — three tables for the question the relevance gate does not
 * answer: of the work that exists, what INTERRUPTS?
 *
 * Migration slot 323 — the next free slot after 322 (memory job outcome).
 *
 * ## Why this is not more columns on `arrivals`
 *
 * `arrivals` records a decision about MAIL CONTENT, made once, at the
 * arrival → work-item boundary. Measured on the owner's production instance,
 * 112 of one day's 209 surfaced arrivals were recorded with the reason "not a
 * message — Cue does not filter this kind of arrival": calendar hits and
 * non-mail watcher events that pass through the gate untouched by design.
 * Work captured from chat, voice, MCP or quick-add has no `arrivals` row at
 * all. A volume control that lived on `arrivals` would therefore be blind to
 * most of what fills the owner's lane.
 *
 * So the band is keyed by work item, and the gate's verdict is an INPUT to it
 * (`valve_bands.arrival_id`) rather than a place to put the answer. The gate
 * is never re-run and its row is never rewritten.
 *
 * ## Why the band is stamped and the stop is not applied
 *
 * `band` is a property of the item; `stop` is a property of the owner's
 * current preference. Storing the band and comparing it at read time means
 * moving the valve is a comparison over existing rows: instant, reversible,
 * and structurally incapable of losing anything, because nothing is removed
 * to make it quiet. Had the valve instead filtered at intake, "Nothing is
 * lost" would be a promise enforced by every future query remembering to look
 * somewhere else — which is exactly the failure mode `arrivals` was made a
 * sibling table to avoid.
 *
 * ## No backfill, and that is the fail-open guarantee
 *
 * There is deliberately no backfill. A work item with no `valve_bands` row
 * reads as `urgent` — the loudest band — so all 131 items standing in the
 * owner's queue today, and every item any un-migrated code path writes
 * tomorrow, keep interrupting exactly as they do now. Filtering only ever
 * begins for an item something positively decided about. An empty table is a
 * valve wide open, never a valve shut.
 *
 * ## Indexes
 *
 *   - `idx_valve_bands_rule` — the observability read: how often each rule
 *     fired in a window, and which rules have never fired at all. This one
 *     exists because a safety floor in this codebase ran with three of its
 *     four conditions dead for weeks; a rule distribution has to be a cheap
 *     query or nobody will run it.
 *   - `idx_valve_bands_band` — the HQ read, everything at or above a band.
 *   - `idx_valve_bands_sender` — applying learned sender feedback.
 *   - `idx_valve_bands_mission` — the per-mission override.
 *
 * No foreign keys, matching `arrivals` and `work_items.project_id`: deleting
 * a work item must not erase the record of how loud Cue thought it was, and
 * deleting a mission must not silently drop an override the owner set.
 *
 * Idempotent: every statement is `IF NOT EXISTS`.
 */
export function migrateVolumeValve(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS valve_bands (
        work_item_id TEXT PRIMARY KEY,
        band TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        banded_by TEXT NOT NULL,
        arrival_id TEXT,
        sender_key TEXT,
        mission_id TEXT,
        surfaced_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_valve_bands_rule
        ON valve_bands (rule_id, created_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_valve_bands_band
        ON valve_bands (band, created_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_valve_bands_sender
        ON valve_bands (sender_key)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_valve_bands_mission
        ON valve_bands (mission_id)
    `);

    // One row for 'global', one per 'mission:<id>' override. Absent = default.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS valve_stops (
        scope TEXT PRIMARY KEY,
        stop TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL
      )
    `);

    // Both directions of correction are counted. A sender the owner dismissed
    // twice and then acted on once must not read as settled — the evidence
    // that the dismissals were wrong stays in the same row.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS valve_feedback (
        subject_kind TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0,
        kept INTEGER NOT NULL DEFAULT 0,
        last_signal_at INTEGER NOT NULL,
        PRIMARY KEY (subject_kind, subject_key)
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_valve_feedback_dismissed
        ON valve_feedback (dismissed)
    `);
  });
}
