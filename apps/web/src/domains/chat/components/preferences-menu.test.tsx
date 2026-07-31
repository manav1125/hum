/**
 * Tests for `PreferencesMenu`.
 *
 * Uses `renderToStaticMarkup` (SSR) so only the trigger and top-level
 * structure are exercisable — Radix Popover/BottomSheet content is not
 * rendered when `open={false}`. Interactive content tests (menu items,
 * admin visibility, credits row) would require a DOM environment with
 * React Testing Library.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
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

mock.module("react-router", () => ({
  useNavigate: () => () => {},
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
});

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
