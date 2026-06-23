import { isHttpAuthDisabled } from "../../config/env.js";
import { findGuardianForChannel } from "../../contacts/contact-store.js";
import { httpError } from "../http-errors.js";
import type { AuthContext } from "./types.js";

/**
 * Verify the actor from AuthContext is the bound guardian for the vellum channel.
 * Returns an error Response if not, or null if allowed.
 */
export function requireBoundGuardian(
  authContext: AuthContext,
): Response | null {
  // Dev bypass: when auth is disabled, skip guardian binding check
  // (mirrors enforcePolicy dev bypass in route-policy.ts)
  if (isHttpAuthDisabled()) {
    return null;
  }
  // Local principal: a `local:<assistantId>:<conversationId>` JWT (self-host
  // owner reaching the daemon over the local session / native app) is the
  // bound guardian by the single-guardian invariant — there is exactly one
  // guardian per assistant and the local owner *is* that guardian. The `local`
  // sub carries no `actorPrincipalId` (subject.ts parses only the
  // conversationId), so the principal-equality check below would otherwise
  // 403 every local-owner approval (confirm / secret / guardian decision),
  // surfacing to the user as an in-thread "Approve" that fails instantly.
  // Treat it as authorized; it has already cleared JWT verification and the
  // route's scope/principal-type policy gate.
  if (authContext.principalType === "local") {
    return null;
  }
  if (!authContext.actorPrincipalId) {
    return httpError(
      "FORBIDDEN",
      "Actor is not the bound guardian for this channel",
      403,
    );
  }
  const guardianResult = findGuardianForChannel("vellum");
  if (!guardianResult) {
    // No guardian yet — in pre-bootstrap state, allow through
    return null;
  }
  if (
    (guardianResult.channel.externalUserId ??
      guardianResult.contact.principalId) !== authContext.actorPrincipalId
  ) {
    return httpError(
      "FORBIDDEN",
      "Actor is not the bound guardian for this channel",
      403,
    );
  }
  return null;
}
