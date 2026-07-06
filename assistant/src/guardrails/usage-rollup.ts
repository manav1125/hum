/**
 * Workspace LLM usage rollup for the Guardrails ledger — the honest pricing
 * story ("this week Cue cost $4.12 · 82% Haiku / 18% Sonnet").
 *
 * Scope: ALL llm_usage_events rows in the window — chat, schedules, meetings,
 * and work-item runs alike. This is deliberately broader than the per-agent
 * attributed spend (agent-store.getAgentSpend), which counts only the
 * work-item-run slice it can honestly attribute to a staffed agent; the
 * rollup answers "what did Cue cost in total", the attribution answers "which
 * agent spent it". Cents are rounded from the stored USD floats at the
 * aggregate, matching getAgentSpend.
 */

import { rawAll } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardrails-usage-rollup");

export interface ModelMixEntry {
  model: string;
  /** Estimated cost attributed to this model over the window, in cents. */
  costCents: number;
  /** LLM calls on this model over the window. */
  calls: number;
  /** costCents / total (0..1); 0 when the window total is zero. */
  share: number;
}

export interface UsageRollup {
  /** Total estimated LLM cost over the window, in cents (workspace-wide). */
  totalCents: number;
  /** Per-model breakdown, highest-cost first. */
  byModel: ModelMixEntry[];
  from: number;
  to: number;
}

/**
 * Workspace usage totals + model mix over the trailing `days` window
 * (default 7). Best-effort: a usage-store hiccup returns an empty rollup
 * rather than breaking the Guardrails page.
 */
export function getUsageRollup(opts?: { days?: number }): UsageRollup {
  const to = Date.now();
  const days =
    opts?.days != null && Number.isFinite(opts.days) && opts.days > 0
      ? opts.days
      : 7;
  const from = to - days * 24 * 60 * 60 * 1000;

  let rows: Array<{ model: string; cost_usd: number | null; calls: number }> =
    [];
  try {
    rows = rawAll<{ model: string; cost_usd: number | null; calls: number }>(
      /*sql*/ `
      SELECT
        COALESCE(NULLIF(TRIM(model), ''), 'unknown') AS model,
        COALESCE(SUM(estimated_cost_usd), 0)          AS cost_usd,
        COUNT(*)                                      AS calls
      FROM llm_usage_events
      WHERE created_at >= ?1 AND created_at <= ?2
      GROUP BY 1
      `,
      from,
      to,
    );
  } catch (err) {
    log.warn({ err: String(err) }, "failed to compute usage rollup (ignored)");
    rows = [];
  }

  const byModelRaw = rows
    .map((r) => ({
      model: r.model,
      costCents: Math.round((r.cost_usd ?? 0) * 100),
      calls: Number(r.calls),
    }))
    .sort(
      (a, b) => b.costCents - a.costCents || a.model.localeCompare(b.model),
    );
  const totalCents = byModelRaw.reduce((sum, r) => sum + r.costCents, 0);

  return {
    totalCents,
    byModel: byModelRaw.map((r) => ({
      ...r,
      share: totalCents > 0 ? r.costCents / totalCents : 0,
    })),
    from,
    to,
  };
}

// ── Per-mission attribution ──────────────────────────────────────────

export interface MissionSpend {
  missionId: string;
  missionTitle: string;
  /** Real attributed LLM cost over the window, in cents. */
  costCents: number;
  /** Run conversations that contributed. */
  runs: number;
}

/**
 * Per-mission attributed spend over the trailing `days` window (default 7)
 * — the "$ by mission" slice of the Guardrails ledger.
 *
 * Derivation (real, not a fabricated split — the same attribution chain as
 * agent-store.getAgentSpend, extended one hop): llm_usage_events →
 * work_items on usage.conversation_id = work_items.last_run_conversation_id
 * → projects on work_items.project_id → missions on projects.mission_id.
 *
 * Honest limits, matching getAgentSpend:
 *   - Only the LATEST run conversation per work item is tracked, so spend
 *     from a superseded prior run of the same item is not attributed.
 *   - Cost outside a work-item run (chat, schedules, meetings) and cost on
 *     items with no project → mission chain is intentionally excluded.
 *   - Missions with no attributable cost in the window are omitted.
 * Best-effort: a usage-store hiccup returns an empty list.
 */
export function getMissionSpend(opts?: { days?: number }): MissionSpend[] {
  const to = Date.now();
  const days =
    opts?.days != null && Number.isFinite(opts.days) && opts.days > 0
      ? opts.days
      : 7;
  const from = to - days * 24 * 60 * 60 * 1000;

  let rows: Array<{
    mission_id: string;
    mission_title: string;
    cost_usd: number | null;
    runs: number;
  }> = [];
  try {
    rows = rawAll<{
      mission_id: string;
      mission_title: string;
      cost_usd: number | null;
      runs: number;
    }>(
      /*sql*/ `
      SELECT
        m.id                                   AS mission_id,
        m.title                                AS mission_title,
        COALESCE(SUM(u.estimated_cost_usd), 0) AS cost_usd,
        COUNT(DISTINCT u.conversation_id)      AS runs
      FROM llm_usage_events u
      JOIN work_items wi ON wi.last_run_conversation_id = u.conversation_id
      JOIN projects p    ON p.id = wi.project_id
      JOIN missions m    ON m.id = p.mission_id
      WHERE u.conversation_id IS NOT NULL
        AND u.created_at >= ?1
        AND u.created_at <= ?2
      GROUP BY m.id, m.title
      `,
      from,
      to,
    );
  } catch (err) {
    log.warn({ err: String(err) }, "failed to compute mission spend (ignored)");
    rows = [];
  }

  return rows
    .map((r) => ({
      missionId: r.mission_id,
      missionTitle: r.mission_title,
      costCents: Math.round((r.cost_usd ?? 0) * 100),
      runs: Number(r.runs),
    }))
    .filter((r) => r.costCents > 0)
    .sort(
      (a, b) =>
        b.costCents - a.costCents ||
        a.missionTitle.localeCompare(b.missionTitle),
    );
}
