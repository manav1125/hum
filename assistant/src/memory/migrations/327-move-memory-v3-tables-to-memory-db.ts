import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocatedTableSpec,
  runMemoryDbRelocation,
} from "./memory-db-relocation.js";

/**
 * Migration 327 — move the memory-v3 shadow tables into the dedicated
 * `assistant-memory.db`:
 *
 *   - `memory_v3_coactivation` (262): append-only co-activation pair log
 *     written by the v3 retrieval loop — pure write churn.
 *   - `memory_v3_auto_edges` (263): learned association graph, reinforced
 *     by the edge-learning pass. Slug-keyed, not conversation-keyed.
 *   - `memory_v3_selections` (268): per-turn selection log.
 *   - `memory_v3_ever_injected` (277): per-conversation injection dedup
 *     tracker.
 *
 * None had foreign keys (all conversation/slug columns are plain text).
 * The conversation-keyed three join `CONVERSATION_KEYED_MEMORY_TABLES`
 * for the explicit purge + orphan sweep; `memory_v3_auto_edges` is
 * slug-keyed and only ever pruned by the v3 maintenance job.
 */
const SPECS: RelocatedTableSpec[] = [
  {
    table: "memory_v3_coactivation",
    columns: [
      "id",
      "conversation_id",
      "turn",
      "source_slug",
      "target_slug",
      "pass_gap",
      "used",
      "created_at",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_v3_coactivation (
        id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        source_slug TEXT NOT NULL,
        target_slug TEXT NOT NULL,
        pass_gap INTEGER NOT NULL,
        used INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_v3_coactivation_pair
        ON memory_v3_coactivation (source_slug, target_slug);
      CREATE INDEX IF NOT EXISTS idx_memory_v3_coactivation_time
        ON memory_v3_coactivation (created_at);
    `,
  },
  {
    table: "memory_v3_auto_edges",
    columns: ["source_slug", "target_slug", "weight", "last_reinforced_at"],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_v3_auto_edges (
        source_slug TEXT NOT NULL,
        target_slug TEXT NOT NULL,
        weight REAL NOT NULL,
        last_reinforced_at INTEGER NOT NULL,
        PRIMARY KEY (source_slug, target_slug)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_v3_auto_edges_weight
        ON memory_v3_auto_edges (weight);
    `,
  },
  {
    table: "memory_v3_selections",
    columns: [
      "conversation_id",
      "turn",
      "slug",
      "source",
      "pinned",
      "created_at",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_v3_selections (
        conversation_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        slug TEXT NOT NULL,
        source TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, turn, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_v3_selections_conv
        ON memory_v3_selections (conversation_id, turn DESC);
    `,
  },
  {
    table: "memory_v3_ever_injected",
    columns: ["conversation_id", "slug", "injected_at", "bytes", "pruned_at"],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_v3_ever_injected (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        pruned_at INTEGER,
        PRIMARY KEY (conversation_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_v3_ever_injected_conv
        ON memory_v3_ever_injected (conversation_id);
    `,
  },
];

export function migrateMoveMemoryV3TablesToMemoryDb(database: DrizzleDb): void {
  runMemoryDbRelocation(database, SPECS);
}
