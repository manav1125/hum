/**
 * Whether this device has been through the self-host first-run intro.
 *
 * Self-hosted sessions bypass the whole platform onboarding funnel — the
 * route guard's `allowGatewayAuth` step short-circuits before
 * `requireAssistant`/`requireConsent` ever run, because a gateway session
 * already HAS its assistant and cannot participate in platform consent. The
 * side effect nobody intended: a self-host user was never introduced to Cue,
 * never asked for terms or AI-data consent, and never told Cue their name.
 * They landed in a bare chat.
 *
 * This flag is the seam that lets the intro run once without re-entering the
 * platform funnel (whose next stop, `hatching`, would try to provision an
 * assistant that already exists).
 *
 * Deliberately DEVICE-scoped, not user-scoped: a self-hosted instance is
 * single-tenant, and a device-scoped key cannot lock anyone out of an
 * instance if the id it keys on is missing.
 */
const LS_INTRO_DONE = "cue:signon:introDone";

export function isSelfHostIntroComplete(): boolean {
  try {
    return localStorage.getItem(LS_INTRO_DONE) === "1";
  } catch {
    // Storage disabled. Report COMPLETE, never incomplete: a false "not done"
    // would redirect the landing route on every navigation, and a loop at the
    // front door is worse than a missed introduction.
    return true;
  }
}

export function markSelfHostIntroComplete(): void {
  try {
    localStorage.setItem(LS_INTRO_DONE, "1");
  } catch {
    /* storage disabled — the gate already fails open, so nothing to do */
  }
}
