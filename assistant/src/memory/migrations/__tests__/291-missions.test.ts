import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../../schema.js";
import { migrateCreateMissions } from "../291-missions.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // `withCrashRecovery` reads/writes a `memory_checkpoints` table — seed a
  // minimal version so the migration can run without the full db-init boot.
  sqlite.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Pre-291 projects shape (no mission_id).
  sqlite.exec(/*sql*/ `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function tableNames(sqlite: Database): string[] {
  return (
    sqlite
      .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function columnNames(sqlite: Database, table: string): string[] {
  return (
    sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

describe("migration 291: missions harness core", () => {
  test("creates the missions, company_profile, mission_events, and fingerprint tables", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateMissions(db);

    const tables = tableNames(sqlite);
    expect(tables).toContain("missions");
    expect(tables).toContain("company_profile");
    expect(tables).toContain("mission_events");
    expect(tables).toContain("mission_plan_fingerprints");

    expect(columnNames(sqlite, "missions")).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "outcome",
        "metric",
        "horizon",
        "status",
        "mode",
        "brief",
        "cadence",
        "budget_cents",
        "spent_cents",
        "continuation_summary",
        "pinned",
        "sort_index",
        "last_cycle_at",
        "created_at",
        "updated_at",
      ]),
    );
    expect(columnNames(sqlite, "company_profile")).toEqual(
      expect.arrayContaining([
        "id",
        "identity",
        "direction",
        "never_lines",
        "workspace_mode",
      ]),
    );
  });

  test("adds a nullable mission_id column to projects and preserves rows", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO projects (id, title, created_at, updated_at)
      VALUES ('p1', 'Launch', 1000, 1000)
    `);

    migrateCreateMissions(db);

    const cols = sqlite.query(`PRAGMA table_info(projects)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const missionId = cols.find((c) => c.name === "mission_id");
    expect(missionId).toBeDefined();
    expect(missionId?.notnull).toBe(0);

    const row = sqlite
      .query(`SELECT mission_id FROM projects WHERE id = 'p1'`)
      .get() as { mission_id: string | null };
    expect(row.mission_id).toBeNull();
  });

  test("mission_plan_fingerprints enforces exact-once via the primary key", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateMissions(db);

    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO mission_plan_fingerprints (fingerprint, mission_id, at) VALUES (?, ?, ?)`,
    );
    expect(insert.run("m1:abc", "m1", 1).changes).toBe(1);
    expect(insert.run("m1:abc", "m1", 2).changes).toBe(0);
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateMissions(db);
    // withCrashRecovery marks the checkpoint done; a second run must not throw
    // even when the checkpoint is cleared (structural statements are IF NOT
    // EXISTS / guarded).
    sqlite.exec(`DELETE FROM memory_checkpoints`);
    expect(() => migrateCreateMissions(db)).not.toThrow();
    expect(
      columnNames(sqlite, "projects").filter((n) => n === "mission_id"),
    ).toHaveLength(1);
  });
});
