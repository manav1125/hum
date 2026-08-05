import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocatedTableSpec,
  runMemoryDbRelocation,
} from "./memory-db-relocation.js";

/**
 * Migration 324 — move the per-conversation memory-state tables into the
 * dedicated `assistant-memory.db`:
 *
 *   - `activation_state` (232, FK cascade added by 241): one-row-per-
 *     conversation v2 activation snapshot, rewritten on every injected turn.
 *   - `conversation_graph_memory_state` (207): ConversationGraphMemory +
 *     InContextTracker snapshot, also rewritten per turn.
 *   - `memory_retrospective_state` (245, `remembered_log` added by 281):
 *     retrospective cursor + cumulative remembered log.
 *
 * All three carried `REFERENCES conversations(id) ON DELETE CASCADE` (241 /
 * 207 / 245). Cross-database foreign keys do not exist, so the memory-side
 * DDL drops the clause; the lost cascade is replaced by the explicit purge
 * in `conversation-memory-cleanup.ts` (called from every conversation
 * delete site) plus the periodic orphan sweep for deletes that raced a
 * crash.
 */
const SPECS: RelocatedTableSpec[] = [
  {
    table: "activation_state",
    columns: [
      "conversation_id",
      "message_id",
      "state_json",
      "ever_injected_json",
      "current_turn",
      "updated_at",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS activation_state (
        conversation_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        ever_injected_json TEXT NOT NULL DEFAULT '[]',
        current_turn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    table: "conversation_graph_memory_state",
    columns: ["conversation_id", "state_json", "created_at", "updated_at"],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS conversation_graph_memory_state (
        conversation_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    table: "memory_retrospective_state",
    columns: [
      "conversation_id",
      "last_processed_message_id",
      "last_run_at",
      "remembered_log",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_retrospective_state (
        conversation_id TEXT PRIMARY KEY,
        last_processed_message_id TEXT NOT NULL,
        last_run_at INTEGER NOT NULL,
        remembered_log TEXT
      );
    `,
  },
];

export function migrateMoveConversationMemoryStateToMemoryDb(
  database: DrizzleDb,
): void {
  runMemoryDbRelocation(database, SPECS);
}
