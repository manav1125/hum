/**
 * The hinge, and the honesty rules that hang off it.
 *
 * Two things are being proven here, and only one of them is about pixels:
 *
 *   1 · **Glance and Deck cannot drift apart.** They render from one census, so
 *       the assertion is that the strip's number for a lane is the *same object*
 *       the rail shows — not a matching value, the same reading. A test that
 *       compares two independently-computed numbers passes right up until the
 *       moment somebody computes one of them differently.
 *
 *   2 · **Never a fake number.** A lane we could not read prints no digit, its
 *       cell is not tappable, and the "filed" label names the window the daemon
 *       actually reported rather than the "today" design's frame illustrated.
 *
 * Every guard in here is mutation-checked: the test breaks the thing the guard
 * watches and asserts the guard fires. A green check on a check that has never
 * fired is not evidence.
 */

import { describe, expect, test } from "bun:test";

import { routes } from "@/utils/routes";

import { known, unavailable } from "./hq-tiers";
import type { HqSchedule, HqWorkItem, Mission } from "./use-missions";
import {
  blockedMissions,
  buildHqCensus,
  DECK_SLOT,
  GLANCE_SLOT,
  HQ_LANE_IDS,
  isTappable,
  RAIL_ORDER,
  railTiles,
  STRIP_ORDER,
  stripCells,
  sublineLanes,
  type HqCensusInput,
  type HqLaneId,
} from "./hq-census";

// ---------------------------------------------------------------------------
// Fixtures — the narrow slices these derivations actually read
// ---------------------------------------------------------------------------

function mission(over: Partial<Mission> & { id: string }): Mission {
  return {
    status: "active",
    title: over.id,
    budgetCents: null,
    spentCents: 0,
    rollup: { counts: { awaiting_review: 0 }, projects: [] },
    ...over,
  } as unknown as Mission;
}

function workItem(id: string, over: Partial<HqWorkItem> = {}): HqWorkItem {
  return { id, title: id, ...over } as unknown as HqWorkItem;
}

/** A queued item the pre-run assessor is holding for a word from the owner. */
function heldItem(id: string): HqWorkItem {
  return workItem(id, {
    assessmentVerdict: "clarify",
    assessmentQuestion: "Which invoice?",
  } as Partial<HqWorkItem>);
}

function schedule(nextRunAt: number): HqSchedule {
  return { id: "s", nextRunAt } as unknown as HqSchedule;
}

function input(over: Partial<HqCensusInput> = {}): HqCensusInput {
  return {
    needsYou: known(0),
    valve: known({ stop: "needs_you" as const, held: 0, unbanded: 0 }),
    missions: known([]),
    holding: known([]),
    arrivals: known({ total: 0, filed: 0, kept: 0, windowHours: 24 }),
    inMotion: known({ running: [], schedules: [] }),
    watching: known({ live: [], failing: [] }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1 · The hinge
// ---------------------------------------------------------------------------

describe("the hinge — Glance and Deck are one census", () => {
  test("every lane has a home in BOTH densities", () => {
    for (const id of HQ_LANE_IDS) {
      expect(GLANCE_SLOT[id]).toBeDefined();
      expect(DECK_SLOT[id]).toBeDefined();
    }
  });

  test("a strip number and its rail tile are the SAME reading, not two", () => {
    const census = buildHqCensus(
      input({
        needsYou: known(6),
        missions: known([
          mission({ id: "a" }),
          mission({ id: "b", status: "paused" }),
        ]),
        holding: known([workItem("q1"), workItem("q2")]),
        arrivals: known({ total: 18, filed: 12, kept: 6, windowHours: 24 }),
      }),
    );
    const strip = new Map(stripCells(census).map((r) => [r.id, r]));
    const rail = new Map(railTiles(census).map((r) => [r.id, r]));
    for (const [id, reading] of rail) {
      const cell = strip.get(id);
      if (!cell) continue; // in_motion rides the subline — asserted below
      // Identity, not equality: two objects that happen to agree today are
      // exactly how the old deck ended up showing 6 beside a badge reading 5.
      expect(cell).toBe(reading);
    }
  });

  test("the lane with no strip cell is still stated in Glance", () => {
    const census = buildHqCensus(input());
    const stripIds = stripCells(census).map((r) => r.id);
    const railIds = railTiles(census).map((r) => r.id);
    const sublineIds = sublineLanes(census).map((r) => r.id);
    // Nothing appears or disappears between views: every lane is either in the
    // strip or in the subline on Glance, and in the rail or the centre on Deck.
    for (const id of HQ_LANE_IDS) {
      expect(stripIds.includes(id) || sublineIds.includes(id)).toBe(true);
      expect(railIds.includes(id) || DECK_SLOT[id] === "centre").toBe(true);
    }
    expect(sublineIds).toEqual(["in_motion"]);
  });

  test("the orders match the declarations exactly", () => {
    const sorted = (ids: readonly HqLaneId[]): string[] => [...ids].sort();
    expect(sorted(STRIP_ORDER)).toEqual(
      sorted(HQ_LANE_IDS.filter((id) => GLANCE_SLOT[id] === "strip")),
    );
    expect(sorted(RAIL_ORDER)).toEqual(
      sorted(HQ_LANE_IDS.filter((id) => DECK_SLOT[id] === "rail")),
    );
  });

  // — mutation checks: break it, and the guard must fire ————————————————
  test("MUTATION · dropping a declared lane from the strip order throws", () => {
    const census = buildHqCensus(input());
    const short = STRIP_ORDER.filter((id) => id !== "holding");
    expect(() => stripCells(census, short)).toThrow(/missing declared lane/);
  });

  test("MUTATION · smuggling a non-strip lane into the strip order throws", () => {
    const census = buildHqCensus(input());
    const wrong: HqLaneId[] = [...STRIP_ORDER, "in_motion"];
    expect(() => stripCells(census, wrong)).toThrow(/not declared for it/);
  });

  test("MUTATION · dropping a declared lane from the rail order throws", () => {
    const census = buildHqCensus(input());
    const short = RAIL_ORDER.filter((id) => id !== "watching");
    expect(() => railTiles(census, short)).toThrow(/missing declared lane/);
  });
});

// ---------------------------------------------------------------------------
// 2 · Never a fake number
// ---------------------------------------------------------------------------

describe("never a fake number", () => {
  test("a lane we could not read prints no digit, and says why", () => {
    const census = buildHqCensus(
      input({ needsYou: unavailable("Cue couldn't read your review queue.") }),
    );
    expect(census.needs_you.stat.kind).toBe("unknown");
    expect(census.needs_you.detail).toBe(
      "Cue couldn't read your review queue.",
    );
    expect(census.needs_you.detail).not.toMatch(/\d/);
  });

  test("an unreadable lane is NOT offered as a tap target", () => {
    const census = buildHqCensus(input({ holding: unavailable("no answer") }));
    expect(isTappable(census.holding)).toBe(false);
    // …while a real zero still is: "0 queued" is a measurement.
    expect(isTappable(buildHqCensus(input()).holding)).toBe(true);
  });

  test("a queried zero is a count, never an absence", () => {
    const census = buildHqCensus(input({ needsYou: known(0) }));
    expect(census.needs_you.stat).toEqual({ kind: "count", value: 0 });
  });

  test("the filed label names the window the daemon reported", () => {
    const census = buildHqCensus(
      input({
        arrivals: known({ total: 18, filed: 12, kept: 6, windowHours: 24 }),
      }),
    );
    // Design's frame says "FILED TODAY". `arrivals/summary` is a TRAILING
    // window with no `since`, so "today" is a claim this surface cannot make.
    expect(census.filed.stripLabel).toBe("FILED · 24H");
    expect(census.filed.stripLabel).not.toMatch(/TODAY/i);
    expect(census.filed.detail).toContain("last 24h");
    expect(census.filed.detail).toContain("12 filed");
  });

  test("a different window changes the label, so it can never go stale", () => {
    const census = buildHqCensus(
      input({
        arrivals: known({ total: 3, filed: 3, kept: 0, windowHours: 6 }),
      }),
    );
    expect(census.filed.stripLabel).toBe("FILED · 6H");
    expect(census.filed.detail).toContain("last 6h");
  });

  test("nothing arrived does not get reported as calm", () => {
    const census = buildHqCensus(input());
    expect(census.filed.detail).toBe("Nothing arrived in the last 24h.");
  });
});

// ---------------------------------------------------------------------------
// 3 · The volume valve
// ---------------------------------------------------------------------------

describe("the volume valve", () => {
  test("an unfiltered lane cannot masquerade as a filtered one", () => {
    // The shipping-day shape: 6 in front of you, and the valve has never sized
    // up 5 of them. They are loud because they are unknown, not because the
    // valve judged them urgent — and the lane has to say which.
    const census = buildHqCensus(
      input({
        needsYou: known(6),
        valve: known({ stop: "needs_you", held: 37, unbanded: 5 }),
      }),
    );
    expect(census.needs_you.detail).toBe("6 things need you.");
    // The caveat is a SEPARATE field so it can reach Glance, where the lane is
    // nothing but a number in the footer strip.
    expect(census.needs_you.caveat).toBe(
      "5 of 6 not sized up by the valve yet.",
    );
  });

  test("a wholly unsized lane says so plainly, not as a fraction", () => {
    const census = buildHqCensus(
      input({
        needsYou: known(131),
        valve: known({ stop: "needs_you", held: 0, unbanded: 131 }),
      }),
    );
    expect(census.needs_you.caveat).toContain("hasn't sized any of these up");
    expect(census.needs_you.caveat).toContain("loud by default");
  });

  test("held work is stated with a door, never folded into the count", () => {
    const census = buildHqCensus(
      input({
        holding: known([workItem("a"), workItem("b")]),
        valve: known({ stop: "needs_you", held: 37, unbanded: 0 }),
      }),
    );
    // The stat stays the queued count: "what Cue has to do" and "what the
    // valve is holding back from you" are different sets, and one number
    // cannot answer both.
    expect(census.holding.stat).toEqual({ kind: "count", value: 2 });
    expect(census.holding.detail).toBe(
      "2 queued — none of them are waiting on you.",
    );
    expect(census.holding.caveat).toBe(
      "37 more held back — in Work, nothing lost.",
    );
    // The door goes to the surface that asks for no stop, so the 37 are there.
    expect(census.holding.href).toBe(routes.allWork);
  });

  test("a valve that has not answered contributes NOTHING, not a zero", () => {
    const census = buildHqCensus(
      input({
        needsYou: known(6),
        holding: known([workItem("a")]),
        valve: unavailable("Still reading your volume valve…"),
      }),
    );
    expect(census.needs_you.detail).toBe("6 things need you.");
    expect(census.holding.detail).toBe(
      "1 queued — none of them are waiting on you.",
    );
    // Specifically: it must not have invented "0 held back" or "0 unsized".
    expect(census.holding.caveat).toBeNull();
    expect(census.needs_you.caveat).toBeNull();
  });

  test("a fully-sized, nothing-held valve stays quiet rather than boasting", () => {
    const census = buildHqCensus(
      input({
        needsYou: known(2),
        valve: known({ stop: "needs_you", held: 0, unbanded: 0 }),
      }),
    );
    expect(census.needs_you.detail).toBe("2 things need you.");
    expect(census.needs_you.caveat).toBeNull();
  });

  test("every lane carries a caveat field, so none can silently omit one", () => {
    const census = buildHqCensus(
      input({ valve: known({ stop: "needs_you", held: 12, unbanded: 3 }) }),
    );
    for (const id of HQ_LANE_IDS) {
      expect(census[id]).toHaveProperty("caveat");
    }
  });
});

// ---------------------------------------------------------------------------
// 4 · The sentences, where the label is half the honesty
// ---------------------------------------------------------------------------

describe("lane sentences", () => {
  test("blocked-ness is derived ONCE and shared with the rings", () => {
    const missions = [
      mission({ id: "a" }),
      mission({ id: "b", status: "paused" }),
      mission({ id: "c", status: "abandoned" }),
    ];
    const census = buildHqCensus(input({ missions: known(missions) }));
    expect(blockedMissions(missions)).toHaveLength(2);
    // The tile draws rings from `blockedMissions`; the strip prints this. One
    // function, so the number beside the picture cannot contradict it.
    expect(census.blocked.stat).toEqual({ kind: "count", value: 2 });
    expect(census.blocked.detail).toBe("3 missions · 2 blocked on your call.");
  });

  test("holding never claims 'none need you' when the assessor holds one", () => {
    const clean = buildHqCensus(
      input({ holding: known([workItem("a"), workItem("b")]) }),
    );
    expect(clean.holding.detail).toBe(
      "2 queued — none of them are waiting on you.",
    );

    const held = buildHqCensus(
      input({ holding: known([workItem("a"), heldItem("b")]) }),
    );
    expect(held.holding.detail).toBe("2 queued · 1 waiting on a word from you.");
    expect(held.holding.detail).not.toContain("none");
  });

  test("watching reports the poll clock as a poll clock", () => {
    const census = buildHqCensus(
      input({
        watching: known({
          live: [
            { id: "1", name: "Gmail", lastPollAt: Date.now() - 4 * 60_000 },
            { id: "2", name: "Slack", lastPollAt: null },
          ],
          failing: [],
        }),
      }),
    );
    expect(census.watching.stat).toEqual({ kind: "count", value: 2 });
    // "checked" is what `lastPollAt` measures. "hit" would be a claim that
    // something arrived, which this field is no evidence for at all.
    expect(census.watching.detail).toContain("checked");
    expect(census.watching.detail).not.toMatch(/\bhit\b/);
  });

  test("a watcher that exists but is failing is named, never counted in", () => {
    const census = buildHqCensus(
      input({
        watching: known({
          live: [],
          failing: [{ id: "1", name: "Gmail", lastPollAt: null }],
        }),
      }),
    );
    expect(census.watching.stat).toEqual({ kind: "count", value: 0 });
    expect(census.watching.detail).toBe(
      "Gmail can't be reached — nothing is being watched.",
    );
    // Not colour alone: the sentence carries the failure in words.
    expect(census.watching.tone).toBe("alarm");
  });

  test("nothing watched says why, rather than implying quiet", () => {
    const census = buildHqCensus(input());
    expect(census.watching.detail).toContain("Nothing is watched yet");
  });

  test("in motion carries the next rhythm, and omits it when there is none", () => {
    const withRhythm = buildHqCensus(
      input({
        inMotion: known({
          running: [workItem("r")],
          schedules: [schedule(Date.now() + 2 * 3_600_000)],
        }),
      }),
    );
    expect(withRhythm.in_motion.detail).toContain("1 running");
    expect(withRhythm.in_motion.detail).toContain("1 rhythm");
    expect(withRhythm.in_motion.detail).toContain("in 2h");

    const idle = buildHqCensus(input());
    expect(idle.in_motion.detail).toBe(
      "Nothing is running · nothing on a schedule.",
    );
  });

  test("every lane carries a glyph, so no state is colour alone", () => {
    const census = buildHqCensus(input());
    for (const id of HQ_LANE_IDS) {
      expect(census[id].glyph.length).toBeGreaterThan(0);
    }
  });
});
