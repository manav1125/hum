/**
 * Persistence for the volume valve: bands, stops, and what the owner taught it.
 *
 * Every read in here degrades toward LOUD. A query that throws returns the
 * value that makes work visible — no band (which the reader treats as urgent),
 * the default stop, an empty learned set — because a database hiccup is not a
 * judgement about anybody's mail. Nothing in this file deletes a row.
 */

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import {
  valveBands,
  valveFeedback,
  valveStops,
} from "../memory/schema/valve.js";
import { listMissionProjects } from "../missions/mission-store.js";
import { getLogger } from "../util/logger.js";
import {
  type BandVerdict,
  DEFAULT_STOP,
  isValveBand,
  isValveStop,
  type ValveBand,
  type ValveBandedBy,
  type ValveRuleId,
  type ValveStop,
} from "./valve-bands.js";

const log = getLogger("valve-store");

export const GLOBAL_SCOPE = "global";

/** The scope key for one mission's override. */
export function missionScope(missionId: string): string {
  return `mission:${missionId}`;
}

/** Read a mission id back out of a scope key, or null for the global row. */
export function missionIdFromScope(scope: string): string | null {
  return scope.startsWith("mission:") ? scope.slice("mission:".length) : null;
}

export interface ValveBandRow {
  workItemId: string;
  band: ValveBand;
  ruleId: string;
  reason: string;
  bandedBy: ValveBandedBy;
  arrivalId: string | null;
  senderKey: string | null;
  missionId: string | null;
  surfacedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

export interface StampBandInput {
  workItemId: string;
  verdict: BandVerdict;
  arrivalId?: string | null;
  senderKey?: string | null;
  missionId?: string | null;
}

/**
 * Record one item's band.
 *
 * Never throws. A stamp that fails leaves the item with no band row, and a
 * work item with no band row reads as urgent — so the failure mode of this
 * function is "the owner sees it anyway", which is the correct direction and
 * the reason it is safe for it to be best-effort.
 */
export function stampBand(input: StampBandInput): void {
  const now = Date.now();
  try {
    getDb()
      .insert(valveBands)
      .values({
        workItemId: input.workItemId,
        band: input.verdict.band,
        ruleId: input.verdict.ruleId,
        reason: input.verdict.reason,
        bandedBy: input.verdict.bandedBy,
        arrivalId: input.arrivalId ?? null,
        senderKey: input.senderKey ?? null,
        missionId: input.missionId ?? null,
        surfacedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: valveBands.workItemId,
        set: {
          band: input.verdict.band,
          ruleId: input.verdict.ruleId,
          reason: input.verdict.reason,
          bandedBy: input.verdict.bandedBy,
          arrivalId: input.arrivalId ?? null,
          senderKey: input.senderKey ?? null,
          missionId: input.missionId ?? null,
          updatedAt: now,
        },
      })
      .run();
  } catch (err) {
    log.warn(
      { err: String(err), workItemId: input.workItemId },
      "could not stamp a valve band (the item stays loud)",
    );
  }
}

/** Bands for a set of work items, keyed by work item id. Never throws. */
export function getBands(workItemIds: string[]): Map<string, ValveBandRow> {
  const out = new Map<string, ValveBandRow>();
  if (workItemIds.length === 0) return out;
  try {
    const rows = getDb()
      .select()
      .from(valveBands)
      .where(inArray(valveBands.workItemId, workItemIds))
      .all() as ValveBandRow[];
    for (const row of rows) {
      // A band value the code does not recognise is a band the code cannot
      // honour. Dropping the row means the item reads as urgent, which is the
      // only safe way to be confused about how loud something is.
      if (!isValveBand(row.band)) continue;
      out.set(row.workItemId, row);
    }
  } catch (err) {
    log.warn(
      { err: String(err), count: workItemIds.length },
      "could not read valve bands (every item stays loud)",
    );
  }
  return out;
}

/**
 * Mark items as having interrupted the owner, so already-seen work can rest.
 *
 * Only ever sets `surfacedAt` on rows where it is still null — "when did this
 * first reach them" must not be pushed forward by every subsequent read, or
 * nothing would ever rest.
 */
export function markSurfaced(workItemIds: string[], now = Date.now()): void {
  if (workItemIds.length === 0) return;
  try {
    getDb()
      .update(valveBands)
      .set({ surfacedAt: now, updatedAt: now })
      .where(
        and(
          inArray(valveBands.workItemId, workItemIds),
          isNull(valveBands.surfacedAt),
        ),
      )
      .run();
  } catch (err) {
    log.warn({ err: String(err) }, "could not mark items surfaced");
  }
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

export interface ValveStopRow {
  scope: string;
  stop: ValveStop;
  updatedAt: number;
  updatedBy: string;
}

/** The global stop, or {@link DEFAULT_STOP} when unset or unreadable. */
export function getGlobalStop(): ValveStop {
  try {
    const row = getDb()
      .select()
      .from(valveStops)
      .where(eq(valveStops.scope, GLOBAL_SCOPE))
      .get() as { stop: string } | undefined;
    if (row && isValveStop(row.stop)) return row.stop;
  } catch (err) {
    log.warn({ err: String(err) }, "could not read the valve stop");
  }
  return DEFAULT_STOP;
}

/** Every stop row, global first. Never throws. */
export function listStops(): ValveStopRow[] {
  try {
    return (
      getDb()
        .select()
        .from(valveStops)
        .orderBy(valveStops.scope)
        .all() as Array<{
        scope: string;
        stop: string;
        updatedAt: number;
        updatedBy: string;
      }>
    )
      .filter((r): r is ValveStopRow => isValveStop(r.stop))
      .sort((a, b) =>
        a.scope === GLOBAL_SCOPE ? -1 : b.scope === GLOBAL_SCOPE ? 1 : 0,
      );
  } catch (err) {
    log.warn({ err: String(err) }, "could not list valve stops");
    return [];
  }
}

/** Set a stop. Throws — a write the owner asked for must report its failure. */
export function setStop(
  scope: string,
  stop: ValveStop,
  actor = "user",
): ValveStopRow {
  const now = Date.now();
  getDb()
    .insert(valveStops)
    .values({ scope, stop, updatedAt: now, updatedBy: actor })
    .onConflictDoUpdate({
      target: valveStops.scope,
      set: { stop, updatedAt: now, updatedBy: actor },
    })
    .run();
  return { scope, stop, updatedAt: now, updatedBy: actor };
}

/**
 * Drop a per-mission override so the mission follows the global stop again.
 *
 * The one delete in the valve, and it removes a PREFERENCE, never an item. The
 * mission's work is untouched; it simply stops being treated specially.
 */
export function clearStop(scope: string): void {
  if (scope === GLOBAL_SCOPE) return;
  getDb().delete(valveStops).where(eq(valveStops.scope, scope)).run();
}

/**
 * The project ids belonging to missions bumped all the way up.
 *
 * Resolves mission → projects once per batch. A mission whose projects cannot
 * be read is skipped rather than fatal: losing a boost makes HQ quieter than
 * the owner asked for, so it is logged loudly, but it cannot take the whole
 * read down with it.
 */
export function boostedProjectIds(): Set<string> {
  const out = new Set<string>();
  for (const row of listStops()) {
    if (row.stop !== "everything") continue;
    const missionId = missionIdFromScope(row.scope);
    if (!missionId) continue;
    try {
      for (const project of listMissionProjects(missionId)) {
        out.add(project.id);
      }
    } catch (err) {
      log.warn(
        { err: String(err), missionId },
        "could not resolve a boosted mission's projects",
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export type ValveSubjectKind = "sender" | "channel" | "rule";

export interface ValveFeedbackRow {
  subjectKind: ValveSubjectKind;
  subjectKey: string;
  dismissed: number;
  kept: number;
  lastSignalAt: number;
}

/**
 * How many dismissals before a sender stops interrupting.
 *
 * Two, not one. A single ✕ is as likely to mean "dealt with it" as "never
 * show me this again", and the cost of being wrong is asymmetric — a sender
 * wrongly quieted is a person the owner stops hearing from. Two dismissals
 * with no intervening action is a pattern; one is an event.
 */
export const LEARN_DOWN_THRESHOLD = 2;

/** Record one correction. Never throws — learning is best-effort by nature. */
export function recordFeedback(
  subjectKind: ValveSubjectKind,
  subjectKey: string,
  signal: "dismissed" | "kept",
): void {
  const key = subjectKey.trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  try {
    getDb()
      .insert(valveFeedback)
      .values({
        subjectKind,
        subjectKey: key,
        dismissed: signal === "dismissed" ? 1 : 0,
        kept: signal === "kept" ? 1 : 0,
        lastSignalAt: now,
      })
      .onConflictDoUpdate({
        target: [valveFeedback.subjectKind, valveFeedback.subjectKey],
        set:
          signal === "dismissed"
            ? {
                dismissed: sql`${valveFeedback.dismissed} + 1`,
                lastSignalAt: now,
              }
            : { kept: sql`${valveFeedback.kept} + 1`, lastSignalAt: now },
      })
      .run();
  } catch (err) {
    log.warn(
      { err: String(err), subjectKind, subjectKey: key },
      "could not record valve feedback",
    );
  }
}

/**
 * The senders the owner has taught the valve to quiet.
 *
 * Loaded once per batch into a Set rather than queried per item, so the
 * predicate handed to the pure banding rules cannot do I/O.
 *
 * `dismissed > kept` as well as over the threshold: a sender the owner
 * dismissed twice and then acted on twice is not settled, and the row keeps
 * both numbers precisely so that case can be told apart from a clean one.
 *
 * An unreadable table returns an EMPTY set — nothing learned, nothing quieted.
 * That is the fail-open direction: a broken learning table must make Cue
 * noisier, never quieter.
 */
export function learnedDownSenders(): Set<string> {
  const out = new Set<string>();
  try {
    const rows = getDb()
      .select()
      .from(valveFeedback)
      .where(
        and(
          eq(valveFeedback.subjectKind, "sender"),
          gte(valveFeedback.dismissed, LEARN_DOWN_THRESHOLD),
        ),
      )
      .all() as ValveFeedbackRow[];
    for (const row of rows) {
      if (row.dismissed > row.kept) out.add(row.subjectKey);
    }
  } catch (err) {
    log.warn(
      { err: String(err) },
      "could not read learned senders (nothing is quieted)",
    );
  }
  return out;
}

/** What the owner has taught the valve, most-corrected first. Never throws. */
export function listFeedback(limit = 50): ValveFeedbackRow[] {
  try {
    return getDb()
      .select()
      .from(valveFeedback)
      .orderBy(desc(valveFeedback.dismissed))
      .limit(Math.min(200, Math.max(1, limit)))
      .all() as ValveFeedbackRow[];
  } catch (err) {
    log.warn({ err: String(err) }, "could not list valve feedback");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface RuleFiringCount {
  ruleId: string;
  band: string;
  count: number;
}

/**
 * How often each rule actually fired, over a window.
 *
 * The direct answer to the question nobody asked of the last safety floor in
 * this codebase, which ran for weeks with three of its four conditions dead
 * while the fourth over-fired and hid the fact. A rule that exists in code and
 * has never fired here is either unreachable or mis-specified, and either way
 * the fix starts with somebody being able to see it.
 */
export function countRuleFirings(since: number): RuleFiringCount[] {
  try {
    return (
      getDb()
        .select({
          ruleId: valveBands.ruleId,
          band: valveBands.band,
          count: sql<number>`count(*)`,
        })
        .from(valveBands)
        .where(gte(valveBands.createdAt, since))
        .groupBy(valveBands.ruleId, valveBands.band)
        .orderBy(desc(sql`count(*)`))
        .all() as Array<{ ruleId: string; band: string; count: number }>
    ).map((r) => ({ ...r, count: Number(r.count) }));
  } catch (err) {
    log.warn({ err: String(err) }, "could not count valve rule firings");
    return [];
  }
}

/** Rule ids stamped by {@link ValveRuleId} that have never fired, ever. */
export function neverFiredRules(known: readonly ValveRuleId[]): ValveRuleId[] {
  try {
    const seen = new Set(
      (
        getDb()
          .selectDistinct({ ruleId: valveBands.ruleId })
          .from(valveBands)
          .all() as Array<{ ruleId: string }>
      ).map((r) => r.ruleId),
    );
    return known.filter((id) => !seen.has(id));
  } catch (err) {
    log.warn({ err: String(err) }, "could not compute never-fired valve rules");
    return [];
  }
}
