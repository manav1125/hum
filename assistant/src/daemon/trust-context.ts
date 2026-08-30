/**
 * Trust context resolved during inbound message processing.
 *
 * Extracted from conversation-runtime-assembly.ts to break circular
 * imports (memory/conversation-crud → daemon/conversation-runtime-assembly).
 */
import type { ChannelId } from "../channels/types.js";
import { isHttpAuthDisabled } from "../config/env.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";

export interface TrustContext {
  /** Channel through which the inbound message arrived. */
  sourceChannel: ChannelId;
  /** Trust classification -- see {@link TrustClass} for semantics. */
  trustClass: TrustClass;
  /** Chat/conversation ID for delivering guardian notifications. */
  guardianChatId?: string;
  /** Canonical external user ID of the guardian for this (assistant, channel) binding. */
  guardianExternalUserId?: string;
  /** Internal principal ID of the guardian. */
  guardianPrincipalId?: string;
  /** Human-readable identifier for the requester (e.g. @username or phone number). */
  requesterIdentifier?: string;
  /** Preferred display name for the requester (member name or sender name). */
  requesterDisplayName?: string;
  /** Raw sender display name as provided by the channel transport. */
  requesterSenderDisplayName?: string;
  /** Guardian-managed display name from the contact record. */
  requesterMemberDisplayName?: string;
  /** Raw timezone for the requester, when supplied by the source channel. */
  requesterTimezone?: string;
  /** Compact timezone label for the requester, when supplied by the source channel. */
  requesterTimezoneLabel?: string;
  /** Raw timezone offset in seconds for the requester, when supplied by the source channel. */
  requesterTimezoneOffsetSeconds?: number;
  /** Canonical external user ID of the requester (the current actor). */
  requesterExternalUserId?: string;
  /** Chat/conversation ID the requester is interacting through. */
  requesterChatId?: string;
}

/**
 * Trust context used by internal background jobs (memory consolidation,
 * scheduled tasks) when invoking the agent loop without
 * an inbound actor identity. The assistant is the guardian over its own
 * internal state, so self-maintenance flows clear the side-effect
 * approval gate. Inbound message conversations resolve trust per-actor
 * via `resolveTrustContext()` and must not use this constant.
 */
export const INTERNAL_GUARDIAN_TRUST_CONTEXT = {
  sourceChannel: "vellum",
  trustClass: "guardian",
} as const satisfies TrustContext;

/**
 * Synthetic fallback trust context used when a pipeline fires before the
 * per-turn trust snapshot has been captured (e.g. fresh conversations before
 * the trust resolver runs, heartbeat turns that never bind an actor, or
 * non-turn invocations like `Conversation.forceCompact`). We bias to
 * `unknown` rather than `guardian` so a missing snapshot cannot accidentally
 * grant elevated trust to a custom plugin reading `ctx.trust`.
 */
export const FALLBACK_TURN_TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "unknown",
};

/**
 * Whether two trust contexts describe the same acting identity at the same
 * privilege, for callers that may only run work under one of them (batched
 * queue turns being the case that matters).
 *
 * Compares the privilege (`trustClass`), the channel a grant is scoped to
 * (`sourceChannel`), and every field that can carry who the actor is. The
 * identity fields are covered exhaustively rather than by picking the usual
 * ones: an ingress that populates only `requesterIdentifier` or
 * `requesterChatId` would otherwise leave two distinct senders comparing
 * equal on a pair of undefineds, which is the exact case this guards.
 *
 * Deliberately conservative: an absent field never matches a present one, so
 * unknown identities are treated as distinct. Answering "different" when they
 * match only costs a batching opportunity; answering "same" when they differ
 * runs one actor's work under another's privileges.
 */
export function sameTrustIdentity(
  a: TrustContext | undefined,
  b: TrustContext | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.trustClass === b.trustClass &&
    a.sourceChannel === b.sourceChannel &&
    a.requesterExternalUserId === b.requesterExternalUserId &&
    a.requesterChatId === b.requesterChatId &&
    a.requesterIdentifier === b.requesterIdentifier &&
    a.guardianExternalUserId === b.guardianExternalUserId &&
    a.guardianPrincipalId === b.guardianPrincipalId
  );
}

/** The two trust fields a conversation-shaped value carries. */
export interface TrustCarrier {
  currentTurnTrustContext?: TrustContext;
  trustContext?: TrustContext;
}

/**
 * The acting turn's trust, else the owner's. Structural rather than a
 * `Conversation` method so call sites handed a conversation-shaped context
 * (the messaging context, `deps.ctx`, partial test doubles) need only the
 * fields they already have.
 *
 * Use at sites that persist or decide INSIDE a stamped turn: the entry
 * points (queue drains, `processMessage`, POST /messages) stamp
 * `currentTurnTrustContext` from the message the turn belongs to, so this
 * names the turn's actor even after the conversation slot has moved on.
 */
export function turnOrRestingTrust(
  carrier: TrustCarrier | undefined,
): TrustContext | undefined {
  return carrier?.currentTurnTrustContext ?? carrier?.trustContext;
}

/**
 * The owner's trust, independent of any turn. Use at sites that persist
 * BEFORE any per-turn stamp exists (channel ingress, wake notices) or after
 * a turn has settled (post-call notifiers): there the conversation slot was
 * just written by the site's own resolution — or restored by cleanup — and
 * the per-turn field may still hold a previous turn's actor, since nothing
 * clears it at turn end. Reading the turn field at these sites would be the
 * regression, not the fix.
 */
export function restingTrust(
  carrier: Pick<TrustCarrier, "trustContext"> | undefined,
): TrustContext | undefined {
  return carrier?.trustContext;
}

/**
 * Fields that can carry the acting principal of the current turn, as held on
 * a conversation-shaped value. Structural for the same test-double reason as
 * {@link TrustCarrier}.
 */
export interface TurnActorCarrier {
  currentTurnSourceActorPrincipalId?: string;
  currentTurnAuthContext?: { actorPrincipalId?: string };
  authContext?: { actorPrincipalId?: string };
}

/**
 * The principal the current turn acts as, for host-proxy routing and other
 * same-actor comparisons. Host proxies compare this against the principal a
 * client registered with on its SSE stream — an ACTOR principal — so it must
 * resolve to the turn's actor, never the workspace guardian: submitting
 * `guardianPrincipalId` would let a non-guardian turn match against the
 * guardian's connected client. A turn with no actor identity submits
 * nothing and fails the same-actor gate closed (`missing_source`).
 */
export function resolveTurnActorPrincipalId(
  carrier: TurnActorCarrier | undefined,
): string | undefined {
  return (
    carrier?.currentTurnSourceActorPrincipalId ??
    carrier?.currentTurnAuthContext?.actorPrincipalId ??
    carrier?.authContext?.actorPrincipalId
  );
}

/**
 * Resolve the effective trust class for an actor.
 *
 * When HTTP auth is disabled (dev bypass), always returns `'guardian'`
 * so that control-plane gates don't block local development.
 *
 * When no trust context is available (e.g. desktop-only conversations that
 * don't go through channel trust resolution), defaults to `'unknown'`
 * to fail-closed.
 */
export function resolveTrustClass(
  trustContext: TrustContext | undefined,
): TrustClass {
  if (isHttpAuthDisabled()) return "guardian";
  return trustContext?.trustClass ?? "unknown";
}

/**
 * Whether personal-memory content may be surfaced for the actor described by
 * `trustContext`: the gate admits guardian-class actors and internal/local
 * flows (turns with no trust context at all), and blocks every actor we can
 * positively identify as something other than the guardian — on any channel,
 * including the first-party console.
 *
 * This is THE personal-memory trust gate. Every surface that exposes private
 * user content — the v2 dynamic/static `<memory>` layers, PKB context, NOW.md,
 * memory-v3 cards/spotlight, and the `loadFromDb` rehydration of persisted
 * memory blocks — must call this one helper so the exposure rule cannot drift
 * between copies. It folds in {@link resolveTrustClass} so the dev-bypass
 * (HTTP auth disabled → guardian) applies uniformly at every call site.
 */
export function isPersonalMemoryAllowed(
  trustContext: TrustContext | undefined,
): boolean {
  // A context that names no trust class carries no information about who is
  // acting — an internal/local flow, a background job, a maintenance pass, a
  // turn nobody is attributed to. Those keep the access they have always had.
  // The test is the CLASS, not the presence of a context object: several
  // internal callers pass a partial context, and reading that as "an actor we
  // could not vouch for" would cut off flows that have no actor at all.
  if (!trustContext?.trustClass) return true;

  // Once we know the class, it decides. The channel does not get a vote.
  //
  // It used to: the rule was "block a remote actor who is untrusted", and
  // `vellum` counted as not-remote. But `vellum` is the first-party console,
  // which a trusted contact can be sitting in — so a non-guardian there was
  // handed the owner's people, preferences and past work. The same load
  // seventy lines away in `loadFromDb` gates message history on guardian
  // class alone, so the two disagreed on exactly that actor, and the
  // permissive one decided what got injected.
  //
  // Personal memory is the owner's. Being on their console is not being them.
  return resolveTrustClass(trustContext) === "guardian";
}
