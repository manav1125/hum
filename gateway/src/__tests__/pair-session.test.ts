/**
 * Tests for `POST /v1/pair/session` — session-authenticated REMOTE pairing for
 * the browser extension.
 *
 * The security-critical assertions are the negative ones: a remote
 * token-minting endpoint that can be tricked into minting for the wrong
 * principal (or for an unauthenticated / expired / revoked caller) is worse
 * than no endpoint at all.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import type { ScopeProfile } from "../auth/types.js";
import {
  initSigningKey,
  mintToken,
  verifyToken,
} from "../auth/token-service.js";

// Init the signing key before importing any module that mints/verifies tokens.
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// The handler resolves the bound guardian and checks revocation. Mock both so
// the tests can drive the auth outcome deterministically without a DB.
const mockFindGuardian = mock();
mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: mockFindGuardian,
}));

const mockIsRevoked = mock(() => false);
mock.module("../auth/actor-token-revocation.js", () => ({
  isActorTokenRevoked: mockIsRevoked,
}));

const { handlePairSession, resetSessionPairRateLimiterForTests } = await import(
  "../http/routes/pair-session.js"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GUARDIAN_ID = "guardian-001";
const REMOTE_IP = "203.0.113.9";
const PROD_ORIGIN = "chrome-extension://mhgllmdapjpfdnfnmdihjffclnjknhmc";
const MALICIOUS_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Mint an edge session token like the one the signed-in web SPA holds. */
function mintSession(opts?: {
  principal?: string;
  scope?: ScopeProfile;
  ttlSeconds?: number;
}): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: `actor:self:${opts?.principal ?? GUARDIAN_ID}`,
    scope_profile: opts?.scope ?? "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: opts?.ttlSeconds ?? 3600,
  });
}

function makeReq(
  overrides: {
    method?: string;
    origin?: string | null;
    interfaceId?: string | null;
    token?: string | null;
  } = {},
): Request {
  const {
    method = "POST",
    origin = PROD_ORIGIN,
    interfaceId = "chrome-extension",
    token = mintSession(),
  } = overrides;
  const headers: Record<string, string> = {
    host: "manav.justcue.app",
    "content-type": "application/json",
  };
  if (origin !== null) headers["origin"] = origin;
  if (interfaceId !== null) headers["x-vellum-interface-id"] = interfaceId;
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request("https://manav.justcue.app/v1/pair/session", {
    method,
    headers,
  });
}

beforeEach(() => {
  resetSessionPairRateLimiterForTests();
  mockFindGuardian.mockReset();
  mockFindGuardian.mockResolvedValue({ principalId: GUARDIAN_ID });
  mockIsRevoked.mockReset();
  mockIsRevoked.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("handlePairSession — valid signed-in session", () => {
  test("mints a guardian-bound chrome_extension_v1 token", async () => {
    const res = await handlePairSession(makeReq(), REMOTE_IP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.token).toBe("string");
    expect(body.guardianId).toBe(GUARDIAN_ID);

    // The minted token must be narrowly scoped and bound to the guardian.
    const verified = verifyToken(body.token as string, "vellum-gateway");
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.scope_profile).toBe("chrome_extension_v1");
      expect(verified.claims.sub).toBe(`actor:self:${GUARDIAN_ID}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Negative auth — the important cases
// ---------------------------------------------------------------------------

describe("handlePairSession — rejects invalid sessions", () => {
  test("rejects a request with no Authorization header (401)", async () => {
    const res = await handlePairSession(makeReq({ token: null }), REMOTE_IP);
    expect(res.status).toBe(401);
  });

  test("rejects a garbage / unsigned token (401)", async () => {
    const res = await handlePairSession(
      makeReq({ token: "not.a.jwt" }),
      REMOTE_IP,
    );
    expect(res.status).toBe(401);
  });

  test("rejects an expired session token (401)", async () => {
    const res = await handlePairSession(
      makeReq({ token: mintSession({ ttlSeconds: -60 }) }),
      REMOTE_IP,
    );
    expect(res.status).toBe(401);
  });

  test("rejects a token that is not the full session profile (401)", async () => {
    // A previously-minted narrow extension token must not re-mint.
    const res = await handlePairSession(
      makeReq({ token: mintSession({ scope: "chrome_extension_v1" }) }),
      REMOTE_IP,
    );
    expect(res.status).toBe(401);
  });

  test("rejects a revoked session token (401)", async () => {
    mockIsRevoked.mockReturnValue(true);
    const res = await handlePairSession(makeReq(), REMOTE_IP);
    expect(res.status).toBe(401);
  });

  test("rejects a daemon-audience token (wrong audience, 401)", async () => {
    const daemonToken = mintToken({
      aud: "vellum-daemon",
      sub: `actor:self:${GUARDIAN_ID}`,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });
    const res = await handlePairSession(
      makeReq({ token: daemonToken }),
      REMOTE_IP,
    );
    expect(res.status).toBe(401);
  });

  test("CROSS-PRINCIPAL: a valid actor token for a different principal cannot mint for the guardian (403)", async () => {
    // Guardian is guardian-001; the caller presents a well-formed, non-revoked,
    // non-expired actor_client_v1 token for attacker-999. This must be rejected
    // — no token is minted for the guardian on behalf of another principal.
    mockFindGuardian.mockResolvedValue({ principalId: GUARDIAN_ID });
    const res = await handlePairSession(
      makeReq({ token: mintSession({ principal: "attacker-999" }) }),
      REMOTE_IP,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe("FORBIDDEN");
  });

  test("rejects when the instance has no bound guardian (403)", async () => {
    mockFindGuardian.mockResolvedValue(null);
    const res = await handlePairSession(makeReq(), REMOTE_IP);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Origin / interface / method guards
// ---------------------------------------------------------------------------

describe("handlePairSession — surface guards", () => {
  test("rejects an unknown extension origin (403)", async () => {
    const res = await handlePairSession(
      makeReq({ origin: MALICIOUS_ORIGIN }),
      REMOTE_IP,
    );
    expect(res.status).toBe(403);
  });

  test("rejects a missing Origin header (403)", async () => {
    const res = await handlePairSession(makeReq({ origin: null }), REMOTE_IP);
    expect(res.status).toBe(403);
  });

  test("rejects a non-extension interface id (400)", async () => {
    const res = await handlePairSession(
      makeReq({ interfaceId: "cli" }),
      REMOTE_IP,
    );
    expect(res.status).toBe(400);
  });

  test("rejects non-POST methods (405)", async () => {
    const res = await handlePairSession(makeReq({ method: "GET" }), REMOTE_IP);
    expect(res.status).toBe(405);
  });

  test("does not leak the mint even with a valid session on a bad origin", async () => {
    // A page that stole the owner's session token but is served from a
    // non-extension origin still cannot mint.
    const res = await handlePairSession(
      makeReq({ origin: "https://evil.example.com" }),
      REMOTE_IP,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("handlePairSession — rate limiting", () => {
  test("rate-limits a spraying peer after 10 requests/min (429)", async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await handlePairSession(makeReq(), REMOTE_IP);
      expect(ok.status).toBe(200);
    }
    const limited = await handlePairSession(makeReq(), REMOTE_IP);
    expect(limited.status).toBe(429);
  });
});
