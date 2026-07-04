import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_missions_v1";

/**
 * Missions harness core (HQ Phase 1) — the goal layer above projects.
 *
 *   - missions: outcome-oriented goals (outcome + metric + horizon) with a
 *     per-mission autonomy mode override, cadence, budget cap/spend, and the
 *     bounded continuation summary the orchestrator regenerates each cycle.
 *   - company_profile: single-row (id='company') identity/direction record
 *     plus never_lines (JSON array of hard boundaries) and the workspace
 *     default autonomy mode.
 *   - mission_events: append-only audit trail of orchestrator cycles
 *     (cycle_started, planned, item_enqueued, checkpoint, reported, …).
 *   - mission_plan_fingerprints: exact-once decomposition guard — one row per
 *     (mission, plan-hash); claimed before enqueuing so a crashed/re-run
 *     cycle never duplicates work items. Idea adapted from Paperclip (MIT,
 *     github.com/paperclipai/paperclip) exact-once decomposition + wake-queue
 *     idempotency keys.
 *   - projects.mission_id: nullable link making existing projects the
 *     mission's initiatives (reference-by-convention, store-enforced — no FK,
 *     matching work_items.project_id).
 */
export function migrateCreateMissions(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        outcome TEXT NOT NULL,
        metric TEXT,
        horizon INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        mode TEXT,
        brief TEXT,
        cadence TEXT,
        budget_cents INTEGER,
        spent_cents INTEGER NOT NULL DEFAULT 0,
        continuation_summary TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        sort_index INTEGER,
        last_cycle_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS company_profile (
        id TEXT PRIMARY KEY,
        identity TEXT,
        direction TEXT,
        never_lines TEXT,
        workspace_mode TEXT NOT NULL DEFAULT 'assist',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS mission_events (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        cycle_id TEXT,
        payload TEXT,
        at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS mission_plan_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `);

    // Initiatives link: projects gain a nullable mission_id.
    const projectCols = raw
      .query(`PRAGMA table_info(projects)`)
      .all() as Array<{ name: string }>;
    if (!projectCols.some((c) => c.name === "mission_id")) {
      raw.exec(`ALTER TABLE projects ADD COLUMN mission_id TEXT`);
    }

    // Every mission-detail read is "all events for this mission, in order".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS mission_events_mission_at_idx
      ON mission_events (mission_id, at)
    `);
    // Rollups group linked projects by mission.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS projects_mission_idx
      ON projects (mission_id)
    `);
    // Mission list ordering mirrors projects (pinned first, then sort_index).
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS missions_pinned_sort_idx
      ON missions (pinned, sort_index)
    `);
  });
}
