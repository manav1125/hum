/**
 * Declarative step model for the pre-chat onboarding flow.
 *
 * The flow is expressed as an ordered list of steps, each with the funnel
 * event it emits when the user advances past it.
 *
 * ONE WEB FUNNEL. This used to fan out across four simultaneous variants
 * (`control` / `paredDown` A-B arms, plus a mobile-v3 arm that appended two
 * more steps on phone viewports). The pared-down funnel won and is now the
 * only web path: **name → google**, identical on every viewport. The Google
 * step is still capability-gated because connecting Google needs a live
 * platform session; when that is absent the funnel is just `name`.
 *
 * The native iOS (Capacitor) flow stays separate — not as an experiment arm,
 * but because that shell collects consent *after* pre-chat rather than before
 * (see `use-prechat-consent-gate` and the native signup return path in
 * `runtime/native-auth.ts`), so it has a genuinely different route order.
 *
 * Navigation operates on step **ids**, never numeric indices: `nextStep` and
 * `prevStep` resolve to the adjacent *enabled* step. Because back always lands
 * on the previous enabled step by construction, a back button can never reveal
 * a step the forward path gated off.
 */
import {
  ONBOARDING_FUNNEL_STEPS,
  type OnboardingFunnelStep,
} from "@/domains/onboarding/funnel-events";
import type { PlatformSessionStatus } from "@/stores/session-status";

export type PreChatStepId = "name" | "google" | "nativeName" | "nativeVibe";

export interface PreChatStep {
  id: PreChatStepId;
  /**
   * Funnel event emitted when the user advances past this step. `null` for
   * steps outside the web funnel (the native iOS flow is not instrumented).
   */
  funnelStep: OnboardingFunnelStep | null;
}

/**
 * The single capability that decides which web steps are reachable: whether
 * the Google OAuth step can run at all (it talks to the platform with platform
 * auth, so it needs a live platform session — see `isPlatformFunnelAvailable`).
 */
export interface WebStepCapabilities {
  canOfferGoogleStep: boolean;
}

/**
 * Whether the platform-backed onboarding funnel is reachable. The Google
 * connect step talks to the platform with platform auth, so it requires a
 * *live* platform session.
 *
 * The local gateway path marks the session authenticated before its
 * `getSession()` probe settles, so `platformSession` sits at `"unknown"` until
 * the probe lands: that is distinct from `"absent"` ("no session"). While the
 * probe is still in flight, a cached platform assistant is a strong signal a
 * session exists (the lockfile is only populated while authenticated), so the
 * funnel stays available rather than hiding steps a returning user should see.
 *
 * Once the probe has settled, a cached id alone is no longer trusted:
 * `cloud === "vellum"` lockfile entries persist in local storage and outlive
 * the session (logout/expiry doesn't prune them), so trusting one post-probe
 * would surface these steps with no authenticated channel to complete them —
 * e.g. attaching Google OAuth to a stale, possibly-invalid assistant id.
 */
export function isPlatformFunnelAvailable(args: {
  localMode: boolean;
  platformSession: PlatformSessionStatus;
  hasCachedPlatformAssistant: boolean;
}): boolean {
  if (!args.localMode) return true;
  if (args.platformSession === "present") return true;
  return args.platformSession === "unknown" && args.hasCachedPlatformAssistant;
}

/** Resolve the ordered, enabled web steps: name, then Google when offerable. */
export function resolveWebSteps(caps: WebStepCapabilities): PreChatStep[] {
  const candidates: Array<PreChatStep & { enabled: boolean }> = [
    {
      id: "name",
      funnelStep: ONBOARDING_FUNNEL_STEPS.nameVibe,
      enabled: true,
    },
    {
      id: "google",
      funnelStep: ONBOARDING_FUNNEL_STEPS.gmailConnect,
      // There is no tool-selection screen any more, so Google is offered
      // whenever the platform-backed step is reachable at all.
      enabled: caps.canOfferGoogleStep,
    },
  ];
  return candidates
    .filter((step) => step.enabled)
    .map(({ enabled: _enabled, ...step }) => step);
}

/**
 * The native iOS flow: name → vibe, then a route to the privacy screen handled
 * by the caller. Not instrumented into the web funnel.
 */
export function resolveNativeSteps(): PreChatStep[] {
  return [
    { id: "nativeName", funnelStep: null },
    { id: "nativeVibe", funnelStep: null },
  ];
}

/**
 * The value earlier builds persisted for the native vibe step (a raw screen
 * index). The macOS/iOS shell and the platform don't ship together, so a user
 * can update mid-onboarding and still have this written; we keep accepting it
 * so the restore lands them on the vibe step instead of the start.
 */
const LEGACY_NATIVE_VIBE_VALUE = "1";

/**
 * Map a persisted native position back to a step id. `nativeName` is the
 * default mount, so only a persisted `nativeVibe` (or its legacy alias) needs
 * restoring; anything else means "start from the top".
 */
export function restoreNativeStep(saved: string | null): PreChatStepId | null {
  if (saved === "nativeVibe" || saved === LEGACY_NATIVE_VIBE_VALUE) {
    return "nativeVibe";
  }
  return null;
}

/** The next enabled step after `current`, or `null` if `current` is last. */
export function nextStep(
  steps: PreChatStep[],
  current: PreChatStepId,
): PreChatStepId | null {
  const index = steps.findIndex((step) => step.id === current);
  if (index < 0) return null;
  return steps[index + 1]?.id ?? null;
}

/** The previous enabled step before `current`, or `null` if `current` is first. */
export function prevStep(
  steps: PreChatStep[],
  current: PreChatStepId,
): PreChatStepId | null {
  const index = steps.findIndex((step) => step.id === current);
  if (index <= 0) return null;
  return steps[index - 1]?.id ?? null;
}
