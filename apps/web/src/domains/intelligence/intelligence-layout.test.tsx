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

// The four Preferences panels that only work under certain conditions read
// these. Defaults mirror the OWNER'S live instance — a self-hosted assistant
// driven from a browser tab — which is the configuration in which he found
// Keyboard, Billing and Self-hosted dead.
const envRef = {
  isElectron: false,
  platformHostedGate: "gated" as "gated" | "disabled" | "full",
  billingGate: "gated" as "gated" | "disabled" | "full",
  isPlatformHosted: false,
  platformNotifications: false,
};

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: (options?: { platformHostedOnly?: boolean }) =>
    options?.platformHostedOnly
      ? envRef.platformHostedGate
      : envRef.billingGate,
  useActiveAssistantIsPlatformHosted: () => envRef.isPlatformHosted,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => envRef.isElectron,
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      platformNotifications: () => envRef.platformNotifications,
    },
  },
}));

/** Everything available — the fully platform-hosted desktop app. */
function everythingAvailable(): void {
  envRef.isElectron = true;
  envRef.platformHostedGate = "full";
  envRef.billingGate = "full";
  envRef.isPlatformHosted = true;
  envRef.platformNotifications = true;
}

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
  envRef.isElectron = false;
  envRef.platformHostedGate = "gated";
  envRef.billingGate = "gated";
  envRef.isPlatformHosted = false;
  envRef.platformNotifications = false;
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

  test("Memory no longer carries a People tab", () => {
    // People is a sidebar destination now. Leaving the tab here would be a
    // second nav path to a second page with the same name — the duplication
    // this codebase has cleaned up twice already.
    const { queryByLabelText } = renderLayout("/assistant/memory");
    expect(queryByLabelText("Memory panels")).toBeNull();
  });
});

/**
 * **The Preferences audit.** One test per row, clicked rather than read.
 *
 * The owner: *"under preferences some things are not working like keyboard and
 * billing & self hosted point no where."* Each of those rows rendered, was
 * clickable, navigated — and landed on a page that immediately `<Navigate>`d
 * back to where it came from. Indistinguishable from a broken link.
 *
 * The gates existed the whole time, in `settings-layout.tsx`, which stopped
 * being rendered on desktop when Settings was absorbed into Your Cue. So the
 * rule now rides on the row itself, and every row is verified by CLICKING it —
 * the same discipline that caught "All conversations".
 */
describe("every Preferences row: click it, and check where you land", () => {
  const PREFERENCES = "/assistant/settings/general";

  /** The panel row's anchors, by label. */
  function panelLink(label: string): HTMLAnchorElement | null {
    const row = document.querySelector('[aria-label="Preferences panels"]');
    return (
      Array.from(row?.querySelectorAll("a") ?? []).find((a) =>
        a.textContent?.includes(label),
      ) ?? null
    );
  }

  /** The disabled `⊘` form of a row, by label. */
  function disabledPanel(label: string): HTMLElement | null {
    const row = document.querySelector('[aria-label="Preferences panels"]');
    return (
      (Array.from(row?.querySelectorAll("[aria-disabled='true']") ?? []).find(
        (n) => n.textContent?.includes(label),
      ) as HTMLElement | undefined) ?? null
    );
  }

  // --- The rows that always work -------------------------------------------

  test.each([
    ["Sounds", "/assistant/settings/sounds"],
    ["Voice", "/assistant/settings/voice"],
    ["Archive", "/assistant/settings/archive"],
  ])("%s is a live link to %s", (label, href) => {
    renderLayout(PREFERENCES);
    const link = panelLink(label);
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(href);
    fireEvent.click(link!);
    expect(panelLink(label)?.getAttribute("aria-current")).toBe("page");
  });

  // --- The four the owner found dead ---------------------------------------

  test.each([
    ["Keyboard", "/assistant/settings/keyboard-shortcuts"],
    ["Self-hosted", "/assistant/settings/devices"],
    ["Billing", "/assistant/settings/billing"],
    ["Notifications", "/assistant/settings/notifications"],
  ])("%s becomes a live link to %s once its condition holds", (label, href) => {
    everythingAvailable();
    renderLayout(PREFERENCES);
    const link = panelLink(label);
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(href);
  });

  test.each(["Keyboard", "Self-hosted", "Billing", "Notifications"])(
    "%s is DISABLED, not a dead link, on the owner's own instance",
    (label) => {
      // Defaults are his: self-hosted assistant, browser tab, no platform.
      renderLayout(PREFERENCES);
      expect(panelLink(label)).toBeNull();
      const disabled = disabledPanel(label);
      expect(disabled).not.toBeNull();
      expect(disabled!.tagName).not.toBe("A");
    },
  );

  test.each(["Keyboard", "Self-hosted", "Billing", "Notifications"])(
    "%s states WHY it is disabled, in text and on hover",
    (label) => {
      renderLayout(PREFERENCES);
      const disabled = disabledPanel(label)!;
      // Not just a tooltip: the reason is in the accessible name too.
      expect(disabled.getAttribute("title")!.length).toBeGreaterThan(20);
      expect(disabled.textContent).toContain(
        disabled.getAttribute("title")!.slice(0, 20),
      );
    },
  );

  test.each(["Keyboard", "Self-hosted", "Billing", "Notifications"])(
    "%s carries a ⊘ glyph — no state here is colour-only",
    (label) => {
      renderLayout(PREFERENCES);
      expect(disabledPanel(label)!.textContent).toContain("⊘");
    },
  );

  test("a disabled row is still VISIBLE — vanishing is its own bug", () => {
    // The owner had already read missing settings as deleted settings once.
    renderLayout(PREFERENCES);
    const row = document.querySelector('[aria-label="Preferences panels"]')!;
    for (const label of [
      "Notifications",
      "Sounds",
      "Voice",
      "Keyboard",
      "Self-hosted",
      "Billing",
      "Archive",
    ]) {
      expect(row.textContent).toContain(label);
    }
  });

  test("each condition is independent — the desktop app alone unlocks Keyboard", () => {
    envRef.isElectron = true;
    renderLayout(PREFERENCES);
    expect(panelLink("Keyboard")).not.toBeNull();
    // ...and leaves the platform-only three exactly where they were.
    expect(panelLink("Billing")).toBeNull();
    expect(panelLink("Self-hosted")).toBeNull();
  });

  test("no row is both a link and disabled", () => {
    everythingAvailable();
    renderLayout(PREFERENCES);
    for (const label of [
      "Keyboard",
      "Billing",
      "Self-hosted",
      "Notifications",
    ]) {
      expect(disabledPanel(label)).toBeNull();
      expect(panelLink(label)).not.toBeNull();
    }
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
