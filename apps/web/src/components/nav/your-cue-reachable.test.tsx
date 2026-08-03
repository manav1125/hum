/**
 * Your Cue has a door on the phone, and this is the test that says so.
 *
 * ## Why it exists, and why it lives here rather than beside the menu
 *
 * The ⓶ screen (`routes.yourCue`) is the phone's single entrance to every
 * configuration surface in the app — {@link YOUR_CUE_DOOR}. It has been left
 * with no entrance once already on this branch, and the round after that it
 * was propped up on a GESTURE: pressing the centre mark while already home.
 * That gesture was then found to be unfireable, fixed, and has now been
 * withdrawn on purpose — the mark is a new conversation from every state
 * (`mobile-v3/tab-bar-v3.tsx`), because a slot that does a different thing
 * depending on where you pressed it is the thing the owner read as
 * "doesn't point anywhere".
 *
 * Withdrawing a door is only safe if another one is *asserted*, not merely
 * believed to exist. So this file drives the real chrome — mount it, press the
 * ⓶ button, press the row — and watches the router land. It is the standing
 * answer to "never leave a destination unreachable".
 *
 * It sits in `components/nav/` because that is where the door is DECLARED, and
 * because the change that made it necessary was a navigation-model change. The
 * menu's own suite (`mobile-v3/overflow-menu.test.tsx`) tests the menu's
 * composition — which rows, in which groups. This tests one property of the
 * whole phone: you can still get there. If someone deletes that row, both fail,
 * and this one says why it mattered.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { YOUR_CUE_DOOR } from "@/components/nav/nav-model";
import { MV3_OVERFLOW_SURFACES } from "@/mobile-v3/corner-chrome";
import { routes } from "@/utils/routes";

const ASSISTANT_ID = "asst-1";

// Only the seams the chrome reads are overridden; everything else is the real
// module. An exhaustive hand-written factory here would silently drop exports
// for every file that loads after this one.
const homeQueryActual = await import(
  "@/domains/home/hooks/use-home-state-query"
);
mock.module("@/domains/home/hooks/use-home-state-query", () => ({
  ...homeQueryActual,
  useHomeStateQuery: () => ({ data: { userName: "Manav" } }),
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

const { Mv3OverflowMenu } = await import("@/mobile-v3/overflow-menu");
const { TabBarV3 } = await import("@/mobile-v3/tab-bar-v3");

function LocationProbe() {
  return createElement(
    "div",
    { "data-testid": "path" },
    useLocation().pathname,
  );
}

/** The phone's global chrome on a primary landing, with an observable router. */
function renderChrome(pathname: string) {
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
        createElement(Mv3OverflowMenu),
        createElement(TabBarV3),
        createElement(LocationProbe),
      ),
    ),
  );
}

function currentPath(): string {
  return screen.getByTestId("path").textContent ?? "";
}

afterEach(cleanup);

describe("Your Cue is reachable from the phone", () => {
  test.each(MV3_OVERFLOW_SURFACES.filter((p) => p !== routes.home))(
    "%s — ⓶ then the row lands on the ⓶ screen",
    (surface) => {
      renderChrome(surface);
      // The whole point is that this is a BUTTON somebody can find, not a
      // gesture: press the avatar, press the row, arrive.
      fireEvent.click(
        screen.getByLabelText(/People, conversations and Your Cue/),
      );
      const row = document.querySelector('[data-menu-key="your-cue"]');
      expect(row).not.toBeNull();
      fireEvent.click(row as Element);
      expect(currentPath()).toBe(routes.yourCue);
      // And the destination it reached is the one the nav model calls the
      // door — not a lookalike leaf that happens to be spelled similarly.
      expect(YOUR_CUE_DOOR.match(currentPath())).toBe(true);
      cleanup();
    },
  );

  test("the row is a door, not a label — it says where it goes", () => {
    renderChrome(routes.hq);
    fireEvent.click(screen.getByLabelText(/People, conversations and Your Cue/));
    const row = document.querySelector('[data-menu-key="your-cue"]');
    expect(row?.textContent).toContain("Your Cue");
  });
});

describe("the mark is not that door", () => {
  // Regression guard in the other direction: if a later round re-points the
  // centre mark at Your Cue, that is a SECOND path to one destination — the
  // duplication this navigation model keeps having to remove — and the owner's
  // report ("it should go to a new conversation") gets quietly reverted.
  test("pressing it goes to a conversation, from the ⓶ screen too", () => {
    renderChrome(routes.hq);
    fireEvent.click(screen.getByLabelText(/hold for voice/));
    expect(currentPath().startsWith("/assistant/conversations/")).toBe(true);
    expect(currentPath()).not.toBe(routes.yourCue);
  });
});
