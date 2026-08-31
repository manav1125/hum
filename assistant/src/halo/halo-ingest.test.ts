/**
 * The pass, end to end, against the real database.
 *
 * The interesting behaviour is all about restraint: a conversation that has
 * not finished is left alone, a quiet stretch costs nothing and produces no
 * page, and running twice changes nothing the second time.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  haloDays,
  haloEpisodes,
  haloGaps,
  haloMarks,
  haloProposals,
  haloSegments,
} from "../memory/schema.js";
import { closeHaloDay, runHaloIngest } from "./halo-ingest.js";
import {
  ensureDay,
  getDay,
  listEpisodesForDay,
  listOpenProposals,
  recordMark,
  recordSegment,
} from "./halo-store.js";

initializeDb();

const DATE = "2026-08-30";
const DAY_START = Date.parse(`${DATE}T09:00:00.000Z`);
const SEGMENT_MS = 20_000;

const COMMITMENT =
  "I'll send Dana the one-pager before Thursday and we agreed the floor " +
  "holds at forty seven a seat for twenty four months, so her side can sign.";

function seedRun(from: number, n: number, transcript = COMMITMENT) {
  for (let i = 0; i < n; i++) {
    recordSegment({
      deviceSessionId: "20260830090000",
      sequence: i,
      startedAt: from + i * SEGMENT_MS,
      coveredThrough: from + (i + 1) * SEGMENT_MS,
      transcript: i === 0 ? transcript : "and then we talked about the rest",
    });
  }
}

/** A stand-in for the model, so the pass is testable without one. */
const understand = async () => ({
  title: "Acme landed on 24 months",
  summary: "The floor held.",
  pullQuote: null,
  pullQuoteSpeaker: null,
  keyTakeaways: [{ label: "Price", value: "$47/seat" }],
  participants: ["Dana"],
  proposals: [
    {
      title: "Send the one-pager to Dana by Thursday",
      owner: null,
      verb: "file" as const,
      destinationLabel: "Renew Acme",
      heardQuote: null,
      heardSpeaker: null,
    },
  ],
});

const judgeYes = async () => ({ propose: true, confident: true });

beforeEach(() => {
  const db = getDb();
  for (const t of [
    haloProposals,
    haloMarks,
    haloGaps,
    haloEpisodes,
    haloSegments,
    haloDays,
  ]) {
    db.delete(t).run();
  }
});

describe("runHaloIngest", () => {
  test("cuts, gates, understands and proposes in one pass", async () => {
    seedRun(DAY_START, 30);
    const result = await runHaloIngest(DATE, {
      now: DAY_START + 3 * 60 * 60 * 1000,
      judge: judgeYes,
      understand,
    });

    expect(result.episodesCreated).toBe(1);
    expect(result.proposalsCreated).toBe(1);

    const dayId = ensureDay(DATE);
    const episodes = listEpisodesForDay(dayId);
    expect(episodes[0].title).toBe("Acme landed on 24 months");
    expect(listOpenProposals()[0].destinationLabel).toBe("Renew Acme");
  });

  test("holds a conversation that has not finished", async () => {
    // Committing a boundary before its evidence arrives would cut a chapter
    // in half — the audio for it is still coming.
    seedRun(DAY_START, 30);
    const result = await runHaloIngest(DATE, {
      now: DAY_START + 30 * SEGMENT_MS + 60_000,
      judge: judgeYes,
      understand,
    });

    expect(result.episodesCreated).toBe(0);
    expect(result.segmentsHeld).toBe(30);
    expect(listEpisodesForDay(ensureDay(DATE))).toEqual([]);
  });

  test("a quiet stretch costs no model call and produces no page", async () => {
    let understood = false;
    seedRun(DAY_START, 30, "the weather has been strange, warm for the season");
    const result = await runHaloIngest(DATE, {
      now: DAY_START + 3 * 60 * 60 * 1000,
      judge: judgeYes,
      understand: async () => {
        understood = true;
        return null;
      },
    });

    expect(understood).toBe(false);
    expect(result.episodesQuiet).toBe(1);
    expect(result.proposalsCreated).toBe(0);
    // It still claims its audio, so the next pass does not re-judge it.
    const episodes = listEpisodesForDay(ensureDay(DATE));
    expect(episodes).toHaveLength(1);
    expect(episodes[0].title).toBeNull();
  });

  test("a marked stretch is never dropped as quiet", async () => {
    const dayId = ensureDay(DATE);
    recordMark({
      dayId,
      markedAt: DAY_START + 5 * SEGMENT_MS,
      words: "the bill",
    });
    seedRun(DAY_START, 30, "mm hm, right, yeah");

    const result = await runHaloIngest(DATE, {
      now: DAY_START + 3 * 60 * 60 * 1000,
      judge: async () => ({ propose: false, confident: true }),
      understand,
    });
    expect(result.episodesCreated).toBeGreaterThan(0);
  });

  test("running twice changes nothing the second time", async () => {
    seedRun(DAY_START, 30);
    const first = await runHaloIngest(DATE, {
      now: DAY_START + 3 * 60 * 60 * 1000,
      judge: judgeYes,
      understand,
    });
    const second = await runHaloIngest(DATE, {
      now: DAY_START + 3 * 60 * 60 * 1000,
      judge: judgeYes,
      understand,
    });

    expect(first.episodesCreated).toBe(1);
    expect(second.episodesCreated).toBe(0);
    expect(listEpisodesForDay(ensureDay(DATE))).toHaveLength(1);
    expect(listOpenProposals()).toHaveLength(1);
  });

  test("a day with no audio is a no-op, not an error", async () => {
    const result = await runHaloIngest(DATE, { now: DAY_START });
    expect(result).toMatchObject({ episodesCreated: 0, segmentsHeld: 0 });
  });
});

describe("closeHaloDay", () => {
  test("writes a verdict and the scope that qualifies it", async () => {
    seedRun(DAY_START, 30);
    await runHaloIngest(DATE, {
      now: DAY_START + 3 * 60 * 60 * 1000,
      judge: judgeYes,
      understand,
    });

    const verdict = await closeHaloDay(DATE);
    expect(verdict.text.length).toBeGreaterThan(0);
    // With no provider configured in tests, the inventory fallback runs —
    // which is exactly the guarantee: the day always gets a true sentence.
    expect(verdict.fallback).toBe(true);

    const day = getDay(DATE)!;
    expect(day.verdict).toBe(verdict.text);
    expect(day.heardSeconds).toBeGreaterThan(0);
  });

  test("a day with one chapter takes the thin register", async () => {
    seedRun(DAY_START, 30);
    await runHaloIngest(DATE, {
      now: DAY_START + 3 * 60 * 60 * 1000,
      judge: judgeYes,
      understand,
    });
    expect((await closeHaloDay(DATE)).register).toBe("thin");
  });

  test("an empty day still gets a sentence, and never apologises", async () => {
    const verdict = await closeHaloDay(DATE);
    expect(verdict.text).toBe("Nothing heard today.");
    expect(verdict.text).not.toContain("sorry");
  });
});
