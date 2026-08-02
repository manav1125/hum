/**
 * Every rail row, **clicked**, with the resulting URL asserted.
 *
 * This file exists because of one shipped bug. "All conversations ›" rendered
 * correctly, was styled correctly, had an `onSelect` that called `navigate`,
 * and did nothing at all: the route it pointed at redirected on desktop back to
 * where you came from, so the URL never changed. Two render-only test files
 * covered the rail and neither could see it — a row that renders is not a row
 * that navigates, and only one of those is what a navigation is for.
 *
 * So the rule for this file is: **no assertion may be about what is on screen.**
 * Every test clicks something and reads the location afterwards. The probe
 * renders the live pathname into the DOM so an assertion can be made against a
 * real router transition rather than a spied callback — a spy would have passed
 * on the dead row too, because `navigate()` genuinely was called.
 *
 * The route table is deliberately NOT mocked: `MemoryRouter` performs the real
 * transition. What it cannot see is a *redirect defined in `routes.tsx`*, which
 * is exactly what killed the row — so `routes.test.tsx` carries the companion
 * assertion that `/assistant/conversations` does not resolve to a redirect.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

interface FakeContact {
  id: string;
  displayName: string;
  role: string;
  interactionCount: number;
  lastInteraction?: number | null;
  channels: unknown[];
}
let contacts: FakeContact[] = [];
let contactMemories: Record<string, { id: string }[]> = {};

// Spread the real module and override only the seams this rail reads.
const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  projectsGet: mock(async () => ({ data: { projects: [] }, ...okResponse })),
  workitemsGet: mock(async () => ({ data: { items: [] }, ...okResponse })),
  pendinginteractionsGet: mock(async () => ({
    data: { interactions: [] },
    ...okResponse,
  })),
  contactsGet: mock(async () => ({ data: { contacts }, ...okResponse })),
  contactsByIdMemoryGet: mock(async (options?: { path?: { id?: string } }) => ({
    data: { memory: contactMemories[options?.path?.id ?? ""] ?? [] },
    ...okResponse,
  })),
}));

const { AssistantSideMenu } = await import("./assistant-side-menu");

/** Renders the live pathname so a test can assert on a real transition. */
function LocationProbe() {
  const { pathname } = useLocation();
  return createElement("div", { "data-testid": "pathname" }, pathname);
}

const at = () => screen.getByTestId("pathname").textContent;

interface RailOptions {
  pathname?: string;
  collapsed?: boolean;
  onStartNewConversation?: () => void;
  onOpenLibrary?: () => void;
}

function renderRail({
  pathname = "/assistant/hq",
  collapsed = false,
  onStartNewConversation,
  onOpenLibrary,
}: RailOptions = {}) {
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
        createElement(AssistantSideMenu, {
          assistantId: ASSISTANT_ID,
          collapsed,
          variant: "rail" as const,
          conversations: [],
          onSelectConversation: () => undefined,
          onStartNewConversation,
          onOpenLibrary,
        }),
        createElement(LocationProbe),
      ),
    ),
  );
}

function seedContact(id: string, memories: number): void {
  contacts.push({
    id,
    displayName: id,
    role: "contact",
    interactionCount: 1,
    lastInteraction: 1,
    channels: [],
  });
  contactMemories[id] = Array.from({ length: memories }, (_, i) => ({
    id: `${id}-m${i}`,
  }));
}

beforeEach(() => {
  contacts = [];
  contactMemories = {};
  globalThis.localStorage?.clear();
});

afterEach(cleanup);

describe("every row in the expanded rail navigates", () => {
  test("HQ", () => {
    renderRail({ pathname: "/assistant/projects" });
    fireEvent.click(screen.getByText("HQ"));
    expect(at()).toBe("/assistant/hq");
  });

  test("Work", () => {
    renderRail();
    fireEvent.click(screen.getByText("Work"));
    expect(at()).toBe("/assistant/projects");
  });

  test("Talk to Cue — with no compose handler it is a destination", () => {
    renderRail({ pathname: "/assistant/hq" });
    fireEvent.click(screen.getByText("Talk to Cue"));
    expect(at()).toBe("/assistant");
  });

  test("Talk to Cue — with one, the row IS the compose action", () => {
    let started = 0;
    renderRail({ onStartNewConversation: () => (started += 1) });
    fireEvent.click(screen.getByText("Talk to Cue"));
    expect(started).toBe(1);
  });

  test("All conversations — the row that shipped dead", () => {
    // The regression, exactly: this rendered, was clickable, called
    // `navigate()`, and left the URL where it was.
    renderRail({ pathname: "/assistant/hq" });
    fireEvent.click(screen.getByText("All conversations"));
    expect(at()).toBe("/assistant/conversations");
  });

  test("All conversations — from the surface it used to bounce off", () => {
    // `/assistant` is the desktop landing surface, which is where the owner
    // clicked it. The old route redirected back to `/assistant`, so the URL
    // was unchanged and the row looked inert.
    renderRail({ pathname: "/assistant" });
    fireEvent.click(screen.getByText("All conversations"));
    expect(at()).toBe("/assistant/conversations");
  });

  test("Library — via the host callback when the layout supplies one", () => {
    let opened = 0;
    renderRail({ onOpenLibrary: () => (opened += 1) });
    fireEvent.click(screen.getByText("Library"));
    expect(opened).toBe(1);
  });

  test("Library — via the row's own route when it does not", () => {
    renderRail();
    fireEvent.click(screen.getByText("Library"));
    expect(at()).toBe("/assistant/library");
  });

  test("Your Cue", () => {
    renderRail();
    fireEvent.click(screen.getByText("Your Cue"));
    expect(at()).toBe("/assistant/your-cue");
  });

  test("People, once the gate lets it in", async () => {
    seedContact("ada", 3);
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("People")).toBeDefined();
    });
    fireEvent.click(screen.getByText("People"));
    expect(at()).toBe("/assistant/people");
  });
});

describe("every icon in the collapsed strip navigates, and says what it is", () => {
  // The strip is what a conversation collapses to, and the owner read four of
  // its destinations as missing. A row whose only name is a hover tooltip has
  // no name at all to a screen reader — and one that is absent from the strip
  // entirely, as "All conversations" was, is not reachable at all.
  test.each([
    ["HQ", "/assistant/hq"],
    ["Work", "/assistant/projects"],
    ["All conversations", "/assistant/conversations"],
    ["Library", "/assistant/library"],
    ["Your Cue", "/assistant/your-cue"],
  ])("%s", (label, expected) => {
    renderRail({ pathname: "/assistant/conversations/abc", collapsed: true });
    fireEvent.click(screen.getByLabelText(label));
    expect(at()).toBe(expected);
  });

  test("the badge count survives into the accessible name", async () => {
    // Collapsed, both the label and the badge are suppressed, so a name of
    // "HQ" alone would drop the one number the strip is carrying.
    seedContact("ada", 1);
    seedContact("grace", 1);
    renderRail({ collapsed: true });
    await waitFor(() => {
      expect(screen.getByLabelText("People (2)")).toBeDefined();
    });
  });
});

describe("the collapse control says which of its two jobs it is doing", () => {
  test("outside a conversation it collapses", () => {
    let toggles = 0;
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          MemoryRouter,
          null,
          createElement(AssistantSideMenu, {
            assistantId: ASSISTANT_ID,
            collapsed: false,
            inConversation: false,
            onToggleCollapsed: () => (toggles += 1),
            variant: "rail" as const,
            conversations: [],
            onSelectConversation: () => undefined,
          }),
        ),
      ),
    );
    const control = screen.getByLabelText("Collapse the sidebar (⌘\\)");
    fireEvent.click(control);
    expect(toggles).toBe(1);
  });

  test("inside a collapsed conversation it offers to pin — on the rail itself", () => {
    // This is the affordance the owner could not find. It was a top-bar button
    // labelled "Toggle sidebar" with no shortcut printed and no mention of
    // pinning; there was nothing on the 52px strip at all.
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          MemoryRouter,
          null,
          createElement(AssistantSideMenu, {
            assistantId: ASSISTANT_ID,
            collapsed: true,
            inConversation: true,
            onToggleCollapsed: () => undefined,
            variant: "rail" as const,
            conversations: [],
            onSelectConversation: () => undefined,
          }),
        ),
      ),
    );
    expect(screen.getByLabelText("Pin the sidebar open (⌘\\)")).toBeDefined();
  });
});
