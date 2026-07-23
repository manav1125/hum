/**
 * Route handler for `POST /v1/pair/session`.
 *
 * Session-authenticated **remote** pairing for the browser extension. This is
 * the remote counterpart to the loopback-only `POST /v1/pair` (`pair.ts`): it
 * lets a user who is signed in to their OWN self-hosted instance pair the Cue
 * browser extension from a real browser over the public edge, WITHOUT weakening
 * the zero-auth loopback path.
 *
 * ── Why a separate route ──────────────────────────────────────────────────
 * `/v1/pair` mints a token for any *loopback* caller and is guarded by
 * `enforceLoopbackOnly` (peer IP + Host + X-Forwarded-For + edge/velay markers).
 * Exposing that zero-auth mint to the internet would be a token-minting oracle.
 * So `/v1/pair` stays exactly as-is (loopback-only, no session auth), and this
 * route adds an explicitly **session-authenticated** path for the remote case.
 * The two never share a code path: this handler deliberately does NOT call
 * `enforceLoopbackOnly` — a remote request is the whole point — and instead
 * proves the caller holds the instance owner's live signed-in session.
 *
 * ── Session proof required (equivalent to the web SPA's own auth) ──────────
 * The caller must present, as `Authorization: Bearer <token>`, the SAME actor
 * edge token the signed-in web SPA / desktop app already holds and sends to the
 * gateway runtime proxy on every request:
 *
 *   1. a valid, **non-expired** edge JWT (`aud=vellum-gateway`) — a live
 *      session, not an expired one (we do NOT pass `allowExpired`);
 *   2. `scope_profile === "actor_client_v1"` — the full signed-in session
 *      profile, mirroring `/auth/token`. A previously-minted narrow extension
 *      token (`chrome_extension_v1`) therefore cannot re-mint, closing a
 *      privilege loop;
 *   3. not revoked (device revocation must not be re-bootstrappable);
 *   4. an `actor` principal whose id matches the assistant's bound vellum
 *      guardian (`findVellumGuardian`) — i.e. the instance owner.
 *
 * This is exactly the check `requireEdgeGuardianAuth` enforces on other
 * guardian routes, done inline here so the minted token is bound to the
 * *authenticated* principal (never a separately-resolved value that could
 * diverge) and so the handler fails closed independent of any loopback grace
 * fallback in the shared auth middleware.
 *
 * ── What it mints ─────────────────────────────────────────────────────────
 * An edge token (`aud=vellum-gateway`, so it is accepted by the runtime-proxy
 * catch-all's `validateEdgeToken`) with:
 *   - `sub = actor:self:<guardianPrincipalId>` — bound to the guardian derived
 *     from the presented session;
 *   - `scope_profile = chrome_extension_v1` — the MINIMAL profile
 *     (`chat.read` for the SSE `/v1/events` relay + `approval.write` for
 *     `POST /v1/host-browser-result`), NOT the full `actor_client_v1`;
 *   - a 24h TTL (matches the loopback extension pair token; covers extended
 *     sessions and SSE reconnects).
 *
 * The extension sends this token as `Authorization: Bearer <token>` on the SSE
 * stream and the host-browser callbacks.
 *
 * Response body: `{ token, expiresAt, guardianId, assistantId }` — the same
 * shape as the stateless `/v1/pair` chrome-extension response.
 */

import { isActorTokenRevoked } from "../../auth/actor-token-revocation.js";
import { findVellumGuardian } from "../../auth/guardian-bootstrap.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { parseSub } from "../../auth/subject.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import { mintToken } from "../../auth/token-service.js";
import { KNOWN_EXTENSION_ORIGINS } from "../../chrome-extension-origins.js";
import { getLogger } from "../../logger.js";
import { errorResponse } from "../loopback-guard.js";

const log = getLogger("pair-session");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Token TTL — matches the loopback extension pair token (`pair.ts`). */
const SESSION_PAIR_TOKEN_TTL_SECONDS = 86400;

const DAEMON_INTERNAL_ASSISTANT_ID = "self";

const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Rate limiter (dedicated, per-peer)
// ---------------------------------------------------------------------------

const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(peerIp: string): {
  allowed: boolean;
  limit: number;
  resetAt: number;
} {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const timestamps = (rateLimitMap.get(peerIp) ?? []).filter(
    (t) => t > windowStart,
  );

  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitMap.set(peerIp, timestamps);
    const oldestInWindow = timestamps[0] ?? now;
    return {
      allowed: false,
      limit: RATE_LIMIT_MAX_REQUESTS,
      resetAt: Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS) / 1000),
    };
  }

  timestamps.push(now);
  rateLimitMap.set(peerIp, timestamps);
  return {
    allowed: true,
    limit: RATE_LIMIT_MAX_REQUESTS,
    resetAt: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000),
  };
}

/** Test helper: clear the rate limiter state. */
export function resetSessionPairRateLimiterForTests(): void {
  rateLimitMap.clear();
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

function auditDeny(
  req: Request,
  peerIp: string,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  log.warn(
    {
      audit: "pair-session-denied",
      peerIp,
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      reason,
      ...extra,
    },
    `pair_session_denied: ${reason}`,
  );
}

function getExternalAssistantId(): string {
  return (
    process.env.VELLUM_ASSISTANT_NAME?.trim() || DAEMON_INTERNAL_ASSISTANT_ID
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handlePairSession(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  // Per-peer rate limit — a remote token-minting endpoint must not be a
  // brute-force / spray surface. Keyed on the real client IP (the gateway
  // resolves this from the socket peer, or X-Forwarded-For when a trusted
  // proxy is declared).
  const rate = checkRateLimit(clientIp);
  if (!rate.allowed) {
    auditDeny(req, clientIp, "rate_limited");
    const retryAfter = Math.max(1, rate.resetAt - Math.ceil(Date.now() / 1000));
    return Response.json(
      { error: { code: "RATE_LIMITED", message: "too many pair requests" } },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(rate.resetAt),
        },
      },
    );
  }

  // This route exists solely for the browser extension. Require the standard
  // interface id so it is never mistaken for a general session-token mint.
  const interfaceId = req.headers.get("x-vellum-interface-id");
  if (interfaceId !== "chrome-extension") {
    auditDeny(req, clientIp, "unexpected_interface", {
      interfaceId: interfaceId ?? "(none)",
    });
    return errorResponse(
      "BAD_REQUEST",
      "endpoint requires X-Vellum-Interface-Id: chrome-extension",
      400,
    );
  }

  // Defense-in-depth: only a known Cue extension origin may invoke this.
  // Chrome sets `Origin: chrome-extension://<id>` on service-worker fetches and
  // enforces it at the network layer, so no other extension (and no ordinary
  // web page — CORS is also narrowed to these origins) can drive this mint even
  // if it somehow obtained the owner's session token. A local process can spoof
  // Origin, but a local process on the owner's machine already has the loopback
  // `/v1/pair` path; this route is about the remote browser case.
  const origin = req.headers.get("origin");
  if (!origin || !KNOWN_EXTENSION_ORIGINS.has(origin)) {
    auditDeny(req, clientIp, "unknown_extension_origin", {
      origin: origin ?? "(none)",
    });
    return errorResponse(
      "FORBIDDEN",
      "origin does not match a known Cue extension",
      403,
    );
  }

  // ── Session proof: the owner's live actor edge token ──────────────────────
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    auditDeny(req, clientIp, "missing_authorization");
    return errorResponse(
      "UNAUTHORIZED",
      "missing session token: send the signed-in session as Authorization: Bearer",
      401,
    );
  }
  const sessionToken = authHeader.slice(7);

  // Validate the edge JWT. Not `allowExpired` — a live session is required.
  const result = validateEdgeToken(sessionToken);
  if (!result.ok) {
    auditDeny(req, clientIp, "invalid_session_token", { reason: result.reason });
    return errorResponse("UNAUTHORIZED", "invalid or expired session", 401);
  }

  // Require the full signed-in session profile. This is the exact token the web
  // SPA / desktop app holds; a narrower minted token (e.g. a prior
  // chrome_extension_v1 pairing token) must NOT be able to re-mint.
  if (result.claims.scope_profile !== "actor_client_v1") {
    auditDeny(req, clientIp, "insufficient_session_scope", {
      scopeProfile: result.claims.scope_profile,
    });
    return errorResponse("UNAUTHORIZED", "session token is not authorized", 401);
  }

  // A revoked device's token must not be able to bootstrap a fresh one.
  if (isActorTokenRevoked(sessionToken, result.claims)) {
    auditDeny(req, clientIp, "revoked_session_token");
    return errorResponse("UNAUTHORIZED", "session has been revoked", 401);
  }

  // The session must be an actor principal.
  const parsed = parseSub(result.claims.sub);
  if (!parsed.ok || parsed.principalType !== "actor" || !parsed.actorPrincipalId) {
    auditDeny(req, clientIp, "non_actor_principal");
    return errorResponse(
      "FORBIDDEN",
      "session is not an actor principal",
      403,
    );
  }
  const sessionPrincipalId = parsed.actorPrincipalId;

  // The actor must be THIS instance's bound guardian (the owner). This is the
  // load-bearing negative check: a valid, non-revoked actor token for a
  // DIFFERENT principal must never mint an extension token for the guardian.
  let guardian: { principalId: string } | null;
  try {
    guardian = await findVellumGuardian();
  } catch (err) {
    log.error({ err }, "pair/session: findVellumGuardian failed");
    return Response.json({ error: "Service Unavailable" }, { status: 503 });
  }
  if (!guardian) {
    auditDeny(req, clientIp, "no_bound_guardian");
    return errorResponse("FORBIDDEN", "no bound guardian on this instance", 403);
  }
  if (guardian.principalId !== sessionPrincipalId) {
    auditDeny(req, clientIp, "principal_not_guardian");
    return errorResponse(
      "FORBIDDEN",
      "session principal is not the bound guardian",
      403,
    );
  }

  // ── Mint the narrowly-scoped, guardian-bound extension token ──────────────
  const guardianPrincipalId = guardian.principalId;
  const expiresAt = Date.now() + SESSION_PAIR_TOKEN_TTL_SECONDS * 1000;
  const token = mintToken({
    aud: "vellum-gateway",
    sub: `actor:${DAEMON_INTERNAL_ASSISTANT_ID}:${guardianPrincipalId}`,
    scope_profile: "chrome_extension_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: SESSION_PAIR_TOKEN_TTL_SECONDS,
  });
  const expiresAtIso = new Date(expiresAt).toISOString();

  log.info(
    { interfaceId, guardianPrincipalId, expiresAt: expiresAtIso },
    "Browser extension paired via remote session auth",
  );

  return Response.json({
    token,
    expiresAt: expiresAtIso,
    guardianId: guardianPrincipalId,
    assistantId: getExternalAssistantId(),
  });
}
