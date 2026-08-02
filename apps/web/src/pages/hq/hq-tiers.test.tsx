/**
 * Tests for the deck's render policy — lanes, absorbed lanes, and events.
 *
 * These do not assert styling. Each one encodes a rule the deck would otherwise
 * break silently, and the two that matter most exist because they are the two
 * directions §13.1 can be got wrong in:
 *
 *   · Tier 1 renders a card at ZERO      — "nothing needs you" deserves space
 *   · a LANE with nothing in it is a LINE — never nothing; it does not vanish
 *   · an EVENT that didn't happen is NOTHING — not a line reporting a non-event
 *   · the rail is FOUR lines, on both surfaces
 *   · no slot renders a count it did not query
 *   · every id is accounted for, as a card, a line, or a warranted absence
 *
 * The two mutations this suite is calibrated against:
 *
 *   1. make an absent event render a line — "an event that didn't happen
 *      renders nothing at all" fails, and so does the four-line count;
 *   2. make an empty lane vanish (`tier3` returning an absence, or `absorbed`
 *      skipping its unavailable line) — "an empty lane is still a line" fails,
 *      and `laneSlotsFor` throws rather than quietly dropping it.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  absorbed,
  counted,
  deliverySentence,
  event,
  known,
  LaneCards,
  LANE_IDS,
  LANE_TIER,
  laneSlotsFor,
  SLOT_KIND,
  TIER1_IDS,
  TIER2_IDS,
  TIER3_IDS,
  tier1,
  tier3,
  TierRail,
  unavailable,
  type AbsentSlot,
  type LaneId,
  type LaneSlot,
} from "@/pages/hq/hq-tiers";

afterEach(cleanup);

function wrap(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/**
 * A whole deck, every slot empty-but-queried — the calmest possible account,
 * and the state where "silently absent" and "calm" are easiest to confuse.
 * The card builders are shaped like the desktop deck's: they return a card
 * when there is something and `null` when there is not, so this is what HQ
 * renders on a quiet morning. `overrides` swaps individual slots for the case
 * under test.
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
    in_motion: absorbed("in_motion", known<string[]>([]), (items) =>
      items.length === 0 ? null : <div>in motion</div>,
    ),
    day: absorbed("day", known<string[]>([]), (items) =>
      items.length === 0 ? null : <div>day</div>,
    ),
    life: absorbed("life", known<string[]>([]), (items) =>
      items.length === 0 ? null : <div>life</div>,
    ),
    batch: event(
      "batch",
      unavailable<string[]>("Cue isn't batching anything yet."),
      () => null,
    ),
    correction: event("correction", known<string[]>([]), (items) =>
      items.length === 0 ? null : <div>correction</div>,
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

describe("a LANE is never silently absent", () => {
  test("an empty lane is still a line — it does not vanish", () => {
    // THE mutation test in the "made a lane disappear" direction. Change
    // `tier3` to return an absence for an empty payload and this fails: the
    // lane is gone from the DOM entirely, which is the one thing the roster
    // exists to prevent.
    const { container } = renderDeck(emptyDeck());
    for (const id of TIER3_IDS) {
      const node = container.querySelector(`[data-lane='${id}']`);
      expect(node).not.toBeNull();
      expect(node!.getAttribute("data-slot")).toBe("hq-tier-line");
      // A full sentence, not a label and not "0 items".
      expect(node!.textContent!.trim().length).toBeGreaterThan(12);
    }
  });

  test("every lane in the roster renders exactly once", () => {
    const { container } = renderDeck(emptyDeck());
    for (const id of LANE_IDS) {
      if (SLOT_KIND[id] === "event") continue;
      const nodes = container.querySelectorAll(`[data-lane='${id}']`);
      // in-motion, the day and Life are absorbed: on a quiet deck their answer
      // is on screen in another form, so they render nowhere here.
      if (nodes.length === 0) {
        expect(["in_motion", "day", "life"]).toContain(id);
        continue;
      }
      expect(nodes).toHaveLength(1);
    }
  });

  test("laneSlotsFor throws if a standing lane somehow renders as absent", () => {
    // Unreachable through the builders — `tier3` returns a line and the
    // absence warrant cannot be minted for a Tier-3 id. This is the runtime
    // backstop for a cast that got around both: the deck refuses to render
    // rather than rendering one lane fewer than it was given.
    const forged = {
      id: "waiting",
      render: "absent",
      warrant: { because: "shhh" },
    } as unknown as AbsentSlot;
    expect(() => laneSlotsFor(emptyDeck({ waiting: forged }))).toThrow(
      /rendered as absent/,
    );
  });

  test("cards plus lines plus warranted absences account for the whole roster", () => {
    const { cards, lines, absent } = laneSlotsFor(emptyDeck());
    expect(cards.length + lines.length + absent.length).toBe(LANE_IDS.length);
    // Tier 1 can never contribute a line — its builder returns a card slot.
    for (const slot of lines) expect(LANE_TIER[slot.id]).not.toBe(1);
    // And nothing that answers a standing question on its own is absent.
    for (const slot of absent) expect(TIER3_IDS).not.toContain(slot.id);
  });
});

describe("an EVENT may be absent, and absence is all it renders", () => {
  test("an event that didn't happen renders nothing at all", () => {
    // THE mutation test in the other direction. Make `event` fall back to a
    // line and this fails — the deck grows a grey sentence reporting that
    // something which never happened has not happened.
    const { container } = renderDeck(emptyDeck());
    expect(container.querySelector("[data-lane='batch']")).toBeNull();
    expect(container.querySelector("[data-lane='correction']")).toBeNull();
    expect(container.textContent).not.toContain("batching");
  });

  test("an event that happened takes a card", () => {
    const lanes = emptyDeck({
      correction: event("correction", known(["invoice"]), (items) => (
        <div>correction: {items.length}</div>
      )),
    });
    const { container } = renderDeck(lanes);
    const node = container.querySelector("[data-lane='correction']");
    expect(node).not.toBeNull();
    expect(node!.getAttribute("data-slot")).not.toBe("hq-tier-line");
    expect(node!.textContent).toContain("correction: 1");
  });

  test("its absence is a value, not a missing key — so it can be explained", () => {
    const { absent } = laneSlotsFor(emptyDeck());
    const batch = absent.find((slot) => slot.id === "batch");
    expect(batch).toBeDefined();
    expect(batch!.warrant.because).toContain("batching");
  });

  test("a lane cannot be declared an event", () => {
    // The loophole §13.1 opens, closed in the type system: `event` takes an
    // `EventId`, and widening that union is a conspicuous edit rather than an
    // accident. If this ever stops erroring, the rule has become a convention.
    // @ts-expect-error — 'waiting' is a lane; it has no absent state to declare
    event("waiting", known<string[]>([]), () => null);
    // Same for an absorbed lane: absorption is a claim about another surface,
    // so only the three ids that made that claim can make it.
    // @ts-expect-error — 'arrivals' is answered by nothing but itself
    absorbed("arrivals", known<string[]>([]), () => null);
    // And the slot cannot be forged either: there is no literal of the warrant.
    const forged: AbsentSlot = {
      id: "batch",
      render: "absent",
      // @ts-expect-error — AbsenceWarrant is opaque; only `event`/`absorbed` mint one
      warrant: { because: "because I said so" },
    };
    expect(forged.id).toBe("batch");
    expect(SLOT_KIND.waiting).toBe("lane");
    expect(SLOT_KIND.batch).toBe("event");
  });
});

describe("an ABSORBED lane defers only to an answer we have", () => {
  test("empty and queried: nothing, because another surface says it", () => {
    const { container } = renderDeck(emptyDeck());
    for (const id of ["in_motion", "day", "life"] as const) {
      expect(container.querySelector(`[data-lane='${id}']`)).toBeNull();
    }
    const { absent } = laneSlotsFor(emptyDeck());
    const inMotion = absent.find((slot) => slot.id === "in_motion");
    expect(inMotion!.warrant.because).toContain("census");
  });

  test("non-empty: a card, exactly as before", () => {
    const lanes = emptyDeck({
      life: absorbed("life", known(["renew the passport"]), (items) =>
        items.length === 0 ? null : <div>life: {items.length}</div>,
      ),
    });
    const { container } = renderDeck(lanes);
    const nodes = container.querySelectorAll("[data-lane='life']");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.getAttribute("data-slot")).not.toBe("hq-tier-line");
    expect(nodes[0]!.textContent).toContain("life: 1");
  });

  test("unqueryable: a LINE, because absorption cannot stand over a gap", () => {
    // The census bar cannot be answering "is anything running?" out of a query
    // that failed. Staying quiet here would be the silent absence, so this is
    // the one case where an absorbed lane still takes a line.
    const lanes = emptyDeck({
      day: absorbed(
        "day",
        unavailable<string[]>("Cue couldn't read your calendar just now."),
        () => null,
      ),
    });
    const { container } = renderDeck(lanes);
    const node = container.querySelector("[data-lane='day']");
    expect(node).not.toBeNull();
    expect(node!.getAttribute("data-slot")).toBe("hq-tier-line");
    expect(node!.textContent).toContain("couldn't read your calendar");
  });
});

describe("the rail is four lines", () => {
  test("exactly Arrivals, Waiting, Rhythms and Pulse on a quiet desktop deck", () => {
    // Nine before §13.1: the four, plus in-motion, the day, Life, the batch
    // offer and the filing correction, each reporting an emptiness nobody had
    // asked about.
    const { container } = renderDeck(emptyDeck());
    const lines = container.querySelectorAll("[data-slot='hq-tier-line']");
    expect(lines).toHaveLength(4);
    expect([...lines].map((el) => el.getAttribute("data-lane"))).toEqual([
      ...TIER3_IDS,
    ]);
  });

  test("still four when the deck is busy — a card leaves, it does not add", () => {
    const lanes = emptyDeck({
      in_motion: absorbed("in_motion", known(["draft the reply"]), (items) => (
        <div>in motion: {items.length}</div>
      )),
      correction: event("correction", known(["invoice"]), (items) => (
        <div>correction: {items.length}</div>
      )),
    });
    const { container } = renderDeck(lanes);
    expect(
      container.querySelectorAll("[data-slot='hq-tier-line']"),
    ).toHaveLength(4);
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

describe("never a number it did not query", () => {
  test("counted() refuses a lane that could not be asked", () => {
    expect(counted(unavailable<string[]>("no"), (p) => p.length)).toBeNull();
  });

  test("counted() reports zero as a real answer, not an absence", () => {
    const zero = counted(known<string[]>([]), (p) => p.length);
    expect(zero).not.toBeNull();
    expect(zero!.value).toBe(0);
  });

  test("an event cannot invent a count for what happened either", () => {
    // The event's card is a function of the queried payload, same as a lane's:
    // an unavailable state never reaches the builder, so there is no payload to
    // read a number out of.
    let reached = false;
    const slot = event("batch", unavailable<number[]>("not built yet"), () => {
      reached = true;
      return <div>never</div>;
    });
    expect(reached).toBe(false);
    expect(slot.render).toBe("absent");
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
