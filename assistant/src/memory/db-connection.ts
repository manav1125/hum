import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { ensureDataDir, getDbPath, getMemoryDbPath } from "../util/platform.js";
import {
  clearStoredDb,
  clearStoredMemoryDb,
  getStoredDb,
  getStoredMemoryDb,
  setStoredDb,
  setStoredMemoryDb,
} from "./db-singleton.js";
import * as schema from "./schema.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

function canonicalizePathThroughExistingParent(path: string): string {
  const resolvedPath = resolve(path);
  const pendingSegments: string[] = [];
  let currentPath = resolvedPath;

  while (true) {
    try {
      return resolve(realpathSync(currentPath), ...pendingSegments.reverse());
    } catch {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return resolvedPath;
      }
      pendingSegments.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function assertTestDbIsIsolated(): void {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS === "1"
  ) {
    return;
  }

  const workspaceDir = process.env.VELLUM_WORKSPACE_DIR?.trim();
  if (!workspaceDir) {
    throw new Error(
      [
        "Refusing to open the assistant DB during tests without VELLUM_WORKSPACE_DIR.",
        "Run assistant tests from the assistant package so the test preload can isolate state:",
        "  cd assistant && bun test src/path/to/file.test.ts",
      ].join("\n"),
    );
  }

  const resolvedWorkspaceDir =
    canonicalizePathThroughExistingParent(workspaceDir);
  const realWorkspaceDir = canonicalizePathThroughExistingParent(
    process.env.VELLUM_TEST_REAL_WORKSPACE_DIR?.trim() ||
      join(homedir(), ".vellum", "workspace"),
  );
  if (
    resolvedWorkspaceDir === realWorkspaceDir ||
    resolvedWorkspaceDir.startsWith(realWorkspaceDir + sep)
  ) {
    throw new Error(
      [
        "Refusing to open the real assistant workspace DB during tests.",
        `VELLUM_WORKSPACE_DIR resolved to ${resolvedWorkspaceDir}.`,
        "Use a temp workspace for tests instead.",
      ].join("\n"),
    );
  }
}

/**
 * Apply the connection-wide PRAGMAs every assistant SQLite connection runs
 * with. These are per-connection settings, so the dedicated memory
 * connection sets them independently of the main connection. Never add a
 * `wal_checkpoint(TRUNCATE)` here — see "SQLite WAL checkpointing" in
 * assistant/CLAUDE.md.
 */
function applyConnectionPragmas(sqlite: Database): void {
  sqlite.exec("PRAGMA journal_mode=WAL");
  // synchronous=NORMAL under WAL (adopted from upstream 590433ef9c): FULL
  // fsyncs on every commit, which dominates write-heavy conversation/memory
  // paths. Under WAL, NORMAL preserves DB integrity across process/OS crashes
  // and only risks losing the last few committed transactions on a hard power
  // loss — an acceptable trade for this DB (high write volume, low durability
  // stakes; the gateway/trust DB, where a lost commit could reopen a trust
  // gap, stays FULL). A/B-revertable via `CUE_SQLITE_SYNCHRONOUS=FULL`.
  const synchronous =
    process.env.CUE_SQLITE_SYNCHRONOUS?.trim().toUpperCase() === "FULL"
      ? "FULL"
      : "NORMAL";
  sqlite.exec(`PRAGMA synchronous=${synchronous}`);
  sqlite.exec("PRAGMA busy_timeout=5000");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA cache_size=-256000");
  sqlite.exec("PRAGMA temp_store=MEMORY");
  // WAL hygiene (adopted from upstream 50f2f83bcc): cap the WAL file so a write
  // burst can't leave a permanently huge WAL (disk + slow crash-recovery scan).
  // Any WAL reset also truncates the file back to this ceiling. 64 MiB.
  sqlite.exec("PRAGMA journal_size_limit=67108864");
}

export function getDb(): DrizzleDb {
  const existing = getStoredDb<DrizzleDb>();
  if (existing) return existing;

  assertTestDbIsIsolated();
  ensureDataDir();
  const sqlite = new Database(getDbPath());
  applyConnectionPragmas(sqlite);
  const db = drizzle(sqlite, { schema });
  setStoredDb(db, () => sqlite.close());
  return db;
}

/**
 * The dedicated high-churn memory database (`assistant-memory.db`), opened
 * lazily as its OWN long-lived connection — deliberately not `ATTACH`ed to
 * the main connection (adopted from upstream 2b70d1d246): an attached DB
 * shares the main connection's transaction and lock lifecycle, so a memory
 * write burst would keep churning the main DB's WAL and write lock, which is
 * exactly what the split removes.
 *
 * Houses the tables relocated by migrations 324–328: the memory graph
 * cluster, per-conversation activation/graph/retrospective state, memory
 * telemetry logs (recall / v2 activation / v2 injection), the memory-v3
 * shadow tables, and the memory job queue. Cross-database foreign keys do
 * not exist, so cascades from `conversations`/`messages` into these tables
 * are replaced by the explicit cleanup calls in
 * `conversation-memory-cleanup.ts`.
 *
 * Opening only sets PRAGMAs — it never runs DDL. Table/index creation
 * belongs to the relocation migrations, which run at startup before any
 * store touches this connection. Throws when the file cannot be opened
 * (same contract as {@link getDb}); cleanup/purge callers that must never
 * fail a main-DB delete wrap their access in try/catch.
 */
export function getMemoryDb(): DrizzleDb {
  const existing = getStoredMemoryDb<DrizzleDb>();
  if (existing) return existing;

  assertTestDbIsIsolated();
  ensureDataDir();
  const sqlite = new Database(getMemoryDbPath());
  applyConnectionPragmas(sqlite);
  const db = drizzle(sqlite, { schema });
  setStoredMemoryDb(db, () => sqlite.close());
  return db;
}

/**
 * Whether the dedicated memory DB connection is currently open. Lets
 * shutdown paths decide whether to run checkpoint work without lazily
 * opening the very connection being checked for.
 */
export function isMemoryDbOpen(): boolean {
  return getStoredMemoryDb<DrizzleDb>() !== null;
}

/**
 * Get the underlying bun:sqlite Database from the global Drizzle instance.
 *
 * Use this instead of the raw cast `(db as unknown as { $client: Database }).$client`.
 * See raw-query.ts for typed query helpers and guidelines on when raw SQL is appropriate.
 */
export function getSqlite(): Database {
  return getSqliteFrom(getDb());
}

/** Underlying bun:sqlite Database for the dedicated memory connection. */
export function getMemorySqlite(): Database {
  return getSqliteFrom(getMemoryDb());
}

/**
 * Extract the underlying bun:sqlite Database from any Drizzle instance.
 * Useful in migrations and tests that receive the Drizzle instance as a parameter.
 */
export function getSqliteFrom(drizzleDb: DrizzleDb): Database {
  // Drizzle's bun:sqlite adapter stores the raw Database as $client but
  // doesn't expose it in its public type. This is the single canonical
  // location for this cast — all callers should use getSqlite/getSqliteFrom.
  return (drizzleDb as unknown as { $client: Database }).$client;
}

/**
 * Reset the db singletons (main + dedicated memory connection). Used by
 * production callers that need to close the live connections so the files
 * can be replaced (post-migration, post-restore, post-vbundle-import) and
 * on graceful shutdown. Clearing both together means no connection lingers
 * open against a swapped-out file.
 *
 * Tests should use `resetDbForTesting()` from
 * `__tests__/db-test-helpers.ts` instead so they don't depend on this
 * module's heavy import chain (`drizzle-orm/bun-sqlite`).
 */
export function resetDb(): void {
  clearStoredDb();
  clearStoredMemoryDb();
}
