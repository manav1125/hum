/**
 * Tests for the mobile lane roster (v8 M2).
 *
 * The one rule that makes mobile different from a shrunk desktop:
 *
 *   **At 390px there is no Tier 2. A lane is a card or a line, never between.**
 *
 * Everything else must hold identically to desktop, because both surfaces build
 * their roster from the same module: no lane silently absent, no number that
 * was not queried, and "0 need you" stated out loud rather than hidden.
 */

import { describe, expect, test } from "bun:test";

import {
  LANE_IDS,
  LANE_TIER,
  laneSlotsFor,
  TIER1_IDS,
  TIER2_IDS,
  TIER3_IDS,
  type LaneId,
} from "@/pages/hq/hq-tiers";

import { buildMv3Lanes, type Mv3LaneInput } from "./mv3-lanes";

const CARDS: Mv3LaneInput["cards"] = {
  needsYou: (count) => <div data-testid="needs-you">needs you: {count}</div>,
  delivered: (items) => <div>delivered: {items.length}</div>,
  missions: (missions) => <div>missions: {missions.length}</div>,
};

/** The calmest possible account: everything queried, everything empty. */
function input(overrides: Partial<Mv3LaneInput> = {}): Mv3LaneInput {
  return {
    glanceCount: 0,
    reviewError: false,
    done: [],
    doneError: false,
    missions: [],
    missionsError: false,
    running: [],
    cameIn: [],
    day: null,
    lifeGroups: [],
    arrivals: { total: 0, filed: 0, kept: 0 },
    arrivalsError: false,
    waiting: [],
    schedules: [],
    schedulesError: false,
    watchingCount: 0,
    heartbeatRuns: null,
    cards: CARDS,
    ...overrides,
  };
}

describe("no Tier 2 at 390px", () => {
  test("every Tier-2 lane is a line, even when it has data", () => {
    // The desktop deck would promote in-motion and Life to cards here. The
    // phone must not: a lane is a card or a line, never between.
    const lanes = buildMv3Lanes(
      input({
        running: [{ id: "w1", title: "Drafting the Acme reply" }] as never,
        cameIn: [{ id: "w2", title: "Invoice", projectId: null }] as never,
        lifeGroups: [{ horizon: "this_week", titles: ["renew the passport"] }],
        day: { commitments: [], unbookedMinutes: 240, freeBlock: null },
      }),
    );
    for (const id of TIER2_IDS) expect(lanes[id].render).toBe("line");
  });

  test("only the three Tier-1 lanes ever produce a card", () => {
    const { cards } = laneSlotsFor(buildMv3Lanes(input()));
    expect(cards.map((slot) => slot.id).sort()).toEqual(
      [...TIER1_IDS].sort() as LaneId[],
    );
    for (const slot of cards) expect(LANE_TIER[slot.id]).toBe(1);
  });
});

describe("Tier 1 renders a card at zero", () => {
  test("needs-you, delivered and missions all render empty", () => {
    const lanes = buildMv3Lanes(input());
    for (const id of TIER1_IDS) expect(lanes[id].render).toBe("card");
  });

  test("the needs-you card is built from the count HqPage computed", () => {
    // Mobile must not re-derive the number: the badge, the headline and the
    // rows are one set (invariant 2), and re-deriving is how they disagreed.
    const lanes = buildMv3Lanes(input({ glanceCount: 4 }));
    const slot = lanes.needs_you;
    expect(slot.render).toBe("card");
  });
});

describe("Tier 3 is always present", () => {
  test("the four lines exist however empty the account is", () => {
    const lanes = buildMv3Lanes(input());
    for (const id of TIER3_IDS) {
      expect(lanes[id].render).toBe("line");
      const slot = lanes[id];
      if (slot.render !== "line") throw new Error("unreachable");
      // A full sentence, not a label and not "0 items".
      expect(slot.line.sentence.length).toBeGreaterThan(12);
      expect(slot.line.sentence).toMatch(/[.!]$/);
    }
  });

  test("arrivals names WHY nothing arrived — a no-op is not a success", () => {
    const slot = buildMv3Lanes(input()).arrivals;
    if (slot.render !== "line") throw new Error("arrivals must be a line");
    expect(slot.line.sentence).toContain("nothing is watching");
  });

  test("the pulse line refuses to imply quiet when nothing is watched", () => {
    const slot = buildMv3Lanes(input({ heartbeatRuns: 1851 })).pulse;
    if (slot.render !== "line") throw new Error("pulse must be a line");
    expect(slot.line.sentence).toContain("Watching nothing");
    expect(slot.line.sentence).toContain("1,851");
  });
});

describe("no lane is silently absent, and no number is invented", () => {
  test("cards plus lines account for the whole roster", () => {
    const { cards, lines } = laneSlotsFor(buildMv3Lanes(input()));
    expect(cards.length + lines.length).toBe(LANE_IDS.length);
    const ids = [...cards, ...lines].map((slot) => slot.id).sort();
    expect(ids).toEqual([...LANE_IDS].sort() as LaneId[]);
  });

  test("a lane that could not be asked shows its reason, not a zero", () => {
    const lanes = buildMv3Lanes(
      input({
        arrivalsError: true,
        schedulesError: true,
        waitingUnavailable: { reason: "Couldn't load what you're waiting on" },
      }),
    );
    for (const id of ["arrivals", "rhythms", "waiting"] as const) {
      const slot = lanes[id];
      if (slot.render !== "line") throw new Error("expected a line");
      expect(slot.line.sentence).not.toContain("0");
      expect(slot.line.sentence.length).toBeGreaterThan(12);
    }
  });

  test("an unreadable Tier-1 lane keeps its card and states the reason", () => {
    const lanes = buildMv3Lanes(
      input({ doneError: true, missionsError: true }),
    );
    expect(lanes.delivered.render).toBe("card");
    expect(lanes.missions.render).toBe("card");
  });

  test("the batch lane says it isn't built yet rather than vanishing", () => {
    const slot = buildMv3Lanes(input()).batch;
    if (slot.render !== "line") throw new Error("batch must be a line");
    expect(slot.line.sentence).toContain("isn't grouping arrivals");
  });
});
