import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_item_hygiene_v1";

/**
 * Task-hygiene columns: "completed elsewhere" + auto-file provenance.
 *
 * Columns (all additive, default-preserving — pre-existing rows behave
 * identically):
 *
 *   - work_items.completed_elsewhere INTEGER NOT NULL DEFAULT 0 — 1 when the
 *     owner marked the task done as "completed elsewhere": the work happened
 *     outside Cue, so review surfaces must not claim Cue produced anything.
 *     Terminal exactly like a normal `done`. Stamped by the complete route
 *     when the body carries `completedElsewhere: true`; read by the
 *     ran-provenance classifier (an elsewhere-completion is always "manual").
 *
 *   - work_items.auto_filed_by TEXT — null | 'cue' | 'user_unfiled'.
 *     'cue' = the background auto-filer assigned this item's project_id
 *     (provenance for the web "auto-filed" chip). 'user_unfiled' = the user
 *     deliberately cleared project_id, so the auto-filer must never re-file
 *     the item. null = user-filed or never filed.
 *
 *   - work_items.auto_file_confidence REAL — the auto-filer's 0–1 confidence
 *     for its assignment; set only alongside auto_filed_by = 'cue'.
 *
 * Enforcement lives in work-items/work-item-auto-file.ts (the sweep only
 * touches project_id IS NULL items whose auto_filed_by != 'user_unfiled') and
 * the work-items routes (PATCH stamps 'user_unfiled' on an explicit unfile;
 * the complete route stamps completed_elsewhere).
 *
 * Idempotent: each ALTER is guarded by a PRAGMA column check.
 */
export function migrateWorkItemHygiene(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const cols = raw
      .prepare(/*sql*/ `PRAGMA table_info(work_items)`)
      .all() as Array<{ name: string }>;
    const has = (name: string) => cols.some((c) => c.name === name);

    if (!has("completed_elsewhere")) {
      raw.exec(
        /*sql*/ `ALTER TABLE work_items ADD COLUMN completed_elsewhere INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!has("auto_filed_by")) {
      raw.exec(/*sql*/ `ALTER TABLE work_items ADD COLUMN auto_filed_by TEXT`);
    }
    if (!has("auto_file_confidence")) {
      raw.exec(
        /*sql*/ `ALTER TABLE work_items ADD COLUMN auto_file_confidence REAL`,
      );
    }
  });
}
