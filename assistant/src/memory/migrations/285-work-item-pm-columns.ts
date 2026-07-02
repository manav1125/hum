import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add the PM fields to work_items:
 *
 *   - project_id TEXT — nullable reference-by-convention to projects.id
 *     (SQLite cannot add a REFERENCES clause via ALTER; the store enforces
 *     integrity, mirroring how source_id works).
 *   - due_at INTEGER — nullable deadline, epoch ms. Stamped by triage when
 *     the task text states an explicit deadline, or set by the user.
 *   - labels TEXT — nullable JSON array string of freeform labels.
 *   - assignee TEXT — nullable; NULL reads as "cue" (the AI runs it).
 *
 * All pre-existing rows keep NULLs — purely additive. Idempotent via the
 * PRAGMA guard.
 */
export function migrateWorkItemPmColumns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(work_items)`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("project_id")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN project_id TEXT`);
  }
  if (!columnNames.has("due_at")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN due_at INTEGER`);
  }
  if (!columnNames.has("labels")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN labels TEXT`);
  }
  if (!columnNames.has("assignee")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN assignee TEXT`);
  }

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS work_items_project_id_idx ON work_items (project_id)
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS work_items_due_at_idx ON work_items (due_at)
  `);
}
