/**
 * Tests for the three tiers — the render policy that replaced "every module
 * renders, always".
 *
 * These do not assert styling. Each one encodes a rule the deck would otherwise
 * break silently, and two of them exist because the rule they guard is the
 * whole reason the old policy was written in the first place:
 *
 *   · Tier 1 renders a card at ZERO      — "nothing needs you" deserves space
 *   · Tier 2 empty renders a LINE        — never nothing; it demotes
 *   · Tier 3 is always present           — the four lines are unconditional
 *   · no lane renders a count it did not query
 *   · every lane appears exactly once, as a card or a line
 *
 * The mutation this suite is calibrated against: make `tier2` return no slot
 * for an empty lane (the obvious "just hide it" change) and
 * "an empty Tier 2 demotes to a line rather than vanishing" fails.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  counted,
  deliverySentence,
  known,
  LaneCards,
  LANE_IDS,
  LANE_TIER,
  laneSlotsFor,
  TIER1_IDS,
  TIER2_IDS,
  TIER3_IDS,
  tier1,
  tier2,
  tier3,
  TierRail,
  unavailable,
  type LaneId,
  type LaneSlot,
} from "@/pages/hq/hq-tiers";

afterEach(cleanup);

function wrap(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/**
 * A whole deck of lanes, every one empty-but-queried — the calmest possible
 * account, and the state where "silently absent" and "calm" are easiest to
 * confuse. `overrides` swaps individual lanes for the case under test.
 */
function emptyDeck(
  overrides: Partial<Record<LaneId, LaneSlot>> = {},
): Record<LaneId, LaneSlot> {
  const base: Record<LaneId, LaneSlot> = {
    needs_you: tier1("needs_you", known<string[]>([]), (items) => (
      <div>needs you: {items.length}</div>
    )),
    delivered: tier1("delivered", known<string[]>([]), (items) => (
      <div>delivered: {items.length}</div>
    )),
    missions: tier1("missions", known<string[]>([]), (items) => (
      <div>missions: {items.length}</div>
    )),
    in_motion: tier2(
      "in_motion",
      known<string[]>([]),
      (items) => (items.length === 0 ? null : <div>in motion</div>),
      () => ({ sentence: "Nothing is running and nothing is queued." }),
    ),
    day: tier2(
      "day",
      known<string[]>([]),
      (items) => (items.length === 0 ? null : <div>day</div>),
      () => ({ sentence: "Nothing is booked today." }),
    ),
    life: tier2(
      "life",
      known<string[]>([]),
      (items) => (items.length === 0 ? null : <div>life</div>),
      () => ({ sentence: "Nothing personal is on your list." }),
    ),
    batch: tier2(
      "batch",
      unavailable<string[]>("Cue isn't batching anything yet."),
      () => null,
      () => ({ sentence: "Cue isn't batching anything." }),
    ),
    correction: tier2(
      "correction",
      known<string[]>([]),
      (items) => (items.length === 0 ? null : <div>correction</div>),
      () => ({ sentence: "Everything that arrived found a home." }),
    ),
    arrivals: tier3("arrivals", known<string[]>([]), () => ({
      sentence: "Nothing has arrived — because nothing is watching.",
    })),
    waiting: tier3("waiting", known<string[]>([]), () => ({
      sentence: "Nothing is waiting on anyone.",
    })),
    rhythms: tier3("rhythms", known<string[]>([]), () => ({
      sentence: "Nothing runs on a schedule yet.",
    })),
    pulse: tier3("pulse", known<string[]>([]), () => ({
      sentence: "Watching nothing yet.",
    })),
  };
  return { ...base, ...overrides };
}

function renderDeck(lanes: Record<LaneId, LaneSlot>) {
  return wrap(
    <>
      <LaneCards lanes={lanes} ids={TIER1_IDS} />
      <LaneCards lanes={lanes} ids={TIER2_IDS} />
      <TierRail lanes={lanes} />
    </>,
  );
}

describe("Tier 1 — always a card", () => {
  test("renders a card at zero, because 'nothing needs you' deserves the space", () => {
    const { container } = renderDeck(emptyDeck());
    for (const id of TIER1_IDS) {
      const node = container.querySelector(`[data-lane='${id}']`);
      expect(node).not.toBeNull();
      // A card, not a line: the line renderer stamps its own slot.
      expect(node!.getAttribute("data-slot")).not.toBe("hq-tier-line");
    }
  });

  test("still a card when the lane could not be asked — stating the reason", () => {
    const lanes = emptyDeck({
      delivered: tier1(
        "delivered",
        unavailable<string[]>("Cue couldn't read what it finished today."),
        (items) => <div>delivered: {items.length}</div>,
      ),
    });
    const { container } = renderDeck(lanes);
    const node = container.querySelector("[data-lane='delivered']");
    expect(node).not.toBeNull();
    expect(node!.textContent).toContain("couldn't read");
    // And crucially NOT a number: an unqueried lane has no count to show.
    expect(node!.textContent).not.toContain("delivered: 0");
  });
});

describe("Tier 2 — a card only when non-empty, a line otherwise", () => {
  test("an empty Tier 2 demotes to a line rather than vanishing", () => {
    // THE mutation test. Change `tier2` to omit an empty lane and this fails:
    // the lane is gone from the DOM entirely, which is the one thing the tiers
    // exist to prevent.
    const { container } = renderDeck(emptyDeck());
    for (const id of TIER2_IDS) {
      const node = container.querySelector(`[data-lane='${id}']`);
      expect(node).not.toBeNull();
      expect(node!.getAttribute("data-slot")).toBe("hq-tier-line");
      // A full sentence, not a label and not "0 items".
      expect(node!.textContent!.trim().length).toBeGreaterThan(12);
    }
  });

  test("a non-empty Tier 2 is promoted to a card and leaves the rail", () => {
    const lanes = emptyDeck({
      life: tier2(
        "life",
        known(["renew the passport"]),
        (items) =>
          items.length === 0 ? null : <div>life: {items.length}</div>,
        () => ({ sentence: "Nothing personal is on your list." }),
      ),
    });
    const { container } = renderDeck(lanes);
    const nodes = container.querySelectorAll("[data-lane='life']");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.getAttribute("data-slot")).not.toBe("hq-tier-line");
    expect(nodes[0]!.textContent).toContain("life: 1");
  });

  test("a lane that could not be asked demotes to its reason, not to zero", () => {
    const { container } = renderDeck(emptyDeck());
    const node = container.querySelector("[data-lane='batch']");
    expect(node!.textContent).toContain("isn't batching anything yet");
  });
});

describe("Tier 3 — one grey line, always present", () => {
  test("all four render even when every one of them is empty", () => {
    const { container } = renderDeck(emptyDeck());
    for (const id of TIER3_IDS) {
      const node = container.querySelector(`[data-lane='${id}']`);
      expect(node).not.toBeNull();
      expect(node!.getAttribute("data-slot")).toBe("hq-tier-line");
    }
  });

  test("each line carries a glyph, so state is never colour alone", () => {
    const { container } = renderDeck(emptyDeck());
    for (const id of TIER3_IDS) {
      const glyph = container
        .querySelector(`[data-lane='${id}'] [aria-hidden]`)
        ?.textContent?.trim();
      expect(glyph).toBeTruthy();
    }
  });

  test("the arrivals line names WHY nothing arrived — a no-op is not a success", () => {
    const { container } = renderDeck(emptyDeck());
    expect(
      container.querySelector("[data-lane='arrivals']")!.textContent,
    ).toContain("nothing is watching");
  });
});

describe("no lane is ever silently absent", () => {
  test("every lane in the roster renders exactly once", () => {
    const { container } = renderDeck(emptyDeck());
    for (const id of LANE_IDS) {
      expect(container.querySelectorAll(`[data-lane='${id}']`)).toHaveLength(1);
    }
  });

  test("cards plus lines account for the whole roster", () => {
    const { cards, lines } = laneSlotsFor(emptyDeck());
    expect(cards.length + lines.length).toBe(LANE_IDS.length);
    // Tier 1 can never contribute a line — its builder cannot return null.
    for (const slot of lines) expect(LANE_TIER[slot.id]).not.toBe(1);
  });
});

describe("never a number it did not query", () => {
  test("counted() refuses a lane that could not be asked", () => {
    expect(counted(unavailable<string[]>("no"), (p) => p.length)).toBeNull();
  });

  test("counted() reports zero as a real answer, not an absence", () => {
    const zero = counted(known<string[]>([]), (p) => p.length);
    expect(zero).not.toBeNull();
    expect(zero!.value).toBe(0);
  });

  test("the delivery sentence drops a lane it could not read rather than calling it zero", () => {
    const three = counted(known([1, 2, 3]), (p) => p.length)!;
    // Needs-you unreadable: the sentence must not claim "0 need you".
    const text = deliverySentence(three, null, 7);
    expect(text).toContain("3 done");
    expect(text).not.toContain("0");
    expect(text).not.toContain("need you");
  });

  test("the delivery sentence says zero out loud when zero is the answer", () => {
    const none = counted(known<number[]>([]), (p) => p.length)!;
    const three = counted(known([1, 2, 3]), (p) => p.length)!;
    expect(deliverySentence(three, none, 7)).toContain("Nothing needs you");
    expect(deliverySentence(none, none, 7)).toContain("Nothing needs you");
  });

  test("morning and afternoon get different leads, same facts", () => {
    const three = counted(known([1, 2, 3]), (p) => p.length)!;
    const two = counted(known([1, 2]), (p) => p.length)!;
    expect(deliverySentence(three, two, 7)).toBe(
      "While you slept: 3 done, 2 need you.",
    );
    expect(deliverySentence(three, two, 15)).toBe(
      "Today so far: 3 done, 2 need you.",
    );
  });

  test("both lanes unreadable says so, and invents nothing", () => {
    expect(deliverySentence(null, null, 7)).toBe(
      "I couldn't read your work just now.",
    );
  });
});
