import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const REMOVED_CONVERSATION_TYPE = "private";
const REMOVED_CONVERSATION_TYPE_SQL = `'${REMOVED_CONVERSATION_TYPE}'`;

const PRIVATE_CONVERSATION_IDS = /*sql*/ `
  SELECT id FROM conversations WHERE conversation_type = ${REMOVED_CONVERSATION_TYPE_SQL}
`;

const PRIVATE_GRAPH_NODE_IDS = /*sql*/ `
  SELECT id FROM memory_graph_nodes WHERE scope_id LIKE 'private:%'
`;

/**
 * Whether a table still lives in the main database.
 *
 * This migration runs unconditionally on every boot — it is idempotent by
 * construction and carries no checkpoint — so it has to tolerate the schema
 * moving underneath it. Migration 326 and the memory-DB relocation moved six of
 * the tables it deletes from (`memory_recall_logs`, `memory_jobs`, and the four
 * `memory_graph_*` tables) into the separate memory database. From that point
 * on the first unguarded statement threw `no such table` and aborted the whole
 * migration at its third of twenty-five statements, on every boot, for good.
 * Prod logged that failure at every restart.
 *
 * Skipping is correct rather than merely safe. An instance that held private
 * conversations purged them while these tables were still in main; the type was
 * removed with this migration, so no new private rows can be created
 * afterwards. There is nothing left on the far side of the split for this to
 * miss. Ongoing conversation-keyed cleanup in the memory database belongs to
 * `conversation-memory-cleanup.ts`.
 */
function mainTableExists(database: DrizzleDb, name: string): boolean {
  return (
    getSqliteFrom(database)
      .query(
        `SELECT name FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(name) != null
  );
}

export function migrateDeletePrivateConversations(database: DrizzleDb): void {
  // Snapshot the migration's start time. The trailing orphan-attachment sweep
  // uses this as an upper bound so it cleans up leaks from prior runs of this
  // migration (those rows were created before this run started) without
  // touching pre-staged uploads created during or after the migration.
  const migrationStartTs = Date.now();

  // Six of the tables below now live in the separate memory database. On a
  // fresh install that is not a problem — this migration runs at 229, long
  // before 326 relocates them — but once an existing database has been through
  // 326, every subsequent boot re-ran this migration against tables that were
  // no longer here.
  const hasMemoryJobs = mainTableExists(database, "memory_jobs");
  const hasGraphNodes = mainTableExists(database, "memory_graph_nodes");

  database.run(/*sql*/ `
    DELETE FROM tool_invocations
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM llm_request_logs
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  // Pre-326 databases still hold this table here and must still be purged;
  // post-326 ones no longer have it, and skipping is correct rather than fatal.
  if (mainTableExists(database, "memory_recall_logs")) {
    database.run(/*sql*/ `
      DELETE FROM memory_recall_logs
      WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
    `);
  }
  database.run(/*sql*/ `
    DELETE FROM llm_usage_events
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM trace_events
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM canonical_guardian_deliveries
    WHERE destination_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
       OR request_id IN (
        SELECT id FROM canonical_guardian_requests
        WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM canonical_guardian_requests
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM scoped_approval_grants
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
       OR call_session_id IN (
        SELECT id FROM call_sessions
        WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM guardian_action_deliveries
    WHERE destination_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
       OR request_id IN (
        SELECT id FROM guardian_action_requests
        WHERE source_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM guardian_action_requests
    WHERE source_conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM channel_guardian_approval_requests
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  if (hasMemoryJobs) {
    database.run(/*sql*/ `
      INSERT OR IGNORE INTO memory_jobs (
        id,
        type,
        payload,
        status,
        attempts,
        run_after,
        created_at,
        updated_at
      )
      SELECT
        'migration-229-delete-private-segment-vector:' || id,
        'delete_qdrant_vectors',
        json_object('targetType', 'segment', 'targetId', id),
        'pending',
        0,
        0,
        0,
        0
      FROM memory_segments
      WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
    `);
  }
  database.run(/*sql*/ `
    DELETE FROM memory_embeddings
    WHERE target_type = 'segment'
      AND target_id IN (
        SELECT id FROM memory_segments
        WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
      )
  `);
  if (hasMemoryJobs) {
    database.run(/*sql*/ `
      INSERT OR IGNORE INTO memory_jobs (
        id,
        type,
        payload,
        status,
        attempts,
        run_after,
        created_at,
        updated_at
      )
      SELECT
        'migration-229-delete-private-summary-vector:' || id,
        'delete_qdrant_vectors',
        json_object('targetType', 'summary', 'targetId', id),
        'pending',
        0,
        0,
        0,
        0
      FROM memory_summaries
      WHERE scope_id LIKE 'private:%'
    `);
  }
  database.run(/*sql*/ `
    DELETE FROM memory_embeddings
    WHERE target_type = 'summary'
      AND target_id IN (
        SELECT id FROM memory_summaries
        WHERE scope_id LIKE 'private:%'
      )
  `);
  if (hasGraphNodes) {
    if (hasMemoryJobs) {
      database.run(/*sql*/ `
        INSERT OR IGNORE INTO memory_jobs (
          id,
          type,
          payload,
          status,
          attempts,
          run_after,
          created_at,
          updated_at
        )
        SELECT
          'migration-229-delete-private-graph-node-vector:' || id,
          'delete_qdrant_vectors',
          json_object('targetType', 'graph_node', 'targetId', id),
          'pending',
          0,
          0,
          0,
          0
        FROM memory_graph_nodes
        WHERE scope_id LIKE 'private:%'
      `);
    }
    // `memory_embeddings` itself stayed in main, but this statement reads the
    // relocated node table, so it belongs inside the guard too.
    database.run(/*sql*/ `
      DELETE FROM memory_embeddings
      WHERE target_type = 'graph_node'
        AND target_id IN (${PRIVATE_GRAPH_NODE_IDS})
    `);
    database.run(/*sql*/ `
      DELETE FROM memory_graph_node_edits
      WHERE node_id IN (${PRIVATE_GRAPH_NODE_IDS})
    `);
    database.run(/*sql*/ `
      DELETE FROM memory_graph_triggers
      WHERE node_id IN (${PRIVATE_GRAPH_NODE_IDS})
    `);
    database.run(/*sql*/ `
      DELETE FROM memory_graph_edges
      WHERE source_node_id IN (${PRIVATE_GRAPH_NODE_IDS})
         OR target_node_id IN (${PRIVATE_GRAPH_NODE_IDS})
    `);
    database.run(/*sql*/ `
      DELETE FROM memory_graph_nodes
      WHERE scope_id LIKE 'private:%'
    `);
  }
  database.run(/*sql*/ `
    DELETE FROM attachments
    WHERE EXISTS (
      SELECT 1
      FROM message_attachments ma
      JOIN messages m ON m.id = ma.message_id
      WHERE ma.attachment_id = attachments.id
        AND m.conversation_id IN (${PRIVATE_CONVERSATION_IDS})
    )
      AND NOT EXISTS (
        SELECT 1
        FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE ma.attachment_id = attachments.id
          AND c.conversation_type != ${REMOVED_CONVERSATION_TYPE_SQL}
      )
  `);
  database.run(/*sql*/ `
    DELETE FROM messages
    WHERE conversation_id IN (${PRIVATE_CONVERSATION_IDS})
  `);
  database.run(/*sql*/ `
    DELETE FROM attachments
    WHERE NOT EXISTS (
      SELECT 1
      FROM message_attachments ma
      WHERE ma.attachment_id = attachments.id
    )
      AND created_at <= ${migrationStartTs}
  `);
  database.run(/*sql*/ `
    DELETE FROM memory_summaries
    WHERE scope_id LIKE 'private:%'
  `);
  database.run(/*sql*/ `
    DELETE FROM conversation_starters
    WHERE scope_id LIKE 'private:%'
  `);

  // Qdrant vectors for deleted embedding rows are cleaned up by background sweeps.
  database.run(/*sql*/ `
    DELETE FROM conversations
    WHERE conversation_type = ${REMOVED_CONVERSATION_TYPE_SQL}
  `);
}
