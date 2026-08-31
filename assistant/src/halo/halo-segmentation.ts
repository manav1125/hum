/**
 * Cutting a day into chapters.
 *
 * A day is not a meeting. Six hours of arriving audio has no natural end, so
 * something has to decide where one episode stops and the next begins — and
 * that decision is the whole Day surface, because every frame in
 * `docs/design/halo/` draws episodes rather than transcript. Get the cuts
 * wrong and the day reads as one shapeless block or as fifty fragments;
 * neither is a journal anybody would read.
 *
 * ## The boundary rules, strongest signal first
 *
 * 1. **A bookmark starts a chapter.** A single click is the only thing a
 *    person can say to Halo with their hand, and the design makes it the
 *    loudest element on the Day. Treating it as merely a highlight *inside*
 *    whatever episode the silence rule happened to produce would let a machine
 *    boundary outrank a human one, which is exactly backwards. So a mark cuts.
 * 2. **Silence ends one.** A long enough gap between segments is the ordinary
 *    end of a conversation. This is the workhorse.
 * 3. **A place change cuts.** Walking from the office to a café is a new
 *    scene, and the frames label chapters by place.
 * 4. **A calendar event cuts at its start.** Cue already knows the meeting
 *    began; the audio does not have to guess it.
 * 5. **Midnight cuts, always.** An episode belongs to exactly one local date
 *    or the Day cannot own it.
 *
 * ## What this deliberately does not do
 *
 * It does not decide whether an episode is *worth* anything — that is the
 * gate's job (`halo-gate.ts`), and keeping the two apart matters: a boundary
 * decision that also judged relevance would silently drop the quiet stretch
 * containing the one sentence that mattered. Every segment lands in exactly
 * one episode here, and judgement happens afterwards on whole episodes.
 *
 * It also never invents an episode across a gap. If nothing arrived between
 * 12:00 and 14:00, that is an absence with a reason (`halo-gaps`), not a
 * two-hour chapter with nothing in it.
 *
 * Pure — no database, no clock, no model — so the rules can be tested as
 * rules. The store applies what this returns.
 */

/** One arrived segment, as much of it as a boundary decision needs. */
export interface SegmentInput {
  id: string;
  startedAt: number;
  coveredThrough: number;
  transcript?: string | null;
  /** The owner's label for where they were, if known. Never a coordinate. */
  placeLabel?: string | null;
}

/** A ⚑ or ✦ the owner made, which cuts the day at that instant. */
export interface MarkInput {
  id: string;
  markedAt: number;
  kind?: "bookmark" | "note";
}

/** A calendar event Cue already knows about. Only its start is used. */
export interface CalendarCutInput {
  startsAt: number;
  title?: string | null;
}

export type BoundaryReason =
  | "silence"
  | "bookmark"
  | "calendar"
  | "place"
  | "day_edge";

export interface EpisodeDraft {
  /** 1-based, in the order the day happened. */
  chapterIndex: number;
  startedAt: number;
  endedAt: number;
  segmentIds: string[];
  markIds: string[];
  placeLabel: string | null;
  boundaryReason: BoundaryReason;
  /** Seconds of audio in this chapter — not wall-clock, which may be longer. */
  heardSeconds: number;
}

export interface SegmentationOptions {
  /**
   * Silence long enough to end a conversation.
   *
   * Three minutes rather than one: at ~20-second segments, a one-minute
   * threshold cuts a chapter every time somebody stops to read something,
   * and the Day fills with two-minute fragments. Three tolerates a natural
   * pause while still ending a conversation that actually ended.
   */
  silenceGapSeconds?: number;
  /**
   * Below this, a stretch is not a chapter — it is a fragment, and it is
   * merged forward into the next one rather than drawn as a bead. A day of
   * 30-second beads is unreadable, and the arc is a story rail.
   */
  minEpisodeSeconds?: number;
  /** Local-midnight boundaries (epoch ms) that must always cut. */
  dayEdges?: number[];
}

const DEFAULT_SILENCE_GAP_SECONDS = 180;
const DEFAULT_MIN_EPISODE_SECONDS = 60;

/** S6: five to nine beads on a normal day, twelve at the outside. */
const MAX_CHAPTERS = 12;

/**
 * The loosest the silence threshold may go while tuning. Beyond half an hour
 * of quiet, two conversations are not one conversation however few beads that
 * would produce — the cap is a readability preference, not a licence to merge
 * a morning into an evening.
 */
const MAX_SILENCE_GAP_SECONDS = 1800;

/**
 * True when an instant belongs to the segment starting at `previousEnd` and
 * running to `currentEnd` — i.e. the cut goes BEFORE that segment.
 *
 * A mark is made *during* a segment, not tidily between two, and continuous
 * sync produces segments that touch (one file's `coveredThrough` is the
 * next's `startedAt`). A strict "between" test therefore never fires on real
 * data: the interesting instants land either exactly on a shared edge or in
 * the middle of a file. Half-open `[previousEnd, currentEnd)` catches both,
 * and puts the marked moment at the START of the new chapter — which is what
 * the person meant when they pressed the button.
 */
function cutsBefore(
  boundary: number,
  previousEnd: number,
  currentEnd: number,
): boolean {
  return boundary >= previousEnd && boundary < currentEnd;
}

/**
 * Cut a day's segments into chapters.
 *
 * Segments may arrive out of order — BLE sync resumes, and a Wi-Fi catch-up
 * can deliver an older session after a newer one — so they are sorted here
 * rather than trusted.
 */
export function segmentDay(
  segments: SegmentInput[],
  marks: MarkInput[] = [],
  calendarCuts: CalendarCutInput[] = [],
  options: SegmentationOptions = {},
): EpisodeDraft[] {
  const silenceGapMs =
    (options.silenceGapSeconds ?? DEFAULT_SILENCE_GAP_SECONDS) * 1000;
  const minEpisodeMs =
    (options.minEpisodeSeconds ?? DEFAULT_MIN_EPISODE_SECONDS) * 1000;

  const ordered = [...segments].sort((a, b) => a.startedAt - b.startedAt);
  if (ordered.length === 0) return [];

  const markTimes = [...marks].sort((a, b) => a.markedAt - b.markedAt);
  const calendarTimes = calendarCuts
    .map((c) => c.startsAt)
    .sort((a, b) => a - b);
  const dayEdges = [...(options.dayEdges ?? [])].sort((a, b) => a - b);

  interface Group {
    segments: SegmentInput[];
    boundaryReason: BoundaryReason;
  }

  const groups: Group[] = [
    { segments: [ordered[0]], boundaryReason: "silence" },
  ];

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const group = groups[groups.length - 1];

    // Strongest first: a human mark, then the day's own edge, then a known
    // meeting start, then a change of scene, then plain silence.
    let reason: BoundaryReason | null = null;

    if (
      markTimes.some((m) =>
        cutsBefore(m.markedAt, previous.coveredThrough, current.coveredThrough),
      )
    ) {
      reason = "bookmark";
    } else if (
      dayEdges.some((edge) =>
        cutsBefore(edge, previous.coveredThrough, current.coveredThrough),
      )
    ) {
      reason = "day_edge";
    } else if (
      calendarTimes.some((t) =>
        cutsBefore(t, previous.coveredThrough, current.coveredThrough),
      )
    ) {
      reason = "calendar";
    } else if (
      previous.placeLabel &&
      current.placeLabel &&
      previous.placeLabel !== current.placeLabel
    ) {
      reason = "place";
    } else if (current.startedAt - previous.coveredThrough >= silenceGapMs) {
      reason = "silence";
    }

    if (reason) {
      groups.push({ segments: [current], boundaryReason: reason });
    } else {
      group.segments.push(current);
    }
  }

  // Fragments merge FORWARD, into the chapter that follows — a stray minute
  // before a meeting belongs to the meeting, not trailing the thing before it.
  // A trailing fragment with nothing after it merges backward instead, since
  // there is nowhere else for it to go.
  const collapsed: Group[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const span = spanOf(group.segments);
    // A stretch a human marked is never a fragment. The mark is the point.
    const isHuman = group.boundaryReason === "bookmark";
    if (span >= minEpisodeMs || isHuman) {
      collapsed.push(group);
      continue;
    }
    const next = groups[i + 1];
    if (next) {
      // Forward: the following chapter keeps its own boundary reason.
      next.segments = [...group.segments, ...next.segments];
      continue;
    }
    const previous = collapsed[collapsed.length - 1];
    if (previous) {
      previous.segments = [...previous.segments, ...group.segments];
      continue;
    }
    // The only group in the day, and short. A short day is still a day.
    collapsed.push(group);
  }

  return collapsed.map((group, index) => {
    const first = group.segments[0];
    const last = group.segments[group.segments.length - 1];
    const startedAt = first.startedAt;
    const endedAt = last.coveredThrough;
    return {
      chapterIndex: index + 1,
      startedAt,
      endedAt,
      segmentIds: group.segments.map((s) => s.id),
      markIds: markTimes
        .filter((m) => m.markedAt >= startedAt && m.markedAt <= endedAt)
        .map((m) => m.id),
      placeLabel: dominantPlace(group.segments),
      boundaryReason: group.boundaryReason,
      heardSeconds: Math.round(
        group.segments.reduce(
          (total, s) => total + (s.coveredThrough - s.startedAt),
          0,
        ) / 1000,
      ),
    };
  });
}

function spanOf(segments: SegmentInput[]): number {
  if (segments.length === 0) return 0;
  return segments[segments.length - 1].coveredThrough - segments[0].startedAt;
}

/**
 * The place the chapter mostly happened in, by heard time rather than by
 * segment count — a long stretch at the café outweighs three segments walking
 * to it.
 */
function dominantPlace(segments: SegmentInput[]): string | null {
  const totals = new Map<string, number>();
  for (const s of segments) {
    if (!s.placeLabel) continue;
    totals.set(
      s.placeLabel,
      (totals.get(s.placeLabel) ?? 0) + (s.coveredThrough - s.startedAt),
    );
  }
  let best: string | null = null;
  let bestTotal = 0;
  for (const [label, total] of totals) {
    if (total > bestTotal) {
      best = label;
      bestTotal = total;
    }
  }
  return best;
}

/**
 * The gaps between chapters, so the arc can draw absences instead of closing
 * over them.
 *
 * Reason is `not_worn` by default and deliberately NOT inferred any further:
 * this function cannot know whether a silence was a dead battery or a 3s hold,
 * and S4 forbids guessing into a gap. The device's own events overwrite the
 * reason where they exist; everything else stays honestly generic.
 */
export function gapsBetween(
  episodes: EpisodeDraft[],
  dayStart: number,
  dayEnd: number,
  minimumGapSeconds = 600,
): Array<{ startedAt: number; endedAt: number; reason: "not_worn" }> {
  const minimumGapMs = minimumGapSeconds * 1000;
  const gaps: Array<{
    startedAt: number;
    endedAt: number;
    reason: "not_worn";
  }> = [];
  let cursor = dayStart;

  for (const episode of episodes) {
    if (episode.startedAt - cursor >= minimumGapMs) {
      gaps.push({
        startedAt: cursor,
        endedAt: episode.startedAt,
        reason: "not_worn",
      });
    }
    cursor = Math.max(cursor, episode.endedAt);
  }

  if (dayEnd - cursor >= minimumGapMs) {
    gaps.push({ startedAt: cursor, endedAt: dayEnd, reason: "not_worn" });
  }

  return gaps;
}

/**
 * Cut a day and then tune it to a readable number of chapters.
 *
 * S6's second ruling: **tune to the count, not the constants.** The arc is a
 * story rail, so a normal day should land at five to nine beads, and twelve is
 * the hard cap. The silence threshold is therefore a starting guess rather
 * than a law — when a day comes out too finely chopped, the threshold rises
 * for THAT DAY until the day fits, which is invisible to the reader and much
 * better than a constant that is right for meetings and wrong for a Saturday.
 *
 * Two rules bound the tuning, and both are the design's:
 *
 *  · **Re-chaptering never splits a ⚑.** Marks always cut, at every
 *    threshold, so a day with fourteen bookmarks stays at fourteen chapters
 *    and the cap yields. A cap that could swallow a human mark would be a cap
 *    that outranks the one thing the wearer said with their hand.
 *  · **Never pad a thin day.** Below the target there is no adjustment at
 *    all: a two-bead day is a two-bead day, and inventing chapters to fill an
 *    arc would be guessing into the day.
 */
export function segmentDayToTarget(
  segments: SegmentInput[],
  marks: MarkInput[] = [],
  calendarCuts: CalendarCutInput[] = [],
  options: SegmentationOptions & { maxChapters?: number } = {},
): EpisodeDraft[] {
  const maxChapters = options.maxChapters ?? MAX_CHAPTERS;
  let silenceGapSeconds =
    options.silenceGapSeconds ?? DEFAULT_SILENCE_GAP_SECONDS;

  let episodes = segmentDay(segments, marks, calendarCuts, {
    ...options,
    silenceGapSeconds,
  });

  // Thin days are left exactly as they are — the tuning only ever loosens.
  while (
    episodes.length > maxChapters &&
    silenceGapSeconds < MAX_SILENCE_GAP_SECONDS
  ) {
    silenceGapSeconds = Math.min(
      silenceGapSeconds * 2,
      MAX_SILENCE_GAP_SECONDS,
    );
    const next = segmentDay(segments, marks, calendarCuts, {
      ...options,
      silenceGapSeconds,
    });
    // A day held above the cap by its marks stops here rather than looping:
    // no further loosening can help, and the marks win.
    if (next.length === episodes.length) break;
    episodes = next;
  }

  return episodes;
}
