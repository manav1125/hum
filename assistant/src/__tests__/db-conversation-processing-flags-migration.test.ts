import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateConversationProcessingFlags } from "../memory/migrations/310-conversation-processing-flags.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapPreFlagsConversations(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      conversation_type TEXT NOT NULL DEFAULT 'standard',
      source TEXT NOT NULL DEFAULT 'user',
      memory_scope_id TEXT NOT NULL DEFAULT 'default',
      is_auto_title INTEGER NOT NULL DEFAULT 1
    )
  `);
}

function getColumn(raw: Database, name: string) {
  return (
    raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).find((column) => column.name === name);
}

describe("conversation processing-flags migration", () => {
  test("adds a nullable processing_started_at and a NOT NULL processing_resume_attempts defaulting to 0", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPreFlagsConversations(raw);
    migrateConversationProcessingFlags(db);

    const startedAt = getColumn(raw, "processing_started_at");
    expect(startedAt).toBeDefined();
    expect(startedAt?.notnull).toBe(0);

    const attempts = getColumn(raw, "processing_resume_attempts");
    expect(attempts).toBeDefined();
    expect(attempts?.notnull).toBe(1);
    expect(attempts?.dflt_value).toBe("0");
  });

  test("existing rows are undisturbed and default to (NULL, 0)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreFlagsConversations(raw);
    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('conv-existing', 'Existing conversation', ${now}, ${now})
    `);

    migrateConversationProcessingFlags(db);

    const row = raw
      .query(
        `SELECT id, title, processing_started_at, processing_resume_attempts
         FROM conversations WHERE id = 'conv-existing'`,
      )
      .get() as {
      id: string;
      title: string | null;
      processing_started_at: number | null;
      processing_resume_attempts: number;
    } | null;

    expect(row).toEqual({
      id: "conv-existing",
      title: "Existing conversation",
      processing_started_at: null,
      processing_resume_attempts: 0,
    });
  });

  test("re-running the migration is a no-op and preserves stored values", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreFlagsConversations(raw);
    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at)
      VALUES ('conv-rerun', ${now}, ${now})
    `);

    migrateConversationProcessingFlags(db);
    raw.exec(/*sql*/ `
      UPDATE conversations
      SET processing_started_at = ${now}, processing_resume_attempts = 2
      WHERE id = 'conv-rerun'
    `);

    expect(() => migrateConversationProcessingFlags(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT processing_started_at, processing_resume_attempts
         FROM conversations WHERE id = 'conv-rerun'`,
      )
      .get() as {
      processing_started_at: number | null;
      processing_resume_attempts: number;
    } | null;

    expect(row).toEqual({
      processing_started_at: now,
      processing_resume_attempts: 2,
    });
  });

  test("partial application (only processing_started_at present) still adds the counter", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPreFlagsConversations(raw);
    // Simulate a crash between the two ALTER statements.
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN processing_started_at INTEGER`,
    );

    expect(() => migrateConversationProcessingFlags(db)).not.toThrow();

    expect(getColumn(raw, "processing_started_at")).toBeDefined();
    expect(getColumn(raw, "processing_resume_attempts")).toBeDefined();
  });
});
