/**
 * The mobile Apps row renders — the assertion nobody had made.
 *
 * `apps` is the only `SIDEBAR_DESTINATIONS` row with no phone door of its own
 * (see `nav-model.test.ts`), so this drawer row IS the door. `nav-model`'s
 * suite proves the row is *declared*; only this file proves it is *drawn*.
 *
 * Both halves of the gate are tested, because each has its own failure mode
 * and they are not interchangeable:
 *
 *   · flag off  → no row. The page redirects to HQ when `ventureverse-apps` is
 *     off, so a row rendered anyway would be a door onto a bounce.
 *   · not hydrated → no row. Flags are typed `Record<string, boolean>`, so an
 *     unknown key reads falsy and every flag looks "off" until the first real
 *     `/feature-flags` response lands. Without the hydration half the row
 *     appears mid-session and yanks itself back.
 *
 * The desktop row takes the same pair and had no test for either.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import type { Conversation } from "@/types/conversation-types";

// Only the seams this component reads are overridden; everything else stays
// the real module. An exhaustive factory would delete exports for every file
// that loads after this one (see assistant/CLAUDE.md — five silent failures).
const workItemsActual = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...workItemsActual,
  workitemsGetOptions: () => ({
    queryKey: ["workitems-stub"],
    queryFn: () => Promise.resolve({ items: [] }),
  }),
}));

// Imported AFTER the mock above so it binds the stubbed query options.
const { Mv3ChatsIndex } = await import("./mv3-chats-index");

const CONVERSATIONS: Conversation[] = [];

/** Paints the current path so a test can assert where the router landed. */
function PathProbe() {
  return createElement(
    "div",
    { "data-testid": "path" },
    useLocation().pathname,
  );
}

function renderIndex(props: { onClose?: () => void } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(PathProbe),
        createElement(Mv3ChatsIndex, {
          assistantId: "asst-1",
          conversations: CONVERSATIONS,
          processingConversationIds: new Set<string>(),
          attentionConversationIds: new Set<string>(),
          onSelectConversation: () => {},
          onStartNewConversation: () => {},
          ...props,
        }),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
});

describe("the Apps row on the phone", () => {
  test("renders once the flag is on and flags have hydrated", () => {
    useAssistantFeatureFlagStore.getState().setFlags({ ventureverseApps: true });
    useAssistantFeatureFlagStore.getState().markHydrated();
    renderIndex();
    expect(screen.queryByLabelText("Open Apps")).not.toBeNull();
  });

  test("MUTATION CHECK: hidden while flags are still defaults", () => {
    // Not belt-and-braces: every flag reads falsy pre-hydration, so without
    // this half the row pops in on the first /feature-flags response.
    useAssistantFeatureFlagStore.getState().setFlags({ ventureverseApps: true });
    renderIndex();
    expect(screen.queryByLabelText("Open Apps")).toBeNull();
  });

  test("MUTATION CHECK: hidden when the flag is off", () => {
    // The Apps page redirects to HQ when the flag is off. A row here would be
    // a door onto a bounce.
    useAssistantFeatureFlagStore.getState().setFlags({ ventureverseApps: false });
    useAssistantFeatureFlagStore.getState().markHydrated();
    renderIndex();
    expect(screen.queryByLabelText("Open Apps")).toBeNull();
  });
});

describe("pressing it opens Apps", () => {
  function enable() {
    useAssistantFeatureFlagStore.getState().setFlags({ ventureverseApps: true });
    useAssistantFeatureFlagStore.getState().markHydrated();
  }

  test("the router lands on /assistant/apps", () => {
    enable();
    renderIndex();
    fireEvent.click(screen.getByLabelText("Open Apps"));
    expect(screen.getByTestId("path").textContent).toBe("/assistant/apps");
  });

  test("REGRESSION: it must not call the page's onClose", () => {
    // The shipped bug. `onClose` is `closeDrawer()` in the drawer but
    // `goBackWithFallback(navigate, routes.hq)` on the full page, so calling
    // it here fired a history pop that resolved AFTER the push — the owner
    // pressed Apps and landed back on home. Only `onLeaveForSurface` may run.
    enable();
    let closed = 0;
    renderIndex({ onClose: () => closed++ });
    fireEvent.click(screen.getByLabelText("Open Apps"));
    expect(closed).toBe(0);
    expect(screen.getByTestId("path").textContent).toBe("/assistant/apps");
  });

  test("the drawer still gets dismissed on the way out", () => {
    // The drawer passes its close as `onLeaveForSurface`; without this it
    // would hang over the destination.
    enable();
    let left = 0;
    renderIndex({ onLeaveForSurface: () => left++ } as { onClose?: () => void });
    fireEvent.click(screen.getByLabelText("Open Apps"));
    expect(left).toBe(1);
  });
});
