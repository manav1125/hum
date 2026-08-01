/**
 * Tests for `PreferencesMenu`.
 *
 * `PreferencesMenu` itself is exercised with `renderToStaticMarkup` (SSR):
 * Radix Popover/BottomSheet content is not rendered when `open={false}`, so
 * only the trigger and top-level structure are visible from there.
 *
 * `PreferencesMenuContent` is a plain component, so where a test needs a real
 * interaction — clicking a row and asserting where it navigates — it mounts
 * the content directly with `@testing-library/react` (happy-dom, see
 * `test-setup.ts`) instead. Item ORDER still can't be asserted through the
 * closed popover; membership and behaviour can.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  useMobileLayout: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// The theme control branches on POINTER, not width — a mouse-driven narrow
// window is not at risk of the mis-tap this guards against. Mocked separately
// from `isMobileRef` so the two can be varied independently.
const coarsePointerRef = { value: false };

mock.module("@/utils/pointer", () => ({
  isPointerCoarse: () => coarsePointerRef.value,
}));

const authRef = {
  isAuthenticated: true,
  user: {
    id: "u1",
    email: "user@example.com",
    isStaff: false,
    username: null,
    firstName: "",
    lastName: "",
  },
  logout: async () => {},
};

mock.module("@/stores/auth-store", () => {
  const store = () => null;
  store.use = {
    user: () => authRef.user,
    logout: () => authRef.logout,
  };
  store.getState = () => authRef;
  return {
    useAuthStore: store,
    useIsAuthenticated: () => authRef.isAuthenticated,
  };
});

const flagsRef = {};

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {};
  store.getState = () => flagsRef;
  return { useClientFeatureFlagStore: store };
});

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {};
  store.getState = () => flagsRef;
  return { useAssistantFeatureFlagStore: store };
});

const billingRef = {
  data: undefined as { effective_balance: string } | undefined,
};

mock.module("@tanstack/react-query", () => ({
  useQuery: () => ({ data: billingRef.data, isLoading: false, isError: false }),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSummaryRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSummaryRetrieve" }],
  }),
  referralCodesMeRetrieveOptions: () => ({
    queryKey: [{ _id: "referralCodesMeRetrieve" }],
  }),
}));

const navigations: string[] = [];

mock.module("react-router", () => ({
  useNavigate: () => (to: string) => {
    navigations.push(to);
  },
}));

// PreferencesMenuContent (rendered directly below) reaches through the
// platform-gate / org-readiness hooks; stub them at the hook boundary so
// the SSR render doesn't need the full store graph.
mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "gated",
  useActiveAssistantIsPlatformHosted: () => false,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

mock.module("@/components/share-feedback-modal", () => ({
  ShareFeedbackModal: () => null,
}));

mock.module("@/components/earn-credits-modal", () => ({
  EarnCreditsModal: () => null,
}));

mock.module("@/components/theme-toggle", () => ({
  ThemeToggle: () =>
    createElement("div", { "data-testid": "theme-toggle" }, "Theme"),
}));

mock.module("@/domains/chat/components/credits-card", () => ({
  CreditsCard: () =>
    createElement("div", { "data-testid": "credits-card" }, "Credits"),
}));

import {
  PreferencesMenu,
  PreferencesMenuContent,
} from "@/domains/chat/components/preferences-menu";

const contentProps = {
  onClose: () => {},
  onShareFeedback: () => {},
  onEarnCredits: () => {},
};

beforeEach(() => {
  isMobileRef.value = false;
  coarsePointerRef.value = false;
  authRef.isAuthenticated = true;
  authRef.user = {
    id: "u1",
    email: "user@example.com",
    isStaff: false,
    username: null,
    firstName: "",
    lastName: "",
  };
  billingRef.data = undefined;
  navigations.length = 0;
});

afterEach(cleanup);

describe("PreferencesMenu", () => {
  test("renders nothing when not logged in", () => {
    authRef.isAuthenticated = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toBe("");
  });

  test("renders a Preferences trigger when logged in", () => {
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("desktop renders trigger (Popover surface)", () => {
    isMobileRef.value = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("mobile renders trigger (BottomSheet surface)", () => {
    isMobileRef.value = true;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });
});

describe("PreferencesMenuContent", () => {
  test("a mouse keeps the inline theme segment", () => {
    coarsePointerRef.value = false;
    const html = renderToStaticMarkup(
      createElement(PreferencesMenuContent, contentProps),
    );
    expect(html).toContain("theme-toggle");
    expect(html).not.toContain("Appearance");
  });

  test("touch replaces the theme segment with an Appearance link row", () => {
    // Regression guard: the embedded System/Light/Dark segment persisted a
    // theme change on a single mis-tap inside the transient sheet. Touch
    // must render a navigation row instead of the segment.
    coarsePointerRef.value = true;
    const html = renderToStaticMarkup(
      createElement(PreferencesMenuContent, contentProps),
    );
    expect(html).toContain("Appearance");
    expect(html).not.toContain("theme-toggle");
  });

  /**
   * Reachability of the act ledger.
   *
   * Guardrails (checkpoints · agent scopes · the ledger) had no entry in any
   * PERSISTENT desktop navigation: not the assistant rail, not the settings
   * sidebar, not the command palette — only contextual cards on surfaces you
   * had to already be on. The ledger is exactly what a user goes looking for
   * when they suspect Cue did something they did not sanction, and at that
   * moment they are not standing on an agent card. This menu is the rail's
   * persistent footer, so the entry has to survive here.
   */
  test("Guardrails — and so the act ledger — is reachable from the menu", () => {
    render(createElement(PreferencesMenuContent, contentProps));
    fireEvent.click(screen.getByText("Guardrails"));
    expect(navigations).toContain("/assistant/guardrails");
  });

  test("exactly ONE Guardrails entry — a second is duplicate nav", () => {
    render(createElement(PreferencesMenuContent, contentProps));
    expect(screen.getAllByText("Guardrails")).toHaveLength(1);
  });

  test("a narrow MOUSE window keeps the segment", () => {
    // The gate used to be `useIsMobile()`, so any sub-767px window — including
    // a 720px Electron pop-out driven by a trackpad — lost the inline theme
    // control for a mis-tap risk it never had. Width must not decide this.
    isMobileRef.value = true;
    coarsePointerRef.value = false;
    const html = renderToStaticMarkup(
      createElement(PreferencesMenuContent, contentProps),
    );
    expect(html).toContain("theme-toggle");
    expect(html).not.toContain("Appearance");
  });
});
