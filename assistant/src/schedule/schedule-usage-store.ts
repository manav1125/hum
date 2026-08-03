import { rawAll } from "../memory/raw-query.js";
import { buildScheduleAttributionSubquery } from "../memory/schedule-attribution-sql.js";

export interface ScheduleUsageSummary {
  scheduleId: string;
  runCount: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

export type SystemTaskUsageKind =
  | "heartbeat"
  | "consolidation"
  | "retrospective";

export interface SystemTaskUsageSummary {
  kind: SystemTaskUsageKind;
  runCount: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

interface ScheduleUsageSummaryRow {
  schedule_id: string;
  run_count: number;
  total_estimated_cost_usd: number | null;
  event_count: number | null;
}

export function getScheduleUsageSummaries({
  from,
  to,
}: {
  from: number;
  to: number;
}): ScheduleUsageSummary[] {
  const now = Date.now();
  const scheduleAttribution = buildScheduleAttributionSubquery({
    eventAlias: "e",
    now,
    selectExpression: "schedule_attr_runs.job_id",
  });
  const rows = rawAll<ScheduleUsageSummaryRow>(
    /*sql*/ `
    WITH run_counts AS (
      SELECT
        job_id AS schedule_id,
        COUNT(*) AS run_count
      FROM cron_runs
      WHERE started_at >= ?
        AND started_at <= ?
      GROUP BY job_id
    ),
    attributed_usage AS (
      SELECT
        e.estimated_cost_usd,
        COALESCE(e.llm_call_count, 1) AS event_count,
        ${scheduleAttribution.sql} AS schedule_id
      FROM llm_usage_events e
      WHERE e.created_at >= ?
        AND e.created_at <= ?
    ),
    usage_totals AS (
      SELECT
        schedule_id,
        COALESCE(SUM(estimated_cost_usd), 0) AS total_estimated_cost_usd,
        COALESCE(SUM(event_count), 0) AS event_count
      FROM attributed_usage
      WHERE schedule_id IS NOT NULL
      GROUP BY schedule_id
    )
    SELECT
      cron_jobs.id AS schedule_id,
      COALESCE(run_counts.run_count, 0) AS run_count,
      COALESCE(usage_totals.total_estimated_cost_usd, 0) AS total_estimated_cost_usd,
      COALESCE(usage_totals.event_count, 0) AS event_count
    FROM cron_jobs
    LEFT JOIN run_counts ON run_counts.schedule_id = cron_jobs.id
    LEFT JOIN usage_totals ON usage_totals.schedule_id = cron_jobs.id
    ORDER BY cron_jobs.created_at ASC, cron_jobs.id ASC
    `,
    from,
    to,
    ...scheduleAttribution.params,
    from,
    to,
  );

  return rows.map((row) => ({
    scheduleId: row.schedule_id,
    runCount: row.run_count,
    totalEstimatedCostUsd: row.total_estimated_cost_usd ?? 0,
    eventCount: row.event_count ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Built-in system jobs (heartbeat, consolidation, memory retrospective)
// ---------------------------------------------------------------------------

/**
 * The `llm_usage_events.call_site` each built-in system job bills under.
 *
 * Cost is aggregated on `call_site` rather than by joining run rows to their
 * conversation (the way user schedules attribute via `cron_runs`) because two
 * of the three jobs have no durable run row to join to:
 *
 * - Consolidation runs with `ephemeralConversation: true` — the runner deletes
 *   the conversation once the run settles, so the `source =
 *   'memory_v2_consolidation'` lookup that backs `consolidation/runs` finds
 *   nothing and a conversation join attributes exactly $0 to a job that really
 *   does spend money.
 * - Retrospective runs are garbage-collected when superseded
 *   (`memory.retrospective.keepSupersededRuns: false`).
 *
 * The usage event outlives the run row in both cases, and `call_site` is
 * written at the call itself, so it stays exact where a join silently drops to
 * zero. For heartbeat — the one job with a durable run table — the two agree
 * to the cent, which is what makes this substitution safe.
 */
const SYSTEM_TASK_CALL_SITES: Record<SystemTaskUsageKind, string> = {
  heartbeat: "heartbeatAgent",
  consolidation: "memoryV2Consolidation",
  retrospective: "memoryRetrospective",
};

const SYSTEM_TASK_KINDS = Object.keys(
  SYSTEM_TASK_CALL_SITES,
) as SystemTaskUsageKind[];

interface SystemTaskUsageRow {
  call_site: string;
  run_count: number | null;
  total_estimated_cost_usd: number | null;
  event_count: number | null;
}

/**
 * Per-system-job run counts and usage totals over `[from, to]` (epoch millis).
 *
 * This is the server-side counterpart to `getScheduleUsageSummaries` and exists
 * for the same reason: the total must cover the whole window the caller asked
 * for. Summing a bounded page of fetched runs on the client cannot do that —
 * heartbeat alone writes ~380 run rows a week, so any fixed page size covers a
 * fraction of a 7-day window and silently under-reports the tail.
 *
 * Run counts come from the most authoritative source available per job:
 *
 * - **heartbeat** counts every row in `heartbeat_runs` inside the window,
 *   including skipped and superseded attempts, matching what `heartbeat/runs`
 *   lists and what `cron_runs` counts for user schedules.
 * - **consolidation / retrospective** have no durable run table, so they count
 *   distinct billed conversations. That counts runs that actually reached the
 *   model — a skipped consolidation (lock held, empty buffer) leaves no trace
 *   to count and costs nothing either way.
 */
export function getSystemTaskUsageSummaries({
  from,
  to,
}: {
  from: number;
  to: number;
}): SystemTaskUsageSummary[] {
  const usageRows = rawAll<SystemTaskUsageRow>(
    /*sql*/ `
    SELECT
      call_site,
      COUNT(DISTINCT conversation_id) AS run_count,
      COALESCE(SUM(estimated_cost_usd), 0) AS total_estimated_cost_usd,
      COALESCE(SUM(COALESCE(llm_call_count, 1)), 0) AS event_count
    FROM llm_usage_events
    WHERE call_site IN (?, ?, ?)
      AND created_at >= ?
      AND created_at <= ?
    GROUP BY call_site
    `,
    SYSTEM_TASK_CALL_SITES.heartbeat,
    SYSTEM_TASK_CALL_SITES.consolidation,
    SYSTEM_TASK_CALL_SITES.retrospective,
    from,
    to,
  );

  const usageByCallSite = new Map(usageRows.map((row) => [row.call_site, row]));

  // Heartbeat is the one system job with a durable run table, so its run count
  // comes from there — a skipped heartbeat is still a run the history lists,
  // and it bills nothing, so counting billed conversations would undercount it.
  // `started_at` is null for skipped rows; the run list keys those off
  // `created_at`, so the window filter has to as well.
  const heartbeatRunRows = rawAll<{ run_count: number | null }>(
    /*sql*/ `
    SELECT COUNT(*) AS run_count
    FROM heartbeat_runs
    WHERE COALESCE(started_at, created_at) >= ?
      AND COALESCE(started_at, created_at) <= ?
    `,
    from,
    to,
  );

  return SYSTEM_TASK_KINDS.map((kind) => {
    const usage = usageByCallSite.get(SYSTEM_TASK_CALL_SITES[kind]);
    return {
      kind,
      runCount:
        kind === "heartbeat"
          ? (heartbeatRunRows[0]?.run_count ?? 0)
          : (usage?.run_count ?? 0),
      totalEstimatedCostUsd: usage?.total_estimated_cost_usd ?? 0,
      eventCount: usage?.event_count ?? 0,
    };
  });
}
