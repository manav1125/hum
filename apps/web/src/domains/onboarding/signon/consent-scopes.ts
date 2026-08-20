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
 *
 * WHAT THE SWITCHES START AT, AND WHY THAT IS NOT JUST `DEFAULT_CONSENT_SCOPES`
 * ---------------------------------------------------------------------------
 * The gate that runs this arc is DEVICE-scoped on purpose (`intro-state.ts`),
 * so the screen replays on every new laptop against an instance that may
 * already hold real policy. Starting the switches at the frozen defaults and
 * writing them on Continue therefore RESET the instance: an owner who set
 * research or draft to "never" in Guardrails got both back at "auto" for
 * clicking a button that said nothing about changing them. Widening autonomy
 * nobody asked for is the failure this file exists to prevent, so:
 *
 *   The switches are seeded from what the instance holds — but only from the
 *   categories the instance holds an ANSWER for.
 *
 * That qualifier is the whole design. A plain read-back is not an answer: the
 * gateway's own default is `send: "auto"`, so on an instance nobody has ever
 * configured a read-back is byte-identical to a deliberate opt-in, and seeding
 * from it would render "Send and spend" ON for every brand-new user — exactly
 * the default that had a background run email a partner with no approval.
 *
 * The gateway now says which is which (`sources`, per category). Of the three
 * shapes that could have carried it, provenance on the existing endpoint is
 * the one that stores nothing new: a row in `autonomy_category_policies`
 * already exists if and only if somebody wrote that category, so the fact was
 * always there and merely discarded while defaults were overlaid. The
 * alternatives are worse in specific ways —
 *
 *   · A separate "answered" marker is a second fact that can disagree with the
 *     first, and every future writer of the policy map has to remember to set
 *     it. The row cannot drift from itself.
 *   · Seeding only the two safe cards and always writing send/money from the
 *     switch would work TODAY only because the gateway's default for research
 *     and draft happens to equal this file's default. That is a coincidence,
 *     not an invariant: retuning `SAFE_DEFAULT_POLICIES.draft` to "ask" would
 *     silently reopen the reset bug through a file nobody edited. It also
 *     leaves the send card permanently unable to tell the truth about an owner
 *     who deliberately turned sending on.
 *
 * A seeded switch is still a human's answer — moved in Guardrails rather than
 * here — so `send_spend` reading true off a STORED `send: "auto"` does not
 * violate the rule at the top of this file. What it must never do is read true
 * off a default, and `answered` is what stops it.
 *
 * WHEN THE INSTANCE DOES NOT ANSWER
 * ---------------------------------
 * Skipping the write is not the safe fallback it looks like — the card
 * promises "with this off, Cue stops and asks", and writing nothing leaves the
 * gateway's `send: "auto"` in force, so the screen would be lying. But writing
 * the FULL map blind is the reset bug again. So a blind Continue writes only
 * what it can defend: the send/spend categories the user just read a promise
 * about, plus any card they physically touched. See `consentPolicyWrite`.
 */
import {
  setAutonomyPolicies,
  type AutonomyMode,
  type AutonomyPolicies,
  type AutonomyPolicyState,
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

/* ───────────────── what the instance already holds ────────────────────── */

/** Which autonomy categories each card speaks for. */
const CARD_CATEGORIES: Record<ConsentScopeId, readonly AutonomyCategoryKey[]> =
  {
    read_organise: ["research"],
    draft_prepare: ["draft", "other"],
    send_spend: ["send", "money"],
  };

type AutonomyCategoryKey = keyof AutonomyPolicies;

/**
 * The single category whose stored mode decides a card's switch.
 *
 * `draft_prepare` speaks for both `draft` and `other`, but only `draft` is
 * evidence of the answer — `other` is the catch-all the card sweeps along, and
 * an instance could hold one without the other.
 */
const CARD_WITNESS: Record<ConsentScopeId, AutonomyCategoryKey> = {
  read_organise: "research",
  draft_prepare: "draft",
  send_spend: "send",
};

/**
 * What this screen knows about the instance it is about to write to.
 *
 * `null` everywhere it is used means "we did not find out" — no assistant yet,
 * the read failed, or the user pressed Continue before it landed. Never a
 * half-view: an unknown is an unknown.
 */
export type ConsentInstanceView = {
  /** The resolved modes, defaults included. Used as the never-loosen floor. */
  policies: AutonomyPolicies;
  /** Per card: does the instance hold an ANSWER, as opposed to a default? */
  answered: Record<ConsentScopeId, boolean>;
};

/** Read the gateway's policy state into the three cards' terms. */
export function consentInstanceView(
  state: AutonomyPolicyState,
): ConsentInstanceView {
  return {
    policies: state.policies,
    answered: {
      read_organise: state.sources[CARD_WITNESS.read_organise] === "stored",
      draft_prepare: state.sources[CARD_WITNESS.draft_prepare] === "stored",
      send_spend: state.sources[CARD_WITNESS.send_spend] === "stored",
    },
  };
}

/**
 * Where the switches start.
 *
 * A card whose category the instance has an ANSWER for shows that answer; a
 * card it does not falls back to the shipped default. `null` — we never found
 * out — is the shipped defaults entire, which is the pre-existing behaviour and
 * keeps `send_spend` off.
 *
 * "On" is `"auto"` and nothing else. A stored `"ask"` or `"never"` is not a
 * grant, so it seeds the switch off, which is also what makes the write below
 * safe: a card can only be ON either because the instance genuinely holds
 * `"auto"` or because a human moved it on this screen.
 */
export function seedConsentScopes(
  view: ConsentInstanceView | null,
): ConsentScopes {
  if (!view) return { ...DEFAULT_CONSENT_SCOPES };
  const seeded = { ...DEFAULT_CONSENT_SCOPES } as ConsentScopes;
  for (const scope of CONSENT_SCOPE_IDS) {
    if (!view.answered[scope]) continue;
    seeded[scope] = view.policies[CARD_WITNESS[scope]] === "auto";
  }
  return seeded;
}

/** Strictness order. Higher is more restrictive; the write may never descend. */
const STRICTNESS: Record<AutonomyMode, number> = { auto: 0, ask: 1, never: 2 };

function strictest(a: AutonomyMode, b: AutonomyMode): AutonomyMode {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * The map to PUT — the one place the reset bug could still live.
 *
 * **Instance known.** The switches are a true picture of it, so every category
 * is written and any difference is the user's own act on this screen. One
 * guard remains: a promised mode of `"auto"` is only ever produced by a switch
 * that is ON, which (per `seedConsentScopes`) means either the instance
 * already held `"auto"` or a human just moved it — so it is written as-is.
 * Everything else is floored against what the instance holds, so an owner who
 * chose `never` for money or deletion does not get relaxed to `ask` by a
 * screen that never mentioned either.
 *
 * **Instance unknown.** Writing the full map is the reset bug, and writing
 * nothing breaks the card's stated promise. So write exactly what can be
 * defended without knowing anything:
 *
 *   · `send` / `money` / `delete` — the categories the user just read a
 *     promise about, at modes no looser than the gateway's own defaults.
 *   · any category belonging to a card the user PHYSICALLY TOUCHED, because
 *     that is an answer given here and dropping it is the fail-open bug.
 *
 *   `research`, `draft` and `other` are otherwise omitted: their "on" is this
 *   file's default rather than anybody's answer, and the PUT upserts only the
 *   keys it is given, so omission leaves the instance's own choice standing.
 *
 * The one loosening this permits: an unknown instance holding `send: "never"`
 * is written back to `"ask"`. It is the sole point where the promise on the
 * card and the never-loosen rule genuinely conflict, `"ask"` is the behaviour
 * the user was shown, and the movement is from "refuse" to "ask a human" — no
 * unattended send becomes possible either way.
 */
export function consentPolicyWrite(
  scopes: ConsentScopes,
  view: ConsentInstanceView | null,
  touched: Partial<Record<ConsentScopeId, boolean>> = {},
): Partial<AutonomyPolicies> {
  const promised = autonomyPoliciesForScopes(scopes);

  if (view) {
    const out: Partial<AutonomyPolicies> = {};
    for (const [category, mode] of Object.entries(promised) as Array<
      [AutonomyCategoryKey, AutonomyMode]
    >) {
      out[category] =
        mode === "auto" ? mode : strictest(mode, view.policies[category]);
    }
    return out;
  }

  const writable = new Set<AutonomyCategoryKey>(["send", "money", "delete"]);
  for (const scope of CONSENT_SCOPE_IDS) {
    // Touched-ness is the KEY's presence, never its value: a user who turned a
    // card OFF answered it just as much as one who turned it on, and reading
    // the boolean here would silently drop every "off" answer.
    if (!(scope in touched)) continue;
    for (const category of CARD_CATEGORIES[scope]) writable.add(category);
  }
  const out: Partial<AutonomyPolicies> = {};
  for (const category of writable) out[category] = promised[category];
  return out;
}

/**
 * Apply the scopes to the daemon, parking them if it cannot be reached.
 *
 * Resolves to `true` when the daemon took them. A `false` is not a failure the
 * user needs to see — the answer is durable either way — but it is why the
 * pending key exists.
 *
 * `view` and `touched` are what `consentPolicyWrite` needs to avoid resetting
 * an instance it never read; omitting them is the blind path, which is also
 * the correct reading of "no assistant to ask".
 */
export async function applyConsentScopes(
  assistantId: string | null,
  scopes: ConsentScopes,
  view: ConsentInstanceView | null = null,
  touched: Partial<Record<ConsentScopeId, boolean>> = {},
): Promise<boolean> {
  // No assistant means the map is PARKED and flushed against whatever is
  // active later — which is not necessarily the instance `view` describes. A
  // view that may not belong to the eventual target is not knowledge, so the
  // blind (omitting) write is the honest one.
  const policies = consentPolicyWrite(
    scopes,
    assistantId ? view : null,
    touched,
  );
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

function parkPendingPolicies(policies: Partial<AutonomyPolicies>): void {
  try {
    setLocalSetting(PENDING_POLICIES_KEY, JSON.stringify(policies));
  } catch {
    /* best-effort */
  }
}

export function readPendingPolicies(): Partial<AutonomyPolicies> | null {
  try {
    const raw = getLocalSetting(PENDING_POLICIES_KEY, "");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Partial<AutonomyPolicies>;
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
