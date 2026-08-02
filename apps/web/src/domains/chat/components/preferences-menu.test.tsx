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
const platformGateRef = { value: "gated" as "gated" | "disabled" | "full" };

mock.module("@/hooks/use-platform-gate", () => ({
  // `platformHostedOnly` callers (billing rows) stay gated regardless; the
  // plain gate is what decides whether a Profile surface exists.
  usePlatformGate: (options?: { platformHostedOnly?: boolean }) =>
    options?.platformHostedOnly ? "gated" : platformGateRef.value,
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
  platformGateRef.value = "gated";
  navigations.length = 0;
});

afterEach(cleanup);

describe("PreferencesMenu", () => {
  test("renders nothing when not logged in", () => {
    authRef.isAuthenticated = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toBe("");
  });

  test("the trigger is the owner, not the machinery", () => {
    // Design's footer is `👤 Manav · Autonomous · $4.10` — the person's NAME,
    // acting as the door to Trust / Preferences / Billing. It shipped labelled
    // "Preferences", and the owner read the settings pages as removed.
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    // The mocked user has no first name and no username, so the honest
    // fallback is the local part of the email — never an invented name.
    expect(html).toContain("user");
    expect(html).not.toContain(">Preferences<");
  });

  test("the trigger carries an accessible name for the collapsed rail", () => {
    // Collapsed, SideMenu.Item suppresses the label and the icon is
    // aria-hidden — the row had no accessible name at all.
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain('aria-label="user — your account and Your Cue"');
  });

  test("desktop renders trigger (Popover surface)", () => {
    isMobileRef.value = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("popover-trigger");
  });

  test("mobile renders trigger (BottomSheet surface)", () => {
    isMobileRef.value = true;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("bottom-sheet-trigger");
  });

  test("a real first name wins over the email fallback", () => {
    authRef.user = { ...authRef.user, firstName: "Manav" };
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Manav");
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
   * Reachability of the act ledger — now via Your Cue.
   *
   * Guardrails (checkpoints · agent scopes · the ledger) once had no entry in
   * any PERSISTENT desktop navigation, which is why this menu carried a row
   * for it: the ledger is exactly what a user goes looking for when they
   * suspect Cue did something they did not sanction, and at that moment they
   * are not standing on an agent card.
   *
   * It is now a permanent leaf — Your Cue → What it does alone → Guardrails —
   * so the row here would be a second nav path to it, which is the thing this
   * round removed everywhere else. Same for Usage. The menu keeps ONE door,
   * and it is the same door the rail's ⚙ row opens.
   */
  test("Your Cue is the menu's door to configuration", () => {
    render(createElement(PreferencesMenuContent, contentProps));
    fireEvent.click(screen.getByText("Your Cue"));
    expect(navigations).toContain("/assistant/your-cue");
  });

  test("exactly ONE door to the shell itself", () => {
    render(createElement(PreferencesMenuContent, contentProps));
    expect(screen.getAllByText("Your Cue")).toHaveLength(1);
    // "Settings" is gone as a word — it is not a place any more.
    expect(screen.queryByText("Settings")).toBeNull();
  });

  /**
   * Trust · Preferences · Billing were three rows here, on design's ruling
   * that the account line is the door to all three. The owner has since
   * consolidated: *"the rest is my cue since we've consolidated everything
   * under there now."* All three are leaves under Your Cue, so nothing became
   * unreachable — they are one click further from a row you open by clicking
   * your own name.
   */
  test("Trust · Preferences · Billing collapsed into Your Cue", () => {
    render(createElement(PreferencesMenuContent, contentProps));
    expect(screen.queryByText("Trust")).toBeNull();
    expect(screen.queryByText("Preferences")).toBeNull();
    expect(screen.queryByText("Billing")).toBeNull();
    expect(screen.getByText("Your Cue")).toBeDefined();
  });

  /**
   * The Profile row, and the honest answer behind it.
   *
   * The owner asked the footer to "go right into my profile (do we have
   * that?)". There is no profile PAGE. The nearest real thing is a `Profile`
   * card on Preferences → General, which edits the user handle against
   * `/v1/user/me/` — and which only renders when there is a live platform
   * session. So the row deep-links to it when it exists, and admits it does
   * not when it does not, rather than navigating somewhere that has no
   * profile on it.
   */
  test("CLICK-THROUGH: with a platform session, Profile lands on the card", () => {
    platformGateRef.value = "full";
    render(createElement(PreferencesMenuContent, contentProps));
    fireEvent.click(screen.getByText("Profile"));
    expect(navigations).toContain("/assistant/settings/general#profile");
  });

  test("without one, Profile is DISABLED and says why — it does not navigate", () => {
    // `usePlatformGate` is mocked "gated" by default: this is the owner's own
    // self-hosted instance, where the Profile card never renders at all.
    platformGateRef.value = "gated";
    render(createElement(PreferencesMenuContent, contentProps));
    const row = screen.getByText("Profile").closest("[aria-disabled]");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByText("Profile"));
    expect(navigations).toHaveLength(0);
  });

  test("the disabled Profile row carries a glyph, not just a tint", () => {
    // No state in this app is distinguished by colour alone.
    platformGateRef.value = "gated";
    render(createElement(PreferencesMenuContent, contentProps));
    const row = screen.getByText("Profile").closest("[aria-disabled]");
    expect(row?.textContent).toContain("⊘");
  });

  test("the reason is reachable by a screen reader, not only on hover", () => {
    platformGateRef.value = "gated";
    render(createElement(PreferencesMenuContent, contentProps));
    const row = screen.getByText("Profile").closest("[aria-disabled]");
    expect(row?.textContent).toContain("Cue has no profile page");
    expect(row?.getAttribute("title")).toContain("Cue has no profile page");
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
