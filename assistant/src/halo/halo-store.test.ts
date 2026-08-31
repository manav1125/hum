/**
 * The store, against the real database.
 *
 * Three properties are worth asserting at this level because each is a
 * promise the product prints on screen: the lag number is never faked,
 * forgetting an episode recalls what it proposed but never the work somebody
 * accepted, and the trust ledger counts dismissals because ✕ teaches.
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
import {
  assignSegmentsToEpisode,
  createEpisode,
  createProposal,
  decideProposal,
  ensureDay,
  forgetEpisode,
  getEpisode,
  getProposal,
  listGapsForDay,
  listMarksForDay,
  listOpenProposals,
  listUnassignedSegments,
  localDateOf,
  readLag,
  readTrustLedger,
  recordGap,
  recordMark,
  recordSegment,
  writeUnderstanding,
  writeVerdict,
} from "./halo-store.js";

initializeDb();

const T0 = Date.UTC(2026, 7, 30, 9, 0, 0);

beforeEach(() => {
  const db = getDb();
  for (const table of [
    haloProposals,
    haloMarks,
    haloGaps,
    haloEpisodes,
    haloSegments,
    haloDays,
  ]) {
    db.delete(table).run();
  }
});

describe("the lag number", () => {
  test("is null when nothing has ever arrived — never a fake zero", () => {
    // The design forbids faking this number; absence is a state the surface
    // renders, not a value it prints.
    expect(readLag()).toEqual({
      behindSeconds: null,
      coveredThrough: null,
      snippet: null,
    });
  });

  test("measures from when the audio ENDS, not when it synced", () => {
    const now = T0 + 10 * 60_000;
    recordSegment({
      deviceSessionId: "20260830090000",
      sequence: 1,
      startedAt: T0,
      coveredThrough: T0 + 20_000,
      snippet: "…so if the floor holds…",
    });
    const lag = readLag(now);
    // Ten minutes since the segment started, minus the 20s it covers.
    expect(lag.behindSeconds).toBe(580);
    expect(lag.snippet).toBe("…so if the floor holds…");
  });

  test("reads the newest coverage, whatever order things arrived in", () => {
    const session = "20260830090000";
    recordSegment({
      deviceSessionId: session,
      sequence: 2,
      startedAt: T0 + 60_000,
      coveredThrough: T0 + 80_000,
    });
    recordSegment({
      deviceSessionId: session,
      sequence: 1,
      startedAt: T0,
      coveredThrough: T0 + 20_000,
    });
    expect(readLag(T0 + 80_000).behindSeconds).toBe(0);
  });
});

describe("days and segments", () => {
  test("a day is created once and reused", () => {
    const a = ensureDay("2026-08-30");
    const b = ensureDay("2026-08-30");
    expect(a).toBe(b);
  });

  test("localDateOf is the owner's date, not UTC's", () => {
    // 22:30 UTC is already the next day in Dubai — the Day must own it there.
    const at = Date.UTC(2026, 7, 30, 22, 30, 0);
    expect(localDateOf(at, "UTC")).toBe("2026-08-30");
    expect(localDateOf(at, "Asia/Dubai")).toBe("2026-08-31");
  });

  test("segments wait unassigned until an episode claims them", () => {
    const dayId = ensureDay("2026-08-30");
    const id = recordSegment({
      deviceSessionId: "s",
      sequence: 1,
      startedAt: T0,
      coveredThrough: T0 + 20_000,
    });
    expect(listUnassignedSegments(T0 - 1000, T0 + 60_000)).toHaveLength(1);

    const episodeId = createEpisode({
      dayId,
      chapterIndex: 1,
      startedAt: T0,
      endedAt: T0 + 20_000,
    });
    assignSegmentsToEpisode([id], episodeId);
    expect(listUnassignedSegments(T0 - 1000, T0 + 60_000)).toEqual([]);
  });
});

describe("understanding", () => {
  test("takeaways and transcript round-trip as structure, not prose", () => {
    const dayId = ensureDay("2026-08-30");
    const episodeId = createEpisode({
      dayId,
      chapterIndex: 1,
      startedAt: T0,
      endedAt: T0 + 600_000,
      placeLabel: "VERVE",
    });
    writeUnderstanding(episodeId, {
      title: "Acme landed on 24 months",
      pullQuote: "If the floor holds at 47, I can take 24 months to my side.",
      pullQuoteSpeaker: "Dana",
      keyTakeaways: [{ label: "Price", value: "floor holds at $47/seat" }],
      participants: ["Dana"],
      transcript: [
        { speaker: "Dana", text: "So where did legal land?", at: T0 },
      ],
    });

    const episode = getEpisode(episodeId)!;
    expect(episode.title).toBe("Acme landed on 24 months");
    expect(JSON.parse(episode.keyTakeaways!)[0].label).toBe("Price");
    expect(JSON.parse(episode.participants!)).toEqual(["Dana"]);
    expect(JSON.parse(episode.transcript!)[0].speaker).toBe("Dana");
  });

  test("the verdict is written with the scope that qualifies it", () => {
    const dayId = ensureDay("2026-08-30");
    writeVerdict(dayId, "The afternoon it heard was a good one.", 5 * 3600);
    const db = getDb();
    const day = db.select().from(haloDays).all()[0];
    expect(day.verdict).toContain("afternoon");
    // A five-hour day's verdict must never read as covering fourteen.
    expect(day.heardSeconds).toBe(18_000);
  });
});

describe("forgetting", () => {
  test("recalls what the episode proposed, and says how many", () => {
    const dayId = ensureDay("2026-08-30");
    const episodeId = createEpisode({
      dayId,
      chapterIndex: 1,
      startedAt: T0,
      endedAt: T0 + 600_000,
    });
    createProposal({ dayId, episodeId, title: "Send the one-pager" });
    createProposal({ dayId, episodeId, title: "Book the follow-up" });

    expect(forgetEpisode(episodeId)).toEqual({ recalled: 2 });
    expect(listOpenProposals()).toEqual([]);
    const recalled = getDb().select().from(haloProposals).all();
    expect(recalled.every((p) => p.recalledAt !== null)).toBe(true);
  });

  test("never withdraws work the owner already accepted", () => {
    // Deleting a memory must not silently delete somebody's commitments.
    const dayId = ensureDay("2026-08-30");
    const episodeId = createEpisode({
      dayId,
      chapterIndex: 1,
      startedAt: T0,
      endedAt: T0 + 600_000,
    });
    const accepted = createProposal({
      dayId,
      episodeId,
      title: "Already filed",
    });
    decideProposal(accepted, "accepted", "wi-1");
    createProposal({ dayId, episodeId, title: "Still waiting" });

    expect(forgetEpisode(episodeId)).toEqual({ recalled: 1 });
    const kept = getProposal(accepted)!;
    expect(kept.state).toBe("accepted");
    expect(kept.workItemId).toBe("wi-1");
    expect(kept.recalledAt).toBeNull();
  });

  test("the episode's words go, and it stops being drawn", () => {
    const dayId = ensureDay("2026-08-30");
    const episodeId = createEpisode({
      dayId,
      chapterIndex: 1,
      startedAt: T0,
      endedAt: T0 + 600_000,
    });
    writeUnderstanding(episodeId, {
      transcript: [{ speaker: "You", text: "private", at: T0 }],
      pullQuote: "private",
    });
    forgetEpisode(episodeId);

    const episode = getEpisode(episodeId)!;
    expect(episode.state).toBe("forgotten");
    expect(episode.transcript).toBeNull();
    expect(episode.pullQuote).toBeNull();
  });
});

describe("proposals", () => {
  test("the provenance pill is stored whole, so it outlives its episode", () => {
    const dayId = ensureDay("2026-08-30");
    const episodeId = createEpisode({
      dayId,
      chapterIndex: 1,
      startedAt: T0,
      endedAt: T0 + 600_000,
    });
    const id = createProposal({
      dayId,
      episodeId,
      title: "Send the one-pager to Dana by Thursday",
      verb: "file",
      destinationLabel: "Renew Acme",
      destinationRef: "project:acme",
      heard: {
        quote: "I'll get you the one-pager before Thursday",
        at: T0 + 5_400_000,
        place: "Verve",
        speaker: "You",
      },
    });
    forgetEpisode(episodeId);

    // Dismissed by the recall, but the audit trail survives the source.
    const proposal = getProposal(id)!;
    expect(proposal.heardQuote).toContain("one-pager");
    expect(proposal.heardPlace).toBe("Verve");
    expect(proposal.destinationLabel).toBe("Renew Acme");
  });

  test("confident proposals sort above the unsure fold", () => {
    const dayId = ensureDay("2026-08-30");
    createProposal({ dayId, title: "Unsure one", confidenceTier: "unsure" });
    createProposal({ dayId, title: "Confident one" });
    expect(listOpenProposals().map((p) => p.title)).toEqual([
      "Confident one",
      "Unsure one",
    ]);
  });

  test("the trust ledger counts dismissals — ✕ only teaches if it is data", () => {
    const dayId = ensureDay("2026-08-30");
    const a = createProposal({ dayId, title: "a" });
    const b = createProposal({ dayId, title: "b" });
    createProposal({ dayId, title: "c" });
    decideProposal(a, "accepted", "wi-1");
    decideProposal(b, "dismissed");

    expect(readTrustLedger()).toEqual({
      proposed: 1,
      accepted: 1,
      dismissed: 1,
    });
  });

  test("deciding records the work item but never creates one", () => {
    // This module holds no work-item writer; the id is handed to it.
    const dayId = ensureDay("2026-08-30");
    const id = createProposal({ dayId, title: "a" });
    decideProposal(id, "accepted", "wi-42");
    expect(getProposal(id)!.workItemId).toBe("wi-42");
  });
});

describe("marks and gaps", () => {
  test("a bookmark keeps the words verbatim", () => {
    const dayId = ensureDay("2026-08-30");
    recordMark({
      dayId,
      markedAt: T0,
      words: "Check whether the Vercel bill doubled",
    });
    const marks = listMarksForDay(dayId);
    expect(marks[0].kind).toBe("bookmark");
    expect(marks[0].words).toBe("Check whether the Vercel bill doubled");
  });

  test("the four absences stay distinguishable", () => {
    // Collapsing these would turn a chosen silence and a dead battery into
    // the same shrug — the frames draw all four differently.
    const dayId = ensureDay("2026-08-30");
    recordGap({
      dayId,
      startedAt: T0,
      reason: "not_worn",
      caption: "at home until noon",
    });
    recordGap({ dayId, startedAt: T0 + 1, reason: "off_the_record" });
    recordGap({
      dayId,
      startedAt: T0 + 2,
      reason: "battery",
      caption: "battery · 6:40",
    });
    recordGap({ dayId, startedAt: T0 + 3, reason: "forgotten" });

    expect(listGapsForDay(dayId).map((g) => g.reason)).toEqual([
      "not_worn",
      "off_the_record",
      "battery",
      "forgotten",
    ]);
  });
});
