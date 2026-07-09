/**
 * WS1 — budget enforcement (Paperclip-inspired governance).
 *
 * Generalizes the mission-level hard-stop to the **agent** and **per-task**
 * scopes. This is a read-only checker: it computes a scope's spend vs its cap
 * and returns `ok | warn | hard_stop`. The caller (work-item-runner, at
 * run-start) decides what to do — mirroring how mission-orchestrator checks
 * `spentCents >= budgetCents` at a cycle boundary and pauses.
 *
 * DEFAULT = ZERO BEHAVIOR CHANGE:
 *   - Agent cap (`agents.cap_cents`) is **advisory** unless the agent has
 *     `hard_stop_enabled = 1`. Every existing agent defaults to 0 (migration
 *     302), so `cap_cents` stays exactly as advisory as it was pre-WS1 (it was
 *     never enforced). Over-cap with hard-stop off returns `warn`, never
 *     `hard_stop`.
 *   - Task budget (`work_items.task_budget_cents`) is unlimited when null/0
 *     (the default for every row). Setting a positive value IS the opt-in to a
 *     hard cap for that task.
 *
 * There is NO mid-run enforcement: `runTask` runs the whole agent loop inside
 * one callback and exposes no per-turn hook, so — like missions — the check
 * fires at run boundaries. A single run can overshoot by at most one run's
 * worth of spend (bounded by the agent loop's own max iterations); the next
 * run-start blocks. Mid-turn cancellation is a deliberate follow-up.
 */

import { getTaskSpendCents } from "../work-items/agent-act-store.js";
import {
  getAgentByAssignee,
  getAgentSpend,
} from "../work-items/agent-store.js";
import { getWorkItem } from "../work-items/work-item-store.js";

/** Default soft-alert threshold (%) when an agent sets no `warnPercent`. */
export const DEFAULT_WARN_PERCENT = 80;

/** Window (days) the agent cap is measured over — matches `cap_cents` semantics (weekly). */
const AGENT_SPEND_WINDOW_DAYS = 7;

export type BudgetScope = "agent" | "task";
export type BudgetState = "ok" | "warn" | "hard_stop";

export interface BudgetCheckResult {
  scope: BudgetScope;
  /** Agent name (assignee) or work-item id. */
  id: string;
  state: BudgetState;
  spentCents: number;
  /** null = uncapped/unlimited (→ always `ok`). */
  capCents: number | null;
  warnPercent: number;
  /** spent / cap * 100, rounded; null when uncapped. */
  pct: number | null;
  /** Whether a hit at 100% hard-stops (agents) — always true for a set task budget. */
  hardStopEnabled: boolean;
  /** Human label for incidents/notices ("Ops", the task title). */
  label: string;
}

function classify(
  spentCents: number,
  capCents: number | null,
  warnPercent: number,
  hardStopEnabled: boolean,
): { state: BudgetState; pct: number | null } {
  if (capCents == null || capCents <= 0) return { state: "ok", pct: null };
  const pct = Math.round((spentCents / capCents) * 100);
  if (spentCents >= capCents) {
    return { state: hardStopEnabled ? "hard_stop" : "warn", pct };
  }
  if (pct >= warnPercent) return { state: "warn", pct };
  return { state: "ok", pct };
}

/**
 * Agent scope: weekly spend (`getAgentSpend`) vs `agents.cap_cents`. Advisory
 * unless the agent's `hard_stop_enabled = 1`. The house agent ("cue", null
 * assignee) has no agent row → always `ok`.
 */
export function checkAgentBudget(agentName: string): BudgetCheckResult {
  const agent = getAgentByAssignee(agentName);
  const capCents = agent?.capCents ?? null;
  const warnPercent = agent?.warnPercent ?? DEFAULT_WARN_PERCENT;
  const hardStopEnabled = agent?.hardStopEnabled === 1;
  const label = agent?.name ?? agentName;

  if (capCents == null || capCents <= 0) {
    return {
      scope: "agent",
      id: agentName,
      state: "ok",
      spentCents: 0,
      capCents: null,
      warnPercent,
      pct: null,
      hardStopEnabled,
      label,
    };
  }

  const spend = getAgentSpend({ days: AGENT_SPEND_WINDOW_DAYS });
  const spentCents =
    spend.byAgent.find((a) => a.agent === agentName)?.spentCents ?? 0;
  const { state, pct } = classify(
    spentCents,
    capCents,
    warnPercent,
    hardStopEnabled,
  );
  return {
    scope: "agent",
    id: agentName,
    state,
    spentCents,
    capCents,
    warnPercent,
    pct,
    hardStopEnabled,
    label,
  };
}

/**
 * Task scope: cumulative attributed spend across the work item's runs
 * (`getTaskSpendCents`) vs `work_items.task_budget_cents`. A set budget is a
 * hard cap (hardStopEnabled implicitly true); null/0 = unlimited → `ok`.
 */
export function checkTaskBudget(workItemId: string): BudgetCheckResult {
  const item = getWorkItem(workItemId);
  const capCents =
    item?.taskBudgetCents != null && item.taskBudgetCents > 0
      ? item.taskBudgetCents
      : null;
  const label = item?.title ?? workItemId;

  if (capCents == null) {
    return {
      scope: "task",
      id: workItemId,
      state: "ok",
      spentCents: 0,
      capCents: null,
      warnPercent: DEFAULT_WARN_PERCENT,
      pct: null,
      hardStopEnabled: true,
      label,
    };
  }

  const spentCents = getTaskSpendCents(workItemId);
  const { state, pct } = classify(
    spentCents,
    capCents,
    DEFAULT_WARN_PERCENT,
    true,
  );
  return {
    scope: "task",
    id: workItemId,
    state,
    spentCents,
    capCents,
    warnPercent: DEFAULT_WARN_PERCENT,
    pct,
    hardStopEnabled: true,
    label,
  };
}

/**
 * Combined run-start gate: the most severe of the agent + task checks.
 * `hard_stop` beats `warn` beats `ok`. Returns the deciding result so the
 * caller can surface the right scope/label in an incident.
 */
export function checkRunStartBudget(
  agentName: string,
  workItemId: string,
): BudgetCheckResult {
  const agent = checkAgentBudget(agentName);
  const task = checkTaskBudget(workItemId);
  const rank: Record<BudgetState, number> = {
    ok: 0,
    warn: 1,
    hard_stop: 2,
  };
  return rank[task.state] >= rank[agent.state] ? task : agent;
}
