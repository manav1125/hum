import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_item_auto_run_eligibility_v1";

/**
 * Durable "user parked this task" marker for the auto-run gate.
 *
 * A user-created task (project-board quick-add, a plain voice to-do, a
 * needs-you feed item) is created with capture-time auto-run skipped — but
 * that intent only lived in the creating call's `skipAutoRun` flag. The
 * periodic queue drainer later swept the same `queued` lane and re-dispatched
 * those items through the policy gate, so under a permissive autonomy policy
 * a quick-added note silently started a background run (and spent money)
 * within minutes of being typed.
 *
 * Column (additive, default-preserving — pre-existing rows behave identically):
 *   - work_items.auto_run_eligibility TEXT — NULL = eligible for the
 *     policy-gated auto-run path (capture-triage, mission cycles, drainer);
 *     'parked' = the user parked this task, so it must NEVER auto-run.
 *     An explicit run (the Run button / came-in confirm / CLI run) clears
 *     the marker at dispatch time in work-item-runner.
 *
 * Enforcement lives in work-items/work-item-triage.ts (maybeAutoRunWorkItem
 * returns reason 'user_parked'); stamping happens at the user-parked creation
 * call sites (work-items routes quick-add, gemini-live add_task, home-feed
 * needs_you).
 *
 * Idempotent: the ALTER is guarded by a PRAGMA column check.
 */
export function migrateWorkItemAutoRunEligibility(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const cols = raw
      .prepare(/*sql*/ `PRAGMA table_info(work_items)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "auto_run_eligibility")) {
      raw.exec(
        /*sql*/ `ALTER TABLE work_items ADD COLUMN auto_run_eligibility TEXT`,
      );
    }
  });
}
