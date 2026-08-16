/**
 * The lifetime "applied N times" counter for memory graph nodes.
 *
 * One append per node per turn it was genuinely put in front of the model,
 * one grouped read per page the Memory surface lists. The table
 * (`memory_node_injection_events`, migration 329) lives in the memory DB
 * beside `memory_graph_nodes`, so both sides of this module talk to the same
 * connection.
 *
 * ## What counts as an application
 *
 * A node entering the model's context for the first time in a conversation.
 * Re-registering the same nodes with the `InContextTracker` after context
 * compaction (`reinjectCachedMemory`, `retrackCachedNodes`) is NOT an
 * application — the model was already looking at them, and counting the
 * re-registration would make a long conversation inflate the number without
 * the memory having been used again.
 *
 * ## Failure posture
 *
 * The writer never throws: a SQLite write must not abort an agent turn on top
 * of a retrieval the rest of the caller depends on. The reader never throws
 * either, and returns an empty map on failure — the surface then omits the
 * line, which is the same thing it does for a memory with no applications.
 * Omitting is always safe here because the omission hides a metric, never the
 * memory itself.
 */

import { getLogger } from "../../util/logger.js";
import { getMemoryDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("memory-node-injection-events");

/**
 * Append one event per node id. Duplicates within `nodeIds` are collapsed —
 * a node injected once in a turn is one application even if two retrieval
 * lanes both selected it.
 *
 * Best-effort: logs and returns on failure.
 */
export function recordNodeInjectionEvents(
  nodeIds: readonly string[],
  injectedAt: number,
): void {
  const unique = [...new Set(nodeIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return;
  try {
    const raw = getSqliteFrom(getMemoryDb());
    const insert = raw.prepare(
      `INSERT INTO memory_node_injection_events (node_id, injected_at) VALUES (?, ?)`,
    );
    const append = raw.transaction((items: readonly string[]) => {
      for (const id of items) insert.run(id, injectedAt);
    });
    append(unique);
  } catch (err) {
    log.warn(
      { err, nodeCount: unique.length },
      "failed to record node injection events; continuing",
    );
  }
}

/**
 * Lifetime application count per node, in one grouped pass over the
 * requested ids. Nodes with no events are OMITTED from the map — callers
 * must treat a missing entry as "nothing recorded", which is not the same
 * claim as "used zero times" and must not be rendered as one.
 */
export function countNodeInjections(
  nodeIds: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  const unique = [...new Set(nodeIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return out;
  try {
    const raw = getSqliteFrom(getMemoryDb());
    const placeholders = unique.map(() => "?").join(",");
    const rows = raw
      .query(
        `SELECT node_id, COUNT(*) AS n FROM memory_node_injection_events
          WHERE node_id IN (${placeholders})
          GROUP BY node_id`,
      )
      .all(...unique) as Array<{ node_id: string; n: number }>;
    for (const row of rows) {
      if (row.n > 0) out.set(row.node_id, row.n);
    }
  } catch (err) {
    log.warn(
      { err, nodeCount: unique.length },
      "failed to read node injection counts; omitting the metric",
    );
  }
  return out;
}
