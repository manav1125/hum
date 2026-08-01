/**
 * Store for the `arrivals` table — the record of everything a watcher saw and
 * what Cue decided about it.
 *
 * The one rule this module exists to keep: **nothing is ever deleted.** There
 * is no `deleteArrival`, and reversing a filing does not rewrite the original
 * decision — it appends to it (`reversedAt` / `reversedBy` are set, the
 * disposition flips, `reason` and `ruleId` keep saying what Cue originally
 * thought). A correction whose evidence is erased is not a training signal.
 *
 * See `memory/schema/arrivals.ts` for why this is a sibling table rather than
 * a flag on `work_items`.
 */

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { arrivals } from "../memory/schema.js";

/**
 * What Cue decided. Exactly two values, and the whole point of the feature:
 *   - `surfaced` — Cue looked at it and decided the owner needs to see it.
 *   - `filed` — recorded and findable, but not something they must look at.
 */
export type ArrivalDisposition = "surfaced" | "filed";

/**
 * What made the call. `rule` and `model` are kept apart on purpose: "filed by
 * rule list_mail" is a header bug, "filed by model" is a prompt problem, and
 * one number covering both tells you nothing about which.
 */
export type ArrivalDecidedBy =
  | "rule"
  | "model"
  | "floor"
  | "playbook"
  | "fallback"
  | "user";

export interface Arrival {
  id: string;
  channel: string;
  externalId: string;
  watcherId: string | null;
  eventId: string | null;
  title: string;
  senderAddress: string | null;
  senderName: string | null;
  snippet: string | null;
  sourceContext: string | null;
  disposition: ArrivalDisposition;
  /** The user-words sentence fragment. Set for both dispositions. */
  reason: string | null;
  decidedBy: ArrivalDecidedBy;
  ruleId: string | null;
  confidence: number | null;
  workItemId: string | null;
  reversedAt: number | null;
  reversedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Cap on how much of a message body is kept for the filed-list preview. */
const SNIPPET_CHARS = 400;

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export interface RecordArrivalInput {
  channel: string;
  externalId: string;
  watcherId?: string | null;
  eventId?: string | null;
  title: string;
  senderAddress?: string | null;
  senderName?: string | null;
  snippet?: string | null;
  sourceContext?: string | null;
  disposition: ArrivalDisposition;
  reason?: string | null;
  decidedBy: ArrivalDecidedBy;
  ruleId?: string | null;
  confidence?: number | null;
  workItemId?: string | null;
}

/**
 * Record one arrival. Idempotent on (channel, externalId): a replayed poll
 * returns the row that already exists rather than inflating the counts the
 * owner is shown. The existing row wins outright — a second look at the same
 * message must never silently re-decide a filing the owner may already have
 * reversed.
 */
export function recordArrival(input: RecordArrivalInput): Arrival {
  const existing = findArrivalByExternalId(input.channel, input.externalId);
  if (existing) return existing;

  const db = getDb();
  const now = Date.now();
  const row: Arrival = {
    id: crypto.randomUUID(),
    channel: input.channel,
    externalId: input.externalId,
    watcherId: input.watcherId ?? null,
    eventId: input.eventId ?? null,
    title: input.title,
    senderAddress: input.senderAddress?.toLowerCase() ?? null,
    senderName: input.senderName ?? null,
    snippet: clip(input.snippet, SNIPPET_CHARS),
    sourceContext: input.sourceContext ?? null,
    disposition: input.disposition,
    reason: input.reason ?? null,
    decidedBy: input.decidedBy,
    ruleId: input.ruleId ?? null,
    confidence: input.confidence ?? null,
    workItemId: input.workItemId ?? null,
    reversedAt: null,
    reversedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(arrivals).values(row).run();
  return row;
}

export function getArrival(id: string): Arrival | undefined {
  const db = getDb();
  return db.select().from(arrivals).where(eq(arrivals.id, id)).get() as
    | Arrival
    | undefined;
}

export function findArrivalByExternalId(
  channel: string,
  externalId: string,
): Arrival | undefined {
  const db = getDb();
  return db
    .select()
    .from(arrivals)
    .where(
      and(eq(arrivals.channel, channel), eq(arrivals.externalId, externalId)),
    )
    .get() as Arrival | undefined;
}

/** Bind a surfaced arrival to the work item it became. */
export function attachWorkItemToArrival(
  arrivalId: string,
  workItemId: string,
): void {
  const db = getDb();
  db.update(arrivals)
    .set({ workItemId, updatedAt: Date.now() })
    .where(eq(arrivals.id, arrivalId))
    .run();
}

export interface ListArrivalsOptions {
  disposition?: ArrivalDisposition;
  /** Only rows at or after this epoch ms. */
  since?: number;
  /** Default 50, capped at 200. */
  limit?: number;
}

export const DEFAULT_ARRIVAL_PAGE = 50;
export const MAX_ARRIVAL_PAGE = 200;

/** Newest-first arrivals. Backs the "Where it went ›" list. */
export function listArrivals(opts: ListArrivalsOptions = {}): Arrival[] {
  const db = getDb();
  const conditions = [
    ...(opts.disposition ? [eq(arrivals.disposition, opts.disposition)] : []),
    ...(opts.since !== undefined ? [gte(arrivals.createdAt, opts.since)] : []),
  ];
  const limit = Math.min(
    MAX_ARRIVAL_PAGE,
    Math.max(1, opts.limit ?? DEFAULT_ARRIVAL_PAGE),
  );
  let query = db.select().from(arrivals);
  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }
  return query
    .orderBy(desc(arrivals.createdAt))
    .limit(limit)
    .all() as Arrival[];
}

export interface ArrivalReasonCount {
  reason: string;
  count: number;
}

export interface ArrivalsSummary {
  /** Inclusive lower bound of the window, epoch ms. */
  since: number;
  /** The moment the summary was computed, epoch ms. */
  until: number;
  windowHours: number;
  /** Everything that arrived in the window. Always `filed + kept`. */
  arrived: number;
  /** Recorded and findable, but not in the lane. */
  filed: number;
  /**
   * Cue looked at it and decided the owner needs to see it. NOT inferred from
   * any filing-confidence field — this is the disposition itself.
   */
  kept: number;
  /** Filed at arrival, then reversed by the owner. A subset of `kept`. */
  reversed: number;
  /** Most common filing reasons in the window, biggest first (max 10). */
  topFiledReasons: ArrivalReasonCount[];
}

const MAX_SUMMARY_REASONS = 10;

/**
 * The arrived / filed / kept census over a trailing window.
 *
 * `kept` means "Cue looked at it and decided you need to see it" — it is a
 * count of `disposition = 'surfaced'` rows and nothing else. It is deliberately
 * not derived from `auto_file_confidence`, which is a PROJECT-assignment
 * signal; reading relevance out of it is what made the old digest dishonest.
 */
export function getArrivalsSummary(opts?: {
  windowHours?: number;
}): ArrivalsSummary {
  const db = getDb();
  const until = Date.now();
  const windowHours =
    opts?.windowHours && opts.windowHours > 0 ? opts.windowHours : 24;
  const since = until - windowHours * 3_600_000;

  const rows = db
    .select({
      disposition: arrivals.disposition,
      count: sql<number>`count(*)`,
    })
    .from(arrivals)
    .where(gte(arrivals.createdAt, since))
    .groupBy(arrivals.disposition)
    .all() as Array<{ disposition: string; count: number }>;

  let filed = 0;
  let kept = 0;
  for (const row of rows) {
    if (row.disposition === "filed") filed += Number(row.count);
    else if (row.disposition === "surfaced") kept += Number(row.count);
  }

  const reversedRow = db
    .select({ count: sql<number>`count(*)` })
    .from(arrivals)
    .where(and(gte(arrivals.createdAt, since), isNotNull(arrivals.reversedAt)))
    .get() as { count: number } | undefined;

  const reasonRows = db
    .select({ reason: arrivals.reason, count: sql<number>`count(*)` })
    .from(arrivals)
    .where(
      and(gte(arrivals.createdAt, since), eq(arrivals.disposition, "filed")),
    )
    .groupBy(arrivals.reason)
    .orderBy(desc(sql`count(*)`))
    .limit(MAX_SUMMARY_REASONS)
    .all() as Array<{ reason: string | null; count: number }>;

  return {
    since,
    until,
    windowHours,
    arrived: filed + kept,
    filed,
    kept,
    reversed: Number(reversedRow?.count ?? 0),
    topFiledReasons: reasonRows
      .filter((r): r is { reason: string; count: number } => r.reason != null)
      .map((r) => ({ reason: r.reason, count: Number(r.count) })),
  };
}

/**
 * How many times the owner has reversed a filing from this sender.
 *
 * A repeated correction for the SAME sender is the strongest signal available
 * — "you keep telling me this person matters" — so it is exposed as a first-
 * class read rather than left for a caller to reconstruct. Nothing consumes it
 * to change behaviour yet; the learning loop is deliberately out of scope, but
 * the data it needs is being collected from day one rather than retrofitted.
 */
export function countSenderCorrections(senderAddress: string): number {
  const db = getDb();
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(arrivals)
    .where(
      and(
        eq(arrivals.senderAddress, senderAddress.toLowerCase()),
        isNotNull(arrivals.reversedAt),
      ),
    )
    .get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/** Senders the owner has corrected at least once, most-corrected first. */
export function listCorrectedSenders(
  limit = 20,
): Array<{ senderAddress: string; corrections: number }> {
  const db = getDb();
  return (
    db
      .select({
        senderAddress: arrivals.senderAddress,
        corrections: sql<number>`count(*)`,
      })
      .from(arrivals)
      .where(
        and(isNotNull(arrivals.reversedAt), isNotNull(arrivals.senderAddress)),
      )
      .groupBy(arrivals.senderAddress)
      .orderBy(desc(sql`count(*)`))
      .limit(limit)
      .all() as Array<{ senderAddress: string | null; corrections: number }>
  )
    .filter(
      (r): r is { senderAddress: string; corrections: number } =>
        r.senderAddress != null,
    )
    .map((r) => ({
      senderAddress: r.senderAddress,
      corrections: Number(r.corrections),
    }));
}

/**
 * Mark a filed arrival as reversed and bind it to the work item it became.
 *
 * The original decision is preserved verbatim — `reason`, `ruleId`,
 * `confidence` and `decidedBy` are untouched. Only the disposition, the work
 * item link and the reversal stamps change, so "Cue filed this as a newsletter
 * and I disagreed" stays legible after the fact. That record is the correction
 * signal; overwriting it would destroy the thing that makes reversal useful.
 */
export function markArrivalReversed(
  arrivalId: string,
  workItemId: string,
  actor = "user",
): Arrival | undefined {
  const db = getDb();
  const now = Date.now();
  db.update(arrivals)
    .set({
      disposition: "surfaced",
      workItemId,
      reversedAt: now,
      reversedBy: actor,
      updatedAt: now,
    })
    .where(eq(arrivals.id, arrivalId))
    .run();
  return getArrival(arrivalId);
}
