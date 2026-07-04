import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add `last_progress_note` to work_items:
 *
 *   - last_progress_note TEXT — nullable one-line description of what the
 *     background runner is currently doing ("Searching the web…", "Running
 *     command"). Stamped by the runner from live tool events while the item
 *     is `running`, cleared when the run reaches a terminal status, so the
 *     Activity/Projects boards can show real mid-run progress.
 *
 * All pre-existing rows keep NULL — purely additive. Idempotent via the
 * PRAGMA guard.
 */
export function migrateWorkItemProgressNote(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(work_items)`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("last_progress_note")) {
    raw.exec(`ALTER TABLE work_items ADD COLUMN last_progress_note TEXT`);
  }
}
