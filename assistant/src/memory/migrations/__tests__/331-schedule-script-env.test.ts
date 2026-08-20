import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateScheduleScriptEnv } from "../331-schedule-script-env.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/** Just enough of `cron_jobs` for an ALTER to have something to alter. */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      script TEXT
    )
  `);
}

function columns(db: ReturnType<typeof createTestDb>): string[] {
  return (
    getSqliteFrom(db).query(`PRAGMA table_info(cron_jobs)`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe("migration 331 — schedule script env", () => {
  test("adds the script_env_json column", () => {
    const db = createTestDb();
    bootstrap(db);
    expect(columns(db)).not.toContain("script_env_json");
    migrateScheduleScriptEnv(db);
    expect(columns(db)).toContain("script_env_json");
  });

  test("is idempotent — re-running does not throw", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateScheduleScriptEnv(db);
    expect(() => migrateScheduleScriptEnv(db)).not.toThrow();
    expect(columns(db)).toContain("script_env_json");
  });

  test("existing schedules keep working with a null environment", () => {
    // No backfill: a schedule written before this column existed declares no
    // environment, and null is exactly that.
    const db = createTestDb();
    bootstrap(db);
    db.run(
      `INSERT INTO cron_jobs (id, name, script) VALUES ('j1', 'old', 'echo hi')`,
    );
    migrateScheduleScriptEnv(db);
    const row = getSqliteFrom(db)
      .query(`SELECT script_env_json FROM cron_jobs WHERE id='j1'`)
      .get() as { script_env_json: string | null };
    expect(row.script_env_json).toBeNull();
  });
});
