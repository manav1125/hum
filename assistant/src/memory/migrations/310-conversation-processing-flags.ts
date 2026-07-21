import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Crash-recovery processing flags on the `conversations` table.
 *
 * Adds two columns that let an out-of-process reader (the daemon at the NEXT
 * boot) detect a turn that a previous process was running when it died:
 *
 *  - `processing_started_at` — epoch-ms set by `Conversation.setProcessing(true)`
 *    when a turn begins and cleared on a clean turn end. If the process dies
 *    mid-turn the row keeps a non-NULL value, which the startup reconciler
 *    (`daemon/interrupted-turn-reconciler.ts`) reads to find interrupted turns.
 *    The client-facing `isProcessing` flag stays sourced from the in-memory
 *    `Conversation` object, so this persisted marker never strands a client as
 *    "processing forever" — it exists solely as boot-time recovery input.
 *
 *  - `processing_resume_attempts` — consecutive startup auto-resume attempts,
 *    incremented by the reconciler when it wakes an interrupted conversation
 *    and reset to 0 on a clean turn end. Caps resume-loops so a turn that
 *    repeatedly takes the process down cannot resume across every boot.
 *
 * No backfill is needed — existing rows default to (NULL, 0), which is correct
 * for any conversation that was not mid-turn at migration time.
 *
 * Idempotent: each `ALTER TABLE` is guarded with `tableHasColumn` so a crash
 * between the two statements (or a re-run) doesn't raise a duplicate-column
 * error on the next boot.
 */
export function migrateConversationProcessingFlags(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  if (!tableHasColumn(database, "conversations", "processing_started_at")) {
    raw.exec(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN processing_started_at INTEGER`,
    );
  }

  if (
    !tableHasColumn(database, "conversations", "processing_resume_attempts")
  ) {
    raw.exec(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN processing_resume_attempts INTEGER NOT NULL DEFAULT 0`,
    );
  }
}
