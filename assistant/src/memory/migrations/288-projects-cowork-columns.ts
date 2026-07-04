import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Cowork PM columns — extend projects + work_items into a real
 * Claude-cowork-style project system.
 *
 * projects:
 *   - category TEXT — nullable freeform bucket ("personal" | "professional" |
 *     "other" | anything). Purely descriptive; no enum constraint at the DB
 *     layer so the taxonomy can evolve without a migration.
 *   - context TEXT — nullable project brief/instructions. The agent reads this
 *     before working ANY task in the project, so cowork context extends per
 *     project (the "what this project is about / how to work it" note).
 *   - sort_index INTEGER — nullable manual ordering key (smaller sorts first).
 *   - pinned INTEGER — 0/1 flag; pinned projects float to the top of the list.
 *
 * work_items:
 *   - context TEXT — nullable per-task notes/context the USER adds. Injected
 *     into the agent's working context alongside the project brief before a
 *     run, so a task can carry run-specific instructions.
 *   - source_context TEXT — nullable JSON snapshot of where the task came from
 *     (channel/mcp/chat/voice + original snippet), stamped at triage time.
 *   - last_activity_at INTEGER — nullable epoch ms, bumped on any event/update.
 *     Ranking uses it to de-prioritize stale drifters (see next-move.ts).
 *
 * All pre-existing rows keep NULLs (pinned defaults to 0) — purely additive.
 * Idempotent via the PRAGMA table_info guard.
 */
export function migrateProjectsCoworkColumns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const projectCols = raw.query(`PRAGMA table_info(projects)`).all() as Array<{
    name: string;
  }>;
  const projectColNames = new Set(projectCols.map((c) => c.name));

  if (!projectColNames.has("category")) {
    raw.exec(`ALTER TABLE projects ADD COLUMN category TEXT`);
  }
  if (!projectColNames.has("context")) {
    raw.exec(`ALTER TABLE projects ADD COLUMN context TEXT`);
  }
  if (!projectColNames.has("sort_index")) {
    raw.exec(`ALTER TABLE projects ADD COLUMN sort_index INTEGER`);
  }
  if (!projectColNames.has("pinned")) {
    raw.exec(
      `ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    );
  }

  const workItemCols = raw
    .query(`PRAGMA table_info(work_items)`)
    .all() as Array<{ name: string }>;
  const workItemColNames = new Set(workItemCols.map((c) => c.name));

  if (!workItemColNames.has("context")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN context TEXT`);
  }
  if (!workItemColNames.has("source_context")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN source_context TEXT`);
  }
  if (!workItemColNames.has("last_activity_at")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN last_activity_at INTEGER`);
  }

  // Ordering index for the pinned/sort_index list query in project-store.
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS projects_pinned_sort_idx
    ON projects (pinned, sort_index)
  `);
  // Ranking reads last_activity_at heavily — index it.
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS work_items_last_activity_at_idx
    ON work_items (last_activity_at)
  `);
}
