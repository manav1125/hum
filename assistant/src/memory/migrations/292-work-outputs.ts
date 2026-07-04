import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_outputs_v1";

/**
 * Create the work_outputs table — the first-class registry of deliverables
 * ("Sprint outputs") produced by work-item runs, powering the artifact cards
 * on Mission detail and the daily brief.
 *
 * A row is one deliverable: either file-backed (attachment_id points at
 * attachments.id — the run's tool-produced attachment) or an external pointer
 * (external_url). kind is the card taxonomy (document | deck | spreadsheet |
 * pdf | image | video | other), derived from mime/extension at capture time.
 * why is the one-line "why it exists" purpose (derived from the work-item
 * title at capture; editable later), agent is the assignee that produced it.
 * mission_id / project_id are denormalized at write time from the owning work
 * item so mission rollups don't re-walk work_items → projects on every read.
 *
 * All references are by convention (store-enforced, no FKs), matching
 * work_items.project_id / projects.mission_id.
 */
export function migrateCreateWorkOutputs(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS work_outputs (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        mission_id TEXT,
        project_id TEXT,
        attachment_id TEXT,
        external_url TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        why TEXT,
        agent TEXT,
        review_state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `);

    // Mission detail reads "this mission's outputs, newest first".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS work_outputs_mission_created_idx
      ON work_outputs (mission_id, created_at)
    `);
    // Work-item detail reads "this run's outputs".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS work_outputs_work_item_idx
      ON work_outputs (work_item_id)
    `);
    // The daily brief reads "recent outputs across everything".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS work_outputs_created_idx
      ON work_outputs (created_at)
    `);
    // Exact-once capture guard: a re-registered (work item, attachment) pair
    // is a no-op (the capture path inserts with OR IGNORE against this).
    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS work_outputs_item_attachment_uniq
      ON work_outputs (work_item_id, attachment_id)
      WHERE attachment_id IS NOT NULL
    `);
  });
}
