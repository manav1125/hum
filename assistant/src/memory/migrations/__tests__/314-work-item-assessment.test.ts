import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateWorkItemAssessment } from "../314-work-item-assessment.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/** Minimal pre-314 shape of the two tables this migration touches. */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
    )
  `);
  db.run(/*sql*/ `
    CREATE TABLE work_item_events (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL
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

function columns(
  db: ReturnType<typeof createTestDb>,
  table: string,
): ColumnRow[] {
  return getSqliteFrom(db)
    .query(`PRAGMA table_info(${table})`)
    .all() as ColumnRow[];
}

describe("migration 314 — pre-run assessment columns", () => {
  test("adds the assessment columns, all nullable", () => {
    const db = createTestDb();
    bootstrap(db);
    db.run(
      /*sql*/ `INSERT INTO work_items (id, title) VALUES ('wi1', 'pre-existing')`,
    );

    migrateWorkItemAssessment(db);

    const cols = columns(db, "work_items");
    const expected = [
      ["assessment_verdict", "TEXT"],
      ["assessment_understanding", "TEXT"],
      ["assessment_plan", "TEXT"],
      ["assessment_question", "TEXT"],
      ["assessment_missing", "TEXT"],
      ["assessment_confidence", "REAL"],
      ["assessment_input_hash", "TEXT"],
      ["assessment_at", "INTEGER"],
    ];
    for (const [name, type] of expected) {
      const col = cols.find((c) => c.name === name);
      expect(col, `missing column ${name}`).toBeTruthy();
      expect(col!.type).toBe(type);
      // Nullable with no default: a never-assessed item reads as "unassessed",
      // which is exactly the pre-314 behaviour.
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBeNull();
    }
  });

  test("pre-existing rows survive with null verdicts", () => {
    const db = createTestDb();
    bootstrap(db);
    db.run(
      /*sql*/ `INSERT INTO work_items (id, title) VALUES ('wi1', 'pre-existing')`,
    );

    migrateWorkItemAssessment(db);

    const row = getSqliteFrom(db)
      .query(
        `SELECT title, assessment_verdict FROM work_items WHERE id = 'wi1'`,
      )
      .get() as { title: string; assessment_verdict: string | null };
    expect(row.title).toBe("pre-existing");
    expect(row.assessment_verdict).toBeNull();
  });

  test("adds the trail narration column", () => {
    const db = createTestDb();
    bootstrap(db);

    migrateWorkItemAssessment(db);

    const detail = columns(db, "work_item_events").find(
      (c) => c.name === "detail",
    );
    expect(detail).toBeTruthy();
    expect(detail!.type).toBe("TEXT");
    expect(detail!.notnull).toBe(0);
  });

  test("is idempotent", () => {
    const db = createTestDb();
    bootstrap(db);

    migrateWorkItemAssessment(db);
    migrateWorkItemAssessment(db);

    expect(
      columns(db, "work_items").filter((c) => c.name === "assessment_verdict"),
    ).toHaveLength(1);
    expect(
      columns(db, "work_item_events").filter((c) => c.name === "detail"),
    ).toHaveLength(1);
  });
});
