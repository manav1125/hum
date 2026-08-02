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
import { cleanup, fireEvent, render } from "@testing-library/react";
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

describe("the left column", () => {
  test("all six questions render as headings", () => {
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

  test("every leaf of every group is visible at once", () => {
    // This is the whole reason the navigation moved left. The two stacked
    // rows showed the leaves of the ONE group you were inside, so fourteen of
    // eighteen surfaces were invisible from any given page — which is how
    // People, All conversations, Your Cue and Preferences all came to read as
    // "removed".
    const column = renderLayout("/assistant/identity").getByLabelText(
      "Your Cue",
    );
    for (const label of [
      "Identity",
      "Brand",
      "Agents",
      "Skills",
      "Connectors",
      "Channels",
      "Agent network",
      "Cue Live",
      "Memory",
      "Watching",
      "Schedules",
      "Automations",
      "Guardrails",
      "System access",
      "Models",
      "Usage & spend",
      "Workspace",
      "Preferences",
    ]) {
      expect(column.textContent).toContain(label);
    }
  });

  test("the active leaf is marked, and not by colour alone", () => {
    // Landing on a deep link must show you where you are without a click.
    const { getByRole } = renderLayout("/assistant/guardrails");
    const active = getByRole("link", { current: "page" });
    expect(active.textContent).toContain("Guardrails");
    expect(active.textContent).toContain("▸");
  });

  test("a leaf navigates when clicked", () => {
    const { getByText, container } = renderLayout("/assistant/identity");
    fireEvent.click(getByText("Workspace"));
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain("Workspace");
  });

  test("the four look-alikes are four separate leaves", () => {
    flagsRef.externalPlugins = true;
    flagsRef.marketplace = true;
    const column = renderLayout("/assistant/skills").getByLabelText("Your Cue");
    for (const label of [
      "Agents",
      "Skills",
      "Plugins",
      "Marketplace",
      "Connectors",
    ]) {
      expect(column.textContent).toContain(label);
    }
  });

  test("flag-gated leaves stay out until their flag is on", () => {
    const column = renderLayout("/assistant/skills").getByLabelText("Your Cue");
    expect(column.textContent).not.toContain("Plugins");
    expect(column.textContent).not.toContain("Marketplace");
  });

  test("a group heading is a heading, not a second way to reach its first leaf", () => {
    // It used to be a button that navigated. A row one line below already goes
    // there, and "no second nav path to the same destination" is the rule this
    // round is enforcing.
    const { getByText } = renderLayout("/assistant/identity");
    expect(getByText("Running Cue").closest("button")).toBeNull();
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

describe("sub-rows", () => {
  test("Preferences' panels render beneath it on a Preferences page", () => {
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

  test("Memory carries People — design's interim home for the relationship surface", () => {
    // The sidebar gate says People has not earned a rail row yet. Design's
    // sequencing says ship it HERE meanwhile; only the gate half shipped, so
    // People existed nowhere.
    const { getByLabelText } = renderLayout("/assistant/memory");
    expect(getByLabelText("Memory panels").textContent).toContain("People");
  });

  test("Memory's People tab keeps the Memory leaf lit", () => {
    // A tab under a leaf, not a nineteenth leaf: the column must not lose its
    // place when you switch to it. The leaf stays marked; only the deepest
    // match claims `aria-current="page"`.
    const { container, getByRole } = renderLayout("/assistant/memory/people");
    expect(
      container.querySelector('[data-active="true"]')?.textContent,
    ).toContain("Memory");
    expect(getByRole("link", { current: "page" }).textContent).toContain(
      "People",
    );
  });

  test("a Memory tab navigates when clicked", () => {
    const { getByText, getByLabelText } = renderLayout("/assistant/memory");
    fireEvent.click(getByLabelText("Memory panels").querySelector("a")!);
    expect(getByText("People").getAttribute("class")).toBeTruthy();
    expect(
      getByLabelText("Memory panels").querySelector('[aria-current="page"]')
        ?.textContent,
    ).toContain("People");
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
