import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_project_knowledge_v1";

/**
 * Create the project_knowledge table — Claude-Projects-style knowledge
 * attached to a cowork project so every task run in that project has the
 * material available.
 *
 * One table covers both kinds of knowledge:
 *   - kind='file': attachment_id points at attachments.id (upload goes through
 *     the existing attachment upload route first, then gets linked here).
 *     Reference-by-convention, store-enforced — no FK, matching how
 *     work_items.project_id references projects.
 *   - kind='link': url carries an external pointer (doc, repo, dashboard)
 *     surfaced to the agent as reference material.
 *
 * label is the display name (defaults to the filename / URL at the store
 * layer). added_at is epoch ms.
 */
export function migrateCreateProjectKnowledge(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS project_knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        attachment_id TEXT,
        url TEXT,
        label TEXT,
        added_at INTEGER NOT NULL
      )
    `);

    // Every read is "all knowledge for this project" — index the lookup key.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS project_knowledge_project_idx
      ON project_knowledge (project_id)
    `);
  });
}
