/**
 * Tests for the **Your Cue** shell's chrome.
 *
 * Two things this file protects:
 *
 *   · **The grouped strip.** Eighteen leaves in six groups, rendered as a row
 *     of questions plus the leaves of whichever one you are inside. The active
 *     group is DERIVED from the active leaf, so a deep link never costs a
 *     second click — assert that, because a selected-group state variable is
 *     the obvious wrong implementation.
 *   · **Exactly one navigation per screen.** On a phone the desktop strip
 *     stands down and a `‹ You` back row renders instead; on a narrow desktop
 *     window (sub-767px Electron) the opposite. Both are driven by the same JS
 *     gate, because when they were driven by two, a narrow window got neither.
 *
 * `useIsMobile` and the slots-store setter are mocked; `MemoryRouter`
 * satisfies the component's `useLocation`/`NavLink` usage.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const isMobileRef = { value: false };
const setTopBarCenterMock = mock((_node: unknown) => {});

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  useMobileLayout: () => isMobileRef.value,
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
// `false` for `externalPlugins`/`marketplace` keeps the baseline leaf set.
const flagsRef = {
  externalPlugins: false,
  marketplace: false,
  settingsDeveloperNav: false,
};

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      hasHydrated: () => true,
      externalPlugins: () => flagsRef.externalPlugins,
      marketplace: () => flagsRef.marketplace,
      settingsDeveloperNav: () => flagsRef.settingsDeveloperNav,
    },
  },
}));

const { IntelligenceLayout } =
  await import("@/domains/intelligence/intelligence-layout");

const renderLayout = (initialPath = "/assistant/identity") =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <IntelligenceLayout />
    </MemoryRouter>,
  );

beforeEach(() => {
  isMobileRef.value = false;
  flagsRef.externalPlugins = false;
  flagsRef.marketplace = false;
  flagsRef.settingsDeveloperNav = false;
  setTopBarCenterMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("the shell", () => {
  test("on desktop it is titled Your Cue, and clears the top-bar center", () => {
    // Renamed from "About Assistant" / Intelligence: that named the machinery,
    // not the thing you came to change.
    const { container } = renderLayout();
    expect(container.querySelector("h1")?.textContent).toBe("Your Cue");
    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });

  test("a surface that paints its own canvas gets no shell title over it", () => {
    // Agents and Guardrails supply their own background, max-width and serif
    // heading. Rendering the shell's <h1> above them is the double-wrap that
    // made "Agents opens in its own container" look like a layout bug.
    const { container } = renderLayout("/assistant/hq/agents");
    expect(container.querySelector("h1")?.className).toContain("hidden");
  });
});

describe("the grouped strip", () => {
  test("all six questions render", () => {
    const { getByText } = renderLayout();
    for (const title of [
      "Who Cue is",
      "Who works for you",
      "How Cue reaches you",
      "What Cue knows & sees",
      "What it does alone",
      "Running Cue",
    ]) {
      expect(getByText(title)).toBeTruthy();
    }
  });

  test("the active group is derived from the URL, not selected", () => {
    // Landing on a deep link must open its group already — otherwise every
    // bookmark costs a click it did not cost before.
    const { getByLabelText } = renderLayout("/assistant/guardrails");
    expect(getByLabelText("What it does alone sections")).toBeTruthy();
  });

  test("each group shows only its own leaves", () => {
    const { getByLabelText } = renderLayout("/assistant/identity");
    const strip = getByLabelText("Who Cue is sections");
    expect(strip.textContent).toContain("Identity");
    expect(strip.textContent).toContain("Brand");
    // Skills belongs to a different group and must not leak into this row.
    expect(strip.textContent).not.toContain("Skills");
  });

  test("the four look-alikes are four separate leaves", () => {
    flagsRef.externalPlugins = true;
    flagsRef.marketplace = true;
    const { getByLabelText } = renderLayout("/assistant/skills");
    const strip = getByLabelText("Who works for you sections");
    for (const label of [
      "Agents",
      "Skills",
      "Plugins",
      "Marketplace",
      "Connectors",
    ]) {
      expect(strip.textContent).toContain(label);
    }
  });

  test("flag-gated leaves stay out until their flag is on", () => {
    const { getByLabelText } = renderLayout("/assistant/skills");
    const strip = getByLabelText("Who works for you sections");
    expect(strip.textContent).not.toContain("Plugins");
    expect(strip.textContent).not.toContain("Marketplace");
  });

  test("Watching renders disabled and says why — it never points at a lookalike", () => {
    const { getByText } = renderLayout("/assistant/memory");
    const watching = getByText(/Watching/).closest("[aria-disabled]");
    expect(watching?.getAttribute("aria-disabled")).toBe("true");
    expect(watching?.getAttribute("title")).toContain("Not built");
    // No colour-only state: the row carries a glyph.
    expect(watching?.textContent).toContain("⊘");
  });
});

describe("the Preferences sub-row", () => {
  test("renders on a Preferences page", () => {
    const { getByLabelText } = renderLayout("/assistant/settings/general");
    const row = getByLabelText("Preferences panels");
    expect(row.textContent).toContain("Notifications");
    expect(row.textContent).toContain("Archive");
    // General is the leaf itself, not a sub-row entry — two rows one line
    // apart pointing at the same page is the duplication this round removed.
    expect(row.textContent).not.toContain("General");
  });

  test("does not render on any other leaf", () => {
    const { queryByLabelText } = renderLayout("/assistant/settings/budget");
    expect(queryByLabelText("Preferences panels")).toBeNull();
  });

  test("the developer panels stay hidden until developer mode is unlocked", () => {
    const { getByLabelText } = renderLayout("/assistant/settings/general");
    expect(getByLabelText("Preferences panels").textContent).not.toContain(
      "Developer",
    );

    cleanup();
    flagsRef.settingsDeveloperNav = true;
    const second = renderLayout("/assistant/settings/general");
    expect(second.getByLabelText("Preferences panels").textContent).toContain(
      "Developer",
    );
  });
});

describe("exactly one navigation per screen", () => {
  test("on mobile the strip stands down and the back row takes over", () => {
    isMobileRef.value = true;
    const { container, getByLabelText, getAllByText } = renderLayout(
      "/assistant/cue-live",
    );

    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector("h1")?.className).toContain("hidden");
    expect(getByLabelText("Back to You")).toBeTruthy();
    expect(
      getAllByText("Cue Live").some(
        (el) => el.getAttribute("data-slot") === "typography",
      ),
    ).toBe(true);
    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });

  test("a narrow desktop window keeps the strip (B6)", () => {
    // `useMobileLayout()` is false in a sub-767px Electron window, so the
    // `‹ You` back row stands down. When the strip was hidden independently by
    // `max-md:hidden` — a raw width test — that window got NO navigation at
    // all. Both are driven by the same gate now.
    isMobileRef.value = false;
    const { container, queryByLabelText } = renderLayout("/assistant/cue-live");

    expect(container.querySelector("nav")).toBeTruthy();
    expect(container.querySelector("h1")?.className).not.toContain("hidden");
    expect(queryByLabelText("Back to You")).toBeNull();
  });

  test("on mobile, full-bleed v3 surfaces get no back row of ours either", () => {
    // They mount their own v3 header (frames 53/54); a second one would stack.
    isMobileRef.value = true;
    for (const path of ["/assistant/identity", "/assistant/contacts"]) {
      const { queryByLabelText, unmount } = renderLayout(path);
      expect(queryByLabelText("Back to You")).toBeNull();
      unmount();
    }
  });

  test("on mobile, every settings path defers to the native settings tree", () => {
    // `MobileSettingsLayout` supplies its own header and back row — this shell
    // adding one would stack two navigations on one phone screen.
    isMobileRef.value = true;
    for (const path of [
      "/assistant/settings/general",
      "/assistant/settings/billing",
      "/assistant/settings/budget",
    ]) {
      const { queryByLabelText, unmount } = renderLayout(path);
      expect(queryByLabelText("Back to You")).toBeNull();
      unmount();
    }
  });
});
