/**
 * M8 — the three things Cue may do for you.
 *
 * Design overruled the single wall of clauses (v22 · R5):
 *
 *   "Consent becomes three cards, not one wall: read-and-organise (on),
 *    draft-and-prepare (on), SEND-AND-SPEND (OFF) — with the real norm stated,
 *    'most people leave this off for the first week.'"
 *
 * WHY THIS FILE IS SAFETY CODE AND NOT LAYOUT
 * ------------------------------------------
 * This instance has already had a background run email a partner with nobody's
 * approval. The post-mortem closed four bypass ranks; the fifth rank is the
 * default itself. A default-on send capability means the *first* consequential
 * action a brand-new user's Cue takes can be irreversible before that user has
 * seen Cue do anything at all. `send_spend: false` is therefore a constant, not
 * a preference with a convenient initial value — `DEFAULT_CONSENT_SCOPES` is
 * frozen, and `consentScopesFromCards` cannot return it true unless a human
 * moved that specific switch.
 *
 * WHERE IT LANDS
 * --------------
 * Two writes, both to paths that already existed:
 *
 *   1. **Per-user device keys**, the same versioned shape `onboarding-cleanup`
 *      uses for tos/ai, so a later build that reads consent reads these the
 *      same way and nobody is re-prompted. The legal consent itself still goes
 *      through `persistConsentForUser` — this is a sibling, not a replacement.
 *
 *   2. **The autonomy policies the daemon actually enforces**
 *      (`lib/autonomy-policies-api.ts`). This is the load-bearing half: the
 *      device keys describe intent, but only the policy map stops a tool call.
 *      The gateway's own defaults are `send: "auto"` and `money: "ask"`, so a
 *      consent screen that wrote nothing would leave send on — which is exactly
 *      the failure this card exists to prevent. Off therefore writes
 *      `send: "ask"` and `money: "ask"` EXPLICITLY rather than trusting a
 *      default it does not own.
 *
 * If no assistant is reachable when the user answers (the arc runs before the
 * daemon is guaranteed up), the map is parked and applied on the next
 * activation — the same pending-value pattern `mv3-onboarding-prefs` uses for
 * the workspace mode. Parked, never dropped: a consent answer that evaporates
 * because a fetch failed is the fail-open bug in its most expensive form.
 */
import {
  setAutonomyPolicies,
  type AutonomyPolicies,
} from "@/lib/autonomy-policies-api";
import {
  getLocalBool,
  getLocalSetting,
  removeLocalSetting,
  setLocalBool,
  setLocalSetting,
} from "@/utils/local-settings";

/** Bump to re-ask everyone. Independent of `CONSENT_VERSION` — these are
 *  capabilities, not terms, and they move for different reasons. */
export const CONSENT_SCOPES_VERSION = "2026-08-03";

export type ConsentScopeId = "read_organise" | "draft_prepare" | "send_spend";

export const CONSENT_SCOPE_IDS: readonly ConsentScopeId[] = [
  "read_organise",
  "draft_prepare",
  "send_spend",
] as const;

export type ConsentScopes = Record<ConsentScopeId, boolean>;

/**
 * The shipped defaults. Frozen so that "make it default-on for the demo" has
 * to be a diff to this line and not a mutation somewhere downstream.
 */
export const DEFAULT_CONSENT_SCOPES: Readonly<ConsentScopes> = Object.freeze({
  read_organise: true,
  draft_prepare: true,
  send_spend: false,
});

function scopeKey(scope: ConsentScopeId, userId: string): string {
  return `device:consent:scope:${scope}:v${CONSENT_SCOPES_VERSION}:${userId}`;
}

const PENDING_POLICIES_KEY = "cue:consent:pendingAutonomyPolicies";

/**
 * Read this user's answers back. Falls back to the shipped defaults for any
 * scope never written — and the default for `send_spend` is false, so a
 * half-written or storage-denied device errs closed.
 */
export function readConsentScopes(userId: string | null): ConsentScopes {
  const out: ConsentScopes = { ...DEFAULT_CONSENT_SCOPES };
  if (typeof window === "undefined" || !userId) return out;
  try {
    for (const scope of CONSENT_SCOPE_IDS) {
      out[scope] = getLocalBool(scopeKey(scope, userId), out[scope]);
    }
  } catch {
    /* storage unavailable — the defaults above are the safe answer */
  }
  return out;
}

/** Write this user's answers to the per-user device keys. */
export function persistConsentScopes(
  userId: string | null,
  scopes: ConsentScopes,
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    for (const scope of CONSENT_SCOPE_IDS) {
      setLocalBool(scopeKey(scope, userId), scopes[scope]);
    }
  } catch {
    /* storage unavailable */
  }
}

/**
 * The three cards, expressed as the policy map the daemon enforces.
 *
 * Every category is named on every branch. An omitted key would inherit
 * whatever the gateway last held — which for `send` is `"auto"` — so "off"
 * has to be said out loud.
 */
export function autonomyPoliciesForScopes(
  scopes: ConsentScopes,
): AutonomyPolicies {
  return {
    // Read and organise: watching sources, filing arrivals, surfacing work.
    research: scopes.read_organise ? "auto" : "never",
    // Draft and prepare: writing, building, researching — all held for review.
    draft: scopes.draft_prepare ? "auto" : "never",
    // Send and spend. `"ask"`, not `"never"`, when off: the card promises Cue
    // "will always stop and ask", and `never` would silently refuse instead of
    // asking, which is a different (and undisclosed) behaviour.
    send: scopes.send_spend ? "auto" : "ask",
    money: scopes.send_spend ? "ask" : "ask",
    // Deletion was never one of the three cards and is never granted by them.
    delete: "ask",
    other: scopes.draft_prepare ? "auto" : "ask",
  };
}

/**
 * Apply the scopes to the daemon, parking them if it cannot be reached.
 *
 * Resolves to `true` when the daemon took them. A `false` is not a failure the
 * user needs to see — the answer is durable either way — but it is why the
 * pending key exists.
 */
export async function applyConsentScopes(
  assistantId: string | null,
  scopes: ConsentScopes,
): Promise<boolean> {
  const policies = autonomyPoliciesForScopes(scopes);
  if (!assistantId) {
    parkPendingPolicies(policies);
    return false;
  }
  try {
    await setAutonomyPolicies(assistantId, policies);
    clearPendingPolicies();
    return true;
  } catch {
    parkPendingPolicies(policies);
    return false;
  }
}

function parkPendingPolicies(policies: AutonomyPolicies): void {
  try {
    setLocalSetting(PENDING_POLICIES_KEY, JSON.stringify(policies));
  } catch {
    /* best-effort */
  }
}

export function readPendingPolicies(): AutonomyPolicies | null {
  try {
    const raw = getLocalSetting(PENDING_POLICIES_KEY, "");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AutonomyPolicies;
  } catch {
    return null;
  }
}

export function clearPendingPolicies(): void {
  try {
    removeLocalSetting(PENDING_POLICIES_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Flush a parked map once an assistant is active. Called from the root layout
 * beside the pending workspace-mode flush; a no-op when nothing is parked.
 */
export async function flushPendingConsentScopes(
  assistantId: string | null,
): Promise<void> {
  if (!assistantId) return;
  const pending = readPendingPolicies();
  if (!pending) return;
  try {
    await setAutonomyPolicies(assistantId, pending);
    clearPendingPolicies();
  } catch {
    /* daemon still unreachable — retried on the next activation */
  }
}
