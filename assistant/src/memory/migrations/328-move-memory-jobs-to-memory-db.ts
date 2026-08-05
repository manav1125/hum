import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocatedTableSpec,
  runMemoryDbRelocation,
} from "./memory-db-relocation.js";

/**
 * Migration 328 — move the memory job queue (`memory_jobs`, created by 100,
 * `deferrals` added by 102, outcome columns added by 322) into the
 * dedicated `assistant-memory.db`.
 *
 * The queue is the highest-frequency writer in the memory subsystem (every
 * enqueue/claim/complete is a row write), so moving it takes the worker's
 * steady churn off the main DB's WAL and write lock entirely.
 *
 * Cross-DB coupling audit (why this move is safe):
 *   - The ONLY call site that enqueued inside a main-DB transaction was
 *     `indexer.ts` (embed_segment / embed_attachment atomically with the
 *     `memory_segments` insert). That coupling is dissolved there: segment
 *     inserts commit on main first, then the embed jobs are enqueued on the
 *     memory connection. A crash in the gap leaves a segment without an
 *     embed job — recoverable garbage the `backfill` / `rebuild_index`
 *     jobs already repair, never a wrong answer.
 *   - Every other enqueue/claim/complete/defer/fail path is a standalone
 *     autocommitted write (verified across all `enqueueMemoryJob` /
 *     `upsertDebouncedJob` / `upsertAutoAnalysisJob` /
 *     `upsertMemoryRetrospectiveJob` / `upsertContactMemoryExtractJob`
 *     call sites).
 *   - `memory_jobs` has no foreign keys in either direction.
 */
const SPECS: RelocatedTableSpec[] = [
  {
    table: "memory_jobs",
    columns: [
      "id",
      "type",
      "payload",
      "status",
      "attempts",
      "deferrals",
      "run_after",
      "last_error",
      "started_at",
      "outcome",
      "produced_count",
      "outcome_reason",
      "created_at",
      "updated_at",
    ],
    createSql: /*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        deferrals INTEGER NOT NULL DEFAULT 0,
        run_after INTEGER NOT NULL,
        last_error TEXT,
        started_at INTEGER,
        outcome TEXT,
        produced_count INTEGER,
        outcome_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_run_after
        ON memory_jobs(status, run_after);
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_conflict_resolve_dedupe
        ON memory_jobs(
          type,
          status,
          json_extract(payload, '$.messageId'),
          COALESCE(json_extract(payload, '$.scopeId'), 'default')
        );
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_type_outcome
        ON memory_jobs (type, outcome);
    `,
  },
];

export function migrateMoveMemoryJobsToMemoryDb(database: DrizzleDb): void {
  runMemoryDbRelocation(database, SPECS);
}
