import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateVolumeValve } from "../323-volume-valve.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/** The checkpoint table crash recovery needs. Nothing else is a prerequisite. */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    )
  `);
}

function tableNames(db: ReturnType<typeof createTestDb>): string[] {
  return (
    getSqliteFrom(db)
      .query(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexNames(db: ReturnType<typeof createTestDb>): string[] {
  return (
    getSqliteFrom(db)
      .query(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("migration 323 — the volume valve", () => {
  test("creates the three tables", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateVolumeValve(db);

    const tables = tableNames(db);
    expect(tables).toContain("valve_bands");
    expect(tables).toContain("valve_stops");
    expect(tables).toContain("valve_feedback");
  });

  test("creates the rule-distribution index, which the health read depends on", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateVolumeValve(db);
    expect(indexNames(db)).toContain("idx_valve_bands_rule");
  });

  test("is idempotent", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateVolumeValve(db);
    expect(() => migrateVolumeValve(db)).not.toThrow();
    expect(tableNames(db).filter((n) => n === "valve_bands")).toHaveLength(1);
  });

  test("BACKFILLS NOTHING — an empty bands table is a valve wide open", () => {
    // The fail-open guarantee is structural and starts here. A work item with
    // no band row reads as urgent, so shipping this migration must leave every
    // existing item exactly as loud as it was. A backfill added later would
    // silently quiet work nobody decided about.
    const db = createTestDb();
    bootstrap(db);
    migrateVolumeValve(db);
    expect(
      getSqliteFrom(db).query(`SELECT count(*) AS n FROM valve_bands`).get(),
    ).toEqual({ n: 0 });
    expect(
      getSqliteFrom(db).query(`SELECT count(*) AS n FROM valve_stops`).get(),
    ).toEqual({ n: 0 });
  });

  test("does not touch arrivals or work_items", () => {
    // The valve reads the gate's verdict; it never rewrites it. If this
    // migration ever grew an ALTER against either table, the record of what
    // came in and why would stop being independent of how loud Cue thinks it
    // is — and the two must be separable to stay auditable.
    const db = createTestDb();
    bootstrap(db);
    db.run(/*sql*/ `CREATE TABLE arrivals (id TEXT PRIMARY KEY)`);
    db.run(/*sql*/ `CREATE TABLE work_items (id TEXT PRIMARY KEY)`);

    migrateVolumeValve(db);

    const arrivalCols = getSqliteFrom(db)
      .query(`PRAGMA table_info(arrivals)`)
      .all() as Array<{ name: string }>;
    const itemCols = getSqliteFrom(db)
      .query(`PRAGMA table_info(work_items)`)
      .all() as Array<{ name: string }>;
    expect(arrivalCols.map((c) => c.name)).toEqual(["id"]);
    expect(itemCols.map((c) => c.name)).toEqual(["id"]);
  });

  test("the feedback table keeps both directions of correction", () => {
    // `dismissed` alone would make a sender the owner contradicted themselves
    // about indistinguishable from one they consistently dismissed.
    const db = createTestDb();
    bootstrap(db);
    migrateVolumeValve(db);
    const cols = (
      getSqliteFrom(db)
        .query(`PRAGMA table_info(valve_feedback)`)
        .all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("dismissed");
    expect(cols).toContain("kept");
  });
});
