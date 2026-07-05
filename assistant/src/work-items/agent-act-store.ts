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
  /** 0/1 — the owner undid this act (redo / output rejection). */
  reversed: number;
  reversedAt: number | null;
  /** Conservative heuristic estimate — see RUN_MINUTES_SAVED_HEURISTIC. */
  estMinutesSaved: number | null;
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
 * Append one act row. Best-effort by contract — returns null (and logs)
 * instead of throwing, so a ledger failure never breaks the choke point
 * that observed the act.
 */
export function recordAgentAct(opts: {
  kind: AgentActKind;
  agent?: string | null;
  workItemId?: string | null;
  missionId?: string | null;
  estMinutesSaved?: number | null;
}): AgentAct | null {
  try {
    const db = getDb();
    const act: AgentAct = {
      id: randomUUID(),
      agent: opts.agent?.trim() || "cue",
      workItemId: opts.workItemId ?? null,
      missionId: opts.missionId ?? null,
      kind: opts.kind,
      reversed: 0,
      reversedAt: null,
      estMinutesSaved: opts.estMinutesSaved ?? null,
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
 * work-output-store). Never throws.
 */
export function recordActForCompletedRun(
  workItem: { id: string; projectId: string | null; assignee: string | null },
  signals: { toolsUsed: Iterable<string>; outputCount: number },
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
    return recordAgentAct({
      kind: "run_completed",
      agent: workItem.assignee,
      workItemId: workItem.id,
      missionId,
      estMinutesSaved: estimateRunMinutesSaved(signals),
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

// ── Reads ────────────────────────────────────────────────────────────

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
