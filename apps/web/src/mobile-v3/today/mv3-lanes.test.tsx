/**
 * Tests for the mobile lane roster and its rail (v8 M2, brief §13.1).
 *
 * Two rules make mobile what it is:
 *
 *   **At 390px a lane is a card or a line, never between.**
 *   **The rail is four lines** — Arrivals, Waiting, Rhythms, Pulse. A lane
 *   answers a standing question; an event either happened or it didn't, and an
 *   absent event carries no information.
 *
 * Everything else must hold identically to desktop, because both surfaces build
 * their roster from the same module: no lane silently absent, no number that
 * was not queried, and "0 need you" stated out loud rather than hidden.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  LANE_IDS,
  LANE_TIER,
  laneSlotsFor,
  SLOT_KIND,
  TIER1_IDS,
  TIER2_IDS,
  TIER3_IDS,
  type LaneId,
} from "@/pages/hq/hq-tiers";

import { buildMv3Lanes, Mv3TierRail, type Mv3LaneInput } from "./mv3-lanes";

afterEach(cleanup);

/**
 * The phone.
 *
 * The rail reads no width — which is the point, and worth stating rather than
 * assuming: the four lines are four because of what the roster says, not
 * because of a breakpoint, so mobile and desktop cannot drift apart by one
 * surface quietly changing its query.
 */
function at390() {
  Object.defineProperty(window, "innerWidth", { value: 390, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, writable: true });
}

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

function renderRail(
  lanes: Record<LaneId, ReturnType<typeof buildMv3Lanes>[LaneId]>,
) {
  return render(
    <MemoryRouter>
      <Mv3TierRail lanes={lanes} />
    </MemoryRouter>,
  );
}

describe("the rail at 390px is four lines", () => {
  test("exactly Arrivals, Waiting, Rhythms and Pulse on a quiet phone", () => {
    // Nine before §13.1 — the four, plus in-motion, the day, Life, the batch
    // offer and the filing correction, each reporting an emptiness nobody had
    // asked about. Four now, and the same four the desktop rail renders.
    at390();
    const { container } = renderRail(buildMv3Lanes(input()));
    const lines = container.querySelectorAll("[data-slot='mv3-tier-line']");
    expect(lines).toHaveLength(4);
    expect([...lines].map((el) => el.getAttribute("data-lane"))).toEqual([
      ...TIER3_IDS,
    ]);
  });

  test("still four when the phone is busy", () => {
    at390();
    const { container } = renderRail(
      buildMv3Lanes(
        input({
          running: [{ id: "w1", title: "Drafting the Acme reply" }] as never,
          cameIn: [{ id: "w2", title: "Invoice", projectId: null }] as never,
          lifeGroups: [
            { horizon: "this_week", titles: ["renew the passport"] },
          ],
          day: { commitments: [], unbookedMinutes: 240, freeBlock: null },
          schedules: [{ id: "s1" }] as never,
          watchingCount: 3,
        }),
      ),
    );
    expect(
      container.querySelectorAll("[data-slot='mv3-tier-line']"),
    ).toHaveLength(4);
  });

  test("every line is a full sentence with a glyph and a door", () => {
    at390();
    const { container } = renderRail(buildMv3Lanes(input()));
    for (const id of TIER3_IDS) {
      const node = container.querySelector(`[data-lane='${id}']`);
      expect(node).not.toBeNull();
      expect(
        node!.querySelector("[aria-hidden]")!.textContent!.trim(),
      ).not.toBe("");
      expect(node!.textContent!.trim().length).toBeGreaterThan(12);
    }
  });
});

describe("no card between the tiers at 390px", () => {
  test("only the three Tier-1 lanes ever produce a card", () => {
    const { cards } = laneSlotsFor(
      buildMv3Lanes(
        input({
          running: [{ id: "w1", title: "Drafting the Acme reply" }] as never,
          cameIn: [{ id: "w2", title: "Invoice", projectId: null }] as never,
          lifeGroups: [
            { horizon: "this_week", titles: ["renew the passport"] },
          ],
          day: { commitments: [], unbookedMinutes: 240, freeBlock: null },
        }),
      ),
    );
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

describe("a LANE is never silently absent", () => {
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

  test("an absorbed lane still takes a line when it could not be queried", () => {
    // The census bar cannot be answering "is anything running?" out of a query
    // that failed, so absorption does not apply and the lane says so. Five
    // lines here, and the fifth is the honest one.
    at390();
    const { container } = renderRail(
      buildMv3Lanes(
        input({
          dayUnavailable: { reason: "Cue couldn't read your calendar." },
        }),
      ),
    );
    const lines = container.querySelectorAll("[data-slot='mv3-tier-line']");
    expect(lines).toHaveLength(5);
    const day = container.querySelector("[data-lane='day']");
    expect(day!.textContent).toContain("couldn't read your calendar");
  });

  test("cards plus lines plus warranted absences account for the whole roster", () => {
    const { cards, lines, absent } = laneSlotsFor(buildMv3Lanes(input()));
    expect(cards.length + lines.length + absent.length).toBe(LANE_IDS.length);
    const ids = [...cards, ...lines, ...absent].map((slot) => slot.id).sort();
    expect(ids).toEqual([...LANE_IDS].sort() as LaneId[]);
    // Only events and absorbed lanes are ever among the absences.
    for (const slot of absent) {
      expect(TIER2_IDS).toContain(slot.id);
      expect(TIER3_IDS).not.toContain(slot.id);
    }
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
});

describe("an EVENT is absent when it didn't happen", () => {
  test("the batch offer renders nothing at all rather than a line about itself", () => {
    // It used to say "Cue isn't batching anything" — a grey sentence reporting
    // the absence of a feature nobody was waiting on. Mutation: make `event`
    // fall back to a line and this fails, along with the four-line count.
    at390();
    const slot = buildMv3Lanes(input()).batch;
    expect(slot.render).toBe("absent");
    const { container } = renderRail(buildMv3Lanes(input()));
    expect(container.querySelector("[data-lane='batch']")).toBeNull();
    expect(container.textContent).not.toContain("batching");
  });

  test("the filing correction is absent even when arrivals are unfiled", () => {
    // §13.1: a correction is a full takeover when it exists, never a line. The
    // takeover is not built on mobile yet, so this stays absent — and when it
    // is built it plugs in as this event's card.
    const slot = buildMv3Lanes(
      input({ cameIn: [{ id: "w2", title: "Invoice" }] as never }),
    ).correction;
    expect(slot.render).toBe("absent");
    expect(SLOT_KIND.correction).toBe("event");
  });

  test("in-motion no longer takes a line — the census carries its count", () => {
    // The census bar states "N doing" and keeps that segment at zero (see
    // `Mv3Census`), which is what earns in-motion the right to render nothing.
    const lanes = buildMv3Lanes(
      input({ running: [{ id: "w1", title: "Drafting" }] as never }),
    );
    expect(lanes.in_motion.render).toBe("absent");
    const slot = lanes.in_motion;
    if (slot.render !== "absent") throw new Error("unreachable");
    expect(slot.warrant.because).toContain("census");
    expect(SLOT_KIND.in_motion).toBe("lane");
  });
});
