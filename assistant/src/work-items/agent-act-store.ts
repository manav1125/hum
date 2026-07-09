/**
 * Agent acts — the act/reversal ledger behind the trust evidence line
 * ("214 acts · 0 reversed") and the TIME BACK "~N hrs" chip.
 *
 * One act = one autonomous thing the agent completed on the owner's behalf.
 * Today acts are captured at ONE choke point: the work-item runner's
 * completion path (kind `run_completed`) — observation-only, beside the
 * sprint-outputs registration. Reversals are captured where the owner undoes
 * the work: re-running an already-reviewed work item (the redo path in
 * `runWorkItemInBackground`) and rejecting a reviewed output
 * (`setWorkOutputReviewState`'s approved → pending flip).
 *
 * Every write here is best-effort by contract: the ledger observes the work
 * loop, it never blocks it. All record/reverse functions swallow their own
 * failures.
 *
 * NO backfill by design — the ledger starts at zero and only counts acts it
 * actually observed, matching the UI's honest "measuring…" starting state.
 *
 * Referential integrity is by convention (store-enforced, no FKs), matching
 * work-item-store / work-output-store.
 */

import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { agentActs, projects } from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-act-store");

// ── Types ────────────────────────────────────────────────────────────

export type AgentActKind =
  | "run_completed"
  | "output_produced"
  | "message_drafted"
  | "schedule_fired"
  | "other";

export interface AgentAct {
  id: string;
  /** The assignee that acted; defaults to "cue". */
  agent: string;
  workItemId: string | null;
  /** Denormalized from the work item's project at write time. */
  missionId: string | null;
  kind: AgentActKind;
  /**
   * Human title of what the act did (the work item's title, e.g. "Draft the
   * pricing one-pager"); null = no natural title source at capture time.
   */
  title: string | null;
  /** 0/1 — the owner undid this act (redo / output rejection / reverse). */
  reversed: number;
  reversedAt: number | null;
  /** Conservative heuristic estimate — see RUN_MINUTES_SAVED_HEURISTIC. */
  estMinutesSaved: number | null;
  /**
   * The run's real attributable LLM cost in cents, summed from
   * llm_usage_events over the run conversation at capture time.
   * Null = unknown (pre-migration act or no run conversation), NOT zero.
   */
  costCents: number | null;
  /**
   * Dominant model of the run — highest summed cost across the run
   * conversation's usage rows (ties break by call count). Null = unknown.
   */
  model: string | null;
  createdAt: number;
}

// ── TIME BACK heuristic ──────────────────────────────────────────────

/**
 * Conservative minutes-saved estimate for one completed background run,
 * derived from the run's observable tool-mix and deliverables — the only
 * per-run "kind" signal work items carry today:
 *
 * | Signal                                                   | Minutes |
 * |----------------------------------------------------------|---------|
 * | Base — any hands-off completed run                       | 5       |
 * | Research tool-mix (web_search / web_fetch used)          | +5      |
 * | Execution tool-mix (bash / skills / file edits used)     | +5      |
 * | Produced ≥1 deliverable (registered work output)         | +10     |
 * | Cap                                                      | 25      |
 *
 * Deliberately conservative: a trivial run credits 5 minutes (below the
 * flat 8-minute work-item credit impact-store already uses for the weekly
 * recap), and even the heaviest research-and-build run never credits more
 * than 25 minutes — the TIME BACK chip should understate, never oversell.
 */
export const RUN_MINUTES_SAVED_HEURISTIC = {
  base: 5,
  research: 5,
  execution: 5,
  deliverables: 10,
  cap: 25,
} as const;

/** Tools whose use marks a run as having done web research. */
const RESEARCH_TOOLS = new Set(["web_search", "web_fetch"]);

/** Tools whose use marks a run as hands-on, multi-step execution work. */
const EXECUTION_TOOLS = new Set([
  "bash",
  "skill_execute",
  "file_write",
  "file_edit",
]);

/** Apply RUN_MINUTES_SAVED_HEURISTIC to one run's observed signals. */
export function estimateRunMinutesSaved(signals: {
  /** Distinct tool names the run's agent loop started. */
  toolsUsed: Iterable<string>;
  /** work_outputs rows registered from this run. */
  outputCount: number;
}): number {
  const tools = new Set(signals.toolsUsed);
  let minutes: number = RUN_MINUTES_SAVED_HEURISTIC.base;
  if ([...tools].some((t) => RESEARCH_TOOLS.has(t))) {
    minutes += RUN_MINUTES_SAVED_HEURISTIC.research;
  }
  if ([...tools].some((t) => EXECUTION_TOOLS.has(t))) {
    minutes += RUN_MINUTES_SAVED_HEURISTIC.execution;
  }
  if (signals.outputCount > 0) {
    minutes += RUN_MINUTES_SAVED_HEURISTIC.deliverables;
  }
  return Math.min(minutes, RUN_MINUTES_SAVED_HEURISTIC.cap);
}

// ── Capture ──────────────────────────────────────────────────────────

/**
 * The run's attributable cost + dominant model, read from llm_usage_events
 * over the run conversation (the same attribution join getAgentSpend uses:
 * every background run executes in a dedicated conversation, so its usage
 * rows ARE the run's cost). Dominant model = highest summed cost, ties
 * broken by call count then name. Returns nulls (unknown, NOT zero/free)
 * when the conversation has no usage rows or the read fails.
 */
export function computeRunCostAndModel(conversationId: string): {
  costCents: number | null;
  model: string | null;
} {
  try {
    const raw = getSqliteFrom(getDb());
    const rows = raw
      .prepare(
        /*sql*/ `SELECT
           COALESCE(NULLIF(TRIM(model), ''), 'unknown') AS model,
           COALESCE(SUM(estimated_cost_usd), 0)          AS cost_usd,
           COUNT(*)                                      AS calls
         FROM llm_usage_events
         WHERE conversation_id = ?
         GROUP BY 1`,
      )
      .all(conversationId) as Array<{
      model: string;
      cost_usd: number | null;
      calls: number;
    }>;
    if (rows.length === 0) return { costCents: null, model: null };
    const totalUsd = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
    const dominant = [...rows].sort(
      (a, b) =>
        (b.cost_usd ?? 0) - (a.cost_usd ?? 0) ||
        Number(b.calls) - Number(a.calls) ||
        a.model.localeCompare(b.model),
    )[0];
    return { costCents: Math.round(totalUsd * 100), model: dominant.model };
  } catch (err) {
    log.warn(
      { err: String(err), conversationId },
      "failed to compute run cost/model for act (ignored)",
    );
    return { costCents: null, model: null };
  }
}

/**
 * WS1 per-task budget rollup: cumulative attributable spend for one work item
 * across ALL its runs, in cents. Sums non-reversed act costs. Returns 0 when
 * there are no acts (or on any read error — best-effort, never throws).
 */
export function getTaskSpendCents(workItemId: string): number {
  try {
    const raw = getSqliteFrom(getDb());
    const row = raw
      .prepare(
        /*sql*/ `SELECT COALESCE(SUM(cost_cents), 0) AS cents
                 FROM agent_acts
                 WHERE work_item_id = ? AND reversed = 0`,
      )
      .get(workItemId) as { cents: number | null } | undefined;
    return Math.max(0, Math.round(row?.cents ?? 0));
  } catch (err) {
    log.warn(
      { err: String(err), workItemId },
      "failed to compute task spend (ignored)",
    );
    return 0;
  }
}

/**
 * Append one act row. Best-effort by contract — returns null (and logs)
 * instead of throwing, so a ledger failure never breaks the choke point
 * that observed the act.
 */
export function recordAgentAct(opts: {
  kind: AgentActKind;
  agent?: string | null;
  workItemId?: string | null;
  missionId?: string | null;
  title?: string | null;
  estMinutesSaved?: number | null;
  costCents?: number | null;
  model?: string | null;
}): AgentAct | null {
  try {
    const db = getDb();
    const act: AgentAct = {
      id: randomUUID(),
      agent: opts.agent?.trim() || "cue",
      workItemId: opts.workItemId ?? null,
      missionId: opts.missionId ?? null,
      kind: opts.kind,
      title: opts.title?.trim() || null,
      reversed: 0,
      reversedAt: null,
      estMinutesSaved: opts.estMinutesSaved ?? null,
      costCents: opts.costCents ?? null,
      model: opts.model ?? null,
      createdAt: Date.now(),
    };
    db.insert(agentActs).values(act).run();
    return act;
  } catch (err) {
    log.warn(
      { err: String(err), kind: opts.kind, workItemId: opts.workItemId },
      "failed to record agent act (ignored)",
    );
    return null;
  }
}

/**
 * The runner's completion choke point: record one `run_completed` act for a
 * work-item run that reached a non-failed terminal status. mission_id is
 * denormalized from the work item's project at write time (matching
 * work-output-store); the act's title is the work item's title (the ledger
 * shows what was actually done, not a kind-derived label); cost + dominant
 * model are computed from the run conversation's usage rows when the runner
 * passes it. Never throws.
 */
export function recordActForCompletedRun(
  workItem: {
    id: string;
    title: string;
    projectId: string | null;
    assignee: string | null;
  },
  signals: {
    toolsUsed: Iterable<string>;
    outputCount: number;
    /** The dedicated run conversation — the cost/model attribution key. */
    runConversationId?: string | null;
  },
): AgentAct | null {
  try {
    const db = getDb();
    const missionId = workItem.projectId
      ? (db
          .select({ missionId: projects.missionId })
          .from(projects)
          .where(eq(projects.id, workItem.projectId))
          .get()?.missionId ?? null)
      : null;
    const { costCents, model } = signals.runConversationId
      ? computeRunCostAndModel(signals.runConversationId)
      : { costCents: null, model: null };
    return recordAgentAct({
      kind: "run_completed",
      agent: workItem.assignee,
      workItemId: workItem.id,
      missionId,
      title: workItem.title,
      estMinutesSaved: estimateRunMinutesSaved(signals),
      costCents,
      model,
    });
  } catch (err) {
    log.warn(
      { err: String(err), workItemId: workItem.id },
      "failed to record run-completed act (ignored)",
    );
    return null;
  }
}

// ── Reversal ─────────────────────────────────────────────────────────

/**
 * Mark the newest not-yet-reversed act for a work item as reversed — the
 * owner undid the agent's work (re-ran the item, or rejected its reviewed
 * output). The latest act is the right target because a work item carries
 * at most one live act per completion; older acts were already superseded
 * or reversed. Returns whether an act was flipped. Never throws.
 */
export function reverseLatestActForWorkItem(workItemId: string): boolean {
  try {
    const raw = getSqliteFrom(getDb());
    const result = raw
      .prepare(
        /*sql*/ `UPDATE agent_acts SET reversed = 1, reversed_at = ?
         WHERE id = (
           SELECT id FROM agent_acts
           WHERE work_item_id = ? AND reversed = 0
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1
         )`,
      )
      .run(Date.now(), workItemId);
    return result.changes > 0;
  } catch (err) {
    log.warn(
      { err: String(err), workItemId },
      "failed to reverse agent act (ignored)",
    );
    return false;
  }
}

/**
 * Outcome of an owner-initiated reversal (`POST acts/:id/reverse`). Honest
 * by contract: `ok: false` means NOTHING was changed — the endpoint never
 * fakes success for an act it has no concrete way to unwind.
 */
export type ReverseActOutcome =
  | {
      ok: true;
      act: AgentAct;
      unwound: {
        /** work_outputs of the act's work item flipped approved → pending. */
        outputsDemoted: number;
        /** The work item was reopened done → awaiting_review. */
        workItemReopened: boolean;
      };
    }
  | {
      ok: false;
      code: "not_found" | "already_reversed" | "no_undo";
      reason: string;
    };

/** Act kinds with a concrete undo mechanism (given a bound work item). */
const REVERSIBLE_KINDS: ReadonlySet<AgentActKind> = new Set([
  "run_completed",
  "output_produced",
]);

const NO_UNDO_REASONS: Record<string, string> = {
  message_drafted:
    "A drafted message has no undo mechanism — drafts are not registered anywhere the ledger can retract from.",
  schedule_fired:
    "A fired schedule already executed — its side effects cannot be undone from the ledger.",
  other: "Acts of kind 'other' carry no concrete undo mechanism.",
};

/**
 * Owner-initiated active reversal of one act by id. Where a concrete undo
 * exists — `run_completed` / `output_produced` acts bound to a work item —
 * it is performed alongside flipping the reversed flag:
 *
 *   1. The work item's approved deliverables are demoted back to pending
 *      review (un-accepted). Direct SQL on purpose: routing through
 *      setWorkOutputReviewState would fire its own reverse-latest-act hook
 *      and double-reverse a sibling act.
 *   2. For `run_completed`, a `done` work item is reopened to
 *      `awaiting_review` so the reversed work re-enters the Review lane.
 *   3. The act itself flips reversed = 1.
 *
 * Kinds with no concrete undo (message_drafted / schedule_fired / other),
 * acts with no bound work item, and already-reversed acts return
 * `ok: false` and change nothing — the caller maps these to 409/404.
 *
 * Unlike the observation-side capture paths this is a deliberate mutation:
 * unexpected DB failures propagate to the caller instead of being swallowed.
 */
export function reverseAct(id: string): ReverseActOutcome {
  const db = getDb();
  const act = db.select().from(agentActs).where(eq(agentActs.id, id)).get() as
    | AgentAct
    | undefined;
  if (!act) {
    return { ok: false, code: "not_found", reason: `Act not found: ${id}` };
  }
  if (act.reversed) {
    return {
      ok: false,
      code: "already_reversed",
      reason: "This act was already reversed.",
    };
  }
  if (!REVERSIBLE_KINDS.has(act.kind)) {
    return {
      ok: false,
      code: "no_undo",
      reason:
        NO_UNDO_REASONS[act.kind] ??
        `Acts of kind '${act.kind}' carry no concrete undo mechanism.`,
    };
  }
  if (!act.workItemId) {
    return {
      ok: false,
      code: "no_undo",
      reason:
        "This act is not bound to a work item, so there is nothing concrete to unwind.",
    };
  }

  const raw = getSqliteFrom(db);
  const now = Date.now();

  // 1. Un-accept the deliverables: approved → pending. (Direct SQL — see
  // the function doc for why this bypasses setWorkOutputReviewState.)
  const outputsDemoted = raw
    .prepare(
      /*sql*/ `UPDATE work_outputs SET review_state = 'pending'
       WHERE work_item_id = ? AND review_state = 'approved'`,
    )
    .run(act.workItemId).changes;

  // 2. Reopen a completed run for re-review. Only 'done' flips — an item
  // already awaiting review, re-running, or archived is left alone.
  let workItemReopened = false;
  if (act.kind === "run_completed") {
    workItemReopened =
      raw
        .prepare(
          /*sql*/ `UPDATE work_items SET status = 'awaiting_review', updated_at = ?
           WHERE id = ? AND status = 'done'`,
        )
        .run(now, act.workItemId).changes > 0;
  }

  // 3. Flip the act itself.
  raw
    .prepare(
      /*sql*/ `UPDATE agent_acts SET reversed = 1, reversed_at = ?
       WHERE id = ? AND reversed = 0`,
    )
    .run(now, id);

  return {
    ok: true,
    act: { ...act, reversed: 1, reversedAt: now },
    unwound: { outputsDemoted, workItemReopened },
  };
}

// ── Reads ────────────────────────────────────────────────────────────

/** Fetch a single act by id. */
export function getAgentAct(id: string): AgentAct | undefined {
  const db = getDb();
  return db.select().from(agentActs).where(eq(agentActs.id, id)).get() as
    | AgentAct
    | undefined;
}

export interface AgentActsAgentSummary {
  agent: string;
  acts: number;
  reversed: number;
  /** Sum over NON-reversed acts only — a reversed act saved nothing. */
  estMinutesSaved: number;
}

export interface AgentActsSummary {
  acts: number;
  reversed: number;
  /** Sum over NON-reversed acts only — a reversed act saved nothing. */
  estMinutesSaved: number;
  byAgent: AgentActsAgentSummary[];
}

/**
 * Ledger totals + per-agent breakdown, optionally filtered to one agent
 * and/or a trailing window of days. estMinutesSaved counts only acts that
 * were not reversed, so the TIME BACK chip stays honest.
 */
export function getActsSummary(opts?: {
  agent?: string;
  days?: number;
}): AgentActsSummary {
  const db = getDb();
  const conditions = [];
  if (opts?.agent) conditions.push(eq(agentActs.agent, opts.agent));
  if (opts?.days != null && Number.isFinite(opts.days) && opts.days > 0) {
    conditions.push(
      gte(agentActs.createdAt, Date.now() - opts.days * 24 * 60 * 60 * 1000),
    );
  }

  const rows = db
    .select({
      agent: agentActs.agent,
      acts: sql<number>`count(*)`,
      reversed: sql<number>`coalesce(sum(${agentActs.reversed}), 0)`,
      estMinutesSaved: sql<number>`coalesce(sum(
        CASE WHEN ${agentActs.reversed} = 0
        THEN coalesce(${agentActs.estMinutesSaved}, 0) ELSE 0 END
      ), 0)`,
    })
    .from(agentActs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(agentActs.agent)
    .all();

  const byAgent = rows
    .map((r) => ({
      agent: r.agent,
      acts: Number(r.acts),
      reversed: Number(r.reversed),
      estMinutesSaved: Number(r.estMinutesSaved),
    }))
    .sort((a, b) => b.acts - a.acts || a.agent.localeCompare(b.agent));

  return {
    acts: byAgent.reduce((sum, r) => sum + r.acts, 0),
    reversed: byAgent.reduce((sum, r) => sum + r.reversed, 0),
    estMinutesSaved: byAgent.reduce((sum, r) => sum + r.estMinutesSaved, 0),
    byAgent,
  };
}

/** Newest-first acts, optionally filtered to one agent. */
export function listRecentActs(opts?: {
  agent?: string;
  limit?: number;
}): AgentAct[] {
  const db = getDb();
  return db
    .select()
    .from(agentActs)
    .where(opts?.agent ? eq(agentActs.agent, opts.agent) : undefined)
    .orderBy(desc(agentActs.createdAt), sql`rowid DESC`)
    .limit(Math.max(1, Math.min(opts?.limit ?? 50, 200)))
    .all() as AgentAct[];
}
