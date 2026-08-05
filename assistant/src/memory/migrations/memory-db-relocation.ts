/**
 * Relocation engine for moving memory-subsystem tables out of the main
 * `assistant.db` and into the dedicated `assistant-memory.db` (design port
 * of upstream vellum-assistant's memory-DB cutover — 342929dfba,
 * b593de8041, 2b70d1d246 — onto our step-list migration runner).
 *
 * Each relocation migration (324–328) owns a list of {@link RelocatedTableSpec}s
 * and calls {@link runMemoryDbRelocation}. The engine:
 *
 *   1. Ensures the table schemas exist on the dedicated memory connection
 *      (`CREATE … IF NOT EXISTS`; the connection itself never runs DDL on
 *      open). Cross-database foreign keys do not exist, so `REFERENCES
 *      conversations(id) ON DELETE CASCADE` clauses are dropped from the
 *      memory-side DDL — replaced by the explicit cleanup calls in
 *      `conversation-memory-cleanup.ts` — while intra-cluster cascades
 *      (memory graph edges/triggers/edits → nodes) are recreated verbatim
 *      because the whole cluster moves together.
 *   2. Copies rows from `main.<table>` into the memory DB in bounded
 *      batches via a temporary `ATTACH` on the daemon's own connection.
 *      ATTACH is used ONLY here, inside the startup migration, for the
 *      one-time `INSERT … SELECT` copy; runtime access always goes through
 *      the dedicated connection (upstream 2b70d1d246's rationale).
 *      Batches are keyed by rowid range and each batch is a single
 *      autocommitted statement, so no giant transaction pins the write
 *      lock. `INSERT OR IGNORE` makes a re-run after a crash mid-copy
 *      converge instead of failing on duplicate keys.
 *   3. Verifies the copy: every `(spec.columns)` tuple in the main table
 *      must exist in the memory table (`EXCEPT` anti-join must be empty)
 *      and the memory table must hold at least as many rows. On any
 *      mismatch the step throws — nothing is dropped, and the runner
 *      retries on the next boot.
 *   4. Records completion in the `memory_db_relocations` marker table
 *      inside the memory DB, then drops the main-side tables
 *      (children-first so main-DB FK enforcement never trips).
 *
 * Idempotency / re-run matrix (the step runs on EVERY boot, after the
 * legacy `CREATE TABLE IF NOT EXISTS` creator migrations, which recreate
 * empty main-side shadows each boot):
 *
 *   - main table absent                       → nothing to do (fresh DB
 *     post-drop, or a workspace born after the cutover).
 *   - main table empty                        → drop it (freshly recreated
 *     shadow, or a fresh workspace's just-created table).
 *   - main table non-empty                    → copy + verify + mark + drop
 *     (first cutover, resumed crash mid-copy, or rows a stale binary wrote
 *     into a shadow — all three converge through `INSERT OR IGNORE`).
 *
 * WAL rule: nothing here checkpoints. The copy runs on the daemon's own
 * long-lived connection; the memory DB's WAL is bounded by
 * `journal_size_limit` and autocheckpoint. Never add a
 * `wal_checkpoint(TRUNCATE)` to this path (assistant/CLAUDE.md).
 */

import type { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import { getMemoryDbPath } from "../../util/platform.js";
import {
  type DrizzleDb,
  getMemorySqlite,
  getSqliteFrom,
} from "../db-connection.js";

const log = getLogger("memory-db-relocation");

/** Marker table (inside the memory DB) recording completed relocations. */
export const MEMORY_RELOCATION_MARKER_TABLE = "memory_db_relocations";

/** Rows copied per batch. Bounds each statement's lock-hold time. */
const COPY_BATCH_ROWS = 10_000;

/** Alias the memory DB is attached under for the duration of one copy. */
const ATTACH_ALIAS = "cue_memdb_reloc";

export interface RelocatedTableSpec {
  /** Unqualified table name (same on both sides). */
  table: string;
  /**
   * Columns to copy, listed explicitly (never `SELECT *`) so the copy is
   * insensitive to main-side physical column order left by historical
   * `ALTER TABLE … ADD COLUMN` migrations. A column absent from a legacy
   * main table copies as NULL.
   */
  columns: string[];
  /**
   * DDL creating this table (and its indexes) on the memory connection.
   * Must be idempotent (`IF NOT EXISTS`). This is the schema of record for
   * the memory side — fresh workspaces get their tables from here, not
   * from the legacy main-DB creator migrations.
   */
  createSql: string;
}

function ensureMarkerTable(mem: Database): void {
  mem.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS ${MEMORY_RELOCATION_MARKER_TABLE} (
      table_name TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL
    )
  `);
}

/** Whether the marker table says `table` finished relocating. */
export function isRelocationComplete(mem: Database, table: string): boolean {
  ensureMarkerTable(mem);
  return (
    mem
      .query(
        `SELECT table_name FROM ${MEMORY_RELOCATION_MARKER_TABLE} WHERE table_name = ?`,
      )
      .get(table) != null
  );
}

function markRelocationComplete(mem: Database, table: string): void {
  mem
    .query(
      `INSERT OR REPLACE INTO ${MEMORY_RELOCATION_MARKER_TABLE} (table_name, completed_at) VALUES (?, ?)`,
    )
    .run(table, Date.now());
}

function tableExistsInMain(raw: Database, name: string): boolean {
  return (
    raw
      .query(
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(name) != null
  );
}

function mainTableIsEmpty(raw: Database, name: string): boolean {
  // EXISTS short-circuits at the first row — no full COUNT scan.
  return raw.query(`SELECT 1 FROM main."${name}" LIMIT 1`).get() == null;
}

function mainColumns(raw: Database, name: string): Set<string> {
  return new Set(
    (
      raw
        .query(`SELECT name FROM pragma_table_info('${name}', 'main')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Copy every row of `main.<table>` into the attached memory DB in bounded
 * rowid-ranged batches. Returns the number of batches run. `INSERT OR
 * IGNORE` keys convergence on the destination's primary keys, so resumed
 * or repeated runs are no-ops for already-copied rows.
 */
function copyTable(raw: Database, spec: RelocatedTableSpec): number {
  const present = mainColumns(raw, spec.table);
  const colList = spec.columns.map(quoteIdent).join(", ");
  const selectList = spec.columns
    .map((c) => (present.has(c) ? quoteIdent(c) : `NULL AS ${quoteIdent(c)}`))
    .join(", ");
  const t = quoteIdent(spec.table);

  let lastRowid = 0;
  let batches = 0;
  for (;;) {
    const page = raw
      .query(
        `SELECT max(rowid) AS m, count(*) AS c FROM (
           SELECT rowid FROM main.${t} WHERE rowid > ? ORDER BY rowid LIMIT ?
         )`,
      )
      .get(lastRowid, COPY_BATCH_ROWS) as { m: number | null; c: number };
    if (!page || page.c === 0 || page.m == null) break;

    raw
      .query(
        `INSERT OR IGNORE INTO ${ATTACH_ALIAS}.${t} (${colList})
         SELECT ${selectList} FROM main.${t}
         WHERE rowid > ? AND rowid <= ?`,
      )
      .run(lastRowid, page.m);
    lastRowid = page.m;
    batches++;
  }
  return batches;
}

/**
 * Throw unless every `(spec.columns)` tuple in the main table exists in
 * the memory-side copy. Runs while the memory DB is attached.
 */
function verifyCopy(raw: Database, spec: RelocatedTableSpec): void {
  const t = quoteIdent(spec.table);
  const cols = spec.columns.map(quoteIdent).join(", ");
  const missing = (
    raw
      .query(
        `SELECT count(*) AS c FROM (
           SELECT ${cols} FROM main.${t}
           EXCEPT
           SELECT ${cols} FROM ${ATTACH_ALIAS}.${t}
         )`,
      )
      .get() as { c: number }
  ).c;
  if (missing > 0) {
    throw new Error(
      `memory-db relocation verification failed for "${spec.table}": ` +
        `${missing} source row(s) missing from the memory copy`,
    );
  }
  const mainCount = (
    raw.query(`SELECT count(*) AS c FROM main.${t}`).get() as { c: number }
  ).c;
  const memCount = (
    raw.query(`SELECT count(*) AS c FROM ${ATTACH_ALIAS}.${t}`).get() as {
      c: number;
    }
  ).c;
  if (memCount < mainCount) {
    throw new Error(
      `memory-db relocation verification failed for "${spec.table}": ` +
        `memory copy has ${memCount} rows, main has ${mainCount}`,
    );
  }
}

/**
 * Run one relocation unit end to end. `specs` must list parent tables
 * before the tables that reference them (copy order); drops run in reverse
 * (children first) so main-DB FK enforcement never blocks a parent drop.
 *
 * Synchronous by design: it runs inside the startup step-list migration
 * pass, which is already a blocking phase — no live traffic contends with
 * it. Throws on any failure BEFORE anything is dropped, so the step is
 * reported failed and retried next boot with the main tables intact.
 */
export function runMemoryDbRelocation(
  database: DrizzleDb,
  specs: RelocatedTableSpec[],
): void {
  const mem = getMemorySqlite();
  ensureMarkerTable(mem);
  for (const spec of specs) {
    mem.exec(spec.createSql);
  }

  const raw = getSqliteFrom(database);
  const mainSide = specs.filter((s) => tableExistsInMain(raw, s.table));
  if (mainSide.length === 0) {
    // Nothing on the main side: fresh workspace whose creators no longer
    // ran, or a fully cut-over DB. Mark complete so downstream consumers
    // (and the idempotency tests) can observe the finished state.
    for (const spec of specs) {
      if (!isRelocationComplete(mem, spec.table)) {
        markRelocationComplete(mem, spec.table);
      }
    }
    return;
  }

  const nonEmpty = mainSide.filter((s) => !mainTableIsEmpty(raw, s.table));

  if (nonEmpty.length > 0) {
    // Attach the memory DB to the daemon's own connection just long enough
    // for the batched INSERT…SELECT copies, then detach. Runtime access
    // never uses ATTACH.
    const escapedPath = getMemoryDbPath().replace(/'/g, "''");
    raw.exec(`ATTACH DATABASE '${escapedPath}' AS ${ATTACH_ALIAS}`);
    try {
      for (const spec of nonEmpty) {
        const batches = copyTable(raw, spec);
        verifyCopy(raw, spec);
        log.info(
          { table: spec.table, batches },
          "memory-db relocation: table copied and verified",
        );
      }
    } finally {
      try {
        raw.exec(`DETACH DATABASE ${ATTACH_ALIAS}`);
      } catch {
        /* already detached */
      }
    }
  }

  // Copy verified (or nothing to copy) — record completion, then drop the
  // main-side tables children-first. A crash between marker and drop just
  // means the next boot re-copies (INSERT OR IGNORE no-ops) and drops.
  for (const spec of mainSide) {
    markRelocationComplete(mem, spec.table);
  }
  for (const spec of [...mainSide].reverse()) {
    raw.exec(`DROP TABLE main.${quoteIdent(spec.table)}`);
  }
  log.info(
    { tables: mainSide.map((s) => s.table) },
    "memory-db relocation: main-side tables dropped",
  );
}
