import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_item_assessment_v1";

/**
 * Pre-run assessment columns + a narration column on the work-item trail.
 *
 * Migration slot 314 — the next free slot after 313 (automations).
 *
 * Before a work item's execution turn, Cue runs ONE cheap flash-tier
 * assessment (work-items/work-item-assessment.ts) over the task plus the
 * context that will actually be handed to the run (project brief, attached
 * knowledge files, task context) and the capabilities it currently has. The
 * verdict is persisted here so every surface — Activity, the run view, the
 * task card — can show what Cue understood, what it plans to do, or what it
 * needs from the user, instead of a bare "Run" button on a task it cannot do.
 *
 * All additive and nullable, so pre-existing rows read exactly as they did
 * before (verdict null = never assessed = today's behaviour).
 *
 *   - work_items.assessment_verdict TEXT — 'execute' | 'clarify' |
 *     'not_ai_task' | 'blocked'. null = not assessed (fail-open).
 *   - work_items.assessment_understanding TEXT — one plain sentence naming
 *     what Cue understood the task to be.
 *   - work_items.assessment_plan TEXT — the 1–2 line plain-words plan, set
 *     with verdict 'execute' and shown as the run starts.
 *   - work_items.assessment_question TEXT — the single highest-value question,
 *     set with verdict 'clarify'. The item parks; answering it (as task
 *     context) changes the input hash and re-opens assessment.
 *   - work_items.assessment_missing TEXT — the one specific missing thing
 *     (a connector, a file, an access), set with verdict 'blocked'.
 *   - work_items.assessment_confidence REAL — the assessor's 0–1 confidence.
 *   - work_items.assessment_input_hash TEXT — hash of everything the verdict
 *     was derived from (title/notes/context/preamble/capabilities). The cache
 *     key: a matching hash reuses the stored verdict instead of paying for
 *     another LLM call, so re-renders and repeat dispatches are free.
 *   - work_items.assessment_at INTEGER — epoch ms of the stored verdict.
 *
 *   - work_item_events.detail TEXT — human-readable narration for a trail row
 *     ("Reading Q2-deck.pdf from project knowledge"). Written by the assessor
 *     ('assessed' rows) and the runner's per-step narration ('run_step' rows);
 *     null on every pre-existing and lifecycle-only row.
 *
 * Idempotent: every ALTER is guarded by a column check.
 */
export function migrateWorkItemAssessment(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const workItemColumns: Array<[string, string]> = [
      ["assessment_verdict", "TEXT"],
      ["assessment_understanding", "TEXT"],
      ["assessment_plan", "TEXT"],
      ["assessment_question", "TEXT"],
      ["assessment_missing", "TEXT"],
      ["assessment_confidence", "REAL"],
      ["assessment_input_hash", "TEXT"],
      ["assessment_at", "INTEGER"],
    ];
    for (const [name, type] of workItemColumns) {
      if (!tableHasColumn(database, "work_items", name)) {
        raw.exec(/*sql*/ `ALTER TABLE work_items ADD COLUMN ${name} ${type}`);
      }
    }

    if (!tableHasColumn(database, "work_item_events", "detail")) {
      raw.exec(/*sql*/ `ALTER TABLE work_item_events ADD COLUMN detail TEXT`);
    }
  });
}
