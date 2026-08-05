import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocatedTableSpec,
  runMemoryDbRelocation,
} from "./memory-db-relocation.js";

/**
 * Migration 325 — move the memory graph cluster into the dedicated
 * `assistant-memory.db` as ONE unit (design rule from upstream b593de8041):
 * `memory_graph_edges`, `memory_graph_triggers`, and
 * `memory_graph_node_edits` each `REFERENCES memory_graph_nodes(id)
 * ON DELETE CASCADE`, so the four tables relocate together in a single
 * migration step and the intra-cluster cascades are recreated verbatim on
 * the memory connection — a node delete keeps cascading to its edges,
 * triggers, and edit history exactly as it did on main.
 *
 * Nodes are listed first so the copy lands parents before children (the
 * memory connection runs with `foreign_keys=ON`); drops run in reverse
 * (children first) inside the relocation engine.
 *
 * Column lists carry the base CREATE columns (202) plus `event_date`
 * (202's own ALTER) and `image_refs` (205). No table in the cluster has a
 * foreign key into `conversations`/`messages` — `memory_graph_node_edits.
 * conversation_id` is plain provenance text, so no cross-DB cascade is
 * lost here.
 */
const SPECS: RelocatedTableSpec[] = [
  {
    table: "memory_graph_nodes",
    columns: [
      "id",
      "content",
      "type",
      "created",
      "last_accessed",
      "last_consolidated",
      "emotional_charge",
      "fidelity",
      "confidence",
      "significance",
      "stability",
      "reinforcement_count",
      "last_reinforced",
      "source_conversations",
      "source_type",
      "narrative_role",
      "part_of_story",
      "scope_id",
      "event_date",
      "image_refs",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_graph_nodes (
        id                    TEXT PRIMARY KEY,
        content               TEXT NOT NULL,
        type                  TEXT NOT NULL,
        created               INTEGER NOT NULL,
        last_accessed         INTEGER NOT NULL,
        last_consolidated     INTEGER NOT NULL,
        emotional_charge      TEXT NOT NULL,
        fidelity              TEXT NOT NULL DEFAULT 'vivid',
        confidence            REAL NOT NULL,
        significance          REAL NOT NULL,
        stability             REAL NOT NULL DEFAULT 14,
        reinforcement_count   INTEGER NOT NULL DEFAULT 0,
        last_reinforced       INTEGER NOT NULL,
        source_conversations  TEXT NOT NULL DEFAULT '[]',
        source_type           TEXT NOT NULL DEFAULT 'inferred',
        narrative_role        TEXT,
        part_of_story         TEXT,
        scope_id              TEXT NOT NULL DEFAULT 'default',
        event_date            INTEGER,
        image_refs            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_scope_id ON memory_graph_nodes(scope_id);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON memory_graph_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_fidelity ON memory_graph_nodes(fidelity);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_created ON memory_graph_nodes(created);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_significance ON memory_graph_nodes(significance);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_event_date ON memory_graph_nodes(event_date);
    `,
  },
  {
    table: "memory_graph_edges",
    columns: [
      "id",
      "source_node_id",
      "target_node_id",
      "relationship",
      "weight",
      "created",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_graph_edges (
        id              TEXT PRIMARY KEY,
        source_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
        target_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
        relationship    TEXT NOT NULL,
        weight          REAL NOT NULL DEFAULT 1.0,
        created         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON memory_graph_edges(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON memory_graph_edges(target_node_id);
    `,
  },
  {
    table: "memory_graph_triggers",
    columns: [
      "id",
      "node_id",
      "type",
      "schedule",
      "condition",
      "condition_embedding",
      "threshold",
      "event_date",
      "ramp_days",
      "follow_up_days",
      "recurring",
      "consumed",
      "cooldown_ms",
      "last_fired",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_graph_triggers (
        id                   TEXT PRIMARY KEY,
        node_id              TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
        type                 TEXT NOT NULL,
        schedule             TEXT,
        condition            TEXT,
        condition_embedding  BLOB,
        threshold            REAL,
        event_date           INTEGER,
        ramp_days            INTEGER,
        follow_up_days       INTEGER,
        recurring            INTEGER NOT NULL DEFAULT 0,
        consumed             INTEGER NOT NULL DEFAULT 0,
        cooldown_ms          INTEGER,
        last_fired           INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_graph_triggers_node_id ON memory_graph_triggers(node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_triggers_type ON memory_graph_triggers(type);
    `,
  },
  {
    table: "memory_graph_node_edits",
    columns: [
      "id",
      "node_id",
      "previous_content",
      "new_content",
      "source",
      "conversation_id",
      "created",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_graph_node_edits (
        id                TEXT PRIMARY KEY,
        node_id           TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
        previous_content  TEXT NOT NULL,
        new_content       TEXT NOT NULL,
        source            TEXT NOT NULL,
        conversation_id   TEXT,
        created           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_node_edits_node_id ON memory_graph_node_edits(node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_node_edits_created ON memory_graph_node_edits(created);
    `,
  },
];

export function migrateMoveMemoryGraphClusterToMemoryDb(
  database: DrizzleDb,
): void {
  runMemoryDbRelocation(database, SPECS);
}
