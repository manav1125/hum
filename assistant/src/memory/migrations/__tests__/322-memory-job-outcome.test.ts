import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateMemoryJobOutcome } from "../322-memory-job-outcome.js";

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

/** Minimal pre-322 shape, plus the checkpoint table crash recovery needs. */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE memory_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      deferrals INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      last_error TEXT,
      started_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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

const T0 = 1_785_000_000_000;

function columns(db: ReturnType<typeof createTestDb>): ColumnRow[] {
  return getSqliteFrom(db)
    .query(`PRAGMA table_info(memory_jobs)`)
    .all() as ColumnRow[];
}

function seedCompletedJob(
  db: ReturnType<typeof createTestDb>,
  id: string,
  type = "contact_memory_extract",
): void {
  getSqliteFrom(db).run(
    /*sql*/ `INSERT INTO memory_jobs
      (id, type, payload, status, run_after, created_at, updated_at)
      VALUES (?, ?, '{}', 'completed', ?, ?, ?)`,
    [id, type, T0, T0, T0],
  );
}

describe("migration 322 — memory job outcome", () => {
  test("adds the three outcome columns", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateMemoryJobOutcome(db);

    const expected: Array<[string, string]> = [
      ["outcome", "TEXT"],
      ["produced_count", "INTEGER"],
      ["outcome_reason", "TEXT"],
    ];
    for (const [name, type] of expected) {
      const col = columns(db).find((c) => c.name === name);
      expect(col).toBeDefined();
      expect(col?.type).toBe(type);
      // Nullable, no default: "this row never said" has to stay expressible.
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
  });

  test("leaves `status` alone — every existing reader branches on it", () => {
    const db = createTestDb();
    bootstrap(db);
    seedCompletedJob(db, "j1");
    migrateMemoryJobOutcome(db);

    const row = getSqliteFrom(db)
      .query(`SELECT status FROM memory_jobs WHERE id = 'j1'`)
      .get() as { status: string };
    expect(row.status).toBe("completed");

    const statusCol = columns(db).find((c) => c.name === "status");
    expect(statusCol?.notnull).toBe(1);
  });

  test("creates the type-by-outcome index the question actually asks", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateMemoryJobOutcome(db);

    const indexes = (
      getSqliteFrom(db).query(`PRAGMA index_list(memory_jobs)`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_memory_jobs_type_outcome");
  });

  /**
   * The whole point of the column. Backfilling old rows to 'produced' would
   * assert work that was never evidenced — the original bug with a new column
   * name — and backfilling to 'empty' would invent a run of failures out of
   * rows we cannot speak for.
   */
  test("leaves existing rows NULL rather than claiming either answer", () => {
    const db = createTestDb();
    bootstrap(db);
    seedCompletedJob(db, "j1");
    seedCompletedJob(db, "j2", "graph_extract");
    migrateMemoryJobOutcome(db);

    const rows = getSqliteFrom(db)
      .query(`SELECT id, outcome, produced_count FROM memory_jobs ORDER BY id`)
      .all() as Array<{
      id: string;
      outcome: string | null;
      produced_count: number | null;
    }>;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.outcome).toBeNull();
      // Not 0 — "never said" is a different fact from "produced nothing".
      expect(row.produced_count).toBeNull();
    }
  });

  test("is idempotent", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateMemoryJobOutcome(db);
    expect(() => migrateMemoryJobOutcome(db)).not.toThrow();
    expect(columns(db).filter((c) => c.name === "outcome")).toHaveLength(1);
  });
});
