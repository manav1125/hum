import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateRitualSnapshots } from "../330-ritual-snapshots.js";

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

function names(db: ReturnType<typeof createTestDb>, type: string): string[] {
  return (
    getSqliteFrom(db)
      .query(`SELECT name FROM sqlite_master WHERE type='${type}'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("migration 330 — ritual snapshots", () => {
  test("creates the snapshot table and its read-state sibling", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateRitualSnapshots(db);

    const tables = names(db, "table");
    expect(tables).toContain("ritual_snapshots");
    expect(tables).toContain("ritual_snapshot_reads");
  });

  test("the (ritual, period_key) index is UNIQUE — that is what makes the write idempotent", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateRitualSnapshots(db);

    const raw = getSqliteFrom(db);
    const sql = (
      raw
        .query(
          `SELECT sql FROM sqlite_master WHERE name='idx_ritual_snapshots_period'`,
        )
        .get() as { sql: string } | null
    )?.sql;
    expect(sql).toContain("UNIQUE");

    const insert = `INSERT INTO ritual_snapshots
      (id, ritual, period_key, period_start, period_end, composed_at, headline, facts)
      VALUES (?, 'brief', '2026-08-17', 0, 1, 1, 'All quiet overnight.', '{}')`;
    raw.query(insert).run("a");
    // A second compose of the same day must not be able to land.
    expect(() => raw.query(insert).run("b")).toThrow();
  });

  test("read-state is keyed by device, so two devices can disagree", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateRitualSnapshots(db);

    const raw = getSqliteFrom(db);
    const insert = `INSERT INTO ritual_snapshot_reads (snapshot_id, device_id, read_at) VALUES (?, ?, 1)`;
    raw.query(insert).run("brief:2026-08-17", "phone");
    raw.query(insert).run("brief:2026-08-17", "mac");
    expect(
      raw.query(`SELECT count(*) AS n FROM ritual_snapshot_reads`).get(),
    ).toEqual({ n: 2 });
    // The same device reading twice is one row, not two.
    expect(() => raw.query(insert).run("brief:2026-08-17", "phone")).toThrow();
  });

  test("is idempotent", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateRitualSnapshots(db);
    expect(() => migrateRitualSnapshots(db)).not.toThrow();
    expect(
      names(db, "table").filter((n) => n === "ritual_snapshots"),
    ).toHaveLength(1);
  });

  test("BACKFILLS NOTHING — the log starts empty and that is the honest state", () => {
    // Every row this table will ever hold was written by a compose that
    // actually ran. There is no source to reconstruct last Tuesday's brief
    // from, so a migration that inserted anything would be inventing history
    // — the exact bug the interim archive was built to avoid.
    const db = createTestDb();
    bootstrap(db);
    migrateRitualSnapshots(db);
    expect(
      getSqliteFrom(db)
        .query(`SELECT count(*) AS n FROM ritual_snapshots`)
        .get(),
    ).toEqual({ n: 0 });
    expect(
      getSqliteFrom(db)
        .query(`SELECT count(*) AS n FROM ritual_snapshot_reads`)
        .get(),
    ).toEqual({ n: 0 });
  });

  test("does not touch work_items — the stores it reads stay untouched", () => {
    const db = createTestDb();
    bootstrap(db);
    db.run(/*sql*/ `CREATE TABLE work_items (id TEXT PRIMARY KEY)`);
    migrateRitualSnapshots(db);
    const cols = (
      getSqliteFrom(db).query(`PRAGMA table_info(work_items)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(["id"]);
  });
});
