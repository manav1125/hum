import type { Database } from "bun:sqlite";

import type { DrizzleDb } from "../db-connection.js";
import { getMemorySqlite } from "../db-connection.js";

/**
 * Migration 329 — `memory_node_injection_events`, an append-only
 * `(node_id, injected_at)` log of every time a memory graph node was
 * actually put in front of the model.
 *
 * This is what backs "applied N times" on the Memory surface. The surface
 * lists `memory_graph_nodes`, so the count is keyed by graph node id — the
 * identity the reader can see — rather than by v2 concept-page slug, which
 * is a different id space with no join to it.
 *
 * ## Why a new table and not the state we already persist
 *
 * `conversation_graph_memory_state` durably persists the `InContextTracker`
 * snapshot, and that snapshot carries `log: { nodeId, turn }[]`. It looks
 * exactly like the store this needs and it is not: it is a per-conversation
 * JSON blob rewritten every turn, and `InContextTracker.evictCompactedTurns`
 * DELETES entries from it when context compacts. Summing it across
 * conversations yields a usage count that falls as a memory gets used more.
 * Do not build on it.
 *
 * `memory_v2_injection_events` (256) is the right shape but the wrong id
 * space — concept-page slugs — and is deliberately a 3-day-half-life routing
 * signal, not a lifetime counter. This table is the lifetime counter, and it
 * is separate on purpose so a future prune of one never silently truncates
 * the other.
 *
 * ## Which database
 *
 * The memory DB (`assistant-memory.db`). Migrations 324–328 moved the whole
 * memory cluster — `memory_graph_nodes` included (325) — out of the main DB,
 * so this table sits beside the rows it counts and the read is a plain
 * same-connection query.
 *
 * Because it is a NEW table rather than a relocation, the DDL runs
 * unconditionally on every boot instead of behind a `memory_checkpoints`
 * entry. That checkpoint lives in the MAIN db; recording completion there
 * while the schema lives in a separate file would mean a restored or
 * re-imported memory DB never gets the table back. The relocation engine
 * re-runs its `CREATE … IF NOT EXISTS` every boot for the same reason.
 *
 * ## No foreign key, no conversation cleanup
 *
 * Cross-database foreign keys do not exist, and within the memory DB a node
 * is never hard-deleted in normal operation — `deleteNode` sets
 * `fidelity = 'gone'`. A forgotten memory keeps its history; it simply stops
 * being listed. Like `memory_v2_injection_events`, this log is node-keyed
 * rather than conversation-keyed, so it is not part of the
 * conversation-delete sweep in `conversation-memory-cleanup.ts`.
 *
 * ## No backfill, deliberately
 *
 * There is no honest source to backfill from — see the two rejected stores
 * above. Every existing node therefore starts at zero, and a zero renders as
 * NOTHING on the surface, never as "applied 0 times". A count that began
 * yesterday must not read as a verdict that the memory is useless.
 *
 * Indexes: `(node_id)` for the per-node count (the hot path — one grouped
 * read per listed page), and `(injected_at)` for time-range pruning later.
 */
export function migrateMemoryNodeInjectionEvents(
  _database: DrizzleDb,
  mem: Database = getMemorySqlite(),
): void {
  mem.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_node_injection_events (
      id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL,
      injected_at INTEGER NOT NULL
    )
  `);
  mem.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_node_injection_events_node
      ON memory_node_injection_events (node_id)
  `);
  mem.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_node_injection_events_time
      ON memory_node_injection_events (injected_at)
  `);
}

export function downMemoryNodeInjectionEvents(
  _database: DrizzleDb,
  mem: Database = getMemorySqlite(),
): void {
  mem.exec(/*sql*/ `DROP TABLE IF EXISTS memory_node_injection_events`);
}
