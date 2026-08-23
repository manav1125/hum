import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateNotes } from "../332-notes.js";

interface ColumnRow {
  name: string;
}

interface IndexRow {
  name: string;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/** Minimal pre-332 shape, plus the checkpoint table crash recovery needs. */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    )
  `);
}

function columns(db: ReturnType<typeof createTestDb>, table: string): string[] {
  return (
    getSqliteFrom(db).query(`PRAGMA table_info(${table})`).all() as ColumnRow[]
  ).map((c) => c.name);
}

function indexes(db: ReturnType<typeof createTestDb>, table: string): string[] {
  return (
    getSqliteFrom(db).query(`PRAGMA index_list(${table})`).all() as IndexRow[]
  ).map((i) => i.name);
}

describe("332-notes", () => {
  test("creates both tables", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateNotes(db);

    expect(columns(db, "notes")).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "body",
        "source",
        "project_id",
        "audio_path",
        "transcript",
        "body_is_summary",
        "extraction_state",
        "last_read_hash",
        "occurred_at",
      ]),
    );
    expect(columns(db, "note_extractions")).toEqual(
      expect.arrayContaining([
        "note_id",
        "kind",
        "payload",
        "confidence_tier",
        "reason",
        "state",
        "conflict",
        "conflict_resolution",
        "accepted_ref_type",
        "accepted_ref_id",
        "decided_at",
      ]),
    );
  });

  test("adds work_items.note_id — the one-way provenance link", () => {
    const db = createTestDb();
    bootstrap(db);
    expect(columns(db, "work_items")).not.toContain("note_id");

    migrateNotes(db);
    expect(columns(db, "work_items")).toContain("note_id");
    expect(indexes(db, "work_items")).toContain("idx_work_items_note");
  });

  test("carries no foreign key, so deleting a note cannot delete work", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateNotes(db);

    const fks = getSqliteFrom(db)
      .query(`PRAGMA foreign_key_list(note_extractions)`)
      .all();
    expect(fks).toEqual([]);

    // The link the other way is reference-by-convention too: a dangling
    // note_id on a work item is the intended end state after a delete.
    const workItemFks = getSqliteFrom(db)
      .query(`PRAGMA foreign_key_list(work_items)`)
      .all();
    expect(workItemFks).toEqual([]);
  });

  test("indexes the reads the destination actually makes", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateNotes(db);

    expect(indexes(db, "notes")).toEqual(
      expect.arrayContaining([
        "idx_notes_occurred_at",
        "idx_notes_project",
        "idx_notes_extraction_state",
      ]),
    );
    expect(indexes(db, "note_extractions")).toEqual(
      expect.arrayContaining([
        "idx_note_extractions_note",
        // "Waiting on you", and accept rate per kind — the number that says
        // whether the feature works.
        "idx_note_extractions_state",
        "idx_note_extractions_kind_state",
      ]),
    );
  });

  test("is idempotent, and keeps rows written between runs", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateNotes(db);

    db.run(
      `INSERT INTO notes (id, title, body, source, body_is_summary,
                          extraction_state, occurred_at, created_at, updated_at)
       VALUES ('n1', 'Walking to the office', 'Do not lead with price.',
               'voice', 0, 'idle', 1, 1, 1)`,
    );

    expect(() => migrateNotes(db)).not.toThrow();
    const rows = getSqliteFrom(db).query(`SELECT id FROM notes`).all();
    expect(rows).toHaveLength(1);
  });
});
