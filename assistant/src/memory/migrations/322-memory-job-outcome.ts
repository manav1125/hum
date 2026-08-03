import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_memory_job_outcome_v1";

/**
 * What a memory job DID, alongside whether it finished.
 *
 * Migration slot 322 — the next free slot after 321 (push budget ledger).
 *
 * ## The bug this fixes
 *
 * `memory_jobs.status` has exactly one word for two different events. A job
 * that extracted forty facts and a job that read the same messages and wrote
 * nothing both land on `completed`, and nothing anywhere carries the
 * difference. That is not a hypothetical:
 *
 *   - `contact_memory_extract` — 697 completed rows, 0 rows in
 *     `contact_memory`. Years of correspondence, nobody learned.
 *   - graph extraction — roughly 190 of 237 runs in a single day logged
 *     "Graph extraction job complete" with `nodesCreated: 0`, because the
 *     checkpoint advanced past messages it never read.
 *
 * Each was found late, and each was found the same way: by comparing job runs
 * against rows produced, in a query nobody had a reason to run. These columns
 * make that comparison a property of the job table instead of an investigation.
 *
 *   - memory_jobs.outcome TEXT — 'produced' | 'empty' | 'skipped' |
 *     'unreported'. See `job-outcome.ts` for why there are four and not three.
 *   - memory_jobs.produced_count INTEGER — records that reached a store.
 *   - memory_jobs.outcome_reason TEXT — why a run wrote nothing, in the
 *     handler's own words.
 *   - idx_memory_jobs_type_outcome — the shape the question asks: this job
 *     type, grouped by what it actually did.
 *
 * ## Why nullable, and why there is no backfill
 *
 * NULL means "this row never said", and it must stay distinguishable from a
 * row that said `empty`. Backfilling old rows to `produced` would assert work
 * that was never evidenced — the original bug with a new column name — and
 * backfilling them to `empty` would invent a run of failures out of rows we
 * simply cannot speak for. Old rows keep NULL, readers skip what they cannot
 * account for, and the column earns its history forward from here.
 *
 * `status` is untouched. Widening that enum would change the meaning of a
 * value every existing reader already branches on; this is purely additive, so
 * nothing that reads `status` today reads it differently tomorrow.
 *
 * Idempotent: every ALTER is column-guarded, the index is IF NOT EXISTS.
 */
export function migrateMemoryJobOutcome(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const columns: Array<[column: string, type: string]> = [
      ["outcome", "TEXT"],
      ["produced_count", "INTEGER"],
      ["outcome_reason", "TEXT"],
    ];
    for (const [column, type] of columns) {
      if (!tableHasColumn(database, "memory_jobs", column)) {
        raw.exec(
          /*sql*/ `ALTER TABLE memory_jobs ADD COLUMN ${column} ${type}`,
        );
      }
    }

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_type_outcome
      ON memory_jobs (type, outcome)
    `);
  });
}
