/**
 * The two surfaces, rendered whole — the tests that exist because looking at
 * the page caught what the unit tests could not.
 *
 * Both of these were live defects found by rendering, not by reasoning:
 *
 *   · Deck drew "◆ YOUR NEXT MOVE" twice — once as a section rule I added,
 *     once as the card's own eyebrow, four pixels apart.
 *   · Glance's subline read "Today so far: 1 done. · Nothing is running",
 *     because each part is a complete sentence and the joiner did not take the
 *     full stops off.
 *
 * Neither is a wrong number, which is why neither had a unit test. They are the
 * reason a surface gets looked at before it is reported as done.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { buildHqCensus, type HqCensusInput } from "./hq-census";
import { HqDeckSurface } from "./hq-deck-surface";
import { HqGlance, glanceSubline } from "./hq-glance";
import { known } from "./hq-tiers";
import type { HqWorkItem, Mission } from "./use-missions";
import type { NextMove } from "./hq-modules";

afterEach(cleanup);

function mission(id: string, status = "active"): Mission {
  return {
    id,
    title: id,
    status,
    budgetCents: null,
    spentCents: 0,
    rollup: { counts: { awaiting_review: 0 }, projects: [] },
  } as unknown as Mission;
}

const MISSIONS = [
  mission("Renew Acme"),
  mission("Ship Halo"),
  mission("Raise $500K", "paused"),
  mission("Raise $100M", "abandoned"),
];

function censusInput(over: Partial<HqCensusInput> = {}): HqCensusInput {
  return {
    needsYou: known(6),
    valve: known({ stop: "needs_you" as const, held: 0, unbanded: 0 }),
    missions: known(MISSIONS),
    holding: known([]),
    arrivals: known({
      total: 18,
      filed: 12,
      kept: 6,
      window: { kind: "trailing" as const, hours: 24 },
    }),
    inMotion: known({ running: [], schedules: [] }),
    watching: known({ live: [], failing: [] }),
    ...over,
  };
}

const MOVE = {
  hasMove: true,
  headline: "Review the Monday plan Cue built overnight",
  reasoning: "finished overnight · waits for your yes",
  actions: [{ id: "a", label: "Review it", kind: "approve", endpoint: "/x" }],
  itemId: null,
  kind: "review",
  sourceConversationId: "c1",
  generatedAt: null,
} as unknown as NextMove;

const NO_MOVE = { hasMove: false, actions: [] } as unknown as NextMove;

function reviewItem(id: string, over: Partial<HqWorkItem> = {}): HqWorkItem {
  return { id, title: id, projectId: null, ...over } as unknown as HqWorkItem;
}

function mount(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function glance(over: Partial<HqCensusInput> = {}, move: NextMove = MOVE) {
  return mount(
    <HqGlance
      assistantId="a"
      greeting="Good evening, Manav."
      deliveredSentence="Today so far: 1 done."
      census={buildHqCensus(censusInput(over))}
      move={move}
      needsYouCount={6}
      onOpenLane={() => {}}
    />,
  );
}

function deck(items: HqWorkItem[], move: NextMove = MOVE, count = 6) {
  return mount(
    <HqDeckSurface
      assistantId="a"
      greeting="Good evening, Manav."
      deliveredSentence="Today so far: 1 done."
      census={buildHqCensus(censusInput())}
      missions={MISSIONS}
      move={move}
      needsYouCount={count}
      approvals={[]}
      reviewItems={items}
      missionsByProjectId={new Map()}
      focus={null}
      onFocusConsumed={() => {}}
    />,
  );
}

describe("Glance", () => {
  test("is greeting, capture, ONE move, one door, and the strip", () => {
    const { container } = glance();
    expect(
      container.querySelectorAll('[data-slot="hq-next-move"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-slot="hq-glance-more"]')!.textContent,
    ).toBe("5 more need you ›");
    expect(container.querySelectorAll("[data-hq-strip-cell]")).toHaveLength(5);
  });

  test("the subline joins whole sentences without stacking full stops", () => {
    const census = buildHqCensus(censusInput());
    const line = glanceSubline("Today so far: 1 done.", census);
    expect(line).toBe(
      "Today so far: 1 done · Nothing is running · nothing on a schedule.",
    );
    expect(line).not.toContain(". ·");
  });

  test("the in-motion lane is stated even though it has no strip cell", () => {
    const { container } = glance({
      inMotion: known({
        running: [reviewItem("r")],
        schedules: [],
      }),
    });
    expect(
      container.querySelector('[data-slot="hq-glance-subline"]')!.textContent,
    ).toContain("1 running");
  });

  /**
   * The defect this exists for was found by looking at the page: on Glance,
   * needs-you is a bare number in the footer strip, so the valve's "I have not
   * judged any of these" note had nowhere to appear and 57 unfiltered items
   * read exactly like 57 filtered ones.
   */
  test("the valve's caveat reaches GLANCE, where the lane is only a number", () => {
    const { container } = glance({
      needsYou: known(57),
      valve: known({ stop: "needs_you" as const, held: 37, unbanded: 57 }),
    });
    const caveat = container.querySelector('[data-slot="hq-glance-caveat"]')!;
    expect(caveat).not.toBeNull();
    expect(caveat.textContent).toContain("hasn't sized any of these up");
  });

  test("a valve with nothing to caveat adds no line", () => {
    const { container } = glance({
      needsYou: known(6),
      valve: known({ stop: "needs_you" as const, held: 0, unbanded: 0 }),
    });
    expect(
      container.querySelector('[data-slot="hq-glance-caveat"]'),
    ).toBeNull();
  });

  test("no move and nothing needing you is a statement, not a blank", () => {
    const { container } = mount(
      <HqGlance
        assistantId="a"
        greeting="Good evening."
        deliveredSentence="I haven't finished anything yet."
        census={buildHqCensus(censusInput({ needsYou: known(0) }))}
        move={NO_MOVE}
        needsYouCount={0}
        onOpenLane={() => {}}
      />,
    );
    expect(
      container.querySelector('[data-slot="hq-glance-clear"]')!.textContent,
    ).toContain("Nothing needs you");
    // No door to a count of zero.
    expect(container.querySelector('[data-slot="hq-glance-more"]')).toBeNull();
  });

  test("an unreadable queue offers no 'N more' door", () => {
    const { container } = mount(
      <HqGlance
        assistantId="a"
        greeting="Good evening."
        deliveredSentence="Today so far: 1 done."
        census={buildHqCensus(censusInput())}
        move={NO_MOVE}
        needsYouCount={null}
        onOpenLane={() => {}}
      />,
    );
    expect(container.querySelector('[data-slot="hq-glance-more"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="hq-glance-clear"]')!.textContent,
    ).toContain("couldn't read your queue");
  });
});

describe("Deck", () => {
  test("names the next move once, not twice", () => {
    const { container } = deck([]);
    const eyebrows = (container.textContent ?? "").match(/YOUR NEXT MOVE/g);
    expect(eyebrows).toHaveLength(1);
  });

  test("caps needs-you at three rows and shows N of M with a door", () => {
    const { container } = deck([
      reviewItem("one"),
      reviewItem("two"),
      reviewItem("three"),
      reviewItem("four"),
      reviewItem("five"),
    ]);
    expect(
      container.querySelectorAll('[data-slot="hq-needs-you-row"]'),
    ).toHaveLength(3);
    const block = container.querySelector('[data-slot="hq-needs-you"]')!;
    expect(block.textContent).toContain("NEEDS YOU · 3 OF 6");
    expect(block.textContent).toContain("Triage all ›");
    // The deck never grows: the fourth and fifth are behind the door.
    expect(container.textContent).not.toContain("four");
  });

  test("the count is the page's number, never a count of the rows drawn", () => {
    // Two rows on screen, but the account has 6 things needing a decision —
    // the rest are paused runs and the next move. Reading the DOM for the
    // number is exactly how the headline once said 6 while the badge said 5.
    const { container } = deck([reviewItem("one"), reviewItem("two")], MOVE, 6);
    expect(
      container.querySelector('[data-slot="hq-needs-you"]')!.textContent,
    ).toContain("NEEDS YOU · 2 OF 6");
  });

  test("zero needing you keeps its card rather than vanishing", () => {
    const { container } = deck([], NO_MOVE, 0);
    const block = container.querySelector('[data-slot="hq-needs-you"]')!;
    expect(block.textContent).toContain("Nothing needs you");
    expect(block.textContent).toContain("NEEDS YOU · 0");
  });

  /**
   * Design's "the holding count shrinks on its own" is a property of this
   * control calling the valve, not of the rules. A ✕ that only removed a row
   * would look identical and teach nothing.
   */
  test("the ✕ teaches the valve about the stream, and only when it can", () => {
    const teachable = deck([
      reviewItem("one", {
        sourceContext: JSON.stringify({ sender: "noreply@example.com" }),
        sourceType: "gmail",
      } as Partial<HqWorkItem>),
    ]);
    expect(
      teachable.container.querySelector('[data-slot="hq-not-relevant"]'),
    ).not.toBeNull();
    cleanup();

    // Nothing to teach about — no sender, no channel. The control is absent
    // rather than present and inert.
    const unteachable = deck([
      reviewItem("one", {
        sourceContext: null,
        sourceType: null,
      } as Partial<HqWorkItem>),
    ]);
    expect(
      unteachable.container.querySelector('[data-slot="hq-not-relevant"]'),
    ).toBeNull();
  });

  test("the valve's caveat reaches the Deck's needs-you block too", () => {
    const { container } = mount(
      <HqDeckSurface
        assistantId="a"
        greeting="Good evening."
        deliveredSentence="Today so far: 1 done."
        census={buildHqCensus(
          censusInput({
            needsYou: known(57),
            valve: known({
              stop: "needs_you" as const,
              held: 37,
              unbanded: 57,
            }),
          }),
        )}
        missions={MISSIONS}
        move={NO_MOVE}
        needsYouCount={57}
        approvals={[]}
        reviewItems={[reviewItem("one")]}
        missionsByProjectId={new Map()}
        focus={null}
        onFocusConsumed={() => {}}
      />,
    );
    const block = container.querySelector('[data-slot="hq-needs-you"]')!;
    expect(
      block.querySelector('[data-slot="hq-lane-caveat"]')!.textContent,
    ).toContain("hasn't sized any of these up");
    // And the held-back number reaches its own tile, with All work as the door.
    const holding = container.querySelector('[data-hq-lane="holding"]')!;
    expect(
      holding.querySelector('[data-slot="hq-lane-caveat"]')!.textContent,
    ).toContain("37 more held back");
  });

  test("the rail is present and is not a second scroll region", () => {
    const { container } = deck([]);
    const rail = container.querySelector<HTMLElement>('[data-slot="hq-rail"]')!;
    expect(rail).not.toBeNull();
    expect(rail.style.overflow).toBe("hidden");
    expect(rail.style.width).toBe("300px");
    expect(rail.querySelectorAll("[data-hq-lane]")).toHaveLength(5);
  });

  /**
   * "Mobile is always Glance. Do not build a Deck for phones."
   *
   * `HqPage` returns the phone's Today screen before it ever reads the density,
   * so the rule holds today by control flow — which is exactly the kind of
   * guarantee that survives until someone adds a second call site. This is the
   * structural half: the phone's own tree may not so much as import the Deck.
   */
  test("no phone surface may import the Deck or its rail", () => {
    const root = join(import.meta.dir, "../../mobile-v3");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const source = readFileSync(path, "utf8");
        if (/hq-deck-surface|\bHqRail\b|\bHqDeckSurface\b/.test(source)) {
          offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  test("what design deleted is gone: no rings hero, no came-in rows", () => {
    const { container } = deck([reviewItem("one")]);
    expect(container.querySelector('[data-slot="hq-hero-card"]')).toBeNull();
    // The full-bleed rings HERO is what design deleted — not the word. v35's
    // V3 puts the state in words under every rail ring precisely so no ring's
    // meaning is carried by its colour and sweep alone, so "ON TRACK" now
    // appears there by design and only there.
    const stateLines = [
      ...container.querySelectorAll('[data-slot="hq-ring-state"]'),
    ];
    expect(stateLines.length).toBeGreaterThan(0);
    for (const node of container.querySelectorAll("*")) {
      if (!/^ON TRACK$|^MOVING$|^BLOCKED/.test(node.textContent ?? "")) continue;
      expect(node.closest('[data-hq-lane="blocked"]')).not.toBeNull();
    }
    // "Came in" survives only as the rail tile's number and sentence.
    const cameIn = container.querySelector('[data-hq-lane="filed"]')!;
    expect(cameIn.querySelectorAll("li,[data-filing-row]")).toHaveLength(0);
  });
});
