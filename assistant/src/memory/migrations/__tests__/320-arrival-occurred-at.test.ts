import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateArrivalOccurredAt } from "../320-arrival-occurred-at.js";

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

/** Minimal pre-320 shape, plus the checkpoint table crash recovery needs. */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE arrivals (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      sender_address TEXT,
      disposition TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(/*sql*/ `
    CREATE TABLE watcher_events (
      id TEXT PRIMARY KEY,
      watcher_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'pending',
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

const T0 = 1_785_000_000_000;

function columns(
  db: ReturnType<typeof createTestDb>,
  table: string,
): ColumnRow[] {
  return getSqliteFrom(db)
    .query(`PRAGMA table_info(${table})`)
    .all() as ColumnRow[];
}

function seedArrival(
  db: ReturnType<typeof createTestDb>,
  id: string,
  createdAt = T0,
): void {
  getSqliteFrom(db).run(
    /*sql*/ `INSERT INTO arrivals
      (id, channel, external_id, title, sender_address, disposition, decided_by, created_at, updated_at)
      VALUES (?, 'watcher:gmail', ?, ?, 'person@example.com', 'surfaced', 'rule', ?, ?)`,
    [id, `ext-${id}`, `subject ${id}`, createdAt, createdAt],
  );
}

describe("migration 320 — arrival occurred_at", () => {
  test("adds occurred_at to both tables", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateArrivalOccurredAt(db);

    for (const table of ["arrivals", "watcher_events"]) {
      const col = columns(db, table).find((c) => c.name === "occurred_at");
      expect(col).toBeDefined();
      expect(col?.type).toBe("INTEGER");
      // Nullable, and with no default: "unknown" has to stay expressible.
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
  });

  test("creates the per-sender event-order index", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateArrivalOccurredAt(db);

    const indexes = (
      getSqliteFrom(db).query(`PRAGMA index_list(arrivals)`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_arrivals_sender_occurred_at");
  });

  /**
   * The whole point of the column. Backfilling `occurred_at` from `created_at`
   * would be the original bug wearing a new name — every pre-320 row would
   * assert an event time it never had, and it would assert the ONE value that
   * is systematically wrong (the moment Cue caught up, not the moment anybody
   * wrote).
   */
  test("leaves existing rows null rather than backfilling from created_at", () => {
    const db = createTestDb();
    bootstrap(db);
    seedArrival(db, "a1");
    seedArrival(db, "a2", T0 + 60_000);
    migrateArrivalOccurredAt(db);

    const rows = getSqliteFrom(db)
      .query(`SELECT id, occurred_at, created_at FROM arrivals ORDER BY id`)
      .all() as Array<{
      id: string;
      occurred_at: number | null;
      created_at: number;
    }>;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.occurred_at).toBeNull();
      expect(row.occurred_at).not.toBe(row.created_at);
    }
  });

  test("is idempotent and preserves values written between runs", () => {
    const db = createTestDb();
    bootstrap(db);
    seedArrival(db, "a1");
    migrateArrivalOccurredAt(db);

    getSqliteFrom(db).run(
      /*sql*/ `UPDATE arrivals SET occurred_at = ${T0 - 86_400_000} WHERE id = 'a1'`,
    );

    // A re-run (crash recovery, a fresh daemon boot) must not clobber it.
    expect(() => {
      migrateArrivalOccurredAt(db);
    }).not.toThrow();

    const row = getSqliteFrom(db)
      .query(`SELECT occurred_at FROM arrivals WHERE id = 'a1'`)
      .get() as { occurred_at: number | null };
    expect(row.occurred_at).toBe(T0 - 86_400_000);

    expect(
      columns(db, "arrivals").filter((c) => c.name === "occurred_at"),
    ).toHaveLength(1);
  });
});
