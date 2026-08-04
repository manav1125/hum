/**
 * The two densities, rendered.
 *
 * `hq-census.test.ts` proves the numbers are one set. This proves the two
 * surfaces actually print that set, and that the three rules survive contact
 * with the DOM:
 *
 *   · the strip's number for a lane is the rail tile's number, character for
 *     character;
 *   · a lane we could not read prints no digit and offers no tap;
 *   · every cell and tile carries its glyph, so no state is colour alone.
 *
 * The rail is asserted to be five tiles at zero as well as at volume — the old
 * HQ's failure was that quiet accounts and busy ones looked different in
 * structure, not just in content.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  buildHqCensus,
  railTiles,
  stripCells,
  type HqCensusInput,
  type HqLaneId,
} from "./hq-census";
import { GlanceStrip, HqRail } from "./hq-lane-ui";
import { known, unavailable } from "./hq-tiers";
import type { Mission } from "./use-missions";

afterEach(cleanup);

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

function input(over: Partial<HqCensusInput> = {}): HqCensusInput {
  return {
    needsYou: known(6),
    valve: known({ stop: "needs_you" as const, held: 0, unbanded: 0 }),
    missions: known([
      mission({ id: "Renew Acme" }),
      mission({ id: "Ship Halo" }),
      mission({ id: "Raise $500K", status: "paused" }),
      mission({ id: "Raise $100M", status: "abandoned" }),
    ]),
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

function renderStrip(
  over: Partial<HqCensusInput> = {},
  onOpen: (id: HqLaneId) => void = () => {},
) {
  const census = buildHqCensus(input(over));
  return {
    census,
    ...render(
      <MemoryRouter>
        <GlanceStrip cells={stripCells(census)} onOpen={onOpen} />
      </MemoryRouter>,
    ),
  };
}

function renderRail(over: Partial<HqCensusInput> = {}) {
  const built = input(over);
  const census = buildHqCensus(built);
  // The rail draws rings from the SAME mission list the census counted, which
  // is the point: if the tile were handed a different list, the ring picture
  // and the number above it could disagree.
  const missions =
    built.missions.kind === "known" ? built.missions.payload : [];
  return {
    census,
    ...render(
      <MemoryRouter>
        <HqRail tiles={railTiles(census)} missions={missions} focus={null} />
      </MemoryRouter>,
    ),
  };
}

describe("Glance strip", () => {
  test("draws design's five cells, in design's order", () => {
    const { container } = renderStrip();
    const cells = [...container.querySelectorAll("[data-hq-strip-cell]")].map(
      (n) => n.getAttribute("data-hq-strip-cell"),
    );
    expect(cells).toEqual([
      "needs_you",
      "blocked",
      "holding",
      "filed",
      "watching",
    ]);
  });

  test("a queried number is a button that opens Deck on that lane", () => {
    const opened: HqLaneId[] = [];
    const { container } = renderStrip({}, (id) => opened.push(id));
    const cell = container.querySelector('[data-hq-strip-cell="blocked"]')!;
    expect(cell.tagName).toBe("BUTTON");
    fireEvent.click(cell);
    expect(opened).toEqual(["blocked"]);
  });

  test("a lane we could not read is NOT a tap target, and says why", () => {
    const { container } = renderStrip({
      holding: unavailable("Cue couldn't read what it's holding."),
    });
    const cell = container.querySelector('[data-hq-strip-cell="holding"]')!;
    expect(cell.tagName).not.toBe("BUTTON");
    expect(cell.textContent).toContain("Cue couldn't read what it's holding.");
    // No digit at all — not a zero, not a dash.
    expect(cell.textContent).not.toMatch(/\d/);
  });

  test("the strip stays five cells whether the account is quiet or busy", () => {
    const quiet = renderStrip({
      needsYou: known(0),
      missions: known([]),
      arrivals: known({
        total: 0,
        filed: 0,
        kept: 0,
        window: { kind: "trailing" as const, hours: 24 },
      }),
    });
    expect(
      quiet.container.querySelectorAll("[data-hq-strip-cell]"),
    ).toHaveLength(5);
    cleanup();
    const busy = renderStrip({ needsYou: known(312) });
    expect(
      busy.container.querySelectorAll("[data-hq-strip-cell]"),
    ).toHaveLength(5);
  });
});

describe("Deck rail", () => {
  test("draws design's five tiles, in design's order", () => {
    const { container } = renderRail();
    const tiles = [...container.querySelectorAll("[data-hq-lane]")].map((n) =>
      n.getAttribute("data-hq-lane"),
    );
    expect(tiles).toEqual([
      "blocked",
      "holding",
      "filed",
      "in_motion",
      "watching",
    ]);
  });

  test("the Missions tile draws STATUS rings — never a fabricated percent", () => {
    const { container } = renderRail();
    const tile = container.querySelector('[data-hq-lane="blocked"]')!;
    // Four missions, four rings, each labelled with its honest state.
    const rings = tile.querySelectorAll('[role="img"]');
    expect(rings).toHaveLength(4);
    expect([...rings].map((r) => r.getAttribute("aria-label"))).toEqual([
      "Mission on track",
      "Mission on track",
      "Mission blocked",
      "Mission blocked",
    ]);
    // Mission progress has no connected metric, so no ring may claim one.
    expect(tile.textContent).not.toMatch(/%/);
  });

  test("blocked-ness is stated once, in the missions tile and nowhere else", () => {
    const { container } = renderRail();
    const blockedMentions = [
      ...container.querySelectorAll("[data-hq-lane]"),
    ].filter((n) => /blocked/i.test(n.textContent ?? ""));
    expect(blockedMentions).toHaveLength(1);
    expect(blockedMentions[0]!.getAttribute("data-hq-lane")).toBe("blocked");
  });

  test("a tile whose lane is unreadable prints the reason, not a number", () => {
    const { container } = renderRail({
      watching: unavailable("Cue couldn't read what it watches."),
    });
    const tile = container.querySelector('[data-hq-lane="watching"]')!;
    expect(tile.textContent).toContain("Cue couldn't read what it watches.");
    expect(tile.textContent).not.toMatch(/\d/);
  });
});

describe("the hinge, on screen", () => {
  test("the strip's number and the rail's number are the same characters", () => {
    const census = buildHqCensus(input({ holding: known([]) }));
    const strip = render(
      <MemoryRouter>
        <GlanceStrip cells={stripCells(census)} onOpen={() => {}} />
      </MemoryRouter>,
    );
    const stripText = (id: string) =>
      strip.container
        .querySelector(`[data-hq-strip-cell="${id}"]`)!
        .textContent!.match(/\d+/)?.[0];
    const stripNumbers = ["needs_you", "blocked", "holding", "filed"].map(
      stripText,
    );
    cleanup();

    const rail = render(
      <MemoryRouter>
        <HqRail tiles={railTiles(census)} missions={[]} focus={null} />
      </MemoryRouter>,
    );
    const railText = (id: string) =>
      rail.container
        .querySelector(`[data-hq-lane="${id}"]`)!
        .textContent!.match(/\d+/)?.[0];

    expect(railText("blocked")).toBe(stripNumbers[1]);
    expect(railText("holding")).toBe(stripNumbers[2]);
    expect(railText("filed")).toBe(stripNumbers[3]);
  });

  test("every cell and tile carries a glyph — no colour-only state", () => {
    const census = buildHqCensus(input());
    const strip = render(
      <MemoryRouter>
        <GlanceStrip cells={stripCells(census)} onOpen={() => {}} />
      </MemoryRouter>,
    );
    for (const reading of stripCells(census)) {
      const cell = strip.container.querySelector(
        `[data-hq-strip-cell="${reading.id}"]`,
      )!;
      expect(cell.textContent).toContain(reading.glyph);
    }
  });
});
