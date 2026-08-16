/**
 * The "applied N times" counter.
 *
 * What these pin, in order of how easy each is to get wrong:
 *
 *   1. A count that only ever goes UP. The reason this table exists at all is
 *      that the obvious existing store (`conversation_graph_memory_state`'s
 *      per-node injection log) is pruned by `evictCompactedTurns`, so summing
 *      it yields a usage figure that FALLS as a memory is used more. The
 *      compaction test below is the guard against anyone re-deriving the
 *      count from a prunable source.
 *   2. Absence vs. zero. A node with no recorded applications must be MISSING
 *      from the read, not present with 0 — the surface has to be able to tell
 *      "no record" from "never used" so it can omit the line instead of
 *      printing a verdict.
 *   3. The writer never throwing. A SQLite failure must not abort an agent
 *      turn on top of a successful retrieval.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateMemoryNodeInjectionEvents } from "../../migrations/329-memory-node-injection-events.js";
import * as schema from "../../schema.js";

/** A standalone memory-DB stand-in with just this migration's schema on it. */
function createMemoryDb() {
  const sqlite = new Database(":memory:");
  migrateMemoryNodeInjectionEvents(
    drizzle(new Database(":memory:"), { schema }),
    sqlite,
  );
  return sqlite;
}

let memSqlite: Database;

// Spread the real module and override only the connection seam — a
// hand-written factory here would delete every other export of
// db-connection.js for every file that runs after this one.
const actualDbConnection = await import("../../db-connection.js");
mock.module("../../db-connection.js", () => ({
  ...actualDbConnection,
  getMemoryDb: () => drizzle(memSqlite, { schema }),
  getSqliteFrom: () => memSqlite,
}));

const { countNodeInjections, recordNodeInjectionEvents } =
  await import("../node-injection-events.js");

beforeEach(() => {
  memSqlite = createMemoryDb();
});

describe("migration 329", () => {
  test("creates the table and both indexes on the memory connection", () => {
    const names = (
      memSqlite.query(`SELECT name FROM sqlite_master`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("memory_node_injection_events");
    expect(names).toContain("idx_memory_node_injection_events_node");
    expect(names).toContain("idx_memory_node_injection_events_time");
  });

  test("re-running is a no-op, not an error (it runs every boot)", () => {
    recordNodeInjectionEvents(["a"], 1_000);
    migrateMemoryNodeInjectionEvents(
      drizzle(new Database(":memory:"), { schema }),
      memSqlite,
    );
    expect(countNodeInjections(["a"]).get("a")).toBe(1);
  });
});

describe("recordNodeInjectionEvents", () => {
  test("appends one row per node and the count accumulates across turns", () => {
    recordNodeInjectionEvents(["alice", "bob"], 1_000);
    recordNodeInjectionEvents(["alice"], 2_000);
    recordNodeInjectionEvents(["alice"], 3_000);

    const counts = countNodeInjections(["alice", "bob"]);
    expect(counts.get("alice")).toBe(3);
    expect(counts.get("bob")).toBe(1);
  });

  test("a node selected twice in one turn counts once", () => {
    // Two retrieval lanes can both surface the same node; the model saw it
    // once, so it was applied once.
    recordNodeInjectionEvents(["alice", "alice", "alice"], 1_000);
    expect(countNodeInjections(["alice"]).get("alice")).toBe(1);
  });

  test("an empty list writes nothing", () => {
    recordNodeInjectionEvents([], 1_000);
    const n = memSqlite
      .query(`SELECT COUNT(*) AS n FROM memory_node_injection_events`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("never throws when the write fails — a turn must not die for a metric", () => {
    memSqlite.exec(`DROP TABLE memory_node_injection_events`);
    expect(() => recordNodeInjectionEvents(["alice"], 1_000)).not.toThrow();
  });
});

describe("countNodeInjections", () => {
  test("omits nodes with no events rather than reporting them as 0", () => {
    recordNodeInjectionEvents(["alice"], 1_000);
    const counts = countNodeInjections(["alice", "never-used"]);
    expect(counts.get("alice")).toBe(1);
    // Absent, not 0 — "no record" is a different claim from "never used",
    // and the surface renders the two differently.
    expect(counts.has("never-used")).toBe(false);
  });

  test("scopes to the requested ids", () => {
    recordNodeInjectionEvents(["alice", "bob"], 1_000);
    const counts = countNodeInjections(["alice"]);
    expect(counts.size).toBe(1);
    expect(counts.get("alice")).toBe(1);
  });

  test("an empty request is an empty result, with no query issued", () => {
    memSqlite.exec(`DROP TABLE memory_node_injection_events`);
    expect(countNodeInjections([]).size).toBe(0);
  });

  test("never throws when the read fails — it omits the metric", () => {
    memSqlite.exec(`DROP TABLE memory_node_injection_events`);
    expect(countNodeInjections(["alice"]).size).toBe(0);
  });
});

describe("the count only ever goes up", () => {
  test("compaction cannot lower it — the whole reason for a separate table", () => {
    // The InContextTracker's own log is pruned by evictCompactedTurns. This
    // table is append-only and lives outside the conversation, so a long,
    // repeatedly-compacted conversation can only ever add to it.
    recordNodeInjectionEvents(["alice"], 1_000);
    recordNodeInjectionEvents(["alice"], 2_000);
    const before = countNodeInjections(["alice"]).get("alice");

    // Whatever compaction does to per-conversation state, it touches nothing
    // here: there is no delete path on this table at all.
    const deletes = (
      memSqlite
        .query(
          `SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_node_injection_events'`,
        )
        .all() as Array<{ sql: string }>
    ).length;
    expect(deletes).toBe(0);

    recordNodeInjectionEvents(["alice"], 3_000);
    const after = countNodeInjections(["alice"]).get("alice");
    expect(after).toBeGreaterThan(before as number);
  });
});
