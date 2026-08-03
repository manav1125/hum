/**
 * The phone's three tabs.
 *
 * What's actually at risk here is the shape of the bar, not its pixels: the
 * centre slot spent two design iterations as a `+` that pointed at nothing,
 * and the fix was to make it a real destination with a real active state that
 * also reports whether agents are working. So: three tabs, the mark in the
 * middle, one badge, and a pulse that is driven by running work rather than
 * by optimism.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

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
      ),
    ),
  );
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
    expect(screen.getByLabelText("Talk to Cue (hold for voice)")).toBeDefined();
  });
});

describe("active state", () => {
  test.each([
    ["/assistant/hq", "HQ"],
    ["/assistant/projects", "Work"],
    ["/assistant/projects/proj-1", "Work"],
    // At home the mark's own label changes (it opens the ⓶ screen there), so
    // this row matches the part that never moves.
    ["/assistant", /hold for voice/],
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
    expect(
      screen.getByLabelText(/hold for voice/).getAttribute("aria-current"),
    ).toBe("page");
  });

  test("the mark stays lit across the whole ⓶ stack", () => {
    // Otherwise Your Cue renders three dim tabs and nothing selected, which
    // is the "nav that looked like decoration" bug this branch already had.
    renderBar("/assistant/your-cue");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const current = [...nav.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-current") === "page",
    );
    expect(current).toHaveLength(1);
    // It is the MARK that is lit, and from here a tap goes back home — so
    // its label is the plain destination, not the ⓶ one.
    expect(current[0]!.getAttribute("aria-label")).toContain("hold for voice");
  });
});

describe("pressing the mark at home", () => {
  test("it stops being a no-op and opens the ⓶ screen", () => {
    // At home the mark used to navigate to the route you were already on.
    // Design's rule for the centre slot: it must point at something.
    renderBar("/assistant");
    const mark = screen.getByLabelText(/hold for voice/);
    expect(mark.getAttribute("aria-label")).toContain("Your Cue");
    expect(mark.getAttribute("aria-label")).toContain(
      "what Cue is doing and how it",
    );
  });

  test("anywhere else it still says where it goes", () => {
    renderBar("/assistant/projects");
    expect(screen.getByLabelText("Talk to Cue (hold for voice)")).toBeDefined();
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
    // hides it while typing AND for the rest of the day. Since `/assistant`
    // resolves into a conversation, that left no mark to press at home — and
    // the mark is this phone's only door to Your Cue, so a whole destination
    // was unreachable because a route was standing in for the keyboard.
    renderBar("/assistant/conversations/abc");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeDefined();
  });
});
