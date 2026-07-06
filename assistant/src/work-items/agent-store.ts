/**
 * Agent registry — the server-side home for the Agents · org page roster
 * (Ops / Builder / Growth / …). Replaces the Phase-1 localStorage charter
 * config so charters persist across devices and other surfaces can read them.
 *
 * `name` is both the display name and the work-item `assignee` match key
 * (matched case-insensitively). `cue` is the implicit house agent — a null
 * work-item assignee reads as "cue" everywhere — and is deliberately NOT a
 * registry row. `cap_cents` is the weekly spend cap in cents (money unit of
 * record, matching missions.budget_cents); null = uncapped.
 *
 * Referential integrity is by convention (store-enforced, no FKs), matching
 * the sibling HQ stores (mission-store, project-store, work-output-store).
 *
 * SPEND ATTRIBUTION (getAgentSpend): per-agent $ is real, derived — NOT a
 * fabricated split of the workspace total. Every background work-item run
 * executes in a dedicated conversation whose id lands on
 * work_items.last_run_conversation_id (see work-item-runner). All LLM cost for
 * that run is recorded in llm_usage_events keyed by that conversation_id. So
 * summing estimated_cost_usd over the usage rows of an assignee's run
 * conversations attributes real spend to the agent. The one honest limit:
 * work_items keeps only the LATEST run conversation per item, so spend from a
 * re-run's superseded prior conversation is not counted — see the note on
 * getAgentSpend.
 */

import { randomUUID } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { rawAll } from "../memory/raw-query.js";
import { agents } from "../memory/schema/tasks.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-store");

// ── Types ────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  /** Display + work-item assignee match key (case-insensitive). */
  name: string;
  /** Single glyph for the role tile (⚙ ▲ ✦ …); null = unset. */
  emoji: string | null;
  /** Short domain blurb under the name ("Operations"); null = unset. */
  domain: string | null;
  /** The standing mandate; null = unset. */
  charter: string | null;
  /** Autonomy tier '1'..'4' (text for headroom). */
  tier: string;
  /** Weekly spend cap in cents; null = uncapped. */
  capCents: number | null;
  /** 0/1 — the role is paused. */
  paused: number;
  /**
   * Per-agent model pin (provider/model string, e.g.
   * "anthropic/claude-haiku-4.5"); null = no pin. Background work-item runs
   * for this assignee execute on the pinned model via the run conversation's
   * `modelOverride` (see work-item-runner) — an explicit per-call model that
   * wins over profile/call-site resolution in the provider layer.
   */
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** List all agents, name-ordered (stable roster). */
export function listAgents(): Agent[] {
  const db = getDb();
  return db.select().from(agents).orderBy(asc(agents.name)).all() as Agent[];
}

/** Fetch a single agent by id. */
export function getAgent(id: string): Agent | undefined {
  const db = getDb();
  return db.select().from(agents).where(eq(agents.id, id)).get() as
    | Agent
    | undefined;
}

/**
 * Resolve the agent behind a work-item assignee (matched case-insensitively
 * on `name`, the assignee match key). Null/empty assignee reads as the
 * implicit house agent "cue", which is deliberately not a registry row —
 * returns undefined.
 */
export function getAgentByAssignee(
  assignee: string | null | undefined,
): Agent | undefined {
  const name = assignee?.trim();
  if (!name) return undefined;
  const db = getDb();
  return db
    .select()
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .get() as Agent | undefined;
}

/** "Hire an agent" — add a new role to the org. */
export function createAgent(opts: {
  name: string;
  emoji?: string | null;
  domain?: string | null;
  charter?: string | null;
  tier?: string;
  capCents?: number | null;
  paused?: boolean;
  model?: string | null;
}): Agent {
  const db = getDb();
  const now = Date.now();
  const agent: Agent = {
    id: randomUUID(),
    name: opts.name,
    emoji: opts.emoji ?? null,
    domain: opts.domain ?? null,
    charter: opts.charter ?? null,
    tier: opts.tier ?? "1",
    capCents: opts.capCents ?? null,
    paused: opts.paused ? 1 : 0,
    model: opts.model ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(agents).values(agent).run();
  return agent;
}

/**
 * Patch one agent (rename / re-charter / tier / cap / pause / model pin).
 * Only provided fields are written; the rest keep their current value.
 */
export function updateAgent(
  id: string,
  updates: Partial<
    Pick<
      Agent,
      | "name"
      | "emoji"
      | "domain"
      | "charter"
      | "tier"
      | "capCents"
      | "paused"
      | "model"
    >
  >,
): Agent | undefined {
  const db = getDb();
  db.update(agents)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(agents.id, id))
    .run();
  return getAgent(id);
}

/** Retire a role. Hard delete; work items keep their `assignee` string. */
export function deleteAgent(id: string): void {
  const db = getDb();
  db.delete(agents).where(eq(agents.id, id)).run();
}

// ── Spend attribution ────────────────────────────────────────────────

export interface AgentSpend {
  /** The assignee name the spend is attributed to (normalized as stored). */
  agent: string;
  /** Real attributed spend in cents over the window. */
  spentCents: number;
  /** Number of run conversations that contributed (non-zero-cost runs). */
  runs: number;
}

export interface AgentSpendSummary {
  /** Per-assignee attributed spend over the trailing window. */
  byAgent: AgentSpend[];
  /**
   * Total attributed spend across all assignees over the window — the sum of
   * byAgent. NOT the workspace usage total (that includes chat, schedules,
   * and everything outside work-item runs); this is only the slice we can
   * honestly attribute to an agent's runs.
   */
  attributedCents: number;
  /** The window this summary covers, epoch ms. */
  from: number;
  to: number;
}

/**
 * Per-agent attributed spend over the trailing `days` window.
 *
 * Derivation (real, not a fabricated split): join llm_usage_events →
 * work_items on usage.conversation_id = work_items.last_run_conversation_id,
 * bucket estimated_cost_usd by the work item's assignee (null assignee reads
 * as "cue"), and filter usage rows to the [from, to] window by created_at.
 *
 * Honest limits (documented, not hidden):
 *   - Only the LATEST run conversation per work item is tracked
 *     (last_run_conversation_id is overwritten on re-run), so cost from a
 *     superseded prior run of the same item is not attributed. New spend from
 *     the current run IS counted.
 *   - Cost incurred outside a work-item run (owner chat, schedules, meetings)
 *     is intentionally excluded — it isn't attributable to a staffed agent.
 * Cents are rounded from the stored USD floats at the aggregate.
 */
export function getAgentSpend(opts?: { days?: number }): AgentSpendSummary {
  const to = Date.now();
  const days =
    opts?.days != null && Number.isFinite(opts.days) && opts.days > 0
      ? opts.days
      : 7;
  const from = to - days * 24 * 60 * 60 * 1000;

  let rows: Array<{ agent: string; cost_usd: number; runs: number }> = [];
  try {
    rows = rawAll<{ agent: string; cost_usd: number | null; runs: number }>(
      /*sql*/ `
      SELECT
        COALESCE(NULLIF(TRIM(wi.assignee), ''), 'cue') AS agent,
        COALESCE(SUM(u.estimated_cost_usd), 0)          AS cost_usd,
        COUNT(DISTINCT u.conversation_id)               AS runs
      FROM llm_usage_events u
      JOIN work_items wi
        ON wi.last_run_conversation_id = u.conversation_id
      WHERE u.conversation_id IS NOT NULL
        AND u.created_at >= ?1
        AND u.created_at <= ?2
      GROUP BY agent
      `,
      from,
      to,
    ).map((r) => ({
      agent: r.agent,
      cost_usd: r.cost_usd ?? 0,
      runs: Number(r.runs),
    }));
  } catch (err) {
    // Best-effort read: never break the roster page on a usage-store hiccup.
    log.warn({ err: String(err) }, "failed to compute agent spend (ignored)");
    rows = [];
  }

  const byAgent: AgentSpend[] = rows
    .map((r) => ({
      agent: r.agent,
      spentCents: Math.round(r.cost_usd * 100),
      runs: r.runs,
    }))
    .sort(
      (a, b) => b.spentCents - a.spentCents || a.agent.localeCompare(b.agent),
    );

  return {
    byAgent,
    attributedCents: byAgent.reduce((sum, r) => sum + r.spentCents, 0),
    from,
    to,
  };
}

/** Seed helper for tests: how many rows the registry holds right now. */
export function countAgents(): number {
  const db = getDb();
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(agents)
    .get();
  return Number(row?.n ?? 0);
}
