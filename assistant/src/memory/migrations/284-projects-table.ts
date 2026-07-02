import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_projects_table_v1";

/**
 * Create the projects table — named containers that group work items
 * ("Q4 launch", "Customer Acme"). Work items reference a project via the
 * nullable work_items.project_id column (added in migration 285); integrity
 * is enforced in the store, not with a foreign key, so archiving/deleting a
 * project can never strand or cascade-delete the underlying work.
 */
export function migrateCreateProjectsTable(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        emoji TEXT,
        color TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status)
    `);
  });
}
