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
 *
 * **Findability**, added after the owner tested the build on his own phone.
 * Two rows he went looking for were not there. His 151 conversations were one
 * row deep in the RIGHT-hand sheet while every product he compares this to
 * puts them top-left — so ☰ leads with them now. And Library, kept out of the
 * ⓶ sheet because it is Work's third view, was invisible to someone reading
 * that sheet for "everything I have". Both were argued for on grounds that
 * were internally coherent and wrong in the hand, so the two tests that
 * enforced their absence are inverted below rather than deleted: the record of
 * why matters more than the assertion did.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { routes } from "@/utils/routes";

const ASSISTANT_ID = "asst-1";

let userName: string | null = "Manav";

/** What the conversation list hands both sheets. Mutated per test. */
let conversations: {
  conversationId: string;
  title?: string;
  lastMessageAt?: number;
  archivedAt?: number;
}[] = [];

/** What the Library's own fetch reports. `entries.length` is the only count. */
let libraryOutputs: { entries: unknown[]; isLoading: boolean; isError: boolean } =
  { entries: [], isLoading: false, isError: false };

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
    conversations,
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => {},
  }),
}));

const libraryOutputsActual = await import(
  "@/mobile-v3/library/use-library-outputs"
);
mock.module("@/mobile-v3/library/use-library-outputs", () => ({
  ...libraryOutputsActual,
  useLibraryOutputs: () => ({ ...libraryOutputs, refetch: () => {} }),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { activeAssistantId: () => ASSISTANT_ID },
  },
}));

// The REAL flag store — Learn's gate is hydration-paired, and a mock that
// hands the hook a boolean would test the mock's wiring, not the gate.
const { useAssistantFeatureFlagStore } = await import(
  "@/stores/assistant-feature-flag-store"
);

const { Mv3OverflowMenu, LIBRARY_FETCH_LIMIT } = await import("./overflow-menu");

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
  return menuKeys();
}

/** Opens the left-hand ☰ menu and returns its row keys, in render order. */
function openThreadSwitcher(): string[] {
  fireEvent.click(screen.getByRole("button", { name: /Your chats/i }));
  return menuKeys();
}

function menuKeys(): string[] {
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
  conversations = [];
  libraryOutputs = { entries: [], isLoading: false, isError: false };
  useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
  cleanup();
});

describe("the ⓶ menu's contents match the ruled model", () => {
  test("People, conversations, then Your Cue's shortcuts — in C6's order", () => {
    renderMenu();
    expect(openAccountMenu()).toEqual([
      "people",
      "conversations",
      "library",
      // "Briefs & reviews" (v43 R1) closes the Accumulating group — rituals
      // accumulate, so they get an archive. It is deliberately NOT the first
      // door to them: the ritual slot at the top of Today is, because a menu
      // has no sense of time and listing these two here alone is exactly what
      // kept both surfaces dark.
      "rituals",
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

  test("the conversations row does not quote the client's window as a total", () => {
    // What the owner's phone actually printed: "All conversations · 151",
    // with 420 active on the server and 1188 rows in the table. 151 was page
    // 0 plus the two drained pages — this client's cache size. The daemon
    // publishes no total, so above one page the row says so in words.
    conversations = Array.from({ length: 151 }, (_, i) => ({
      conversationId: `c${i}`,
    }));
    renderMenu();
    openAccountMenu();
    const row = screen
      .getAllByRole("menuitem")
      .find((el) => el.getAttribute("data-menu-key") === "conversations")!;
    expect(row.textContent).not.toContain("151");
    expect(row.textContent).toContain("including older threads");
  });

  test("Library IS a row here — the sheet is what people read for 'everything'", () => {
    // This assertion used to run the other way round: Library was excluded
    // because it is Work's third view and a second row would be a second nav
    // path. The owner read this sheet looking for it — *"the swipe up is not
    // showing library either"* — which settles it. Both rows point at the one
    // `?view=library` url, so there is still one Library.
    renderMenu();
    openAccountMenu();
    expect(rowLabels().some((l) => l.startsWith("Library"))).toBe(true);
  });

  test("Library lands on Work's library view, not a second Library", () => {
    renderMenu();
    openAccountMenu();
    const row = screen
      .getAllByRole("menuitem")
      .find((el) => el.getAttribute("data-menu-key") === "library");
    fireEvent.click(row!);
    // The path drops the query, so assert on the full href the row targets.
    expect(routes.workView("library").startsWith(routes.projects)).toBe(true);
    expect(screen.getByTestId("path").textContent).toBe(routes.projects);
  });

  describe("the Library row's count is real or absent", () => {
    const librarySub = () =>
      screen
        .getAllByRole("menuitem")
        .find((el) => el.getAttribute("data-menu-key") === "library")!
        .textContent!.replace(/›/g, "")
        .trim();

    test("a settled read prints the number the gallery would show", () => {
      libraryOutputs = {
        entries: Array.from({ length: 12 }, (_, i) => ({ id: `o${i}` })),
        isLoading: false,
        isError: false,
      };
      renderMenu();
      openAccountMenu();
      expect(librarySub()).toBe("Library12 made");
    });

    test("a read in flight prints no number at all", () => {
      // A `0` here is indistinguishable from "you have made nothing", and one
      // of those two is a fabrication.
      libraryOutputs = { entries: [], isLoading: true, isError: false };
      renderMenu();
      openAccountMenu();
      expect(librarySub()).toBe("Library");
    });

    test("a FAILED read keeps the row and drops the number", () => {
      // Fail-open: an outage may not remove a door, and it may not invent a
      // count either.
      libraryOutputs = { entries: [], isLoading: false, isError: true };
      renderMenu();
      openAccountMenu();
      expect(librarySub()).toBe("Library");
    });

    test("at the fetch's ceiling the true total is unknown, so none is shown", () => {
      libraryOutputs = {
        entries: Array.from({ length: LIBRARY_FETCH_LIMIT }, (_, i) => ({
          id: `o${i}`,
        })),
        isLoading: false,
        isError: false,
      };
      renderMenu();
      openAccountMenu();
      expect(librarySub()).toBe("Library");
    });

    test("that ceiling is the one the Library hook actually asks for", async () => {
      // The constant is a mirror of a file another workstream owns, so it is
      // checked against the source rather than trusted.
      const source = await Bun.file(
        new URL("./library/use-library-outputs.ts", import.meta.url).pathname,
      ).text();
      expect(source).toContain(`LIMIT = ${LIBRARY_FETCH_LIMIT}`);
    });
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

describe("the ☰ corner is where the chats are", () => {
  // The inversion of "does not duplicate conversations — that row lives in ⓶".
  // That rule optimised for one-destination-one-path and produced a phone on
  // which 151 conversations had no top-left door at all.

  test("the threads come first; search and capture ride below them", () => {
    conversations = [
      { conversationId: "c1", title: "Acme pricing", lastMessageAt: 3 },
      { conversationId: "c2", title: "Board deck", lastMessageAt: 2 },
    ];
    renderMenu();
    expect(openThreadSwitcher()).toEqual([
      "thread:c1",
      "thread:c2",
      "all-conversations",
      "new-chat",
      "search",
      "add-tasks",
    ]);
  });

  test("a thread row opens THAT thread — one tap, no list in between", () => {
    conversations = [
      { conversationId: "c1", title: "Acme pricing", lastMessageAt: 3 },
    ];
    renderMenu();
    openThreadSwitcher();
    fireEvent.click(
      screen.getAllByRole("menuitem").find(
        (el) => el.getAttribute("data-menu-key") === "thread:c1",
      )!,
    );
    expect(screen.getByTestId("path").textContent).toBe(
      routes.conversation("c1"),
    );
  });

  test("most recent first, archived left out", () => {
    conversations = [
      { conversationId: "old", title: "Old", lastMessageAt: 1 },
      { conversationId: "new", title: "New", lastMessageAt: 9 },
      { conversationId: "gone", title: "Gone", lastMessageAt: 10, archivedAt: 11 },
    ];
    renderMenu();
    expect(openThreadSwitcher().slice(0, 2)).toEqual([
      "thread:new",
      "thread:old",
    ]);
  });

  test("with no threads it still offers the list, and says why it is short", () => {
    renderMenu();
    const keys = openThreadSwitcher();
    expect(keys).toEqual(["all-conversations", "new-chat", "search", "add-tasks"]);
    expect(screen.getByText(/No chats yet/i)).toBeDefined();
  });

  test("the corner's accessible name says chats, not just search", () => {
    // The button is the whole affordance for someone who cannot see the glyph.
    renderMenu();
    expect(
      screen.getByRole("button", { name: "Your chats, search and capture" }),
    ).toBeDefined();
  });
});

describe("Learn's phone door rides below the hairline", () => {
  // The ☰ sheet is the phone's only global drawer, so this row is the
  // surface's ONLY mobile entrance — and it is flag-gated dark, like the
  // desktop rail row it mirrors.

  test("hydrated flag on → the row is there, after search and capture", () => {
    useAssistantFeatureFlagStore.setState({ hasHydrated: true, learnApp: true });
    renderMenu();
    expect(openThreadSwitcher()).toEqual([
      "all-conversations",
      "new-chat",
      "search",
      "add-tasks",
      "learn",
    ]);
  });

  test("the row lands on the Learn surface", () => {
    useAssistantFeatureFlagStore.setState({ hasHydrated: true, learnApp: true });
    renderMenu();
    openThreadSwitcher();
    fireEvent.click(
      screen
        .getAllByRole("menuitem")
        .find((el) => el.getAttribute("data-menu-key") === "learn")!,
    );
    expect(screen.getByTestId("path").textContent).toBe(routes.learn);
  });

  test("a `true` before hydration is a default, not a ruling — no row", () => {
    // The store's own contract: flag values are registry defaults until the
    // first real /feature-flags response lands.
    useAssistantFeatureFlagStore.setState({
      hasHydrated: false,
      learnApp: true,
    });
    renderMenu();
    expect(openThreadSwitcher()).not.toContain("learn");
  });

  test("flag off → dark, exactly what design signed off on", () => {
    useAssistantFeatureFlagStore.setState({
      hasHydrated: true,
      learnApp: false,
    });
    renderMenu();
    expect(openThreadSwitcher()).not.toContain("learn");
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
