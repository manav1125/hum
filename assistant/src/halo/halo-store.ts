/**
 * Store for the Halo tables. Reads and writes those six tables and nothing
 * else.
 *
 * The separation is the same one `note-store.ts` keeps and for the same
 * reason: **this module never creates work.** Turning a proposal into a
 * `work_items` row is the accept path's job, so the rule "nothing files
 * without acceptance" is a structural property of the module graph rather
 * than something reviewers have to keep noticing.
 *
 * See `memory/schema/halo.ts` for the shape and the design rules behind it.
 */

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import {
  haloDays,
  haloEpisodes,
  haloGaps,
  haloMarks,
  haloProposals,
  haloSegments,
} from "../memory/schema.js";

export type HaloGapReason =
  | "not_worn"
  | "off_the_record"
  | "battery"
  | "forgotten";
export type HaloMarkKind = "bookmark" | "note";
export type HaloEpisodeState = "kept" | "forgotten";
export type HaloProposalState = "proposed" | "accepted" | "dismissed";
export type HaloProposalVerb = "file" | "draft" | "schedule" | "note";

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in the owner's local time — the day's natural key. */
export function localDateOf(at: number, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(at));
}

export function ensureDay(localDate: string): string {
  const db = getDb();
  const existing = db
    .select({ id: haloDays.id })
    .from(haloDays)
    .where(eq(haloDays.localDate, localDate))
    .get();
  if (existing) return existing.id;

  const now = Date.now();
  const id = crypto.randomUUID();
  db.insert(haloDays)
    .values({ id, localDate, createdAt: now, updatedAt: now })
    .run();
  return id;
}

export function getDay(localDate: string) {
  return getDb()
    .select()
    .from(haloDays)
    .where(eq(haloDays.localDate, localDate))
    .get();
}

/**
 * Record the verdict — the serif line the recap opens on.
 *
 * `heardSeconds` is written alongside it because S4 requires the verdict to
 * scope itself to what was actually heard. Writing one without the other
 * would let a five-hour day's verdict read as if it covered fourteen.
 */
export function writeVerdict(
  dayId: string,
  verdict: string,
  heardSeconds: number,
): void {
  const now = Date.now();
  getDb()
    .update(haloDays)
    .set({
      verdict,
      verdictWrittenAt: now,
      heardSeconds,
      updatedAt: now,
    })
    .where(eq(haloDays.id, dayId))
    .run();
}

export function closeDay(dayId: string): void {
  const now = Date.now();
  getDb()
    .update(haloDays)
    .set({ closedAt: now, updatedAt: now })
    .where(eq(haloDays.id, dayId))
    .run();
}

// ---------------------------------------------------------------------------
// Segments — and the lag every surface prints
// ---------------------------------------------------------------------------

export interface RecordSegmentInput {
  deviceSessionId: string;
  sequence: number;
  startedAt: number;
  coveredThrough: number;
  transcript?: string | null;
  snippet?: string | null;
}

export function recordSegment(input: RecordSegmentInput): string {
  const now = Date.now();
  const id = crypto.randomUUID();
  getDb()
    .insert(haloSegments)
    .values({
      id,
      deviceSessionId: input.deviceSessionId,
      sequence: input.sequence,
      startedAt: input.startedAt,
      coveredThrough: input.coveredThrough,
      syncedAt: now,
      transcript: input.transcript ?? null,
      snippet: input.snippet ?? null,
      createdAt: now,
    })
    .run();
  return id;
}

export interface HaloLag {
  /**
   * How far behind the room Cue is, in seconds. **Null when nothing has ever
   * arrived** — the design forbids faking this number, so absence is a state
   * the surface renders ("—"), never a zero it prints.
   */
  behindSeconds: number | null;
  /** When the most recent audio ENDS. Not when it synced. */
  coveredThrough: number | null;
  /** The live strip's last words. */
  snippet: string | null;
}

/**
 * The lag number, from the arrival record.
 *
 * This is the product's organizing idea made computable: Halo is always a
 * little behind the room, never in it. Every surface — the card's "synced to
 * N min ago", the Island's "3m behind", the Day's sync pill — reads this.
 */
export function readLag(now = Date.now()): HaloLag {
  const latest = getDb()
    .select({
      coveredThrough: haloSegments.coveredThrough,
      snippet: haloSegments.snippet,
    })
    .from(haloSegments)
    .orderBy(desc(haloSegments.coveredThrough))
    .limit(1)
    .get();

  if (!latest) {
    return { behindSeconds: null, coveredThrough: null, snippet: null };
  }
  return {
    behindSeconds: Math.max(
      0,
      Math.round((now - latest.coveredThrough) / 1000),
    ),
    coveredThrough: latest.coveredThrough,
    snippet: latest.snippet ?? null,
  };
}

/** Segments not yet claimed by an episode — segmentation's input. */
export function listUnassignedSegments(from: number, to: number) {
  return getDb()
    .select()
    .from(haloSegments)
    .where(
      and(
        isNull(haloSegments.episodeId),
        gte(haloSegments.startedAt, from),
        lte(haloSegments.startedAt, to),
      ),
    )
    .orderBy(asc(haloSegments.startedAt))
    .all();
}

export function assignSegmentsToEpisode(
  segmentIds: string[],
  episodeId: string,
): void {
  if (segmentIds.length === 0) return;
  getDb()
    .update(haloSegments)
    .set({ episodeId })
    .where(inArray(haloSegments.id, segmentIds))
    .run();
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export function recordMark(input: {
  dayId: string;
  markedAt: number;
  kind?: HaloMarkKind;
  words?: string | null;
}): string {
  const id = crypto.randomUUID();
  getDb()
    .insert(haloMarks)
    .values({
      id,
      dayId: input.dayId,
      kind: input.kind ?? "bookmark",
      markedAt: input.markedAt,
      words: input.words ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function listMarksForDay(dayId: string) {
  return getDb()
    .select()
    .from(haloMarks)
    .where(eq(haloMarks.dayId, dayId))
    .orderBy(asc(haloMarks.markedAt))
    .all();
}

export function attachMarksToEpisode(
  markIds: string[],
  episodeId: string,
): void {
  if (markIds.length === 0) return;
  getDb()
    .update(haloMarks)
    .set({ episodeId })
    .where(inArray(haloMarks.id, markIds))
    .run();
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface CreateEpisodeInput {
  dayId: string;
  chapterIndex: number;
  startedAt: number;
  endedAt: number;
  placeLabel?: string | null;
  boundaryReason?: string;
}

export function createEpisode(input: CreateEpisodeInput): string {
  const now = Date.now();
  const id = crypto.randomUUID();
  getDb()
    .insert(haloEpisodes)
    .values({
      id,
      dayId: input.dayId,
      chapterIndex: input.chapterIndex,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      placeLabel: input.placeLabel ?? null,
      boundaryReason: input.boundaryReason ?? "silence",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export interface EpisodeUnderstanding {
  title?: string | null;
  summary?: string | null;
  pullQuote?: string | null;
  pullQuoteSpeaker?: string | null;
  pullQuoteAt?: number | null;
  /** `[{label, value}]` — the Key Takeaways block. */
  keyTakeaways?: Array<{ label: string; value: string }> | null;
  participants?: string[] | null;
  transcript?: Array<{ speaker: string; text: string; at: number }> | null;
  conversationId?: string | null;
}

export function writeUnderstanding(
  episodeId: string,
  understanding: EpisodeUnderstanding,
): void {
  getDb()
    .update(haloEpisodes)
    .set({
      title: understanding.title ?? null,
      summary: understanding.summary ?? null,
      pullQuote: understanding.pullQuote ?? null,
      pullQuoteSpeaker: understanding.pullQuoteSpeaker ?? null,
      pullQuoteAt: understanding.pullQuoteAt ?? null,
      keyTakeaways: understanding.keyTakeaways
        ? JSON.stringify(understanding.keyTakeaways)
        : null,
      participants: understanding.participants
        ? JSON.stringify(understanding.participants)
        : null,
      transcript: understanding.transcript
        ? JSON.stringify(understanding.transcript)
        : null,
      conversationId: understanding.conversationId ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(haloEpisodes.id, episodeId))
    .run();
}

export function listEpisodesForDay(dayId: string, includeForgotten = false) {
  const db = getDb();
  const where = includeForgotten
    ? eq(haloEpisodes.dayId, dayId)
    : and(eq(haloEpisodes.dayId, dayId), eq(haloEpisodes.state, "kept"));
  return db
    .select()
    .from(haloEpisodes)
    .where(where)
    .orderBy(asc(haloEpisodes.chapterIndex))
    .all();
}

export function getEpisode(episodeId: string) {
  return getDb()
    .select()
    .from(haloEpisodes)
    .where(eq(haloEpisodes.id, episodeId))
    .get();
}

/**
 * S2's delete ladder, at the episode rung.
 *
 * Forgetting is a state change plus a **recall**: proposals this episode made
 * that nobody accepted are withdrawn, because a proposal that outlived its
 * evidence is a claim with nothing behind it. Accepted proposals are left
 * alone — the work is the owner's now, and deleting a memory must never
 * silently delete their commitments. The design says this explicitly, and the
 * delete sheet states the blast radius.
 *
 * Returns how many proposals were recalled, so the undo toast can say so.
 */
export function forgetEpisode(episodeId: string): { recalled: number } {
  const db = getDb();
  const now = Date.now();

  db.update(haloEpisodes)
    .set({
      state: "forgotten",
      transcript: null,
      pullQuote: null,
      summary: null,
      keyTakeaways: null,
      updatedAt: now,
    })
    .where(eq(haloEpisodes.id, episodeId))
    .run();

  // Counted before the write rather than from a row count: the toast says
  // how many were withdrawn, and that number has to be the real one.
  const open = db
    .select({ id: haloProposals.id })
    .from(haloProposals)
    .where(
      and(
        eq(haloProposals.episodeId, episodeId),
        eq(haloProposals.state, "proposed"),
      ),
    )
    .all();

  if (open.length > 0) {
    db.update(haloProposals)
      .set({ state: "dismissed", recalledAt: now })
      .where(
        inArray(
          haloProposals.id,
          open.map((row) => row.id),
        ),
      )
      .run();
  }

  return { recalled: open.length };
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

export function recordGap(input: {
  dayId: string;
  startedAt: number;
  endedAt?: number | null;
  reason: HaloGapReason;
  caption?: string | null;
}): string {
  const id = crypto.randomUUID();
  getDb()
    .insert(haloGaps)
    .values({
      id,
      dayId: input.dayId,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      reason: input.reason,
      caption: input.caption ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function listGapsForDay(dayId: string) {
  return getDb()
    .select()
    .from(haloGaps)
    .where(eq(haloGaps.dayId, dayId))
    .orderBy(asc(haloGaps.startedAt))
    .all();
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
  dayId: string;
  episodeId?: string | null;
  markId?: string | null;
  title: string;
  owner?: string | null;
  verb?: HaloProposalVerb;
  destinationLabel?: string | null;
  destinationRef?: string | null;
  confidenceTier?: "confident" | "unsure";
  /** The provenance pill, carried whole so it outlives its episode. */
  heard?: {
    quote?: string | null;
    at?: number | null;
    place?: string | null;
    speaker?: string | null;
  };
}

export function createProposal(input: CreateProposalInput): string {
  const id = crypto.randomUUID();
  getDb()
    .insert(haloProposals)
    .values({
      id,
      dayId: input.dayId,
      episodeId: input.episodeId ?? null,
      markId: input.markId ?? null,
      title: input.title,
      owner: input.owner ?? null,
      verb: input.verb ?? "file",
      destinationLabel: input.destinationLabel ?? null,
      destinationRef: input.destinationRef ?? null,
      confidenceTier: input.confidenceTier ?? "confident",
      heardQuote: input.heard?.quote ?? null,
      heardAt: input.heard?.at ?? null,
      heardPlace: input.heard?.place ?? null,
      heardSpeaker: input.heard?.speaker ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/**
 * F2's queue: open proposals, confident ones first so the unsure fold sits
 * below them.
 */
export function listOpenProposals(limit = 50) {
  return getDb()
    .select()
    .from(haloProposals)
    .where(eq(haloProposals.state, "proposed"))
    .orderBy(asc(haloProposals.confidenceTier), desc(haloProposals.createdAt))
    .limit(limit)
    .all();
}

/**
 * The trust ledger the queue footer prints — "34 accepted · 7 dismissed".
 * Dismissals are counted because ✕ teaches, which only works if it is data.
 */
export function readTrustLedger(since?: number) {
  const db = getDb();
  const rows = db
    .select({
      state: haloProposals.state,
      total: sql<number>`count(*)`,
    })
    .from(haloProposals)
    .where(since ? gte(haloProposals.createdAt, since) : undefined)
    .groupBy(haloProposals.state)
    .all();

  const of = (state: string) =>
    Number(rows.find((r) => r.state === state)?.total ?? 0);
  return {
    proposed: of("proposed"),
    accepted: of("accepted"),
    dismissed: of("dismissed"),
  };
}

/**
 * Mark a proposal decided.
 *
 * `workItemId` is recorded, never created — this module holds no work-item
 * writer, so a proposal cannot become work by passing through here. The accept
 * route creates the row and hands back its id.
 */
export function decideProposal(
  proposalId: string,
  state: Exclude<HaloProposalState, "proposed">,
  workItemId?: string | null,
): void {
  getDb()
    .update(haloProposals)
    .set({
      state,
      workItemId: workItemId ?? null,
      decidedAt: Date.now(),
    })
    .where(eq(haloProposals.id, proposalId))
    .run();
}

export function getProposal(proposalId: string) {
  return getDb()
    .select()
    .from(haloProposals)
    .where(eq(haloProposals.id, proposalId))
    .get();
}
