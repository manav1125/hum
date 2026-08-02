import { describe, expect, test } from "bun:test";
import { matchRoutes } from "react-router";

import { routeTree } from "@/routes";
import { SIDEBAR_DESTINATIONS } from "@/components/nav/nav-model";

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

  test("it is the conversations INDEX, not the mobile screen that redirects", () => {
    // The regression this guards: the route mounted `ChatsIndexPage`, whose
    // very first desktop statement is `<Navigate to="/assistant" replace />`.
    // The rail's "All conversations ›" row then pointed at a URL that bounced
    // straight back to where you came from — so the row rendered, was
    // clickable, called `navigate()`, and did nothing. A component name is the
    // only thing a route table can assert here; the click itself is covered by
    // `assistant-side-menu.click-through.test.tsx`.
    const matches = matchRoutes(routeTree as never, "/assistant/conversations");
    const leaf = matches?.[matches.length - 1]?.route as
      { lazy?: { Component?: () => Promise<unknown> } } | undefined;
    expect(typeof leaf?.lazy?.Component).toBe("function");
    // …and it is not a `<Navigate>` leaf.
    expect(redirectTarget("/assistant/conversations")).toBeNull();
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
    // v15 displaced these out of the rail into the CUE group, the avatar
    // menu, ⌘K or the Intelligence tab strip. Every one keeps its URL —
    // subtraction in the chrome, never in the URL space.
    "/assistant/skills",
    "/assistant/memory",
    "/assistant/library",
    "/assistant/identity",
    "/assistant/workspace",
    "/assistant/cue-live",
    "/assistant/contacts",
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

describe("Your Cue absorbed Settings without 404ing a bookmark", () => {
  // Settings moved from its own SidebarShell into the Your Cue shell. That is
  // a re-parenting, not a move: every URL below has been linked from cards,
  // coach tours and the mobile You cluster for months, and each one must land
  // exactly where it did.
  test.each([
    "/assistant/settings",
    "/assistant/settings/general",
    "/assistant/settings/ai",
    "/assistant/settings/integrations",
    "/assistant/settings/brand",
    "/assistant/settings/schedules",
    "/assistant/settings/schedules/sch-1",
    "/assistant/settings/notifications",
    "/assistant/settings/keyboard-shortcuts",
    "/assistant/settings/sounds",
    "/assistant/settings/voice",
    "/assistant/settings/devices",
    "/assistant/settings/privacy",
    "/assistant/settings/budget",
    "/assistant/settings/archive",
    "/assistant/settings/billing",
    "/assistant/settings/billing/upgrade/cancel",
    "/assistant/settings/billing/upgrade/success",
    "/assistant/settings/debug",
    "/assistant/settings/developer",
    "/assistant/settings/advanced",
    "/assistant/settings/danger-zone",
    "/assistant/settings/system-events",
  ])("%s still resolves", (path) => {
    expect(leafIsNotFound(path)).toBe(false);
  });

  test("the settings index redirects to General rather than rendering it twice", () => {
    expect(redirectTarget("/assistant/settings")).toBe(
      "/assistant/settings/general",
    );
  });

  test("the new doors resolve", () => {
    expect(leafIsNotFound("/assistant/your-cue")).toBe(false);
    expect(leafIsNotFound("/assistant/agent-network")).toBe(false);
  });

  test("the Your Cue door lands on Identity, not a landing screen", () => {
    expect(redirectTarget("/assistant/your-cue")).toBe("/assistant/identity");
  });
});

describe("the six contextual entry points survive the move", () => {
  // Design: "Six leaves must stay reachable contextually as well — Agents from
  // an agent chip, Guardrails from a tier chip, Schedules from HQ's ↻ line,
  // Watching from the pulse line, People from a name, Usage from the spend
  // chip." Re-parenting a route inside a layout must not change its URL, or
  // every one of those links breaks silently.
  test.each([
    // The agent chip and the coach tour both point here.
    "/assistant/hq/agents",
    // The HQ tier chip's "Trust ›".
    "/assistant/guardrails",
    // HQ's ⟳ Rhythms lane.
    "/assistant/settings/schedules",
    // HQ's ○ Pulse lane.
    "/assistant/automations",
    // Any name.
    "/assistant/people",
    // The spend tile.
    "/assistant/logs/usage",
  ])("%s is unchanged and resolves", (path) => {
    expect(leafIsNotFound(path)).toBe(false);
  });

  test("Agents kept its URL under /hq/ — it was re-parented, not moved", () => {
    // Moving it would have broken the agent chip, the mobile You row and the
    // coach tour's surface match in one go.
    expect(leafIsNotFound("/assistant/hq/agents")).toBe(false);
    // And it must still not be swallowed by `hq/:id`.
    const matches =
      matchRoutes(routeTree as never, "/assistant/hq/agents") ?? [];
    const leaf = matches[matches.length - 1]?.route as
      { path?: string } | undefined;
    expect(leaf?.path).toBe("hq/agents");
  });
});

describe("the four duplications each resolve to one page", () => {
  test("spend: /assistant/logs/usage no longer renders a second usage page", () => {
    // It renders `UsageRedirect`, which sends desktop to Usage & spend with
    // the query string intact (mobile keeps the v3 screen — see the component).
    const matches =
      matchRoutes(routeTree as never, "/assistant/logs/usage") ?? [];
    const leaf = matches[matches.length - 1]?.route as
      { Component?: { name?: string } } | undefined;
    expect(leaf?.Component?.name).toBe("UsageRedirect");
  });

  test("the logs index no longer defaults to the usage page", () => {
    expect(redirectTarget("/assistant/logs")).toBe("/assistant/logs/trace");
  });

  test("trust: the old console URL still lands on Guardrails", () => {
    expect(redirectTarget("/assistant/trust")).toBe("/assistant/guardrails");
  });

  test("people: the retired Memory tab redirects to the one People page", () => {
    // People was promoted to the sidebar, so its interim tab under Memory was
    // a second nav path to a second page with the same name. The tab and its
    // page are gone; the URL still resolves, which is what stops a bookmark
    // 404ing. Fifth duplication, same rule.
    expect(redirectTarget("/assistant/memory/people")).toBe(
      "/assistant/people",
    );
  });

  test("people: the sidebar and the redirect agree on the destination", () => {
    // The brief's requirement in one assertion: "the sidebar row and any
    // existing link must land on the same page."
    const row = SIDEBAR_DESTINATIONS.find((d) => d.key === "people");
    expect(row).toBeDefined();
    expect(redirectTarget("/assistant/memory/people")).toBe(row!.to);
  });
});

/**
 * True when `path`'s matched chain includes the Your Cue shell layout.
 *
 * The shell is code-split (`lazy: { Component }`), so unlike `AccountLayout`
 * there is no `Component.name` to read on the raw tree — the loader function's
 * own source is the only handle on which module it will import. Matching on
 * that is why this reads a `.toString()` rather than a component reference.
 */
function isUnderYourCueShell(path: string): boolean {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  return matches.some((m) => {
    const route = m.route as { lazy?: { Component?: () => unknown } };
    const loader = route.lazy?.Component;
    return (
      typeof loader === "function" &&
      loader.toString().includes("intelligence-layout")
    );
  });
}

describe("every leaf renders in the same shell", () => {
  // Design: "Every surface inside Your Cue renders in the same shell with the
  // same sidebar. Skills and Library are already correct; Agents is the
  // outlier." Agents opened in its own container because it was mounted as a
  // bare sibling of `hq`, and Guardrails had the same problem. Both are
  // children of the shell now — which is the actual fix, rather than restyling
  // the pages.
  test.each([
    "/assistant/identity",
    "/assistant/settings/brand",
    // The two that were outliers.
    "/assistant/hq/agents",
    "/assistant/guardrails",
    "/assistant/skills",
    "/assistant/plugins",
    "/assistant/marketplace",
    "/assistant/connectors",
    "/assistant/connectors/slack",
    "/assistant/channels",
    "/assistant/agent-network",
    "/assistant/cue-live",
    "/assistant/memory",
    // The retired People tab. Still mounted (as a redirect) so a bookmark
    // resolves rather than 404ing.
    "/assistant/memory/people",
    "/assistant/settings/schedules",
    "/assistant/automations",
    "/assistant/settings/privacy",
    "/assistant/settings/ai",
    "/assistant/settings/budget",
    "/assistant/workspace",
    "/assistant/settings/general",
    // Preferences panels ride the same shell.
    "/assistant/settings/notifications",
    "/assistant/settings/archive",
    "/assistant/settings/billing",
  ])("%s renders inside the Your Cue shell", (path) => {
    expect(isUnderYourCueShell(path)).toBe(true);
  });

  test("the app's own destinations are NOT inside the config shell", () => {
    // Your Cue is a door you go through, not a frame around the product.
    for (const path of [
      "/assistant/hq",
      "/assistant/projects",
      "/assistant/people",
      "/assistant/library",
    ]) {
      expect(isUnderYourCueShell(path)).toBe(false);
    }
  });
});
