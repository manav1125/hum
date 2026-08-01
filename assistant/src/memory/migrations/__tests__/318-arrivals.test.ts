import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateArrivals } from "../318-arrivals.js";

interface ColumnRow {
  name: string;
}

interface IndexRow {
  name: string;
  unique: number;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/** Minimal pre-318 shape, plus the checkpoint table crash recovery needs. */
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

function workItemColumns(db: ReturnType<typeof createTestDb>): string[] {
  return (
    getSqliteFrom(db)
      .query(`PRAGMA table_info(work_items)`)
      .all() as ColumnRow[]
  ).map((c) => c.name);
}

function arrivalIndexes(db: ReturnType<typeof createTestDb>): IndexRow[] {
  return getSqliteFrom(db)
    .query(`PRAGMA index_list(arrivals)`)
    .all() as IndexRow[];
}

describe("318 — arrivals", () => {
  test("creates the arrivals table and the work-item back-link", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateArrivals(db);

    const tables = getSqliteFrom(db)
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .all("arrivals") as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(workItemColumns(db)).toContain("arrival_id");
  });

  test("(channel, external_id) is UNIQUE so a replayed poll cannot double-count", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateArrivals(db);

    const unique = arrivalIndexes(db).filter((i) => i.unique === 1);
    expect(unique.map((i) => i.name)).toContain(
      "idx_arrivals_channel_external",
    );

    const raw = getSqliteFrom(db);
    const insert = (id: string) =>
      raw.run(
        /*sql*/ `INSERT INTO arrivals
          (id, channel, external_id, title, disposition, decided_by, created_at, updated_at)
          VALUES (?, 'watcher:gmail', 'msg-1', 't', 'filed', 'rule', 1, 1)`,
        [id],
      );
    insert("a-1");
    expect(() => insert("a-2")).toThrow();
  });

  test("the read indexes the summary and the filed list need are present", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateArrivals(db);

    const names = arrivalIndexes(db).map((i) => i.name);
    expect(names).toContain("idx_arrivals_created_at");
    expect(names).toContain("idx_arrivals_disposition_created_at");
    expect(names).toContain("idx_arrivals_sender");

    const workItemIndexes = getSqliteFrom(db)
      .query(`PRAGMA index_list(work_items)`)
      .all() as IndexRow[];
    expect(workItemIndexes.map((i) => i.name)).toContain(
      "idx_work_items_arrival",
    );
  });

  test("is idempotent and preserves rows across a re-run", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateArrivals(db);

    const raw = getSqliteFrom(db);
    raw.run(/*sql*/ `INSERT INTO arrivals
        (id, channel, external_id, title, disposition, reason, decided_by, created_at, updated_at)
        VALUES ('a-1', 'watcher:gmail', 'msg-1', 'Digest', 'filed', 'newsletter from Stripe', 'rule', 1, 1)`);

    expect(() => migrateArrivals(db)).not.toThrow();

    const rows = raw.query(`SELECT reason FROM arrivals`).all() as Array<{
      reason: string;
    }>;
    expect(rows).toEqual([{ reason: "newsletter from Stripe" }]);
    expect(workItemColumns(db)).toContain("arrival_id");
  });

  test("existing work items read exactly as before — arrival_id is null", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);
    raw.run(/*sql*/ `INSERT INTO work_items (id, task_id, title, created_at)
        VALUES ('wi-1', 'task-1', 'pre-318 item', 1)`);

    migrateArrivals(db);

    const row = raw
      .query(`SELECT arrival_id FROM work_items WHERE id = 'wi-1'`)
      .get() as { arrival_id: string | null };
    expect(row.arrival_id).toBeNull();
  });
});
