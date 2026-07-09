import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_budget_policies_v1";

/**
 * WS1 — budget enforcement policy columns (Paperclip-inspired governance).
 *
 * Generalizes the mission-level hard-stop (which already works) to the agent
 * and per-task scopes. `agents.cap_cents` was defined but never enforced; this
 * adds the two knobs that turn a cap into an enforceable policy, plus an
 * optional per-task cap.
 *
 * Columns (all additive, nullable / default-preserving so EVERY existing row
 * behaves EXACTLY as today — enforcement is opt-in):
 *   - agents.warn_percent        INTEGER  — soft-alert threshold (e.g. 80).
 *                                           NULL = use the workspace config
 *                                           default (budgets.warnPercent).
 *   - agents.hard_stop_enabled   INTEGER  — 0/1. 0 (default) = a cap is
 *                                           advisory only (today's behavior:
 *                                           cap_cents was never enforced). 1 =
 *                                           the run-start budget check pauses
 *                                           the agent's runs at the cap.
 *   - work_items.task_budget_cents INTEGER — per-task hard cap in cents.
 *                                           NULL/0 = unlimited (today).
 *
 * Enforcement lives in guardrails/budget-enforcement.ts (checkBudget) and is
 * called at work-item run-start in work-items/work-item-runner.ts — mirroring
 * the mission-orchestrator's cycle-boundary check. Nothing here changes
 * behavior on its own: with hard_stop_enabled=0 and task_budget_cents=NULL
 * (the defaults for all existing + new rows unless a user opts in), the checker
 * always returns "ok".
 *
 * Idempotent by construction: each ALTER is guarded by a PRAGMA column check.
 */
export function migrateBudgetPolicies(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const agentColumns = raw
      .prepare(/*sql*/ `PRAGMA table_info(agents)`)
      .all() as Array<{ name: string }>;
    if (!agentColumns.some((c) => c.name === "warn_percent")) {
      raw.exec(/*sql*/ `ALTER TABLE agents ADD COLUMN warn_percent INTEGER`);
    }
    if (!agentColumns.some((c) => c.name === "hard_stop_enabled")) {
      raw.exec(
        /*sql*/ `ALTER TABLE agents ADD COLUMN hard_stop_enabled INTEGER NOT NULL DEFAULT 0`,
      );
    }

    const workItemColumns = raw
      .prepare(/*sql*/ `PRAGMA table_info(work_items)`)
      .all() as Array<{ name: string }>;
    if (!workItemColumns.some((c) => c.name === "task_budget_cents")) {
      raw.exec(
        /*sql*/ `ALTER TABLE work_items ADD COLUMN task_budget_cents INTEGER`,
      );
    }
  });
}
