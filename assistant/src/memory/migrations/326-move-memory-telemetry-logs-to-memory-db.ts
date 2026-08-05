import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocatedTableSpec,
  runMemoryDbRelocation,
} from "./memory-db-relocation.js";

/**
 * Migration 326 — move the memory telemetry log tables into the dedicated
 * `assistant-memory.db`:
 *
 *   - `memory_recall_logs` (194, `query_context` added by 211): one row per
 *     recall pass, feeds the inspector memory tab.
 *   - `memory_v2_activation_logs` (234): per-turn v2 activation telemetry —
 *     historically the single largest driver of assistant.db growth
 *     (~100KB+ per row), which is exactly the churn this split removes
 *     from the main DB's WAL.
 *   - `memory_v2_injection_events` (256): slug-keyed injection history for
 *     EMA tier-2 routing. Not conversation-keyed — pruned by time, never
 *     by conversation delete.
 *
 * None of the three had a foreign key (their `conversation_id` /
 * `message_id` columns are plain text), so no cascade is lost; the
 * conversation-keyed two join `CONVERSATION_KEYED_MEMORY_TABLES` for the
 * explicit purge + orphan sweep.
 */
const SPECS: RelocatedTableSpec[] = [
  {
    table: "memory_recall_logs",
    columns: [
      "id",
      "conversation_id",
      "message_id",
      "enabled",
      "degraded",
      "provider",
      "model",
      "degradation_json",
      "semantic_hits",
      "merged_count",
      "selected_count",
      "tier1_count",
      "tier2_count",
      "hybrid_search_latency_ms",
      "sparse_vector_used",
      "injected_tokens",
      "latency_ms",
      "top_candidates_json",
      "injected_text",
      "reason",
      "query_context",
      "created_at",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_recall_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        enabled INTEGER NOT NULL,
        degraded INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        degradation_json TEXT,
        semantic_hits INTEGER NOT NULL,
        merged_count INTEGER NOT NULL,
        selected_count INTEGER NOT NULL,
        tier1_count INTEGER NOT NULL,
        tier2_count INTEGER NOT NULL,
        hybrid_search_latency_ms INTEGER NOT NULL,
        sparse_vector_used INTEGER NOT NULL,
        injected_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        top_candidates_json TEXT NOT NULL,
        injected_text TEXT,
        reason TEXT,
        query_context TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_recall_logs_message_id
        ON memory_recall_logs (message_id);
      CREATE INDEX IF NOT EXISTS idx_memory_recall_logs_conversation_id
        ON memory_recall_logs (conversation_id);
    `,
  },
  {
    table: "memory_v2_activation_logs",
    columns: [
      "id",
      "conversation_id",
      "message_id",
      "turn",
      "mode",
      "concepts_json",
      "skills_json",
      "config_json",
      "created_at",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_v2_activation_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        turn INTEGER NOT NULL,
        mode TEXT NOT NULL,
        concepts_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_message_id
        ON memory_v2_activation_logs (message_id);
      CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_conversation_id
        ON memory_v2_activation_logs (conversation_id);
      CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_created_at
        ON memory_v2_activation_logs (created_at);
    `,
  },
  {
    table: "memory_v2_injection_events",
    columns: ["id", "slug", "injected_at"],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_v2_injection_events (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL,
        injected_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_v2_injection_events_slug_time
        ON memory_v2_injection_events (slug, injected_at);
      CREATE INDEX IF NOT EXISTS idx_memory_v2_injection_events_time
        ON memory_v2_injection_events (injected_at);
    `,
  },
];

export function migrateMoveMemoryTelemetryLogsToMemoryDb(
  database: DrizzleDb,
): void {
  runMemoryDbRelocation(database, SPECS);
}
