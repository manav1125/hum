/**
 * Explicit cleanup for the memory-subsystem tables relocated to the
 * dedicated `assistant-memory.db` (migrations 324–328).
 *
 * SQLite foreign keys cannot span database files, so the main-DB
 * `conversations` cascades that used to clean `activation_state`,
 * `conversation_graph_memory_state`, and `memory_retrospective_state` —
 * and the anti-join sweeps that cleaned the FK-less log tables — no longer
 * reach these rows. Every conversation delete/clear site calls the
 * functions here explicitly instead (a direct-call port of upstream
 * vellum-assistant's `conversation-memory-purge` hook design — our memory
 * subsystem is core code, not a plugin, so plain function calls replace
 * the hook layering).
 *
 * Guarantees:
 *   - Best-effort, per table: a locked or unopenable memory DB can NEVER
 *     abort a main-DB delete. Failures are logged and swallowed — for
 *     these derived tables a stray orphan row is harmless garbage, and the
 *     periodic orphan sweep picks it up later.
 *   - No moved table is message-cascade-scoped (verified per table: the
 *     `message_id` columns on recall/activation logs never had FKs), so
 *     message deletes need no counterpart here; conversation-scoped rows
 *     get the purge + the sweep backstop.
 */

import type { Database } from "bun:sqlite";

import { getLogger } from "../util/logger.js";
import { getMemorySqlite, getSqlite } from "./db-connection.js";

const log = getLogger("conversation-memory-cleanup");

/**
 * Conversation-keyed tables on the memory connection that a conversation
 * delete must purge (each keys rows on a `conversation_id` column). A
 * table joins this list when it relocates to the memory DB.
 *
 * Deliberately NOT here:
 *   - `memory_graph_node_edits.conversation_id` is provenance text on a
 *     node-scoped audit row — it lives and dies with its node (intra-
 *     cluster cascade), not with the conversation.
 *   - `memory_v2_injection_events` / `memory_v3_auto_edges` are slug-keyed
 *     learning state with no conversation column; time/weight pruning owns
 *     them.
 *   - `memory_jobs` payloads reference conversations as JSON, not a
 *     column; job cancellation is `task-memory-cleanup.ts`'s job.
 */
export const CONVERSATION_KEYED_MEMORY_TABLES: readonly string[] = [
  "activation_state",
  "conversation_graph_memory_state",
  "memory_retrospective_state",
  "memory_recall_logs",
  "memory_v2_activation_logs",
  "memory_v3_coactivation",
  "memory_v3_selections",
  "memory_v3_ever_injected",
];

function memorySqliteOrNull(context: string): Database | null {
  try {
    return getMemorySqlite();
  } catch (err) {
    log.warn(
      { err, context },
      "memory database unavailable; memory cleanup degraded",
    );
    return null;
  }
}

/**
 * Delete the given conversation's rows from every table in
 * {@link CONVERSATION_KEYED_MEMORY_TABLES} on the memory connection.
 * Best-effort per table; never throws.
 */
export function purgeConversationMemoryTables(conversationId: string): void {
  const raw = memorySqliteOrNull("purgeConversationMemoryTables");
  if (!raw) return;
  for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
    try {
      raw
        .query(`DELETE FROM ${table} WHERE conversation_id = ?`)
        .run(conversationId);
    } catch (err) {
      log.warn(
        { err, conversationId, table },
        "Failed to purge memory table for deleted conversation; continuing",
      );
    }
  }
}

/**
 * Wipe every conversation-keyed memory table plus the memory job queue on
 * the memory connection. Used by the clear-all reset: it drops all
 * conversations at once, so there is no id to key on — every row in the
 * per-conversation tables is orphaned by the wipe, and the job queue's
 * pending work references conversations that no longer exist.
 *
 * Long-term memory (the graph cluster) and slug-keyed learning state
 * (injection events, auto edges) deliberately survive, matching the
 * pre-split behavior where clear-all never touched them.
 *
 * Best-effort with the same guarantees as
 * {@link purgeConversationMemoryTables}.
 */
export function clearAllConversationMemoryTables(): void {
  const raw = memorySqliteOrNull("clearAllConversationMemoryTables");
  if (!raw) return;
  for (const table of [...CONVERSATION_KEYED_MEMORY_TABLES, "memory_jobs"]) {
    try {
      raw.query(`DELETE FROM ${table}`).run();
    } catch (err) {
      log.warn(
        { err, table },
        "Failed to clear memory table during clear-all; continuing",
      );
    }
  }
}

/** Ids per batched probe/delete — bounds each statement's lock hold. */
const SWEEP_BATCH = 500;

export interface OrphanSweepResult {
  /** Total orphan rows' distinct conversation ids deleted across tables. */
  swept: number;
}

/** Yield to the event loop so a large backlog never blocks it. */
function breathe(): Promise<void> {
  return Bun.sleep(0);
}

/**
 * Delete rows whose conversation no longer exists from every table in
 * {@link CONVERSATION_KEYED_MEMORY_TABLES}. This is the backstop for
 * deletes that raced a crash between the main-DB delete and the purge
 * call (the cross-DB delete pair is not atomic by construction).
 *
 * There is no cross-attach, so no single-statement anti-join exists: page
 * distinct conversation ids off the memory connection by keyset, confirm
 * existence against `conversations` on the main connection, then delete
 * that page's orphans. Bounded statements with a yield between pages.
 *
 * Idempotent and best-effort: an unavailable memory DB no-ops, and one
 * failing table is logged and skipped so the rest still run.
 */
export async function sweepOrphanConversationMemoryTables(): Promise<OrphanSweepResult> {
  const memoryRaw = memorySqliteOrNull("sweepOrphanConversationMemoryTables");
  if (!memoryRaw) return { swept: 0 };
  const mainRaw = getSqlite();

  let swept = 0;
  for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
    try {
      swept += await sweepTable(table, memoryRaw, mainRaw);
    } catch (err) {
      log.warn(
        { err, table },
        "Failed to sweep orphan rows from a relocated memory table; continuing",
      );
    }
  }
  if (swept > 0) {
    log.info({ swept }, "Swept orphan rows from relocated memory tables");
  }
  return { swept };
}

async function sweepTable(
  table: string,
  memoryRaw: Database,
  mainRaw: Database,
): Promise<number> {
  let deleted = 0;
  // Keyset cursor over distinct conversation ids: the empty string sorts
  // before any real id, so the first page starts at the beginning, and the
  // scan advances through the index instead of restarting per batch.
  let cursor = "";
  for (;;) {
    const page = (
      memoryRaw
        .query(
          `SELECT DISTINCT conversation_id AS id FROM ${table}
           WHERE conversation_id > ? ORDER BY conversation_id LIMIT ?`,
        )
        .all(cursor, SWEEP_BATCH) as Array<{ id: string }>
    ).map((row) => row.id);
    if (page.length === 0) break;
    cursor = page[page.length - 1];

    // Ids the main DB still knows; the rest are orphans.
    const placeholders = page.map(() => "?").join(", ");
    const alive = new Set(
      (
        mainRaw
          .query(`SELECT id FROM conversations WHERE id IN (${placeholders})`)
          .all(...page) as Array<{ id: string }>
      ).map((row) => row.id),
    );
    const orphans = page.filter((id) => !alive.has(id));
    if (orphans.length > 0) {
      const del = orphans.map(() => "?").join(", ");
      memoryRaw
        .query(`DELETE FROM ${table} WHERE conversation_id IN (${del})`)
        .run(...orphans);
      deleted += orphans.length;
    }

    await breathe();
    if (page.length < SWEEP_BATCH) break;
  }
  return deleted;
}
