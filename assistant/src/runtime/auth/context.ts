/**
 * AuthContext builder — combines sub parsing and scope resolution into
 * a normalized AuthContext that downstream code can consume without
 * knowing about JWT internals.
 */

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { resolveScopeProfile } from "./scopes.js";
import { parseSub } from "./subject.js";
import type { AuthContext, TokenClaims } from "./types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type BuildAuthContextResult =
  | { ok: true; context: AuthContext }
  | { ok: false; reason: string };

/**
 * Injectable dependencies for {@link buildAuthContext}.
 *
 * The owner-principal resolver is parameterized rather than imported so that
 * `context.ts` stays free of the DB-touching contacts layer — keeping this
 * module a pure, side-effect-free unit and preserving test isolation (a test
 * that mocks the contacts store must not bleed into a sibling that imports
 * this builder). The production wiring lives in the auth middleware, the sole
 * runtime caller, which passes `findLocalGuardianPrincipalId`.
 */
export interface BuildAuthContextDeps {
  /**
   * Resolve the self-host owner's principal id — the vellum-bound guardian's
   * `contact.principalId`. Returns `undefined` before guardian bootstrap, or
   * when omitted (the `local` principal then carries no actorPrincipalId).
   */
  resolveOwnerPrincipalId?: () => string | undefined;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a normalized AuthContext from verified JWT claims.
 *
 * Parses the sub claim and resolves the scope profile into a concrete
 * set of scopes. Returns a failure result if the sub is malformed.
 *
 * When the token audience is `vellum-daemon`, the assistantId is forced
 * to DAEMON_INTERNAL_ASSISTANT_ID ('self') regardless of what the JWT
 * sub encodes. Daemon code must never derive internal scoping from
 * externally-provided assistant IDs.
 *
 * Local-owner principal resolution (ROOT FIX): a `local:<assistantId>:
 * <conversationId>` sub identifies the self-host owner reaching the daemon
 * over the local session / native app. The `local` token is only mintable
 * behind the lockfile/loopback guard on the owner's own machine, so a `local`
 * principal *is* the trusted owner by definition. The sub carries no
 * `actorPrincipalId` (the parser extracts only the conversationId), which
 * left `buildAuthContext` yielding `actorPrincipalId: undefined` — and gate
 * after gate (approvals, tasks, trust-context resolution) silently rejected
 * the owner. We resolve `actorPrincipalId` for `local` to the owner's
 * principal — the vellum-bound guardian's `contact.principalId` — so the
 * owner is a fully-recognized principal at the root and flows through the
 * same guardian-trust pathway as an HTTP actor session. When no guardian
 * binding exists yet (pre-bootstrap) the resolver returns `undefined`, which
 * is the pre-existing behavior; downstream gates already tolerate that.
 */
export function buildAuthContext(
  claims: TokenClaims,
  deps?: BuildAuthContextDeps,
): BuildAuthContextResult {
  const subResult = parseSub(claims.sub);
  if (!subResult.ok) {
    return { ok: false, reason: subResult.reason };
  }

  const scopes = resolveScopeProfile(claims.scope_profile);

  // Daemon-audience tokens always scope to the internal assistant ID,
  // preventing external assistant IDs from leaking into daemon-side
  // storage and routing.
  const assistantId =
    claims.aud === "vellum-daemon"
      ? DAEMON_INTERNAL_ASSISTANT_ID
      : subResult.assistantId;

  // For a `local` principal, resolve the actor to the owner's guardian
  // principal id (supplied by the caller). Other principal types keep the
  // actorPrincipalId the sub already encodes (actor) or carry none (svc_*).
  let actorPrincipalId = subResult.actorPrincipalId;
  if (subResult.principalType === "local") {
    actorPrincipalId = deps?.resolveOwnerPrincipalId?.();
  }

  const context: AuthContext = {
    subject: claims.sub,
    principalType: subResult.principalType,
    assistantId,
    actorPrincipalId,
    conversationId: subResult.conversationId,
    scopeProfile: claims.scope_profile,
    scopes,
    policyEpoch: claims.policy_epoch,
  };

  return { ok: true, context };
}
