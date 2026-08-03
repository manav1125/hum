/**
 * The honesty rules behind People, tested as rules rather than as pixels.
 *
 * Two of these exist because the frame asks for something the daemon cannot
 * supply, and the failure mode is silent: a plausible sentence that nobody
 * questions. So the tests assert the ABSENCE as hard as the presence.
 */

import { describe, expect, test } from "bun:test";

import {
  ACTIVE_WITHIN_DAYS,
  QUIET_AFTER_DAYS,
  QUIET_MIN_EXCHANGES,
  asProse,
  avatarGround,
  browsablePeople,
  compactAgo,
  daysSince,
  learnedSummary,
  learnedSummaryFromBulk,
  provenanceLine,
  relationshipState,
  type ContactMemoryReadEntry,
  type ContactMemoryRow,
} from "./people-data";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function memory(over: Partial<ContactMemoryRow> = {}): ContactMemoryRow {
  return {
    id: "m1",
    contactId: "c1",
    statement: "Replies before 10am, never after 6",
    kind: "fact",
    source: "from_conversation",
    sourceRef: null,
    confidence: 0.9,
    createdAt: NOW - 30 * DAY,
    lastSeenAt: NOW - DAY,
    ...over,
  };
}

describe("relationshipState — real fields only", () => {
  test("a long gap on a real relationship is going quiet, with the gap shown", () => {
    const s = relationshipState(
      { lastInteraction: NOW - 11 * DAY, interactionCount: 9 },
      NOW,
    );
    expect(s.id).toBe("quiet");
    expect(s.days).toBe(11);
    // The evidence is IN the label — the reader can check the claim.
    expect(s.label).toBe("Going quiet · 11 days");
  });

  test("a one-off from weeks ago is not 'going quiet' — there is no relationship to fade", () => {
    const s = relationshipState(
      {
        lastInteraction: NOW - 40 * DAY,
        interactionCount: QUIET_MIN_EXCHANGES - 1,
      },
      NOW,
    );
    expect(s.id).not.toBe("quiet");
  });

  test("a recent exchange reads active", () => {
    const s = relationshipState(
      { lastInteraction: NOW - ACTIVE_WITHIN_DAYS * DAY, interactionCount: 20 },
      NOW,
    );
    expect(s.id).toBe("active");
  });

  test("no exchanges is 'no exchanges yet', never a strength", () => {
    const s = relationshipState(
      { lastInteraction: null, interactionCount: 0 },
      NOW,
    );
    expect(s.id).toBe("new");
    expect(s.label).toBe("No exchanges yet");
    expect(s.days).toBeNull();
  });

  test("NEVER claims 'you owe a reply' or 'waiting on her' — no direction field exists", () => {
    // Design's M3/F4 draw both. If a direction field ever lands, this test is
    // the thing to change deliberately — not a sentence that quietly appears.
    const samples = [
      { lastInteraction: NOW - 1 * DAY, interactionCount: 47 },
      { lastInteraction: NOW - 6 * DAY, interactionCount: 31 },
      { lastInteraction: NOW - 60 * DAY, interactionCount: 200 },
      { lastInteraction: null, interactionCount: 0 },
      { lastInteraction: NOW - QUIET_AFTER_DAYS * DAY, interactionCount: 3 },
    ];
    for (const s of samples) {
      const label = relationshipState(s, NOW).label.toLowerCase();
      expect(label).not.toContain("owe");
      expect(label).not.toContain("waiting on");
      expect(label).not.toContain("reply");
    }
  });

  test("a clock skew into the future reads as 0 days, never negative", () => {
    expect(daysSince(NOW + 5 * DAY, NOW)).toBe(0);
  });
});

describe("learnedSummary — four outcomes that must not read the same", () => {
  const base = {
    isLoading: false,
    isError: false,
    memory: [] as ContactMemoryRow[],
    degraded: false as boolean | undefined,
    degradedReason: null as string | null,
    interactionCount: 12,
    displayName: "Dana Whitman",
  };

  test("a failed fetch is an error, not an empty result", () => {
    const s = learnedSummary({ ...base, isError: true });
    expect(s.status).toBe("error");
    if (s.status !== "error") throw new Error("unreachable");
    expect(s.sentence).toContain("failed request");
    // Crucially it must NOT be the "nothing learned yet" sentence.
    expect(s.sentence).not.toContain("hasn't learned anything");
  });

  test("error beats degraded and empty — order matters", () => {
    const s = learnedSummary({
      ...base,
      isError: true,
      degraded: true,
      degradedReason: "the model timed out",
    });
    expect(s.status).toBe("error");
  });

  test("a degraded pipeline says extraction is learning nothing, and why", () => {
    const s = learnedSummary({
      ...base,
      degraded: true,
      degradedReason: "the extraction budget is shorter than the model needs",
    });
    expect(s.status).toBe("degraded");
    if (s.status !== "degraded") throw new Error("unreachable");
    expect(s.sentence).toContain("learning nothing");
    expect(s.reason).toBe(
      "the extraction budget is shorter than the model needs",
    );
  });

  test("a healthy pipeline with nothing written says so WITHOUT blaming a bug", () => {
    const s = learnedSummary(base);
    expect(s.status).toBe("empty");
    if (s.status !== "empty") throw new Error("unreachable");
    expect(s.sentence).toContain("hasn't learned anything durable");
    expect(s.sentence).not.toContain("learning nothing");
  });

  test("an UNREAD health check does not get treated as healthy or as broken", () => {
    // `degraded: undefined` = the health request itself failed. An unread
    // check is not evidence of a problem, so it falls through to the neutral
    // empty sentence rather than accusing the pipeline.
    const s = learnedSummary({ ...base, degraded: undefined });
    expect(s.status).toBe("empty");
  });

  test("real rows become prose with real provenance and nothing invented", () => {
    const rows = [
      memory({ id: "a", statement: "Handles the redlines" }),
      memory({
        id: "b",
        statement: "Prefers email over chat for anything contractual.",
        createdAt: NOW - 60 * DAY,
      }),
    ];
    const s = learnedSummary({ ...base, memory: rows });
    expect(s.status).toBe("learned");
    if (s.status !== "learned") throw new Error("unreachable");
    expect(s.prose).toBe(
      "Handles the redlines. Prefers email over chat for anything contractual.",
    );
    expect(s.statements).toHaveLength(2);
    expect(s.provenance).toContain("From 12 exchanges");
    // The provenance date is the EARLIEST row, not the first in the array.
    expect(s.provenance).toContain("first learned");
  });

  test("loading is its own state — never rendered as empty", () => {
    expect(learnedSummary({ ...base, isLoading: true }).status).toBe("loading");
  });

  test("prose punctuates but never adds words", () => {
    expect(asProse(["a", "b."])).toBe("a. b.");
  });

  test("provenance drops the half it cannot support", () => {
    expect(provenanceLine(0, [])).toBeNull();
    expect(provenanceLine(0, [memory()])).toContain("First learned");
    expect(provenanceLine(3, [])).toBe("From 3 exchanges");
  });
});

describe("learnedSummaryFromBulk — three states that arrive as zero rows", () => {
  const base = {
    isLoading: false,
    isError: false,
    degraded: false as boolean | undefined,
    degradedReason: null as string | null,
    interactionCount: 12,
    displayName: "Dana Whitman",
  };

  function entry(over: Partial<ContactMemoryReadEntry> = {}) {
    return {
      contactId: "c1",
      status: "empty",
      memory: [],
      total: 0,
      reason: null,
      ...over,
    } as ContactMemoryReadEntry;
  }

  test("`learned` renders the real rows", () => {
    const s = learnedSummaryFromBulk({
      ...base,
      entry: entry({
        status: "learned",
        memory: [memory({ statement: "Handles the redlines" })],
        total: 1,
      }),
    });
    expect(s.status).toBe("learned");
    if (s.status !== "learned") throw new Error("unreachable");
    expect(s.prose).toBe("Handles the redlines.");
  });

  test("`empty` is the honest nothing-yet sentence", () => {
    const s = learnedSummaryFromBulk({ ...base, entry: entry() });
    expect(s.status).toBe("empty");
  });

  /**
   * The whole reason the response carries a status: `empty` and `unavailable`
   * are byte-identical apart from it. A summary that reads the rows instead of
   * the status produces the wrong sentence here and nowhere else.
   */
  test("`unavailable` is a failure, never the nothing-yet sentence", () => {
    const s = learnedSummaryFromBulk({
      ...base,
      entry: entry({
        status: "unavailable",
        reason: "Cue has no contact with this id",
      }),
    });
    expect(s.status).toBe("error");
    if (s.status !== "error") throw new Error("unreachable");
    expect(s.sentence).toContain("couldn't look up");
    expect(s.sentence).toContain("Cue has no contact with this id");
    expect(s.sentence).not.toContain("hasn't learned anything");
  });

  test("`unavailable` outranks a degraded pipeline — we never got that far", () => {
    const s = learnedSummaryFromBulk({
      ...base,
      degraded: true,
      degradedReason: "the extraction budget expired",
      entry: entry({ status: "unavailable", reason: null }),
    });
    expect(s.status).toBe("error");
  });

  test("a contact missing from a settled response is unavailable, not empty", () => {
    const s = learnedSummaryFromBulk({ ...base, entry: undefined });
    expect(s.status).toBe("error");
  });

  test("a contact missing while the read is still in flight is loading", () => {
    const s = learnedSummaryFromBulk({
      ...base,
      isLoading: true,
      entry: undefined,
    });
    expect(s.status).toBe("loading");
  });

  test("a failed read beats any per-contact verdict", () => {
    const s = learnedSummaryFromBulk({
      ...base,
      isError: true,
      entry: entry({ status: "empty" }),
    });
    expect(s.status).toBe("error");
    if (s.status !== "error") throw new Error("unreachable");
    expect(s.sentence).toContain("failed request");
  });
});

describe("list helpers", () => {
  test("you and the assistant are not 'people Cue knows'", () => {
    const list = browsablePeople([
      {
        id: "1",
        displayName: "A",
        role: "contact",
        interactionCount: 1,
        lastInteraction: 5,
        channels: [],
      },
      {
        id: "2",
        displayName: "Me",
        role: "guardian",
        interactionCount: 9,
        lastInteraction: 9,
        channels: [],
      },
      {
        id: "3",
        displayName: "Cue",
        role: "assistant",
        interactionCount: 9,
        lastInteraction: 9,
        channels: [],
      },
    ] as never);
    expect(list.map((c) => c.id)).toEqual(["1"]);
  });

  test("every avatar ground is an -on-fill leg (these discs carry white text)", () => {
    const bright = ["#0e8c8c", "#3d6ee8", "#7f77dd", "#b4770f", "#c24e42"];
    for (const name of [
      "Rachel Lieu",
      "Dana Whitman",
      "Sarah Chen",
      "Tom Beale",
      "Q",
    ]) {
      expect(bright).not.toContain(avatarGround(name).toLowerCase());
    }
  });

  test("compactAgo is a duration, never a fabricated date", () => {
    expect(compactAgo(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(compactAgo(null, NOW)).toBeNull();
  });
});
