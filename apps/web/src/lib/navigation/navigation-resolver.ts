import type { PlatformSessionStatus } from "@/stores/session-status";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// State — every variable that can influence a routing decision
// ---------------------------------------------------------------------------

export interface NavigationState {
  isLocalMode: boolean;
  isGatewayAuth: boolean;
  hasAssistants: boolean;
  sessionSettled: boolean;
  isAuthenticated: boolean;
  platformSession: PlatformSessionStatus;
  tosAccepted: boolean;
  aiDataConsent: boolean;
  /**
   * Whether this device has been through the self-host first-run intro.
   * Gateway (self-host) sessions bypass the whole platform funnel below, so
   * without this they were never introduced to Cue, never asked for consent
   * and never asked their name — they landed in a bare chat. Defaults to
   * `true` so any state built without it behaves exactly as before.
   */
  selfHostIntroComplete: boolean;
}

// ---------------------------------------------------------------------------
// Query — what the caller wants to know
// ---------------------------------------------------------------------------

export type NavigationQuery =
  | { kind: "route-guard"; pathname: string }
  | { kind: "onboarding-intercept"; intendedDestination: string }
  | { kind: "hatch-gate" }
  | {
      kind: "post-auth";
      authIntent: "login" | "signup";
      returnTo: string | null;
      fallback: string;
    }
  | { kind: "post-retire" };

// ---------------------------------------------------------------------------
// Decision — what the caller should do
// ---------------------------------------------------------------------------

export type NavigationDecision =
  { action: "allow" } | { action: "redirect"; to: string } | { action: "wait" };

// ---------------------------------------------------------------------------
// Shared predicates & helpers
// ---------------------------------------------------------------------------

function hasCompletedOnboarding(state: NavigationState): boolean {
  return state.tosAccepted && state.aiDataConsent;
}

const ONBOARDING_PREFIX = `${routes.assistant}/onboarding`;

const LOCAL_ONLY_ONBOARDING_PATHS: Set<string> = new Set([
  routes.onboarding.hosting,
  routes.onboarding.apiKey,
]);

const LOCAL_ONLY_STANDALONE_PATHS: Set<string> = new Set([
  routes.welcome,
  routes.selectAssistant,
]);

function isOnboardingPath(pathname: string): boolean {
  return (
    pathname.startsWith(`${ONBOARDING_PREFIX}/`) ||
    pathname === ONBOARDING_PREFIX
  );
}

function onboardingEntrypoint(isLocalMode: boolean): string {
  return isLocalMode ? routes.welcome : routes.onboarding.privacy;
}

function extractPathname(destination: string): string {
  if (
    destination.startsWith("http://") ||
    destination.startsWith("https://") ||
    destination.startsWith("//")
  ) {
    try {
      return new URL(destination, "http://placeholder.invalid").pathname;
    } catch {
      return destination;
    }
  }
  return destination;
}

// ---------------------------------------------------------------------------
// Login return-to
// ---------------------------------------------------------------------------

export function resolveLoginReturnTo(
  state: NavigationState,
  fromPath: string,
): string {
  if (fromPath === routes.welcome) {
    return state.hasAssistants
      ? routes.selectAssistant
      : routes.onboarding.hosting;
  }
  if (fromPath === routes.selectAssistant) {
    return `${fromPath}?fromLogin=1`;
  }
  return fromPath;
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

export function resolveNavigation(
  state: NavigationState,
  query: NavigationQuery,
): NavigationDecision {
  switch (query.kind) {
    case "route-guard":
      return resolveRouteGuard(state, query.pathname);
    case "onboarding-intercept":
      return resolveOnboardingIntercept(state, query.intendedDestination);
    case "hatch-gate":
      return resolveHatchGate(state);
    case "post-auth":
      return resolvePostAuth(query.authIntent, query.returnTo, query.fallback);
    case "post-retire":
      return resolvePostRetire(state);
  }
}

// ---------------------------------------------------------------------------
// Route guard — pipeline of steps
// ---------------------------------------------------------------------------
//
// Each step returns a NavigationDecision to short-circuit, or null to
// pass through to the next step. The pipeline terminates with "allow".
//
// Conceptual layers:
//   1. Readiness          — is the session ready?
//   2. Bypass             — gateway auth skips everything
//   3. Identity           — is the user authenticated?
//   4. Mode boundary      — is this path valid for the user's mode?
//   5. Setup exemptions   — onboarding/consent paths are always reachable
//   6. Assistant required  — user needs at least one assistant
//   7. Consent required   — platform users must accept TOS

type RouteGuardStep = (
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
) => NavigationDecision | null;

const ROUTE_GUARD_PIPELINE: RouteGuardStep[] = [
  waitForSession,
  requireSelfHostIntro,
  allowGatewayAuth,
  requireAuth,
  enforceModeBoundary,
  allowSetupRoutes,
  requireAssistant,
  requireConsent,
];

function resolveRouteGuard(
  state: NavigationState,
  pathnameWithSearch: string,
): NavigationDecision {
  const qIdx = pathnameWithSearch.indexOf("?");
  const path =
    qIdx >= 0 ? pathnameWithSearch.slice(0, qIdx) : pathnameWithSearch;

  for (const step of ROUTE_GUARD_PIPELINE) {
    const decision = step(state, path, pathnameWithSearch);
    if (decision) return decision;
  }
  return { action: "allow" };
}

function waitForSession(state: NavigationState): NavigationDecision | null {
  return state.sessionSettled ? null : { action: "wait" };
}

/**
 * The landing paths a freshly signed-in self-host user actually arrives on.
 *
 * The gate is scoped to exactly these — NOT to "every path" — on purpose. A
 * broad gate in front of every route is the kind of thing that, if its
 * completion flag ever fails to write, locks a user out of their own instance
 * entirely. Scoped this way the worst possible failure is that someone sees
 * the intro twice, or never; either beats a locked door on launch day.
 */
const SELF_HOST_INTRO_ENTRY_PATHS = new Set<string>([
  routes.assistant,
  routes.home,
  routes.hq,
]);

/**
 * Send a first-run gateway session through the self-host intro before it
 * lands. Gateway sessions skip the platform funnel entirely (see
 * `allowGatewayAuth`, the very next step), which silently meant a self-host
 * user was never introduced, never asked for terms or AI-data consent, and
 * never asked what to call them.
 *
 * Runs BEFORE `allowGatewayAuth` because that step's whole job is to
 * short-circuit — anything that must apply to gateway sessions has to be
 * ahead of it.
 */
function requireSelfHostIntro(
  state: NavigationState,
  path: string,
): NavigationDecision | null {
  if (!state.isGatewayAuth) return null;
  if (state.selfHostIntroComplete) return null;
  if (path === routes.onboarding.hello) return null;
  if (!SELF_HOST_INTRO_ENTRY_PATHS.has(path)) return null;
  return { action: "redirect", to: routes.onboarding.hello };
}

function allowGatewayAuth(state: NavigationState): NavigationDecision | null {
  return state.isGatewayAuth ? { action: "allow" } : null;
}

function requireAuth(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.isAuthenticated) return null;

  if (
    state.isLocalMode &&
    (isOnboardingPath(path) || LOCAL_ONLY_STANDALONE_PATHS.has(path))
  ) {
    if (path === routes.selectAssistant && !state.hasAssistants) {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "allow" };
  }
  if (state.isLocalMode && !state.hasAssistants) {
    return { action: "redirect", to: routes.welcome };
  }
  if (state.isLocalMode) {
    return { action: "redirect", to: routes.selectAssistant };
  }
  return {
    action: "redirect",
    to: `${routes.account.login}?returnTo=${encodeURIComponent(pathnameWithSearch)}`,
  };
}

function enforceModeBoundary(
  state: NavigationState,
  path: string,
): NavigationDecision | null {
  if (LOCAL_ONLY_STANDALONE_PATHS.has(path)) {
    if (!state.isLocalMode) {
      return { action: "redirect", to: routes.assistant };
    }
    if (path === routes.selectAssistant && !state.hasAssistants) {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "allow" };
  }

  if (LOCAL_ONLY_ONBOARDING_PATHS.has(path) && !state.isLocalMode) {
    return { action: "redirect", to: routes.assistant };
  }

  return null;
}

function allowSetupRoutes(
  state: NavigationState,
  path: string,
): NavigationDecision | null {
  if (path === routes.reviewTerms) return { action: "allow" };

  if (isOnboardingPath(path)) {
    if (path === routes.onboarding.hatching && !hasCompletedOnboarding(state)) {
      return {
        action: "redirect",
        to: onboardingEntrypoint(state.isLocalMode),
      };
    }
    return { action: "allow" };
  }

  return null;
}

function requireAssistant(state: NavigationState): NavigationDecision | null {
  if (state.hasAssistants) return null;

  if (state.isLocalMode) {
    if (state.platformSession === "unknown") return { action: "wait" };
    if (state.platformSession === "present") {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "redirect", to: routes.welcome };
  }

  if (!hasCompletedOnboarding(state)) {
    return { action: "redirect", to: routes.onboarding.privacy };
  }
  return { action: "redirect", to: routes.onboarding.hatching };
}

function requireConsent(
  state: NavigationState,
  _path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.isLocalMode || hasCompletedOnboarding(state)) return null;

  const returnTo = encodeURIComponent(pathnameWithSearch);
  return {
    action: "redirect",
    to: `${routes.reviewTerms}?returnTo=${returnTo}`,
  };
}

// ---------------------------------------------------------------------------
// onboarding-intercept
// ---------------------------------------------------------------------------

function resolveOnboardingIntercept(
  state: NavigationState,
  intendedDestination: string,
): NavigationDecision {
  // Gateway-auth (self-host) sessions are already authenticated to a gateway
  // and resolve the single `self` assistant — never route them into local
  // onboarding. Mirrors `allowGatewayAuth` in the route-guard pipeline (which
  // the onboarding-intercept path does not run through).
  if (state.isGatewayAuth) return { action: "allow" };
  if (state.isLocalMode && state.hasAssistants) return { action: "allow" };
  if (hasCompletedOnboarding(state)) return { action: "allow" };

  const path = extractPathname(intendedDestination);
  if (!path.startsWith(routes.assistant)) return { action: "allow" };
  if (path.startsWith(`${routes.assistant}/onboarding`))
    return { action: "allow" };
  if (path === routes.reviewTerms) return { action: "allow" };

  return {
    action: "redirect",
    to: onboardingEntrypoint(state.isLocalMode),
  };
}

// ---------------------------------------------------------------------------
// hatch-gate
// ---------------------------------------------------------------------------

function resolveHatchGate(state: NavigationState): NavigationDecision {
  if (!state.sessionSettled) return { action: "wait" };
  if (!state.isAuthenticated && !state.isLocalMode) {
    return { action: "redirect", to: routes.account.login };
  }
  if (!hasCompletedOnboarding(state)) {
    return { action: "redirect", to: onboardingEntrypoint(state.isLocalMode) };
  }
  return { action: "allow" };
}

// ---------------------------------------------------------------------------
// post-auth
// ---------------------------------------------------------------------------

function resolvePostAuth(
  authIntent: "login" | "signup",
  returnTo: string | null,
  fallback: string,
): NavigationDecision {
  if (authIntent === "signup") {
    return { action: "redirect", to: routes.onboarding.privacy };
  }
  return { action: "redirect", to: sanitizeReturnTo(returnTo, fallback) };
}

// ---------------------------------------------------------------------------
// post-retire
// ---------------------------------------------------------------------------

function resolvePostRetire(state: NavigationState): NavigationDecision {
  if (state.hasAssistants) {
    // select-assistant is local-only; platform users go straight to /assistant
    return {
      action: "redirect",
      to: state.isLocalMode ? routes.selectAssistant : routes.assistant,
    };
  }
  if (!state.isLocalMode) {
    return { action: "redirect", to: routes.onboarding.privacy };
  }
  if (state.platformSession === "present") {
    return { action: "redirect", to: routes.onboarding.hosting };
  }
  return { action: "redirect", to: routes.welcome };
}
