/**
 * Work / Things on the phone: the header's count and the rows beneath it.
 *
 * The owner's report was *"Things doesn't show all the projects the user has
 * in their account, it just shows one"* — a header reading `5 things` above a
 * single card. Nothing was filtered (KIND was Everything, STATE was Active·5)
 * and nothing was missing from the account. The four absent things had been
 * COLLAPSED into the Personal roll-up, which C2 introduced so personal work
 * would not compete with the professional deck — on an account where personal
 * work outnumbers it four to one.
 *
 * So the property under test is not "does the roll-up exist" (it should) but
 * the two halves of this codebase's standing rule: a header count and the rows
 * beneath it must come from the same query, **or the difference must be stated
 * on screen**. Below the threshold the roll-up states its own size; at or above
 * it, there is no roll-up and the cards are the statement.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

interface SeedProject {
  id: string;
  title: string;
  category: string | null;
  open?: number;
}

/** Full project records off the seeds — only category and counts ever vary. */
function toRecord(p: SeedProject) {
  return {
    id: p.id,
    title: p.title,
    emoji: null,
    color: null,
    status: "active",
    category: p.category,
    context: null,
    sortIndex: 0,
    pinned: 0,
    missionId: null,
    createdAt: 1,
    updatedAt: 2,
    stats: {
      counts: {
        queued: p.open ?? 0,
        running: 0,
        awaiting_review: 0,
        done: 0,
        open: p.open ?? 0,
        total: p.open ?? 0,
      },
      nextTask: null,
    },
  };
}

let seeds: SeedProject[] = [];

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  projectsGet: mock(async (opts?: { query?: { status?: string } }) => ({
    // The daemon's default list is active-only; the Done segment asks
    // explicitly. Mirroring that here keeps the archived path honest.
    data: {
      projects:
        opts?.query?.status === "archived" ? [] : seeds.map(toRecord),
    },
    ...okResponse,
  })),
  workitemsGet: mock(async () => ({ data: { items: [] }, ...okResponse })),
  pendinginteractionsGet: mock(async () => ({
    data: { interactions: [] },
    ...okResponse,
  })),
  missionsGet: mock(async () => ({ data: { missions: [] }, ...okResponse })),
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

mock.module("@/hooks/use-activity-sync", () => ({
  useActivitySync: () => undefined,
}));

const { Mv3Projects, rollUpFits } = await import("./mv3-projects");

function LocationProbe() {
  return createElement(
    "div",
    { "data-testid": "path" },
    useLocation().pathname,
  );
}

function renderThings() {
  return render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        { initialEntries: ["/assistant/projects"] },
        createElement(Mv3Projects),
        createElement(LocationProbe),
      ),
    ),
  );
}

/** Every thing rendered as its own card, by the card's accessible name. */
function cardTitles(): string[] {
  return screen
    .queryAllByLabelText(/^Thing: /)
    .map((el) => el.getAttribute("aria-label")!.replace("Thing: ", ""));
}

function rollUpRow(): HTMLElement | null {
  return screen.queryByLabelText(/^Personal — /);
}

afterEach(() => {
  seeds = [];
  cleanup();
});

describe("the rule", () => {
  // Stated once, in one line, so it cannot drift into a tuned threshold: a
  // roll-up may never hide more things than it leaves showing.
  test.each([
    [0, 3, false, "nothing to roll up"],
    [1, 3, true, "a footnote under a deck"],
    [3, 3, true, "equal — the deck still stands on its own"],
    [4, 1, false, "the footnote WAS the account"],
    [2, 0, false, "no deck at all to compete with"],
  ])("%i personal, %i in the deck → %p (%s)", (personal, deck, expected) => {
    expect(rollUpFits(personal, deck)).toBe(expected);
  });
});

describe("the owner's account: 4 personal, 1 professional", () => {
  // The exact shape read out of production. `5 things` was the right number
  // all along; the deck underneath it was the part that was wrong.
  const OWNERS_SHAPE: SeedProject[] = [
    { id: "p1", title: "Alpha", category: "professional", open: 2 },
    { id: "p2", title: "Bravo", category: "personal", open: 6 },
    { id: "p3", title: "Charlie", category: "personal", open: 2 },
    { id: "p4", title: "Delta", category: "personal", open: 18 },
    { id: "p5", title: "Echo", category: "personal", open: 7 },
  ];

  test("all five things render as their own row", async () => {
    seeds = OWNERS_SHAPE;
    renderThings();
    await waitFor(() => expect(cardTitles().length).toBeGreaterThan(0));
    expect(cardTitles().sort()).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo",
    ]);
  });

  test("nothing is left behind a roll-up", async () => {
    seeds = OWNERS_SHAPE;
    renderThings();
    await waitFor(() => expect(cardTitles().length).toBe(5));
    expect(rollUpRow()).toBeNull();
  });

  test("the header's count equals the rows underneath it", async () => {
    seeds = OWNERS_SHAPE;
    renderThings();
    await waitFor(() => expect(screen.getByText(/\d+ things/)).toBeDefined());
    const headline = screen.getByText(/\d+ things/).textContent ?? "";
    const claimed = Number(/(\d+) things/.exec(headline)![1]);
    expect(claimed).toBe(5);
    // Same number, counted off the surface rather than off the query.
    expect(cardTitles()).toHaveLength(claimed);
  });

  test("a row that renders is a row that navigates", async () => {
    // Rendering five cards is only worth anything if each opens its thing.
    seeds = OWNERS_SHAPE;
    renderThings();
    await waitFor(() => expect(cardTitles().length).toBe(5));
    fireEvent.click(screen.getByLabelText("Thing: Delta"));
    expect(screen.getByTestId("path").textContent).toBe(
      "/assistant/projects/p4",
    );
  });
});

describe("when the roll-up still earns its place", () => {
  const DECK_HEAVY: SeedProject[] = [
    { id: "w1", title: "Alpha", category: "professional", open: 3 },
    { id: "w2", title: "Bravo", category: "professional", open: 1 },
    { id: "w3", title: "Charlie", category: null, open: 2 },
    { id: "w4", title: "Home", category: "personal", open: 4 },
  ];

  test("personal collapses to one row, as C2 asked", async () => {
    seeds = DECK_HEAVY;
    renderThings();
    await waitFor(() => expect(cardTitles().length).toBe(3));
    expect(cardTitles()).not.toContain("Home");
    expect(rollUpRow()).not.toBeNull();
  });

  test("the row states how many things it is holding — count first", async () => {
    // The header says "4 things" and the deck shows 3 cards. The missing one
    // has to be legible in the row, not inferred from an open-task tally
    // about a different noun.
    seeds = DECK_HEAVY;
    renderThings();
    await waitFor(() => expect(rollUpRow()).not.toBeNull());
    const text = rollUpRow()!.textContent ?? "";
    expect(text).toContain("1 thing");
    // Count leads; the open tally follows it.
    expect(text.indexOf("1 thing")).toBeLessThan(text.indexOf("4 open"));
  });

  test("the header's count and the rows underneath still add up", async () => {
    seeds = DECK_HEAVY;
    renderThings();
    await waitFor(() => expect(rollUpRow()).not.toBeNull());
    const claimed = Number(
      /(\d+) things/.exec(screen.getByText(/\d+ things/).textContent ?? "")![1],
    );
    const heldByRollUp = Number(
      /(\d+) thing/.exec(rollUpRow()!.textContent ?? "")![1],
    );
    expect(cardTitles().length + heldByRollUp).toBe(claimed);
  });

  test("the roll-up is a door — it opens onto what it collapsed", async () => {
    seeds = DECK_HEAVY;
    renderThings();
    await waitFor(() => expect(rollUpRow()).not.toBeNull());
    fireEvent.click(rollUpRow()!);
    await waitFor(() => expect(cardTitles()).toEqual(["Home"]));
  });
});

describe("an account with no professional work at all", () => {
  test("still shows every thing — a roll-up with no deck is just a wall", async () => {
    seeds = [
      { id: "h1", title: "Alpha", category: "personal", open: 1 },
      { id: "h2", title: "Bravo", category: "personal", open: 2 },
    ];
    renderThings();
    await waitFor(() => expect(cardTitles().length).toBe(2));
    expect(rollUpRow()).toBeNull();
  });
});
