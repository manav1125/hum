/**
 * Tests for the two design rulings of 2026-08-01.
 *
 *  1. `awaiting_review` reads as "Needs you", not "Review".
 *  2. An abandoned mission still gets a ring, in the `blocked` tone.
 *
 * Both were product decisions rather than engineering ones, so they are pinned
 * here — a future refactor that quietly reverts either would otherwise look
 * like a tidy-up.
 */

import { describe, expect, test } from "bun:test";

import { workStateMeta } from "@vellumai/design-library";

import { describeWorkState } from "@/pages/hq/work-vocabulary";
import { ringStatusFor } from "@/pages/hq/use-missions";

type MissionLike = Parameters<typeof ringStatusFor>[0];

const NO_COUNTS = {
  queued: 0,
  running: 0,
  awaiting_review: 0,
  done: 0,
  failed: 0,
  open: 0,
  total: 0,
};

function mission(over: Partial<MissionLike> = {}): MissionLike {
  return {
    status: "active",
    budgetCents: null,
    spentCents: 0,
    rollup: {
      counts: { ...NO_COUNTS },
      projects: [],
      spentCents: 0,
      budgetCents: null,
    },
    ...over,
  } as MissionLike;
}

describe("ruling 1 — awaiting_review is 'Needs you'", () => {
  test("the work vocabulary says Needs you", () => {
    expect(describeWorkState("awaiting_review").label).toBe("Needs you");
  });

  test("the design-library state model agrees, so the two cannot drift", () => {
    // The split this closes: deliverable 07 called it "Review", §3 called it
    // "Needs you", and it is the label on the deck's primary lane AND the
    // sidebar badge — so the product said two things about one number.
    expect(workStateMeta({ status: "awaiting_review" }).label).toBe("Needs you");
  });

  test("'Ready for review' survives as a distinct state", () => {
    // Mapped rather than relabelled: renaming `review` would have left two
    // states rendering identically. ◱ stays reserved for the real thing.
    expect(describeWorkState("ready_for_review").label).toBe("Ready for review");
    expect(describeWorkState("ready_for_review").glyph).toBe("◱");
  });
});

describe("ruling 2 — an abandoned mission keeps its ring", () => {
  test("abandoned reads as blocked, not as absent", () => {
    expect(ringStatusFor(mission({ status: "abandoned" }))).toBe("blocked");
  });

  test("paused and budget-stopped still read as blocked", () => {
    expect(ringStatusFor(mission({ status: "paused" }))).toBe("blocked");
    expect(
      ringStatusFor(mission({ budgetCents: 1000, spentCents: 1000 })),
    ).toBe("blocked");
  });

  test("an active mission with work awaiting you reads needs_you", () => {
    expect(
      ringStatusFor(
        mission({
          rollup: {
            counts: { ...NO_COUNTS, awaiting_review: 2, open: 2, total: 2 },
            projects: [],
            spentCents: 0,
            budgetCents: null,
          },
        }),
      ),
    ).toBe("needs_you");
  });

  test("an ordinary active mission is on track", () => {
    expect(ringStatusFor(mission())).toBe("on_track");
  });
});
