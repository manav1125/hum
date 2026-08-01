import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateWorkItemLifeLensAndWaiting } from "../317-work-item-life-lens-and-waiting.js";

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

/** Minimal pre-317 shape, plus the checkpoint table crash recovery needs. */
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

const T0 = 1_785_000_000_000;

function seedItem(
  db: ReturnType<typeof createTestDb>,
  id: string,
  createdAt = T0,
): void {
  getSqliteFrom(db).run(
    /*sql*/ `INSERT INTO work_items (id, task_id, title, created_at) VALUES (?, ?, ?, ?)`,
    [id, `task-${id}`, `item ${id}`, createdAt],
  );
}

function columns(db: ReturnType<typeof createTestDb>): ColumnRow[] {
  return getSqliteFrom(db)
    .query(`PRAGMA table_info(work_items)`)
    .all() as ColumnRow[];
}

function indexNames(db: ReturnType<typeof createTestDb>): string[] {
  return (
    getSqliteFrom(db).query(`PRAGMA index_list(work_items)`).all() as Array<{
      name: string;
    }>
  ).map((i) => i.name);
}

describe("migration 317 — life lens + waiting columns", () => {
  test("adds all four columns with the right nullability", () => {
    const db = createTestDb();
    bootstrap(db);

    migrateWorkItemLifeLensAndWaiting(db);

    const byName = new Map(columns(db).map((c) => [c.name, c]));

    const domain = byName.get("domain");
    expect(domain).toBeDefined();
    expect(domain!.type).toBe("TEXT");
    // NOT NULL with a constant default is what makes the backfill automatic.
    expect(domain!.notnull).toBe(1);
    expect(domain!.dflt_value).toBe("'work'");

    for (const [name, type] of [
      ["horizon", "TEXT"],
      ["waiting_on", "TEXT"],
      ["last_chased_at", "INTEGER"],
    ] as const) {
      const col = byName.get(name);
      expect(col).toBeDefined();
      expect(col!.type).toBe(type);
      expect(col!.notnull).toBe(0);
    }

    const indexes = indexNames(db);
    expect(indexes).toContain("idx_work_items_domain");
    expect(indexes).toContain("idx_work_items_waiting_on");
  });

  test('every pre-existing row becomes domain="work" — nothing drifts into Life', () => {
    // The Life boundary is a privacy boundary: a queue item that silently
    // became personal would be hidden by "hide Life" (or dropped from a
    // work-only export) without anybody deciding that.
    const db = createTestDb();
    bootstrap(db);
    seedItem(db, "wi-1");
    seedItem(db, "wi-2");
    seedItem(db, "wi-3");

    migrateWorkItemLifeLensAndWaiting(db);

    const rows = getSqliteFrom(db)
      .query(
        `SELECT id, domain, horizon, waiting_on, last_chased_at FROM work_items`,
      )
      .all() as Array<{
      id: string;
      domain: string;
      horizon: string | null;
      waiting_on: string | null;
      last_chased_at: number | null;
    }>;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.domain).toBe("work");
      // The other three stay unset: an item nobody marked reads as before.
      expect(row.horizon).toBeNull();
      expect(row.waiting_on).toBeNull();
      expect(row.last_chased_at).toBeNull();
    }
  });

  test("a row inserted without a domain still lands as work", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateWorkItemLifeLensAndWaiting(db);

    // Exactly what an un-updated writer (an older daemon, a raw INSERT) does.
    seedItem(db, "wi-legacy-writer");

    const domain = (
      getSqliteFrom(db)
        .query(
          `SELECT domain AS d FROM work_items WHERE id = 'wi-legacy-writer'`,
        )
        .get() as { d: string }
    ).d;
    expect(domain).toBe("work");
  });

  test("re-running is a no-op and never rewrites a stamped lens", () => {
    const db = createTestDb();
    bootstrap(db);
    seedItem(db, "wi-life");

    migrateWorkItemLifeLensAndWaiting(db);
    getSqliteFrom(db).run(
      `UPDATE work_items SET domain = 'life', horizon = 'someday', waiting_on = 'contact-rachel', last_chased_at = ${T0} WHERE id = 'wi-life'`,
    );
    // Clear the checkpoint so the body genuinely re-runs (the crash-recovery
    // path after an interrupted migration).
    getSqliteFrom(db).run(`DELETE FROM memory_checkpoints`);
    migrateWorkItemLifeLensAndWaiting(db);

    const row = getSqliteFrom(db)
      .query(
        `SELECT domain, horizon, waiting_on, last_chased_at AS chased FROM work_items WHERE id = 'wi-life'`,
      )
      .get() as {
      domain: string;
      horizon: string;
      waiting_on: string;
      chased: number;
    };
    expect(row.domain).toBe("life");
    expect(row.horizon).toBe("someday");
    expect(row.waiting_on).toBe("contact-rachel");
    expect(row.chased).toBe(T0);
  });

  test("repairs a nullable domain left by a partially-applied attempt", () => {
    // If the column exists but nullable (an interrupted hand-patch), the
    // guarded ALTER is skipped and the default never fires — the explicit
    // backfill is what still guarantees "no row is domain-less".
    const db = createTestDb();
    bootstrap(db);
    getSqliteFrom(db).exec(`ALTER TABLE work_items ADD COLUMN domain TEXT`);
    seedItem(db, "wi-orphan");

    migrateWorkItemLifeLensAndWaiting(db);

    const domain = (
      getSqliteFrom(db)
        .query(`SELECT domain AS d FROM work_items WHERE id = 'wi-orphan'`)
        .get() as { d: string }
    ).d;
    expect(domain).toBe("work");
  });
});
