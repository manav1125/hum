/**
 * The phone's three tabs.
 *
 * What's actually at risk here is the shape of the bar, not its pixels: the
 * centre slot spent three design iterations pointing at nothing, at the route
 * you were already on, and then at two different places depending on where you
 * pressed it. So the tests below fix the thing that kept moving — **one press,
 * one outcome, from every state, and it is a new conversation** — alongside
 * three tabs, the mark in the middle, one badge, and a pulse driven by running
 * work rather than by optimism.
 *
 * Your Cue's reachability is NOT asserted here, because the mark is no longer
 * its door: see `components/nav/your-cue-reachable.test.tsx`, which drives the
 * ⓶ menu that is.
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

let workItems: { id: string; status: string; projectId: string | null }[] = [];

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  projectsGet: mock(async () => ({ data: { projects: [] }, ...okResponse })),
  workitemsGet: mock(async () => ({
    data: { items: workItems },
    ...okResponse,
  })),
  pendinginteractionsGet: mock(async () => ({
    data: { interactions: [] },
    ...okResponse,
  })),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { activeAssistantId: () => ASSISTANT_ID },
  },
}));

const { TabBarV3 } = await import("./tab-bar-v3");

/** Reports where the router actually is, so "it navigates" is observable. */
function LocationProbe() {
  return createElement(
    "div",
    { "data-testid": "path" },
    useLocation().pathname,
  );
}

function renderBar(pathname = "/assistant/hq") {
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
        { initialEntries: [pathname] },
        createElement(TabBarV3),
        createElement(LocationProbe),
      ),
    ),
  );
}

function currentPath(): string {
  return screen.getByTestId("path").textContent ?? "";
}

/** The mark, by the only part of its label that never moves. */
function mark(): HTMLElement {
  return screen.getByLabelText(/hold for voice/);
}

afterEach(() => {
  workItems = [];
  cleanup();
});

describe("the bar's shape", () => {
  test("three tabs, no more", () => {
    renderBar();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.querySelectorAll("button")).toHaveLength(3);
  });

  test("Today, the mark, then Work — in that order, mark CENTRED", () => {
    renderBar();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const buttons = [...nav.querySelectorAll("button")];
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    expect(labels[0]).toBe("HQ");
    expect(labels[1]).toContain("Talk to Cue");
    expect(labels[2]).toBe("Work");
    // The centre is the whole argument for three: at four slots the mark sits
    // at position 2 of 4 and reads as an accident.
    expect(buttons.indexOf(buttons[1]!)).toBe((buttons.length - 1) / 2);
  });

  test("the phone prints Today, not HQ", () => {
    // The rail says HQ; v24's frames say Today under the phone glyph. One
    // declaration, `phoneLabel` — not a ternary at the call site.
    renderBar();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const printed = [...nav.querySelectorAll("button")].map((b) =>
      b.textContent?.trim(),
    );
    expect(printed[0]).toContain("Today");
    expect(printed[1]).toContain("Cue");
    expect(printed[2]).toContain("Work");
  });

  test("the mark advertises its long-press, so voice is discoverable", () => {
    // Voice stopped being a tab because it is a mode, not a place. It cannot
    // therefore become invisible.
    renderBar();
    expect(mark().getAttribute("aria-label")).toContain("hold for voice");
  });
});

describe("active state", () => {
  test.each([
    ["/assistant/hq", "HQ"],
    ["/assistant/projects", "Work"],
    ["/assistant/projects/proj-1", "Work"],
    ["/assistant", /hold for voice/],
    ["/assistant/conversations/abc", /hold for voice/],
  ])("%s marks %s current", (pathname, label: string | RegExp) => {
    renderBar(pathname);
    expect(screen.getByLabelText(label).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  test("exactly one tab is ever current", () => {
    renderBar("/assistant/projects");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const current = [...nav.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-current") === "page",
    );
    expect(current).toHaveLength(1);
  });

  test("the centre slot is a real destination, not a no-op", () => {
    // v9's floating mark pointed at nothing. This asserts it points somewhere.
    renderBar("/assistant");
    expect(mark().getAttribute("aria-current")).toBe("page");
  });

  test("the mark does NOT claim Your Cue any more", () => {
    // It used to light here so the bar wouldn't render three dim tabs. But a
    // lit tab claims "this press brought you here and returns you", and from
    // Your Cue this press now starts a conversation. Your Cue is reached from
    // the ⓶ chrome, not from a tab, so no tab selected is the honest state.
    renderBar("/assistant/your-cue");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const current = [...nav.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-current") === "page",
    );
    expect(current).toHaveLength(0);
  });
});

describe("pressing the mark", () => {
  // The owner's report: "the centre C doesn't point anywhere. It should go to
  // a new conversation." What made it read that way was that the answer moved
  // — at home it opened the ⓶ screen, elsewhere it resumed whatever thread
  // was last open. These fix ONE outcome from every state.
  test.each([
    ["from Today", "/assistant/hq"],
    ["from Work", "/assistant/projects"],
    ["from the chats index", "/assistant/conversations"],
    ["from home", "/assistant"],
    ["from inside a conversation", "/assistant/conversations/existing-abc"],
  ])("%s it opens a new conversation", (_name, from) => {
    renderBar(from);
    fireEvent.click(mark());
    const after = currentPath();
    // A real conversation route, and NOT the one we were already on — the
    // v9 failure mode was a navigation to the current route.
    expect(after.startsWith("/assistant/conversations/")).toBe(true);
    expect(after).not.toBe(from);
  });

  test("two presses are two different threads, never a no-op", () => {
    renderBar("/assistant/hq");
    fireEvent.click(mark());
    const first = currentPath();
    fireEvent.click(mark());
    expect(currentPath()).not.toBe(first);
  });

  test("its label says both where it goes and what the press does", () => {
    // One label in every state, because it is one action in every state.
    renderBar("/assistant");
    expect(mark().getAttribute("aria-label")).toBe(
      "Talk to Cue — new conversation (hold for voice)",
    );
    cleanup();
    renderBar("/assistant/projects");
    expect(mark().getAttribute("aria-label")).toBe(
      "Talk to Cue — new conversation (hold for voice)",
    );
  });
});

describe("the pulse", () => {
  test("stays off when nothing is running", async () => {
    workItems = [{ id: "wi-1", status: "queued", projectId: null }];
    renderBar();
    await waitFor(() => {
      expect(screen.getByLabelText("HQ")).toBeDefined();
    });
    expect(screen.queryByText("Agents are working")).toBeNull();
  });

  test("turns on — with words, not only motion — while work runs", async () => {
    workItems = [{ id: "wi-1", status: "running", projectId: null }];
    renderBar();
    // A pulse is a colour-and-motion signal; it carries an accessible name so
    // the state survives reduced motion and a screen reader.
    await waitFor(() => {
      expect(screen.getByText("Agents are working")).toBeDefined();
    });
  });
});

describe("the badge", () => {
  test("Today carries the app's only badge", async () => {
    workItems = [
      { id: "wi-1", status: "awaiting_review", projectId: null },
      { id: "wi-2", status: "awaiting_review", projectId: null },
    ];
    renderBar();
    await waitFor(() => {
      expect(screen.getByText("2")).toBeDefined();
    });
    // And it hangs off HQ, not off Work or the mark.
    expect(screen.getByLabelText("HQ").textContent).toContain("2");
    expect(screen.getByLabelText("Work").textContent).not.toContain("2");
  });
});

describe("surfaces that own their own dock", () => {
  test.each(["/assistant/voice", "/assistant/brief"])(
    "%s hides the bar",
    (pathname) => {
      renderBar(pathname);
      expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    },
  );

  test("the bare chats index keeps it", () => {
    renderBar("/assistant/conversations");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeDefined();
  });

  test("a conversation keeps it too — hiding is about the keyboard, not the route", () => {
    // This asserted the opposite until v25 · G3 #4 was read properly. The
    // rule is "hides while typing, returns on dismiss"; a route predicate
    // hides it while typing AND for the rest of the day. It matters more now
    // than it did then: the mark lands you in a conversation, so a bar that
    // vanished there would leave the surface you spend the day on with no
    // way back to Today or Work except the browser's own back.
    renderBar("/assistant/conversations/abc");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeDefined();
  });
});
