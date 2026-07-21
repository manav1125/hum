/**
 * Missions — outcome-oriented goals sitting above projects (the HQ layer).
 * A mission declares the destination (outcome + metric + horizon); ordinary
 * projects link to it via projects.mission_id as its initiatives; work items
 * flow through those projects exactly as today.
 *
 * Referential integrity is by convention (store-enforced, no FKs), matching
 * project-store: deleting a mission nulls projects.mission_id, never cascades.
 *
 * Also home to:
 *   - the single-row company profile (identity / direction / never-lines /
 *     workspace autonomy mode) the orchestrator injects into every cycle,
 *   - the mission_events audit trail,
 *   - the exact-once plan-fingerprint claim (adapted from Paperclip, MIT,
 *     github.com/paperclipai/paperclip — decomposition idempotency keys).
 */

import { randomUUID } from "node:crypto";

import { asc, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import {
  companyProfile,
  missionEvents,
  missionPlanFingerprints,
  missions,
  projects,
  workItems,
} from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";
import type { WorkItemStatus } from "../work-items/work-item-store.js";

const log = getLogger("mission-store");

// ── Types ────────────────────────────────────────────────────────────

export type MissionStatus = "active" | "paused" | "achieved" | "abandoned";
export type MissionMode = "observe" | "assist" | "autonomous";

/** Hard cap on the regenerated continuation summary (chars ≈ bytes). */
export const CONTINUATION_SUMMARY_MAX_CHARS = 8_000;

export interface Mission {
  id: string;
  title: string;
  /** The measurable outcome the mission drives toward. */
  outcome: string;
  /** Optional metric the outcome is tracked by. */
  metric: string | null;
  /** Optional target date, epoch ms. */
  horizon: number | null;
  status: MissionStatus;
  /** Per-mission autonomy override; null = workspace default. */
  mode: MissionMode | null;
  /** The mission "why" — brief injected into every planning cycle. */
  brief: string | null;
  /** 'hourly' | 'daily' | 'weekly'; null = default (daily). */
  cadence: string | null;
  /**
   * Wall-clock sweep time "HH:mm" (24h, daemon-local tz) for daily/weekly
   * cadence; hourly ignores it. Null = legacy rolling-interval scheduling
   * (pre-migration-309 rows) — clients render the clock-less fallback.
   */
  sweepAt: string | null;
  /** Hard spend cap in cents; null = uncapped. */
  budgetCents: number | null;
  spentCents: number;
  /** Bounded (~8KB) per-cycle regenerated state doc. */
  continuationSummary: string | null;
  pinned: number;
  sortIndex: number | null;
  lastCycleAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MissionRollup {
  /** Linked initiative projects (id/title/emoji/status). */
  projects: Array<{
    id: string;
    title: string;
    emoji: string | null;
    status: string;
  }>;
  /** Work-item counts by status across all linked projects. */
  counts: {
    queued: number;
    running: number;
    awaiting_review: number;
    done: number;
    failed: number;
    open: number;
    total: number;
  };
  spentCents: number;
  budgetCents: number | null;
}

export interface MissionWithRollup extends Mission {
  rollup: MissionRollup;
}

export interface CompanyProfile {
  /** Who we are — identity/positioning blurb. */
  identity: string | null;
  /** Where we're going — direction/strategy notes. */
  direction: string | null;
  /** Hard boundaries the AI may never cross. */
  neverLines: string[];
  /** Workspace-default autonomy mode. */
  workspaceMode: MissionMode;
  updatedAt: number | null;
}

export type MissionEventKind =
  | "cycle_started"
  | "assessed"
  | "planned"
  | "item_enqueued"
  | "output_ready"
  | "checkpoint"
  | "budget_stop"
  | "reported"
  | "error";

export interface MissionEvent {
  id: string;
  missionId: string;
  kind: MissionEventKind;
  cycleId: string | null;
  /** JSON payload — event-kind-specific details. */
  payload: string | null;
  at: number;
}

// ── Mission CRUD ─────────────────────────────────────────────────────

export function createMission(opts: {
  title: string;
  outcome: string;
  metric?: string;
  horizon?: number;
  mode?: MissionMode;
  brief?: string;
  cadence?: string;
  sweepAt?: string;
  budgetCents?: number;
  pinned?: boolean;
  sortIndex?: number;
}): Mission {
  const db = getDb();
  const now = Date.now();
  const mission: Mission = {
    id: randomUUID(),
    title: opts.title,
    outcome: opts.outcome,
    metric: opts.metric ?? null,
    horizon: opts.horizon ?? null,
    status: "active",
    mode: opts.mode ?? null,
    brief: opts.brief ?? null,
    cadence: opts.cadence ?? null,
    // New missions get a real sweep clock by default; only legacy rows are
    // clock-less.
    sweepAt: opts.sweepAt ?? "08:00",
    budgetCents: opts.budgetCents ?? null,
    spentCents: 0,
    continuationSummary: null,
    pinned: opts.pinned ? 1 : 0,
    sortIndex: opts.sortIndex ?? null,
    lastCycleAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(missions).values(mission).run();
  return mission;
}

export function getMission(id: string): Mission | undefined {
  const db = getDb();
  return db.select().from(missions).where(eq(missions.id, id)).get() as
    | Mission
    | undefined;
}

/**
 * List missions, pinned-first then manual sortIndex (nulls last) then newest —
 * the same ordering contract as listProjects. Defaults to every non-abandoned
 * mission; pass a status to filter.
 */
export function listMissions(opts?: { status?: MissionStatus }): Mission[] {
  const db = getDb();
  const sortIndexNullsLast = sql`CASE WHEN ${missions.sortIndex} IS NULL THEN 1 ELSE 0 END`;
  let query = db.select().from(missions);
  if (opts?.status) {
    query = query.where(eq(missions.status, opts.status)) as typeof query;
  } else {
    query = query.where(sql`${missions.status} != 'abandoned'`) as typeof query;
  }
  return query
    .orderBy(
      desc(missions.pinned),
      sortIndexNullsLast,
      asc(missions.sortIndex),
      desc(missions.createdAt),
    )
    .all() as Mission[];
}

export function updateMission(
  id: string,
  updates: Partial<
    Pick<
      Mission,
      | "title"
      | "outcome"
      | "metric"
      | "horizon"
      | "status"
      | "mode"
      | "brief"
      | "cadence"
      | "sweepAt"
      | "budgetCents"
      | "spentCents"
      | "continuationSummary"
      | "pinned"
      | "sortIndex"
      | "lastCycleAt"
    >
  >,
): Mission | undefined {
  const db = getDb();
  const next = { ...updates };
  // The continuation summary is bounded by contract — enforce at the choke
  // point so no caller can grow it unbounded.
  if (
    typeof next.continuationSummary === "string" &&
    next.continuationSummary.length > CONTINUATION_SUMMARY_MAX_CHARS
  ) {
    next.continuationSummary = `${next.continuationSummary
      .slice(0, CONTINUATION_SUMMARY_MAX_CHARS - 20)
      .trimEnd()}\n[truncated]`;
  }
  db.update(missions)
    .set({ ...next, updatedAt: Date.now() })
    .where(eq(missions.id, id))
    .run();
  return getMission(id);
}

/**
 * Hard-delete a mission. Linked projects keep living — their mission_id is
 * nulled so they fall back to the unlinked pool (mirrors deleteProject's
 * handling of work items). Events and fingerprints go with the mission.
 */
export function deleteMission(id: string): void {
  const db = getDb();
  db.update(projects)
    .set({ missionId: null, updatedAt: Date.now() })
    .where(eq(projects.missionId, id))
    .run();
  db.delete(missionEvents).where(eq(missionEvents.missionId, id)).run();
  db.delete(missionPlanFingerprints)
    .where(eq(missionPlanFingerprints.missionId, id))
    .run();
  db.delete(missions).where(eq(missions.id, id)).run();
}

// ── Rollups ──────────────────────────────────────────────────────────

/** Projects linked to a mission (its initiatives). */
export function listMissionProjects(missionId: string): Array<{
  id: string;
  title: string;
  emoji: string | null;
  status: string;
}> {
  const db = getDb();
  return db
    .select({
      id: projects.id,
      title: projects.title,
      emoji: projects.emoji,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.missionId, missionId))
    .orderBy(desc(projects.pinned), asc(projects.sortIndex))
    .all();
}

function computeMissionRollup(mission: Mission): MissionRollup {
  const db = getDb();
  const linked = listMissionProjects(mission.id);
  const counts = {
    queued: 0,
    running: 0,
    awaiting_review: 0,
    done: 0,
    failed: 0,
    open: 0,
    total: 0,
  };
  if (linked.length > 0) {
    const rows = db
      .select({ status: workItems.status, count: sql<number>`count(*)` })
      .from(workItems)
      .where(
        inArray(
          workItems.projectId,
          linked.map((p) => p.id),
        ),
      )
      .groupBy(workItems.status)
      .all() as Array<{ status: WorkItemStatus; count: number }>;
    for (const r of rows) {
      counts.total += r.count;
      if (r.status === "queued") counts.queued = r.count;
      else if (r.status === "running") counts.running = r.count;
      else if (r.status === "awaiting_review") counts.awaiting_review = r.count;
      else if (r.status === "done") counts.done = r.count;
      else if (r.status === "failed") counts.failed = r.count;
    }
    counts.open = counts.queued + counts.running + counts.awaiting_review;
  }
  return {
    projects: linked,
    counts,
    spentCents: mission.spentCents,
    budgetCents: mission.budgetCents,
  };
}

export function getMissionWithRollup(
  id: string,
): MissionWithRollup | undefined {
  const mission = getMission(id);
  if (!mission) return undefined;
  return { ...mission, rollup: computeMissionRollup(mission) };
}

/** List missions with rollups, in the same order as {@link listMissions}. */
export function listMissionsWithRollups(opts?: {
  status?: MissionStatus;
}): MissionWithRollup[] {
  return listMissions(opts).map((m) => ({
    ...m,
    rollup: computeMissionRollup(m),
  }));
}

// ── Company profile ──────────────────────────────────────────────────

const COMPANY_PROFILE_ID = "company";

const DEFAULT_PROFILE: CompanyProfile = {
  identity: null,
  direction: null,
  neverLines: [],
  workspaceMode: "assist",
  updatedAt: null,
};

function parseNeverLines(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((l): l is string => typeof l === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeMode(raw: string | null | undefined): MissionMode {
  return raw === "observe" || raw === "autonomous" ? raw : "assist";
}

/** Read the single-row company profile; a missing row reads as defaults. */
export function getCompanyProfile(): CompanyProfile {
  const db = getDb();
  const row = db
    .select()
    .from(companyProfile)
    .where(eq(companyProfile.id, COMPANY_PROFILE_ID))
    .get();
  if (!row) return { ...DEFAULT_PROFILE };
  return {
    identity: row.identity,
    direction: row.direction,
    neverLines: parseNeverLines(row.neverLines),
    workspaceMode: normalizeMode(row.workspaceMode),
    updatedAt: row.updatedAt,
  };
}

/** Upsert the single-row company profile. Partial — omitted fields keep their value. */
export function updateCompanyProfile(updates: {
  identity?: string | null;
  direction?: string | null;
  neverLines?: string[];
  workspaceMode?: MissionMode;
}): CompanyProfile {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(companyProfile)
    .where(eq(companyProfile.id, COMPANY_PROFILE_ID))
    .get();
  if (!existing) {
    db.insert(companyProfile)
      .values({
        id: COMPANY_PROFILE_ID,
        identity: updates.identity ?? null,
        direction: updates.direction ?? null,
        neverLines: JSON.stringify(updates.neverLines ?? []),
        workspaceMode: updates.workspaceMode ?? "assist",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } else {
    db.update(companyProfile)
      .set({
        ...(updates.identity !== undefined
          ? { identity: updates.identity }
          : {}),
        ...(updates.direction !== undefined
          ? { direction: updates.direction }
          : {}),
        ...(updates.neverLines !== undefined
          ? { neverLines: JSON.stringify(updates.neverLines) }
          : {}),
        ...(updates.workspaceMode !== undefined
          ? { workspaceMode: updates.workspaceMode }
          : {}),
        updatedAt: now,
      })
      .where(eq(companyProfile.id, COMPANY_PROFILE_ID))
      .run();
  }
  return getCompanyProfile();
}

// ── Mission events (audit trail) ─────────────────────────────────────

/** Best-effort insert — a broken audit write must never break a cycle. */
export function recordMissionEvent(opts: {
  missionId: string;
  kind: MissionEventKind;
  cycleId?: string;
  payload?: unknown;
}): void {
  try {
    const db = getDb();
    db.insert(missionEvents)
      .values({
        id: randomUUID(),
        missionId: opts.missionId,
        kind: opts.kind,
        cycleId: opts.cycleId ?? null,
        payload:
          opts.payload === undefined ? null : JSON.stringify(opts.payload),
        at: Date.now(),
      })
      .run();
  } catch (err) {
    log.warn(
      { err: String(err), missionId: opts.missionId, kind: opts.kind },
      "mission event write failed (ignored)",
    );
  }
}

export function listMissionEvents(
  missionId: string,
  opts?: { limit?: number },
): MissionEvent[] {
  const db = getDb();
  // Newest-first with a bound, then re-sorted ascending so callers always see
  // chronological order over the most recent window. rowid breaks
  // same-millisecond ties by insertion order.
  const rows = db
    .select()
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .orderBy(desc(missionEvents.at), sql`rowid DESC`)
    .limit(Math.max(1, Math.min(opts?.limit ?? 200, 1000)))
    .all() as MissionEvent[];
  return rows.reverse();
}

// ── Drift detection (§6 lifecycle — derived, no new table) ───────────────

/** Cycles a mission may idle (no progress event) before a drift nudge fires. */
export const DRIFT_STALE_CYCLES = 3;

/**
 * Event kinds that count as real forward motion. A cycle that only started,
 * assessed, planned, or reported without producing any of these is "idling" —
 * it burned a cycle but moved nothing.
 */
const PROGRESS_KINDS = new Set<MissionEventKind>([
  "item_enqueued",
  "output_ready",
]);

export interface MissionDriftState {
  /** Distinct cycle windows observed (capped at the scan window). */
  cyclesObserved: number;
  /** Consecutive most-recent cycles with no progress-bearing event. */
  idleCycles: number;
  /** True once idle streak reaches the stale threshold. */
  drifting: boolean;
  /** The most-recent cycleId — the idempotency key for the nudge. */
  latestCycleId: string | null;
}

/**
 * Derive a mission's drift state from its event trail alone. Groups the recent
 * events into cycle windows (by cycleId, newest-first), then counts how many of
 * the most-recent windows produced zero progress-bearing events. Events with no
 * cycleId (manual notes) are ignored for windowing.
 */
export function computeMissionDrift(missionId: string): MissionDriftState {
  // A generous window: DRIFT_STALE_CYCLES cycles rarely exceed a few dozen
  // events, but pull extra so a chatty cycle can't push older ones out of view.
  const events = listMissionEvents(missionId, { limit: 400 });
  // Walk newest-first, collecting distinct cycles and whether each made progress.
  const order: string[] = [];
  const madeProgress = new Map<string, boolean>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (!e.cycleId) continue;
    if (!madeProgress.has(e.cycleId)) {
      order.push(e.cycleId);
      madeProgress.set(e.cycleId, false);
    }
    if (PROGRESS_KINDS.has(e.kind)) madeProgress.set(e.cycleId, true);
  }
  const latestCycleId = order[0] ?? null;
  let idleCycles = 0;
  for (const cycleId of order) {
    if (madeProgress.get(cycleId)) break;
    idleCycles++;
  }
  return {
    cyclesObserved: order.length,
    idleCycles,
    drifting:
      order.length >= DRIFT_STALE_CYCLES && idleCycles >= DRIFT_STALE_CYCLES,
    latestCycleId,
  };
}

/**
 * Emit a drift-nudge checkpoint when an active, un-paused mission has idled for
 * {@link DRIFT_STALE_CYCLES} cycles. Idempotent per cycle window: a nudge is
 * recorded at most once per `latestCycleId`, so repeated sweeps within the same
 * window never spam the trail. Returns true when a nudge was newly emitted.
 */
export function maybeEmitMissionDrift(missionId: string): boolean {
  const mission = getMission(missionId);
  if (!mission || mission.status !== "active") return false;
  const drift = computeMissionDrift(missionId);
  if (!drift.drifting || !drift.latestCycleId) return false;

  // Idempotency: has a drift checkpoint already fired for this cycle window?
  const recent = listMissionEvents(missionId, { limit: 60 });
  for (const e of recent) {
    if (e.kind !== "checkpoint" || e.cycleId !== drift.latestCycleId) continue;
    try {
      const p = e.payload
        ? (JSON.parse(e.payload) as { drift?: unknown })
        : null;
      if (p && p.drift === true) return false;
    } catch {
      // Non-JSON checkpoint — not a drift marker, keep scanning.
    }
  }

  recordMissionEvent({
    missionId,
    kind: "checkpoint",
    cycleId: drift.latestCycleId,
    payload: {
      drift: true,
      idleCycles: drift.idleCycles,
      note: `Idling — ${drift.idleCycles} cycles with nothing to run. Replan, step in, or pause.`,
    },
  });
  return true;
}

// ── Achieved-summary rollup (§6 celebration stats) ───────────────────────

export interface MissionAchievedSummary {
  /** Cycles run over the mission's life (distinct cycleIds in the trail). */
  cycles: number;
  /** Outputs produced (output_ready events). */
  outputs: number;
  /** Work items the mission enqueued (item_enqueued events). */
  itemsEnqueued: number;
  /** Total spend in cents. */
  spentCents: number;
  /** Mission lifespan in ms (created → achieved/last event), or null. */
  durationMs: number | null;
  /** Conservative "hours back" estimate (30 min per output, whole hours). */
  hoursSaved: number;
}

/**
 * Roll a mission's life up into the celebration stats — cycles run, outputs,
 * spend, duration — from its events + stored spend. Read-only; safe to call on
 * any mission regardless of status (the UI only shows it when achieved).
 */
export function getMissionAchievedSummary(
  missionId: string,
): MissionAchievedSummary | undefined {
  const mission = getMission(missionId);
  if (!mission) return undefined;
  const events = listMissionEvents(missionId, { limit: 1000 });
  const cycles = new Set<string>();
  let outputs = 0;
  let itemsEnqueued = 0;
  let lastEventAt = mission.createdAt;
  for (const e of events) {
    if (e.cycleId) cycles.add(e.cycleId);
    if (e.kind === "output_ready") outputs++;
    if (e.kind === "item_enqueued") itemsEnqueued++;
    if (e.at > lastEventAt) lastEventAt = e.at;
  }
  const durationMs =
    lastEventAt > mission.createdAt ? lastEventAt - mission.createdAt : null;
  return {
    cycles: cycles.size,
    outputs,
    itemsEnqueued,
    spentCents: mission.spentCents,
    durationMs,
    // 30 minutes saved per output landed, floored to whole hours — the same
    // conservative posture as the act ledger's TIME BACK chip.
    hoursSaved: Math.floor((outputs * 30) / 60),
  };
}

// ── Exact-once plan fingerprints ─────────────────────────────────────

/**
 * Claim an exact-once plan fingerprint. Returns true when THIS caller won the
 * claim (safe to enqueue the plan's items), false when the fingerprint was
 * already claimed — i.e. an earlier cycle (possibly one that crashed after
 * enqueuing) already materialized this exact plan for this mission.
 *
 * Adapted from Paperclip (MIT, github.com/paperclipai/paperclip): its
 * plan-to-task decomposition stamps `sourceIssueId` + `planRevisionId` on
 * created tasks and its wake queue dedupes on `idempotencyKey` — the same
 * insert-first, unique-key exact-once shape as this table.
 */
export function claimMissionPlanFingerprint(
  missionId: string,
  planHash: string,
): boolean {
  // Raw statement: the claim's return value is the INSERT's change count
  // (drizzle's bun-sqlite `.run()` is typed void, so it can't report it).
  const raw = getSqliteFrom(getDb());
  const fingerprint = `${missionId}:${planHash}`;
  const result = raw
    .prepare(
      /*sql*/ `INSERT OR IGNORE INTO mission_plan_fingerprints (fingerprint, mission_id, at) VALUES (?, ?, ?)`,
    )
    .run(fingerprint, missionId, Date.now());
  return result.changes > 0;
}
