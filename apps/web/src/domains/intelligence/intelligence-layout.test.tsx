/**
 * Tests for `IntelligenceLayout`'s mobile/desktop chrome.
 *
 * On mobile the desktop section-nav strip is hidden and a v3-grammar back
 * row renders instead ("‹ You" + the section title); the shared top-bar
 * center slot stays cleared. The in-body <h1> is hidden with
 * `max-md:hidden`. On desktop the in-body <h1> renders the title, the tab
 * strip renders, and the top-bar center is cleared (`setTopBarCenter(null)`).
 *
 * `useIsMobile` and the slots-store setter are mocked; the assistant name is
 * driven through the real identity store. `MemoryRouter` satisfies the
 * component's `useLocation`/`NavLink` usage.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const isMobileRef = { value: false };
const setTopBarCenterMock = mock((_node: unknown) => {});

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/components/layout/chat-layout-slots-store", () => ({
  useChatLayoutSlotsStore: {
    use: {
      setTopBarCenter: () => setTopBarCenterMock,
    },
  },
}));

// The real feature-flag store imports the generated API client, which isn't
// available under the test runner. Stub the selectors the layout reads;
// `false` for `externalPlugins`/`marketplace` keeps the baseline tab set.
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      hasHydrated: () => true,
      externalPlugins: () => false,
      marketplace: () => false,
    },
  },
}));

const { IntelligenceLayout } =
  await import("@/domains/intelligence/intelligence-layout");

const renderLayout = (initialPath = "/") =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <IntelligenceLayout />
    </MemoryRouter>,
  );

beforeEach(() => {
  isMobileRef.value = false;
  setTopBarCenterMock.mockClear();
  useAssistantIdentityStore.getState().setIdentity("Ada", null);
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("IntelligenceLayout", () => {
  test("on mobile, renders the back row with the section title and hides the in-body h1", () => {
    isMobileRef.value = true;
    // Cue Live is a section that still uses the interim strip (Identity /
    // Contacts / Skills / Memory / Workspace… render full-bleed v3 surfaces
    // that mount their own headers — round-4 frames 53/54).
    const { container, getAllByText, getByLabelText } = renderLayout(
      "/assistant/cue-live",
    );

    // The in-body h1 still renders the title but is hidden on mobile.
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("About Ada");
    expect(heading?.className).toContain("max-md:hidden");

    // The desktop tab strip is hidden on mobile (UAT P2: it used to leak
    // above Cue Live/Identity/Workspace at phone widths).
    const nav = container.querySelector("nav");
    expect(nav?.className).toContain("max-md:hidden");

    // The v3 back row carries navigation + the section title.
    expect(getByLabelText("Back to You")).toBeTruthy();
    expect(
      getAllByText("Cue Live").some(
        (el) => el.getAttribute("data-slot") === "typography",
      ),
    ).toBe(true);

    // The shared top-bar center stays cleared.
    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });

  test("on mobile, Identity and Contacts render full-bleed — no interim strip", () => {
    isMobileRef.value = true;
    for (const path of ["/assistant/identity", "/assistant/contacts"]) {
      const { queryByLabelText, unmount } = renderLayout(path);
      // These surfaces mount their own v3 header (frames 53/54), so the
      // layout's `‹ You` strip stands down.
      expect(queryByLabelText("Back to You")).toBeNull();
      unmount();
    }
  });

  test("on desktop, renders the in-body title and clears the top-bar center", () => {
    isMobileRef.value = false;
    const { container } = renderLayout();

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("About Ada");

    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });
});
