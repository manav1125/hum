import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateWorkItemOriginConversation } from "../315-work-item-origin-conversation.js";

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
 * Minimal pre-315 shape: the two columns the backfill joins on, plus the
 * checkpoint table the crash-recovery wrapper needs.
 */
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
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_from_conversation_id TEXT,
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

const T0 = 1_784_729_200_000;

function seedTask(
  db: ReturnType<typeof createTestDb>,
  id: string,
  conversationId: string | null,
  createdAt = T0,
): void {
  getSqliteFrom(db).run(
    /*sql*/ `INSERT INTO tasks (id, title, created_from_conversation_id, created_at) VALUES (?, ?, ?, ?)`,
    [id, `task ${id}`, conversationId, createdAt],
  );
}

function seedItem(
  db: ReturnType<typeof createTestDb>,
  id: string,
  taskId: string,
  createdAt = T0,
): void {
  getSqliteFrom(db).run(
    /*sql*/ `INSERT INTO work_items (id, task_id, title, created_at) VALUES (?, ?, ?, ?)`,
    [id, taskId, `item ${id}`, createdAt],
  );
}

function originOf(
  db: ReturnType<typeof createTestDb>,
  id: string,
): string | null {
  return (
    getSqliteFrom(db)
      .query(`SELECT origin_conversation_id AS o FROM work_items WHERE id = ?`)
      .get(id) as { o: string | null }
  ).o;
}

describe("migration 315 — work_items origin_conversation_id", () => {
  test("adds the nullable TEXT column and its index", () => {
    const db = createTestDb();
    bootstrap(db);

    migrateWorkItemOriginConversation(db);

    const raw = getSqliteFrom(db);
    const col = (
      raw.query(`PRAGMA table_info(work_items)`).all() as ColumnRow[]
    ).find((c) => c.name === "origin_conversation_id");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);

    const indexes = raw
      .query(`PRAGMA index_list(work_items)`)
      .all() as Array<{ name: string }>;
    expect(
      indexes.some((i) => i.name === "idx_work_items_origin_conversation_id"),
    ).toBe(true);
  });

  test("backfills the link for an item minted alongside its own task", () => {
    // This is the shape of the two real items that lost the link: a voice
    // commitment minted a lightweight template and its work item in one call.
    const db = createTestDb();
    bootstrap(db);
    seedTask(db, "task-cafes", "conv-voice-1", T0);
    seedItem(db, "wi-cafes", "task-cafes", T0 + 12);

    migrateWorkItemOriginConversation(db);

    expect(originOf(db, "wi-cafes")).toBe("conv-voice-1");
  });

  test("leaves a REUSED template's items unlinked rather than guessing", () => {
    // `createTask` is idempotent on (normalized title, template), and saved
    // templates are run many times. The task's conversation names whoever
    // defined it FIRST — attributing every item to that thread would be a lie,
    // so an ambiguous template is skipped entirely.
    const db = createTestDb();
    bootstrap(db);
    seedTask(db, "task-shared", "conv-a", T0);
    seedItem(db, "wi-1", "task-shared", T0 + 5);
    seedItem(db, "wi-2", "task-shared", T0 + 9);

    migrateWorkItemOriginConversation(db);

    expect(originOf(db, "wi-1")).toBeNull();
    expect(originOf(db, "wi-2")).toBeNull();
  });

  test("leaves an item queued long after its template unlinked", () => {
    const db = createTestDb();
    bootstrap(db);
    seedTask(db, "task-old", "conv-a", T0);
    seedItem(db, "wi-late", "task-old", T0 + 10 * 60_000);

    migrateWorkItemOriginConversation(db);

    expect(originOf(db, "wi-late")).toBeNull();
  });

  test("a task with no source conversation leaves its item null", () => {
    const db = createTestDb();
    bootstrap(db);
    seedTask(db, "task-cli", null, T0);
    seedItem(db, "wi-cli", "task-cli", T0);

    migrateWorkItemOriginConversation(db);

    expect(originOf(db, "wi-cli")).toBeNull();
  });

  test("idempotent, and never overwrites a link already recorded", () => {
    const db = createTestDb();
    bootstrap(db);
    seedTask(db, "task-cafes", "conv-voice-1", T0);
    seedItem(db, "wi-cafes", "task-cafes", T0);

    migrateWorkItemOriginConversation(db);
    // Simulate a later, authoritative write from the runtime write path.
    getSqliteFrom(db).run(
      `UPDATE work_items SET origin_conversation_id = 'conv-authoritative' WHERE id = 'wi-cafes'`,
    );
    // Clear the checkpoint so the migration body genuinely re-runs.
    getSqliteFrom(db).run(`DELETE FROM memory_checkpoints`);
    migrateWorkItemOriginConversation(db);

    expect(originOf(db, "wi-cafes")).toBe("conv-authoritative");
  });
});
