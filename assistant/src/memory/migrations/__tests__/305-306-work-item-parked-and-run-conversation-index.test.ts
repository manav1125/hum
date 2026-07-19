import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateWorkItemAutoRunEligibility } from "../305-work-item-auto-run-eligibility.js";
import { migrateWorkItemsRunConversationIndex } from "../306-work-items-run-conversation-index.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/**
 * Minimal pre-305 work_items shape (only the columns these migrations touch
 * or that the checkpoint machinery needs). Mirrors the sibling migration
 * tests' bootstrap approach — no full 108-tasks-and-work-items setup.
 */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      last_run_conversation_id TEXT
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

describe("migration 305 — work_items auto_run_eligibility", () => {
  test("adds the nullable TEXT column; existing rows read NULL (eligible)", () => {
    const db = createTestDb();
    bootstrap(db);
    db.run(
      /*sql*/ `INSERT INTO work_items (id, title) VALUES ('wi1', 'pre-existing')`,
    );

    migrateWorkItemAutoRunEligibility(db);

    const raw = getSqliteFrom(db);
    const cols = raw
      .query(`PRAGMA table_info(work_items)`)
      .all() as ColumnRow[];
    const col = cols.find((c) => c.name === "auto_run_eligibility");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);

    const row = raw
      .query(`SELECT auto_run_eligibility FROM work_items WHERE id = 'wi1'`)
      .get() as { auto_run_eligibility: string | null };
    expect(row.auto_run_eligibility).toBeNull();
  });

  test("is idempotent — a re-run does not throw or duplicate the column", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateWorkItemAutoRunEligibility(db);
    migrateWorkItemAutoRunEligibility(db);
    const cols = getSqliteFrom(db)
      .query(`PRAGMA table_info(work_items)`)
      .all() as ColumnRow[];
    expect(cols.filter((c) => c.name === "auto_run_eligibility")).toHaveLength(
      1,
    );
  });
});

describe("migration 306 — work_items last_run_conversation_id index", () => {
  test("creates the index and stays idempotent", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateWorkItemsRunConversationIndex(db);
    migrateWorkItemsRunConversationIndex(db);

    const raw = getSqliteFrom(db);
    const indexes = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='work_items'`,
      )
      .all() as Array<{ name: string }>;
    expect(
      indexes.filter(
        (i) => i.name === "idx_work_items_last_run_conversation_id",
      ),
    ).toHaveLength(1);

    // The point-lookup shape used by checkpoint-enforcement / guardrails now
    // seeks instead of scanning.
    const plan = raw
      .query(
        `EXPLAIN QUERY PLAN SELECT id FROM work_items WHERE last_run_conversation_id = 'c1'`,
      )
      .all() as Array<{ detail: string }>;
    expect(
      plan.some((p) =>
        p.detail.includes("idx_work_items_last_run_conversation_id"),
      ),
    ).toBe(true);
  });
});
