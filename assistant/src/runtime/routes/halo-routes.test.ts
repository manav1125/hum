/**
 * The Day, as the frames will read it.
 *
 * These assert response shape rather than storage, because the frames are the
 * contract: the sync pill must be honest about not knowing, absences must
 * arrive distinguishable, and marks must attach to their chapter rather than
 * being left for the client to correlate.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  createEpisode,
  createProposal,
  ensureDay,
  localDateOf,
  recordGap,
  recordMark,
  recordSegment,
  writeUnderstanding,
  writeVerdict,
} from "../../halo/halo-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  haloDays,
  haloEpisodes,
  haloGaps,
  haloMarks,
  haloProposals,
  haloSegments,
} from "../../memory/schema.js";
import { NotFoundError } from "./errors.js";
import { ROUTES } from "./halo-routes.js";

initializeDb();

const route = (id: string) => ROUTES.find((r) => r.operationId === id)!;
const T0 = Date.UTC(2026, 7, 30, 10, 12, 0);
const DATE = localDateOf(T0);

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

function seedDay() {
  const dayId = ensureDay(DATE);
  writeVerdict(dayId, "The morning found Acme its number.", 5 * 3600);
  const episodeId = createEpisode({
    dayId,
    chapterIndex: 1,
    startedAt: T0,
    endedAt: T0 + 40 * 60_000,
    placeLabel: "VERVE",
    boundaryReason: "calendar",
  });
  writeUnderstanding(episodeId, {
    title: "Acme landed on 24 months",
    keyTakeaways: [{ label: "Price", value: "floor holds at $47/seat" }],
    participants: ["Dana"],
  });
  return { dayId, episodeId };
}

describe("GET halo/status", () => {
  test("says it does not know rather than printing a zero", () => {
    // The lag number is real or absent. A fabricated 0 would claim Cue is
    // current with a room it has never heard.
    const status = route("haloStatus").handler({} as never) as {
      sync: { state: string; behindSeconds: number | null };
    };
    expect(status.sync.state).toBe("unknown");
    expect(status.sync.behindSeconds).toBeNull();
  });

  test("reports the real lag once audio has arrived", () => {
    recordSegment({
      deviceSessionId: "s",
      sequence: 1,
      startedAt: Date.now() - 600_000,
      coveredThrough: Date.now() - 580_000,
      snippet: "…so if the floor holds…",
    });
    const status = route("haloStatus").handler({} as never) as {
      sync: { state: string; behindSeconds: number; snippet: string };
    };
    expect(status.sync.state).toBe("behind");
    expect(status.sync.behindSeconds).toBeGreaterThan(500);
    expect(status.sync.snippet).toContain("floor holds");
  });
});

describe("GET halo/days/:date", () => {
  test("returns the cover: verdict, its scope, and the counts", () => {
    seedDay();
    const day = route("haloDay").handler({
      pathParams: { date: DATE },
    } as never) as Record<string, never>;

    expect(day.verdict).toBe("The morning found Acme its number." as never);
    // The qualifier travels with the verdict, always.
    expect(day.heardSeconds).toBe(18_000 as never);
    expect(day.counts).toMatchObject({ conversations: 1, places: 1 });
  });

  test("a chapter carries its takeaways and its own marks", () => {
    const { dayId, episodeId } = seedDay();
    const markId = recordMark({
      dayId,
      markedAt: T0 + 60_000,
      words: "Check whether the Vercel bill doubled",
    });
    getDb()
      .update(haloMarks)
      .set({ episodeId })
      .where(eq(haloMarks.id, markId))
      .run();

    const day = route("haloDay").handler({
      pathParams: { date: DATE },
    } as never) as { episodes: Array<Record<string, never>> };

    const episode = day.episodes[0];
    expect(episode.title).toBe("Acme landed on 24 months" as never);
    expect((episode.keyTakeaways as never as unknown[])[0]).toEqual({
      label: "Price",
      value: "floor holds at $47/seat",
    } as never);
    expect(episode.participants).toEqual(["Dana"] as never);
    // Attached here, not left for the client to correlate by timestamp.
    expect(episode.marks as never as unknown[]).toHaveLength(1);
  });

  test("the four absences come back distinguishable", () => {
    const { dayId } = seedDay();
    recordGap({
      dayId,
      startedAt: T0 - 3600_000,
      reason: "not_worn",
      caption: "at home until noon",
    });
    recordGap({ dayId, startedAt: T0 - 1800_000, reason: "off_the_record" });
    recordGap({
      dayId,
      startedAt: T0 - 900_000,
      reason: "battery",
      caption: "battery · 6:40",
    });
    recordGap({ dayId, startedAt: T0 - 300_000, reason: "forgotten" });

    const day = route("haloDay").handler({
      pathParams: { date: DATE },
    } as never) as { gaps: Array<{ reason: string; caption: string | null }> };

    expect(day.gaps.map((g) => g.reason)).toEqual([
      "not_worn",
      "off_the_record",
      "battery",
      "forgotten",
    ]);
    expect(day.gaps[0].caption).toBe("at home until noon");
  });

  test("a day nobody wore is a 404, not an empty day", () => {
    expect(() =>
      route("haloDay").handler({ pathParams: { date: "2026-01-01" } } as never),
    ).toThrow(NotFoundError);
  });

  test("a malformed date is refused before it reaches the store", () => {
    expect(() =>
      route("haloDay").handler({ pathParams: { date: "../../etc" } } as never),
    ).toThrow();
  });
});

describe("the queue", () => {
  test("carries the heard pill and the destination the chip names", () => {
    const { dayId, episodeId } = seedDay();
    createProposal({
      dayId,
      episodeId,
      title: "Send the one-pager to Dana by Thursday",
      destinationLabel: "Renew Acme",
      heard: {
        quote: "I'll get you the one-pager before Thursday",
        at: T0,
        place: "Verve",
        speaker: "You",
      },
    });

    const queue = route("haloQueue").handler({ queryParams: {} } as never) as {
      proposals: Array<{ destinationLabel: string; heard: { place: string } }>;
      ledger: { proposed: number };
    };
    expect(queue.proposals[0].destinationLabel).toBe("Renew Acme");
    expect(queue.proposals[0].heard.place).toBe("Verve");
    expect(queue.ledger.proposed).toBe(1);
  });

  test("accept turns one into work; dismiss records the ✕", async () => {
    const { dayId } = seedDay();
    const keep = createProposal({ dayId, title: "Keep me" });
    const drop = createProposal({ dayId, title: "Drop me" });

    const accepted = (await route("haloAcceptProposal").handler({
      body: { proposalId: keep },
    } as never)) as { status: string; workItemId: string };
    expect(accepted.status).toBe("accepted");
    expect(accepted.workItemId).toBeTruthy();

    route("haloDismissProposal").handler({
      body: { proposalId: drop },
    } as never);

    const queue = route("haloQueue").handler({ queryParams: {} } as never) as {
      proposals: unknown[];
      ledger: { accepted: number; dismissed: number };
    };
    expect(queue.proposals).toHaveLength(0);
    expect(queue.ledger).toMatchObject({ accepted: 1, dismissed: 1 });
  });

  test("accepting something that does not exist is a 404", async () => {
    await expect(
      route("haloAcceptProposal").handler({
        body: { proposalId: "x" },
      } as never),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("POST halo/marks", () => {
  test("registers before any audio for it has arrived", () => {
    // The button registering is the promise; the chapter comes later.
    const result = route("haloMark").handler({
      body: { markedAt: T0, words: "Check the Vercel bill" },
    } as never) as { id: string; kind: string };

    expect(result.kind).toBe("bookmark");
    const marks = getDb().select().from(haloMarks).all();
    expect(marks[0].words).toBe("Check the Vercel bill");
    // And it opened the day it belongs to.
    expect(getDb().select().from(haloDays).all()[0].localDate).toBe(DATE);
  });

  test("a double-click note is a different kind, not a different table", () => {
    const result = route("haloMark").handler({
      body: {
        markedAt: T0,
        kind: "note",
        words: "What if the film opens in silence",
      },
    } as never) as { kind: string };
    expect(result.kind).toBe("note");
  });

  test("an unparseable timestamp is refused", () => {
    expect(() =>
      route("haloMark").handler({ body: { markedAt: "yesterday" } } as never),
    ).toThrow();
  });
});
