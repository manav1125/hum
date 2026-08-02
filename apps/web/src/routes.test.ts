import { describe, expect, test } from "bun:test";
import { matchRoutes } from "react-router";

import { routeTree } from "@/routes";

// Walk the matched route chain for `path` and report whether `AccountLayout`
// is one of its layout components. Matching runs against the raw `routeTree`
// (not the constructed `router`) because `createBrowserRouter` consumes the
// `Component` field, leaving nothing to inspect.
function isUnderAccountLayout(path: string): boolean {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  return matches.some(
    (m) =>
      (m.route as { Component?: { name?: string } }).Component?.name ===
      "AccountLayout",
  );
}

describe("account route compact-window grouping", () => {
  // The auth screens that render in the main window opt into the compact
  // (440×630) window via AccountLayout's sizing hook.
  test.each([
    "/account",
    "/account/login",
    "/account/signup",
    "/account/provider/callback",
    "/account/provider/signup",
    "/account/password/reset",
    "/account/password/reset/key/abc123",
  ])("%s is sized by AccountLayout", (path) => {
    expect(isUnderAccountLayout(path)).toBe(true);
  });

  // The OAuth completion / loopback pages render inside a popup child window
  // (or are transient redirects). They must stay OUT of AccountLayout — the
  // resize IPC targets the main window, so sizing from a popup would shrink
  // the wrong window and persist `onboardingActive`.
  test.each([
    "/account/oauth/popup-complete",
    "/account/oauth/complete",
    "/account/oauth/desktop-complete",
    "/account/platform-callback",
  ])("%s is NOT sized by AccountLayout", (path) => {
    expect(isUnderAccountLayout(path)).toBe(false);
  });
});

// Leaf-route component/element presence for a matched path. NotFound is the
// only catch-all component, so "resolves to something other than NotFound"
// distinguishes real routes/redirects from dead paths.
function leafIsNotFound(path: string): boolean {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  const leaf = matches[matches.length - 1]?.route as
    { Component?: { name?: string } } | undefined;
  return leaf?.Component?.name === "NotFound";
}

describe("pre-app short paths resolve in the SPA router", () => {
  // The gateway serves the SPA shell for these GET paths (spa-shell-paths.ts);
  // the router must then handle them (redirect components), not 404.
  test.each([
    "/onboarding/welcome",
    "/onboarding/privacy",
    "/welcome",
    "/select-assistant",
    "/review-terms",
  ])("%s matches a redirect, not the catch-all", (path) => {
    expect(leafIsNotFound(path)).toBe(false);
  });
});

describe("chats index route", () => {
  test("/assistant/conversations (no id) resolves to a real route", () => {
    expect(leafIsNotFound("/assistant/conversations")).toBe(false);
  });

  test.each(["/assistant/system-events", "/emails", "/assistant/nope"])(
    "%s falls to the NotFound catch-all",
    (path) => {
      expect(leafIsNotFound(path)).toBe(true);
    },
  );
});

/**
 * Where a `<Navigate>` leaf points, or null if the leaf is not a redirect.
 * Reads the element's props rather than rendering, so this stays a routing
 * assertion instead of a React one.
 */
function redirectTarget(path: string): string | null {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  const leaf = matches[matches.length - 1]?.route as
    { element?: { props?: { to?: unknown } } } | undefined;
  const to = leaf?.element?.props?.to;
  return typeof to === "string" ? to : null;
}

describe("the navigation rework leaves every old URL resolvable", () => {
  // The whole point of the v9→v11 nav changes was subtraction in the CHROME,
  // not in the URL space. A bookmark, a pasted link, a push-notification deep
  // link and an old HQ census link must all still land somewhere real.
  test.each([
    // The three primary destinations.
    "/assistant",
    "/assistant/hq",
    "/assistant/projects",
    // Retired-into-HQ landings.
    "/assistant/home",
    "/assistant/mission-control",
    "/assistant/activity",
    "/assistant/agents",
    "/assistant/next-moves",
    "/assistant/dashboard",
    // The ledger's old standalone home, and the item routes beside it.
    "/assistant/work",
    "/assistant/work/wi-1/live",
    // Surfaces that lost a tab or a rail row but not their URL.
    "/assistant/voice",
    "/assistant/create",
    "/assistant/channels",
    "/assistant/conversations",
    "/assistant/people",
    "/assistant/explore",
    "/assistant/guardrails",
    "/assistant/trust",
    "/assistant/automations",
    "/assistant/hq/agents",
    "/assistant/brand",
    "/assistant/connectors",
    "/assistant/review-queue",
    "/assistant/settings",
    "/assistant/logs",
  ])("%s still resolves", (path) => {
    expect(leafIsNotFound(path)).toBe(false);
  });

  test("/assistant/work redirects into Work → Everything", () => {
    // "All work" stopped being a destination — but deleting the route would
    // have 404'd every bookmark and every cross-surface link still pointing
    // at it. Break this redirect and the ledger becomes unreachable from
    // every one of those links.
    expect(redirectTarget("/assistant/work")).toBe(
      "/assistant/projects?view=everything",
    );
  });

  test("the redirect does not swallow the work-item live route", () => {
    // `work/:workItemId/live` is a sibling of the exact `work` path. If the
    // redirect ever became a prefix match, watching a run would bounce to the
    // ledger instead.
    expect(redirectTarget("/assistant/work/wi-1/live")).toBeNull();
    expect(leafIsNotFound("/assistant/work/wi-1/live")).toBe(false);
  });

  test("Work's own path is a real page, not another redirect", () => {
    // Two views share it via `?view=`; if this ever became a redirect the two
    // views would have become two destinations again.
    expect(redirectTarget("/assistant/projects")).toBeNull();
  });
});
