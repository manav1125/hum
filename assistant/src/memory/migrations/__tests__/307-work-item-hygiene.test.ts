import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateWorkItemHygiene } from "../307-work-item-hygiene.js";

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

/**
 * Minimal pre-307 work_items shape (only the columns this migration touches
 * or that the checkpoint machinery needs). Mirrors the sibling migration
 * tests' bootstrap approach.
 */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      project_id TEXT
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

describe("migration 307 — work_items hygiene columns", () => {
  test("adds the three columns with default-preserving semantics", () => {
    const db = createTestDb();
    bootstrap(db);
    db.run(
      /*sql*/ `INSERT INTO work_items (id, title) VALUES ('wi1', 'pre-existing')`,
    );

    migrateWorkItemHygiene(db);

    const raw = getSqliteFrom(db);
    const cols = raw
      .query(`PRAGMA table_info(work_items)`)
      .all() as ColumnRow[];

    const completed = cols.find((c) => c.name === "completed_elsewhere");
    expect(completed).toBeDefined();
    expect(completed!.type).toBe("INTEGER");
    expect(completed!.notnull).toBe(1);

    const filedBy = cols.find((c) => c.name === "auto_filed_by");
    expect(filedBy).toBeDefined();
    expect(filedBy!.type).toBe("TEXT");
    expect(filedBy!.notnull).toBe(0);

    const confidence = cols.find((c) => c.name === "auto_file_confidence");
    expect(confidence).toBeDefined();
    expect(confidence!.type).toBe("REAL");
    expect(confidence!.notnull).toBe(0);

    // Pre-existing rows behave identically: not completed elsewhere, never
    // auto-filed.
    const row = raw
      .query(
        `SELECT completed_elsewhere, auto_filed_by, auto_file_confidence FROM work_items WHERE id = 'wi1'`,
      )
      .get() as {
      completed_elsewhere: number;
      auto_filed_by: string | null;
      auto_file_confidence: number | null;
    };
    expect(row.completed_elsewhere).toBe(0);
    expect(row.auto_filed_by).toBeNull();
    expect(row.auto_file_confidence).toBeNull();
  });

  test("is idempotent — a re-run does not throw or duplicate columns", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateWorkItemHygiene(db);
    migrateWorkItemHygiene(db);
    const cols = getSqliteFrom(db)
      .query(`PRAGMA table_info(work_items)`)
      .all() as ColumnRow[];
    for (const name of [
      "completed_elsewhere",
      "auto_filed_by",
      "auto_file_confidence",
    ]) {
      expect(cols.filter((c) => c.name === name)).toHaveLength(1);
    }
  });

  test("partial prior state — only the missing columns are added", () => {
    const db = createTestDb();
    bootstrap(db);
    // Simulate a crash between ALTERs: the first column already exists.
    db.run(
      /*sql*/ `ALTER TABLE work_items ADD COLUMN completed_elsewhere INTEGER NOT NULL DEFAULT 0`,
    );

    migrateWorkItemHygiene(db);

    const cols = getSqliteFrom(db)
      .query(`PRAGMA table_info(work_items)`)
      .all() as ColumnRow[];
    expect(cols.filter((c) => c.name === "completed_elsewhere")).toHaveLength(
      1,
    );
    expect(cols.some((c) => c.name === "auto_filed_by")).toBe(true);
    expect(cols.some((c) => c.name === "auto_file_confidence")).toBe(true);
  });
});
