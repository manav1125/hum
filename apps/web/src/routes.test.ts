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
    | { Component?: { name?: string } }
    | undefined;
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
