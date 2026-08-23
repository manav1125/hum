import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_notes_v1";

/**
 * Notes — capture, and the proposals Cue finds inside it.
 *
 * Migration slot 332 — the next free slot after 331 (schedule script env).
 *
 * ## The two tables
 *
 * `notes` is what the owner wrote, said, selected or forwarded.
 * `note_extractions` is what Cue thinks is in it — a task, a memory, a trait
 * about a person — and every row is a PROPOSAL. Extraction never writes
 * without acceptance, so the proposal is a row and the accept route is the
 * only code that turns one into work. See `../schema/notes.ts` for why that
 * rule is modelled in the schema rather than left to reviewers.
 *
 * ## The work-item link
 *
 *   - `work_items.note_id TEXT` — the note a task came from. Null on every
 *     pre-332 row and on every item captured any other way, so a client that
 *     has never heard of notes reads exactly as before.
 *
 * Following the `arrivals` precedent (a dedicated `arrival_id` column rather
 * than overloading `source_type` / `source_id`, which mean "which external
 * CHANNEL did this arrive on"). A note is not a channel, and a task made from
 * a note still has a legitimate channel of its own.
 *
 * No foreign keys, the same reference-by-convention rule the rest of this
 * schema uses — and here it is load-bearing rather than incidental:
 * **provenance is one-way, so deleting a note must never delete work.** A
 * dangling `note_id` is the intended end state, and the work item renders
 * "from a note you deleted" rather than pretending it had no origin.
 *
 * ## Indexes
 *
 *   - `idx_notes_occurred_at` — the list is newest-first on when the THOUGHT
 *     happened, not when the row was made; a Halo capture and an import both
 *     carry their own time.
 *   - `idx_notes_project` — a project's room lists the notes filed to it.
 *   - `idx_notes_extraction_state` — the header's counts and the "reading"
 *     sweep both filter on it.
 *   - `idx_note_extractions_note` — the rail, per note.
 *   - `idx_note_extractions_state` — "Waiting on you · 3" across all notes,
 *     which is what makes the acceptance rule workable instead of a place
 *     proposals rot.
 *   - `idx_note_extractions_kind_state` — accept rate per extraction type,
 *     instrumented from day one because it is the number that says whether
 *     this feature works.
 *   - `idx_work_items_note` — a note's card states what it produced.
 *
 * Idempotent: both tables and every index are `IF NOT EXISTS`, and the one
 * ALTER is column-guarded. No backfill — there is nothing to backfill from.
 */
export function migrateNotes(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'typed',
        source_detail TEXT,
        project_id TEXT,
        audio_path TEXT,
        audio_duration_ms INTEGER,
        transcript TEXT,
        body_is_summary INTEGER NOT NULL DEFAULT 0,
        extraction_state TEXT NOT NULL DEFAULT 'idle',
        last_read_hash TEXT,
        last_read_at INTEGER,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS note_extractions (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        confidence_tier TEXT NOT NULL DEFAULT 'confident',
        reason TEXT,
        state TEXT NOT NULL DEFAULT 'proposed',
        conflict TEXT,
        conflict_resolution TEXT,
        accepted_ref_type TEXT,
        accepted_ref_id TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_notes_occurred_at
        ON notes (occurred_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_notes_project
        ON notes (project_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_notes_extraction_state
        ON notes (extraction_state)
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_note_extractions_note
        ON note_extractions (note_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_note_extractions_state
        ON note_extractions (state, created_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_note_extractions_kind_state
        ON note_extractions (kind, state)
    `);

    if (!tableHasColumn(database, "work_items", "note_id")) {
      raw.exec(/*sql*/ `ALTER TABLE work_items ADD COLUMN note_id TEXT`);
    }
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_items_note
        ON work_items (note_id)
    `);
  });
}
