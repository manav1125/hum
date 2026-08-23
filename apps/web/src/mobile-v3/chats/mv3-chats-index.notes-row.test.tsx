/**
 * The mobile Notes row renders — the door for the rail's newest destination.
 *
 * Notes is a `SIDEBAR_DESTINATIONS` row with no phone door of its own, so
 * this drawer row IS the door. `nav-model.test.ts` proves the key is
 * *declared* in `MOBILE_DRAWER_DESTINATION_KEYS`; only this file proves the
 * row is actually *drawn* — the exact gap that shipped Apps invisible on
 * phones, and the reason this test exists on day one rather than after
 * someone reports it.
 *
 * Unlike Apps there is no flag behind Notes, so the row is unconditional. The
 * assertions here are therefore about the two things that can still break:
 * the row exists, and pressing it navigates without firing the page's
 * `onClose` (a history pop that resolves after the push and bounces you home).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import type { Conversation } from "@/types/conversation-types";

// Only the seam this component reads is overridden; everything else stays the
// real module. An exhaustive factory would delete exports for every file that
// loads after this one (see assistant/CLAUDE.md — five silent failures).
const queryGenActual =
  await import("@/generated/daemon/@tanstack/react-query.gen");
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...queryGenActual,
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

describe("the Notes row on the phone", () => {
  test("renders unconditionally — there is no flag behind Notes", () => {
    renderIndex();
    expect(screen.queryByLabelText("Open Notes")).not.toBeNull();
  });

  test("does not wait for feature flags to hydrate", () => {
    // Apps needs the hydration gate because it IS flag-gated; copying that
    // gate here would hide the row for the first moments of every session
    // for no reason.
    useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
    renderIndex();
    expect(screen.queryByLabelText("Open Notes")).not.toBeNull();
  });
});

describe("pressing it opens Notes", () => {
  test("the router lands on /assistant/notes", () => {
    renderIndex();
    fireEvent.click(screen.getByLabelText("Open Notes"));
    expect(screen.getByTestId("path").textContent).toBe("/assistant/notes");
  });

  test("REGRESSION: it must not call the page's onClose", () => {
    // The shape of the shipped Apps bug: `onClose` is `closeDrawer()` in the
    // drawer but a history pop on the full page, so calling it here resolves
    // AFTER the push and lands the owner back on home. Only
    // `onLeaveForSurface` may run.
    let closed = 0;
    renderIndex({ onClose: () => closed++ });
    fireEvent.click(screen.getByLabelText("Open Notes"));
    expect(closed).toBe(0);
    expect(screen.getByTestId("path").textContent).toBe("/assistant/notes");
  });
});
