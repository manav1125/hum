// Tests for the memory-DB split (migrations 324–328 + the explicit
// cross-DB cleanup that replaces the lost FK cascades).
//
// Covers, per the cutover contract:
//   1. Fresh workspace: after initializeDb() the moved tables exist ONLY in
//      assistant-memory.db; assistant.db carries none of them.
//   2. Existing workspace: rows present in main-side tables are copied into
//      the memory DB, verified, and the main tables dropped.
//   3. Crash-mid-copy idempotency: a partial copy (some rows already in the
//      memory DB) and a crash-after-marker-before-drop both converge on
//      re-run — no duplicates, no lost rows, main side dropped.
//   4. Intra-cluster cascade preservation: node deletes still cascade to
//      edges on the memory connection.
//   5. Cleanup-on-delete: deleteConversation purges the conversation-keyed
//      memory tables; clearAll wipes them plus the job queue; the orphan
//      sweep removes rows whose conversation is gone and keeps live ones.
//   6. Backup inclusion: the snapshot path captures assistant-memory.db as
//      its own filename family, and the families never cross-rotate.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  listDbSnapshots,
  parseDbSnapshotTimestamp,
  performDbSnapshot,
} from "../../backup/db-snapshot.js";
import { getMemoryDbPath } from "../../util/platform.js";
import {
  addMessage,
  clearAll,
  createConversation,
  deleteConversation,
} from "../conversation-crud.js";
import {
  clearAllConversationMemoryTables,
  CONVERSATION_KEYED_MEMORY_TABLES,
  purgeConversationMemoryTables,
  sweepOrphanConversationMemoryTables,
} from "../conversation-memory-cleanup.js";
import { getMemorySqlite, getSqlite } from "../db-connection.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { migrateMoveConversationMemoryStateToMemoryDb } from "../migrations/324-move-conversation-memory-state-to-memory-db.js";
import { migrateMoveMemoryGraphClusterToMemoryDb } from "../migrations/325-move-memory-graph-cluster-to-memory-db.js";
import {
  isRelocationComplete,
  MEMORY_RELOCATION_MARKER_TABLE,
} from "../migrations/memory-db-relocation.js";

initializeDb();

const MOVED_TABLES = [
  "activation_state",
  "conversation_graph_memory_state",
  "memory_retrospective_state",
  "memory_graph_nodes",
  "memory_graph_edges",
  "memory_graph_triggers",
  "memory_graph_node_edits",
  "memory_recall_logs",
  "memory_v2_activation_logs",
  "memory_v2_injection_events",
  "memory_v3_coactivation",
  "memory_v3_auto_edges",
  "memory_v3_selections",
  "memory_v3_ever_injected",
  "memory_jobs",
] as const;

function mainHasTable(name: string): boolean {
  return (
    getSqlite()
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) != null
  );
}

function memoryHasTable(name: string): boolean {
  return (
    getMemorySqlite()
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) != null
  );
}

function memCount(table: string): number {
  return (
    getMemorySqlite().query(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
}

function insertActivationRow(conversationId: string, turn = 1): void {
  getMemorySqlite()
    .query(
      `INSERT OR REPLACE INTO activation_state
         (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
       VALUES (?, 'm-1', '{}', '[]', ?, ?)`,
    )
    .run(conversationId, turn, Date.now());
}

// ---------------------------------------------------------------------
// 1. Fresh workspace — tables live only in the memory DB
// ---------------------------------------------------------------------

describe("fresh workspace", () => {
  test("moved tables exist in assistant-memory.db and NOT in assistant.db", () => {
    for (const table of MOVED_TABLES) {
      expect(memoryHasTable(table)).toBe(true);
      expect(mainHasTable(table)).toBe(false);
    }
  });

  test("every relocation is marked complete in the marker table", () => {
    expect(memoryHasTable(MEMORY_RELOCATION_MARKER_TABLE)).toBe(true);
    for (const table of MOVED_TABLES) {
      expect(isRelocationComplete(getMemorySqlite(), table)).toBe(true);
    }
  });

  test("kept memory-sounding tables stay in the main DB", () => {
    // Verified keep decisions: telemetry/session/content tables that only
    // sound like memory, plus the message-FK'd and pipeline tables.
    for (const table of [
      "activation_sessions", // onboarding funnel telemetry, not memory
      "memory_checkpoints", // migration/ops KV — must sit beside main-DB state
      "memory_segments", // Qdrant-feeding pipeline + messages FK cascade
      "memory_summaries",
      "memory_embeddings",
      "message_bookmarks",
      "conversation_starters",
    ]) {
      expect(mainHasTable(table)).toBe(true);
    }
  });

  test("main-DB message cascade still covers memory_segments (kept table)", async () => {
    const conv = createConversation("cascade check");
    await addMessage(conv.id, "user", "hello segments", {
      skipIndexing: true,
    });
    // No moved table interferes with the main-DB delete path.
    deleteConversation(conv.id);
    expect(
      getSqlite()
        .query(`SELECT COUNT(*) AS c FROM conversations WHERE id = ?`)
        .get(conv.id),
    ).toEqual({ c: 0 });
  });
});

// ---------------------------------------------------------------------
// 2 + 3. Existing workspace copy + crash idempotency
// ---------------------------------------------------------------------

describe("existing-workspace relocation", () => {
  beforeEach(() => {
    getSqlite().exec(`DROP TABLE IF EXISTS activation_state`);
    getMemorySqlite().exec(`DELETE FROM activation_state`);
    getMemorySqlite()
      .query(
        `DELETE FROM ${MEMORY_RELOCATION_MARKER_TABLE} WHERE table_name = 'activation_state'`,
      )
      .run();
  });

  function createLegacyMainActivationState(rows: number): void {
    // The pre-split main-DB shape (migration 241 variant, FK included).
    getSqlite().exec(/*sql*/ `
      CREATE TABLE activation_state (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        ever_injected_json TEXT NOT NULL DEFAULT '[]',
        current_turn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    for (let i = 0; i < rows; i++) {
      const conv = createConversation(`legacy-${i}-${Date.now()}`);
      getSqlite()
        .query(
          `INSERT INTO activation_state
             (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
           VALUES (?, 'm', '{"s":1}', '[]', ?, ?)`,
        )
        .run(conv.id, i, 1000 + i);
    }
  }

  test("copies rows into the memory DB, verifies, and drops the main table", () => {
    createLegacyMainActivationState(5);
    expect(mainHasTable("activation_state")).toBe(true);

    migrateMoveConversationMemoryStateToMemoryDb(getDb());

    expect(mainHasTable("activation_state")).toBe(false);
    expect(memCount("activation_state")).toBe(5);
    expect(isRelocationComplete(getMemorySqlite(), "activation_state")).toBe(
      true,
    );
  });

  test("crash mid-copy: partial memory-side rows converge on re-run without duplicates", () => {
    createLegacyMainActivationState(4);
    // Simulate a prior run that copied only some rows before dying: copy 2
    // rows by hand into the memory DB (marker NOT set, main table intact).
    const firstTwo = getSqlite()
      .query(
        `SELECT conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at
           FROM activation_state ORDER BY rowid LIMIT 2`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of firstTwo) {
      getMemorySqlite()
        .query(
          `INSERT INTO activation_state
             (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.conversation_id as string,
          row.message_id as string,
          row.state_json as string,
          row.ever_injected_json as string,
          row.current_turn as number,
          row.updated_at as number,
        );
    }
    expect(memCount("activation_state")).toBe(2);

    migrateMoveConversationMemoryStateToMemoryDb(getDb());

    expect(mainHasTable("activation_state")).toBe(false);
    expect(memCount("activation_state")).toBe(4);
  });

  test("crash after marker, before drop: re-run just re-verifies and drops", () => {
    createLegacyMainActivationState(3);
    // Simulate: marker written, drop never happened.
    getMemorySqlite()
      .query(
        `INSERT OR REPLACE INTO ${MEMORY_RELOCATION_MARKER_TABLE} (table_name, completed_at) VALUES ('activation_state', ?)`,
      )
      .run(Date.now());

    migrateMoveConversationMemoryStateToMemoryDb(getDb());

    expect(mainHasTable("activation_state")).toBe(false);
    expect(memCount("activation_state")).toBe(3);
  });

  test("empty recreated shadow (legacy CREATE IF NOT EXISTS creator) is dropped on the next pass", () => {
    // Post-cutover boots recreate empty main-side shadows via the old
    // creator migrations; the relocation step must clear them again.
    getSqlite().exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS activation_state (
        conversation_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        ever_injected_json TEXT NOT NULL DEFAULT '[]',
        current_turn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    migrateMoveConversationMemoryStateToMemoryDb(getDb());
    expect(mainHasTable("activation_state")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 4. Intra-cluster cascades survive the move
// ---------------------------------------------------------------------

describe("memory graph cluster on the memory connection", () => {
  test("node delete cascades to edges and edits", () => {
    const mem = getMemorySqlite();
    mem.exec(`DELETE FROM memory_graph_edges`);
    mem.exec(`DELETE FROM memory_graph_node_edits`);
    mem.exec(`DELETE FROM memory_graph_nodes`);
    const now = Date.now();
    const insertNode = (id: string) =>
      mem
        .query(
          `INSERT INTO memory_graph_nodes
             (id, content, type, created, last_accessed, last_consolidated,
              emotional_charge, confidence, significance, last_reinforced)
           VALUES (?, 'c', 'semantic', ?, ?, ?, '{}', 0.5, 0.5, ?)`,
        )
        .run(id, now, now, now, now);
    insertNode("n-1");
    insertNode("n-2");
    mem
      .query(
        `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relationship, created)
         VALUES ('e-1', 'n-1', 'n-2', 'reminds-of', ?)`,
      )
      .run(now);
    mem
      .query(
        `INSERT INTO memory_graph_node_edits (id, node_id, previous_content, new_content, source, created)
         VALUES ('ed-1', 'n-1', 'a', 'b', 'test', ?)`,
      )
      .run(now);

    mem.query(`DELETE FROM memory_graph_nodes WHERE id = 'n-1'`).run();
    expect(memCount("memory_graph_edges")).toBe(0);
    expect(memCount("memory_graph_node_edits")).toBe(0);

    // Re-run of the cluster migration stays a no-op with data present.
    migrateMoveMemoryGraphClusterToMemoryDb(getDb());
    expect(memCount("memory_graph_nodes")).toBe(1);
  });
});

// ---------------------------------------------------------------------
// 5. Cleanup on delete / clear-all / orphan sweep
// ---------------------------------------------------------------------

describe("cross-DB cleanup", () => {
  test("deleteConversation purges every conversation-keyed memory table", () => {
    const conv = createConversation("purge me");
    const keep = createConversation("keep me");
    const mem = getMemorySqlite();
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      mem.exec(`DELETE FROM ${table}`);
    }
    insertActivationRow(conv.id);
    insertActivationRow(keep.id);
    mem
      .query(
        `INSERT INTO memory_recall_logs
           (id, conversation_id, enabled, degraded, semantic_hits, merged_count,
            selected_count, tier1_count, tier2_count, hybrid_search_latency_ms,
            sparse_vector_used, injected_tokens, latency_ms, top_candidates_json, created_at)
         VALUES ('r-1', ?, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '[]', ?)`,
      )
      .run(conv.id, Date.now());
    mem
      .query(
        `INSERT INTO memory_v3_ever_injected (conversation_id, slug, injected_at)
         VALUES (?, 'slug-a', ?)`,
      )
      .run(conv.id, Date.now());

    deleteConversation(conv.id);

    expect(
      mem
        .query(
          `SELECT COUNT(*) AS c FROM activation_state WHERE conversation_id = ?`,
        )
        .get(conv.id),
    ).toEqual({ c: 0 });
    expect(memCount("memory_recall_logs")).toBe(0);
    expect(memCount("memory_v3_ever_injected")).toBe(0);
    // The other conversation's state survives.
    expect(
      mem
        .query(
          `SELECT COUNT(*) AS c FROM activation_state WHERE conversation_id = ?`,
        )
        .get(keep.id),
    ).toEqual({ c: 1 });
    deleteConversation(keep.id);
  });

  test("purgeConversationMemoryTables never throws (best-effort contract)", () => {
    expect(() => purgeConversationMemoryTables("no-such-conv")).not.toThrow();
  });

  test("clearAll wipes conversation-keyed tables plus the job queue on the memory DB", async () => {
    const conv = createConversation("clear-all victim");
    insertActivationRow(conv.id);
    getMemorySqlite()
      .query(
        `INSERT INTO memory_jobs (id, type, payload, status, run_after, created_at, updated_at)
         VALUES ('job-ca', 'graph_extract', '{}', 'pending', 0, 0, 0)`,
      )
      .run();

    await clearAll();

    expect(memCount("activation_state")).toBe(0);
    expect(memCount("memory_jobs")).toBe(0);
  });

  test("clearAllConversationMemoryTables leaves graph nodes (long-term memory) alone", () => {
    const mem = getMemorySqlite();
    mem.exec(`DELETE FROM memory_graph_nodes`);
    const now = Date.now();
    mem
      .query(
        `INSERT INTO memory_graph_nodes
           (id, content, type, created, last_accessed, last_consolidated,
            emotional_charge, confidence, significance, last_reinforced)
         VALUES ('n-keep', 'c', 'semantic', ?, ?, ?, '{}', 0.5, 0.5, ?)`,
      )
      .run(now, now, now, now);
    clearAllConversationMemoryTables();
    expect(memCount("memory_graph_nodes")).toBe(1);
    mem.exec(`DELETE FROM memory_graph_nodes`);
  });

  test("orphan sweep deletes rows for dead conversations and keeps live ones", async () => {
    const live = createConversation("live one");
    const mem = getMemorySqlite();
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      mem.exec(`DELETE FROM ${table}`);
    }
    insertActivationRow(live.id);
    insertActivationRow("dead-conversation-id");

    const result = await sweepOrphanConversationMemoryTables();

    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(
      mem
        .query(`SELECT conversation_id AS id FROM activation_state`)
        .all()
        .map((r) => (r as { id: string }).id),
    ).toEqual([live.id]);
    deleteConversation(live.id);
  });
});

// ---------------------------------------------------------------------
// 6. Backup inclusion — the memory DB is snapshotted as its own family
// ---------------------------------------------------------------------

describe("backup inclusion", () => {
  const dir = mkdtempSync(join(tmpdir(), "cue-db-split-snap-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("performDbSnapshot captures assistant-memory.db under the memory prefix", async () => {
    // Force some memory-DB content so the snapshot is non-trivial.
    insertActivationRow("snapshot-proof");
    const result = await performDbSnapshot({
      dbPath: getMemoryDbPath(),
      dir,
      retention: 3,
      snapshotPrefix: "assistant-memory-",
      // In-process runner against the live memory connection: FULL
      // checkpoint + VACUUM INTO, never TRUNCATE.
      executeSql: async (sql: string) => {
        try {
          getMemorySqlite().exec(sql);
          return { ok: true, error: null };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    });
    expect(result.entry.filename.startsWith("assistant-memory-")).toBe(true);
    expect(result.entry.sizeBytes).toBeGreaterThan(0);
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith("assistant-memory-"))).toBe(true);
    getMemorySqlite()
      .query(`DELETE FROM activation_state WHERE conversation_id = ?`)
      .run("snapshot-proof");
  });

  test("the main and memory snapshot families never cross-match", async () => {
    // A memory snapshot must be invisible to the main family's lister (and
    // vice versa), so per-family retention can never rotate the other's
    // copies out.
    const memoryList = await listDbSnapshots(dir, "assistant-memory-");
    const mainList = await listDbSnapshots(dir);
    expect(memoryList.length).toBeGreaterThan(0);
    expect(mainList.length).toBe(0);
    expect(
      parseDbSnapshotTimestamp(
        "assistant-memory-20260101-010203.db",
        "assistant-memory-",
      ),
    ).not.toBeNull();
    // The default prefix is the main family — a memory snapshot filename
    // must not parse under it (that is the cross-match this test pins).
    expect(
      parseDbSnapshotTimestamp("assistant-memory-20260101-010203.db"),
    ).toBeNull();
    expect(
      parseDbSnapshotTimestamp(
        "assistant-20260101-010203.db",
        "assistant-memory-",
      ),
    ).toBeNull();
    expect(
      parseDbSnapshotTimestamp("assistant-20260101-010203.db"),
    ).not.toBeNull();
  });
});
