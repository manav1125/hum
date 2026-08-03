/**
 * The phone's ⓶ menu — the corner that holds what the three tabs dropped.
 *
 * Two things are at risk here, and neither is pixels.
 *
 * **Agreement.** This menu spent a release listing `CUE_NAV`'s six (Agents ·
 * Skills · Rhythms · Memory · Library · Watching) while the desktop rail had
 * already retired that grouping — so the two platforms described different
 * products from one codebase. That constant is now deleted, and v23 C6 rules
 * what stands in its place: People and All conversations under *Accumulating*,
 * then Agents, Skills and the door to all of Your Cue.
 *
 * **Reach.** These rows used to drop from the corner they were tapped in,
 * which put every one of them inside the top third of an 844px screen. The
 * brief allows a top-side chevron as an escape; a menu of destinations is not
 * an escape. Both menus are bottom sheets now, and the test below asserts the
 * dialog rather than trusting the styling.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { routes } from "@/utils/routes";

const ASSISTANT_ID = "asst-1";

let userName: string | null = "Manav";

const homeQueryActual = await import(
  "@/domains/home/hooks/use-home-state-query"
);
mock.module("@/domains/home/hooks/use-home-state-query", () => ({
  ...homeQueryActual,
  useHomeStateQuery: () => ({ data: { userName } }),
}));

const conversationQueriesActual = await import("@/hooks/conversation-queries");
mock.module("@/hooks/conversation-queries", () => ({
  ...conversationQueriesActual,
  useConversationListQuery: () => ({
    conversations: [],
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => {},
  }),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { activeAssistantId: () => ASSISTANT_ID },
  },
}));

const { Mv3OverflowMenu } = await import("./overflow-menu");

/** Renders the chrome plus a location probe, so navigation is observable. */
function renderMenu() {
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
        { initialEntries: [routes.hq] },
        createElement(Mv3OverflowMenu),
        createElement(LocationProbe),
      ),
    ),
  );
}

function LocationProbe() {
  return createElement(
    "div",
    { "data-testid": "path" },
    useLocation().pathname,
  );
}

/** Opens the right-hand menu and returns its row keys, in render order. */
function openAccountMenu(): string[] {
  fireEvent.click(screen.getByRole("button", { name: /People, conversations/i }));
  return screen
    .getAllByRole("menuitem")
    .map((el) => el.getAttribute("data-menu-key") ?? "");
}

function rowLabels(): string[] {
  return screen
    .getAllByRole("menuitem")
    .map((el) => el.textContent?.replace(/›/g, "").trim() ?? "");
}

afterEach(() => {
  userName = "Manav";
  cleanup();
});

describe("the ⓶ menu's contents match the ruled model", () => {
  test("People, conversations, then Your Cue's shortcuts — in C6's order", () => {
    renderMenu();
    expect(openAccountMenu()).toEqual([
      "people",
      "conversations",
      "agents",
      "skills",
      "your-cue",
      "create",
      "logs",
    ]);
  });

  test("People leads — it is what the tab bar stopped being able to say", () => {
    // v23 took People's tab away and the mitigation was contextual entry plus
    // this row. If it stops leading, the fallback has been quietly demoted too.
    renderMenu();
    expect(openAccountMenu()[0]).toBe("people");
  });

  test("Library is NOT a row here — it is Work's third view", () => {
    renderMenu();
    openAccountMenu();
    expect(rowLabels().some((l) => l.startsWith("Library"))).toBe(false);
  });

  test("the retired CUE group is not back as destinations", () => {
    renderMenu();
    openAccountMenu();
    const labels = rowLabels();
    // Rhythms and Memory are configuration leaves inside Your Cue now. Agents
    // and Skills survive as the two most-touched shortcuts, which is design's
    // own list, not a leftover.
    for (const retired of ["Rhythms", "Memory", "Watching"]) {
      expect(labels.some((l) => l.startsWith(retired))).toBe(false);
    }
  });
});

describe("reach — a menu of destinations is not a corner escape", () => {
  test("it opens as a bottom sheet, not a popover under the button", () => {
    renderMenu();
    openAccountMenu();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  test("the sheet can be dismissed without hitting the button again", () => {
    renderMenu();
    openAccountMenu();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

describe("a row that renders is a row that navigates", () => {
  test.each([
    ["people", () => routes.people],
    ["conversations", () => routes.conversations],
    ["agents", () => routes.hqAgents],
    ["skills", () => routes.skills],
    ["your-cue", () => routes.yourCue],
    ["logs", () => routes.logs.root],
  ])("%s lands somewhere real", (key, expected) => {
    renderMenu();
    openAccountMenu();
    const row = screen
      .getAllByRole("menuitem")
      .find((el) => el.getAttribute("data-menu-key") === key);
    expect(row).toBeDefined();
    fireEvent.click(row!);
    expect(screen.getByTestId("path").textContent).toBe(expected());
  });
});

describe("the ⓶ screen always has a door", () => {
  test("the menu reaches it even when the mark cannot", () => {
    // The spec's entrance is "press the mark when already home". Home resolves
    // into a conversation, and the conversation surface hides the tab bar — so
    // that gesture has no mark to press. This row is the door that does exist.
    renderMenu();
    openAccountMenu();
    const row = screen
      .getAllByRole("menuitem")
      .find((el) => el.getAttribute("data-menu-key") === "your-cue");
    fireEvent.click(row!);
    expect(screen.getByTestId("path").textContent).toBe(routes.yourCue);
  });
});

describe("the ☰ corner", () => {
  test("does not duplicate conversations — that row lives in ⓶", () => {
    // One destination, one nav path. This codebase has had to remove the same
    // duplication three times.
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Search and capture" }));
    const keys = screen
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("data-menu-key"));
    expect(keys).toEqual(["search", "add-tasks"]);
  });
});

describe("the button is the owner, honestly", () => {
  test("carries the signed-in user's initial", () => {
    renderMenu();
    expect(
      screen.getByRole("button", { name: /Manav — People, conversations/ }),
    ).toBeDefined();
  });

  test("with no name on file it does not invent one", () => {
    userName = null;
    renderMenu();
    // Not a letter — a letter would read as an initial Cue does not have.
    const button = screen.getByRole("button", {
      name: /^You — People, conversations/,
    });
    expect(button.textContent).toBe("☺");
  });
});
