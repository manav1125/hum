/**
 * The pass that turns arrived audio into a day.
 *
 * Everything upstream of here is a piece: segments land, segmentation cuts,
 * the gate judges, understanding writes, the verdict closes. This is the one
 * place they run in order, and it exists as its own module for the same
 * reason `observation-driver.ts` does — the decision logic is all the risk,
 * and it should be testable without a model, a device or a clock.
 *
 * ## Why it re-cuts rather than appends
 *
 * A chapter is only whole once the conversation has ended, and audio arrives
 * for minutes afterwards. Appending each new segment to "the current episode"
 * would mean a chapter whose boundary was decided before its evidence
 * arrived. So the pass re-cuts the day's **unassigned** segments each time,
 * and only claims a stretch as an episode once it has clearly ended — which
 * is what `settleAfterSeconds` is for. Episodes already written are never
 * re-cut; the reader may have read them.
 *
 * ## Order matters, and it is the design's order
 *
 * gate → understand → propose. The gate runs on the raw words BEFORE anything
 * is written, so a chapter that says nothing costs no model call and produces
 * no page. Understanding runs only for chapters that survive. Nothing files
 * work at any point: proposals are rows, and acceptance is elsewhere.
 *
 * ## What it never does
 *
 * It does not invent chapters across gaps, does not pad a thin day, and does
 * not write a verdict for a day that is still happening — the recap is a
 * 9pm ritual, and a verdict written at noon would describe half a day as if
 * it were the whole one.
 */

import { getLogger } from "../util/logger.js";
import { gateEpisode, type HaloEpisodeJudge } from "./halo-gate.js";
import { segmentDayToTarget } from "./halo-segmentation.js";
import {
  assignSegmentsToEpisode,
  attachMarksToEpisode,
  createEpisode,
  createProposal,
  ensureDay,
  listEpisodesForDay,
  listMarksForDay,
  listUnassignedSegments,
  localDateOf,
  writeUnderstanding,
  writeVerdict,
} from "./halo-store.js";
import {
  type HaloUnderstanding,
  understandEpisode,
} from "./halo-understanding.js";
import {
  type HaloVerdict,
  type VerdictDayShape,
  writeDayVerdict,
} from "./halo-verdict.js";

const log = getLogger("halo-ingest");

/**
 * How long after its last audio a stretch is considered finished.
 *
 * Five minutes rather than the three the silence threshold uses: the cut and
 * the commit are different questions. Three minutes of quiet is enough to say
 * two stretches are different conversations; it is not enough to say the
 * later one is over, because somebody who paused to read something is still
 * in the room.
 */
const SETTLE_AFTER_SECONDS = 300;

export interface HaloIngestOptions {
  now?: number;
  timeZone?: string;
  judge?: HaloEpisodeJudge | null;
  settleAfterSeconds?: number;
  /** Injected for tests; defaults to the real model call. */
  understand?: (input: {
    utterances: Array<{ speaker: string; text: string; at: number }>;
    placeLabel?: string | null;
  }) => Promise<HaloUnderstanding | null>;
}

export interface HaloIngestResult {
  localDate: string;
  episodesCreated: number;
  episodesQuiet: number;
  proposalsCreated: number;
  segmentsHeld: number;
}

/**
 * Run the pass for one local date.
 *
 * Idempotent: only unassigned segments are considered, and every segment a
 * chapter claims is marked, so running twice does nothing the second time.
 */
export async function runHaloIngest(
  localDate: string,
  options: HaloIngestOptions = {},
): Promise<HaloIngestResult> {
  const now = options.now ?? Date.now();
  const settleAfterMs =
    (options.settleAfterSeconds ?? SETTLE_AFTER_SECONDS) * 1000;

  const dayId = ensureDay(localDate);
  const dayStart = Date.parse(`${localDate}T00:00:00.000Z`);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const segments = listUnassignedSegments(dayStart, dayEnd);
  if (segments.length === 0) {
    return {
      localDate,
      episodesCreated: 0,
      episodesQuiet: 0,
      proposalsCreated: 0,
      segmentsHeld: 0,
    };
  }

  const marks = listMarksForDay(dayId).filter((m) => !m.episodeId);

  const drafts = segmentDayToTarget(
    segments.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      coveredThrough: s.coveredThrough,
      transcript: s.transcript,
    })),
    marks.map((m) => ({
      id: m.id,
      markedAt: m.markedAt,
      kind: m.kind as "bookmark" | "note",
    })),
  );

  // Existing chapters are never re-cut — the reader may have read them.
  const existing = listEpisodesForDay(dayId, true).length;

  let episodesCreated = 0;
  let episodesQuiet = 0;
  let proposalsCreated = 0;
  let segmentsHeld = 0;

  const byId = new Map(segments.map((s) => [s.id, s]));

  for (const draft of drafts) {
    // Still happening — leave it for the next pass rather than committing a
    // boundary before its evidence has arrived.
    if (now - draft.endedAt < settleAfterMs) {
      segmentsHeld += draft.segmentIds.length;
      continue;
    }

    const words = draft.segmentIds
      .map((id) => byId.get(id)?.transcript?.trim())
      .filter((t): t is string => !!t)
      .join(" ");

    const decision = await gateEpisode(
      {
        heardSeconds: draft.heardSeconds,
        transcript: words,
        markIds: draft.markIds,
      },
      options.judge,
    );

    // A quiet stretch still claims its segments — otherwise every pass would
    // re-judge the same audio forever — but produces no chapter and no page.
    if (decision.verdict === "quiet") {
      episodesQuiet += 1;
      const episodeId = createEpisode({
        dayId,
        chapterIndex: existing + episodesCreated + episodesQuiet,
        startedAt: draft.startedAt,
        endedAt: draft.endedAt,
        placeLabel: draft.placeLabel,
        boundaryReason: draft.boundaryReason,
      });
      assignSegmentsToEpisode(draft.segmentIds, episodeId);
      attachMarksToEpisode(draft.markIds, episodeId);
      continue;
    }

    const episodeId = createEpisode({
      dayId,
      chapterIndex: existing + episodesCreated + episodesQuiet + 1,
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      placeLabel: draft.placeLabel,
      boundaryReason: draft.boundaryReason,
    });
    assignSegmentsToEpisode(draft.segmentIds, episodeId);
    attachMarksToEpisode(draft.markIds, episodeId);
    episodesCreated += 1;

    const understand = options.understand ?? understandEpisode;
    const understanding = await understand({
      utterances: draft.segmentIds
        .map((id) => byId.get(id))
        .filter((s): s is NonNullable<typeof s> => !!s && !!s.transcript)
        .map((s) => ({
          speaker: "unknown",
          text: s.transcript!,
          at: s.startedAt,
        })),
      placeLabel: draft.placeLabel,
    });

    if (!understanding) continue;

    writeUnderstanding(episodeId, {
      title: understanding.title,
      summary: understanding.summary,
      pullQuote: understanding.pullQuote,
      pullQuoteSpeaker: understanding.pullQuoteSpeaker,
      pullQuoteAt: draft.startedAt,
      keyTakeaways: understanding.keyTakeaways,
      participants: understanding.participants,
    });

    for (const proposal of understanding.proposals) {
      createProposal({
        dayId,
        episodeId,
        title: proposal.title,
        owner: proposal.owner,
        verb: proposal.verb,
        destinationLabel: proposal.destinationLabel,
        // A chapter the wearer marked proposes confidently; an unsure gate
        // verdict puts its proposals behind the fold.
        confidenceTier: decision.confidenceTier,
        heard: {
          quote: proposal.heardQuote,
          at: draft.startedAt,
          place: draft.placeLabel,
          speaker: proposal.heardSpeaker,
        },
      });
      proposalsCreated += 1;
    }
  }

  log.info(
    {
      localDate,
      episodesCreated,
      episodesQuiet,
      proposalsCreated,
      segmentsHeld,
    },
    "Halo ingest pass complete",
  );

  return {
    localDate,
    episodesCreated,
    episodesQuiet,
    proposalsCreated,
    segmentsHeld,
  };
}

/**
 * Close the day: write the verdict the recap opens on.
 *
 * Separate from the ingest pass because it is a ritual with a time, not a
 * consequence of audio arriving. A verdict written at noon would describe
 * half a day as though it were the whole one, so the caller decides when the
 * day is over and this only decides what to say about it.
 */
export async function closeHaloDay(
  localDate: string,
  options: { timeZone?: string } = {},
): Promise<HaloVerdict> {
  const dayId = ensureDay(localDate);
  const episodes = listEpisodesForDay(dayId);
  const marks = listMarksForDay(dayId);

  const heardSeconds = episodes.reduce(
    (total, e) => total + Math.round((e.endedAt - e.startedAt) / 1000),
    0,
  );
  const wornSeconds =
    episodes.length > 0
      ? Math.round(
          (episodes[episodes.length - 1].endedAt - episodes[0].startedAt) /
            1000,
        )
      : 0;

  const shape: VerdictDayShape = {
    chapters: episodes.map((e) => ({
      title: e.title,
      summary: e.summary,
      placeLabel: e.placeLabel,
      // An outcome is a chapter that produced something worth keeping.
      hasOutcome: !!e.title && !!e.keyTakeaways && e.keyTakeaways !== "[]",
    })),
    heardSeconds,
    wornSeconds,
    markCount: marks.length,
    weekday: new Date(`${localDate}T12:00:00.000Z`).toLocaleDateString(
      "en-US",
      {
        weekday: "long",
        timeZone: options.timeZone ?? "UTC",
      },
    ),
  };

  const verdict = await writeDayVerdict(shape);
  writeVerdict(dayId, verdict.text, heardSeconds);
  return verdict;
}

/** The local date the ingest pass should be running for right now. */
export function currentHaloDate(timeZone?: string, now = Date.now()): string {
  return localDateOf(now, timeZone);
}
