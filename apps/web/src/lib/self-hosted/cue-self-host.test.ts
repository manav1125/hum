import { beforeEach, describe, expect, test, afterEach } from "bun:test";

import {
  clearSelfHostMode,
  decodeActorTokenExpMs,
  EXTENSION_SESSION_TOKEN_LS_KEYS,
  getStoredActorToken,
  isCueSelfHostDeploy,
  isSelfHostMode,
  isStoredActorTokenValid,
  rehydrateGatewayTokenFromActor,
  seedCueToken,
  shouldShowCueConnect,
} from "@/lib/self-hosted/cue-self-host";

const LS_TOKEN_KEY = "vellum:gw:token";
const LS_EXPIRES_KEY = "vellum:gw:expiresAt";
const LS_ACTOR_TOKEN_KEY = "cue:selfHost:actorToken";
const LS_SELF_HOST_FLAG = "cue:selfHost";

/** Build a JWT-shaped string whose payload carries the given `exp` (seconds). */
function makeToken(claims: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = btoa(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

beforeEach(() => {
  clearSelfHostMode();
  localStorage.removeItem(LS_ACTOR_TOKEN_KEY);
});

describe("decodeActorTokenExpMs", () => {
  test("decodes a numeric exp claim to epoch-ms", () => {
    const token = makeToken({ exp: 1_700_000_000 });
    expect(decodeActorTokenExpMs(token)).toBe(1_700_000_000_000);
  });

  test("returns null for null, non-JWT shapes, and missing/non-numeric exp", () => {
    expect(decodeActorTokenExpMs(null)).toBeNull();
    expect(decodeActorTokenExpMs("not-a-jwt")).toBeNull();
    expect(decodeActorTokenExpMs("a.b")).toBeNull();
    expect(decodeActorTokenExpMs(makeToken({ sub: "x" }))).toBeNull();
    expect(decodeActorTokenExpMs(makeToken({ exp: "soon" }))).toBeNull();
  });
});

describe("seedCueToken + durable storage", () => {
  test("seeding a 30-day token persists the durable actor token and flips the flag", () => {
    const token = makeToken({ exp: nowSec() + 30 * 24 * 60 * 60 });
    expect(seedCueToken(token)).toBe(true);

    expect(isSelfHostMode()).toBe(true);
    expect(getStoredActorToken()).toBe(token);
    expect(localStorage.getItem(LS_TOKEN_KEY)).toBe(token);
    expect(isStoredActorTokenValid()).toBe(true);
    expect(shouldShowCueConnect()).toBe(false);
  });

  test("derives the stored expiry from the token's own exp claim", () => {
    const exp = nowSec() + 7 * 24 * 60 * 60;
    const token = makeToken({ exp });
    seedCueToken(token);
    // Stored expiry (seconds) should match the JWT exp, not a fresh 30d stamp.
    expect(Number(localStorage.getItem(LS_EXPIRES_KEY))).toBe(exp);
  });

  test("rejects a mistyped non-JWT paste", () => {
    expect(seedCueToken("garbage")).toBe(false);
    expect(isSelfHostMode()).toBe(false);
  });
});

describe("EXTENSION_SESSION_TOKEN_LS_KEYS (browser-extension handoff contract)", () => {
  // The Cue browser extension reads the signed-in session token out of these
  // localStorage keys (in order) to pair a remote instance via
  // POST /v1/pair/session. Lock the contract: a rename here must be mirrored in
  // clients/chrome-extension/background/session-token.ts or pairing breaks.
  test("names the durable actor key first, then the gateway-token slot", () => {
    expect(EXTENSION_SESSION_TOKEN_LS_KEYS).toEqual([
      LS_ACTOR_TOKEN_KEY,
      LS_TOKEN_KEY,
    ]);
  });

  test("seeding a session populates the first handoff key with the actor token", () => {
    const token = makeToken({ exp: nowSec() + 30 * 24 * 60 * 60 });
    seedCueToken(token);
    // The key the extension reads first must carry the actor_client_v1 token
    // that POST /v1/pair/session requires.
    expect(localStorage.getItem(EXTENSION_SESSION_TOKEN_LS_KEYS[0])).toBe(token);
  });

  test("disconnect clears every handoff key so the extension cannot read a stale token", () => {
    const token = makeToken({ exp: nowSec() + 30 * 24 * 60 * 60 });
    seedCueToken(token);
    clearSelfHostMode();
    for (const key of EXTENSION_SESSION_TOKEN_LS_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });
});

describe("isStoredActorTokenValid", () => {
  test("false with no token", () => {
    expect(isStoredActorTokenValid()).toBe(false);
  });

  test("false once the actor token has passed its exp (with skew margin)", () => {
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");
    localStorage.setItem(LS_ACTOR_TOKEN_KEY, makeToken({ exp: nowSec() - 10 }));
    expect(isStoredActorTokenValid()).toBe(false);
  });

  test("treats an undecodable exp as valid (gateway is the real authority)", () => {
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");
    localStorage.setItem(LS_ACTOR_TOKEN_KEY, makeToken({ sub: "x" }));
    expect(isStoredActorTokenValid()).toBe(true);
  });
});

describe("rehydrateGatewayTokenFromActor", () => {
  test("re-stamps a cleared gateway slot from the durable actor token (survives a 401 clear)", () => {
    const token = makeToken({ exp: nowSec() + 30 * 24 * 60 * 60 });
    seedCueToken(token);

    // Simulate a 401 having cleared only the short-lived gateway slot.
    localStorage.removeItem(LS_TOKEN_KEY);
    localStorage.removeItem(LS_EXPIRES_KEY);
    // The boot gate would now wrongly show Connect…
    expect(shouldShowCueConnect()).toBe(false); // (cueConnect deploy flag off in tests)

    // …but re-hydration restores the slot from the durable actor token.
    expect(rehydrateGatewayTokenFromActor()).toBe(true);
    expect(localStorage.getItem(LS_TOKEN_KEY)).toBe(token);
  });

  test("returns false (no resurrection) when the actor token is expired", () => {
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");
    localStorage.setItem(LS_ACTOR_TOKEN_KEY, makeToken({ exp: nowSec() - 10 }));
    expect(rehydrateGatewayTokenFromActor()).toBe(false);
    expect(localStorage.getItem(LS_TOKEN_KEY)).toBeNull();
  });

  test("no-op outside self-host mode", () => {
    expect(rehydrateGatewayTokenFromActor()).toBe(false);
  });
});

describe("legacy migration (token seeded before the durable key existed)", () => {
  test("backfills the durable actor token from the legacy gateway slot", () => {
    const token = makeToken({ exp: nowSec() + 30 * 24 * 60 * 60 });
    // Self-host flag + gateway slot set, but NO durable key (pre-fix state).
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");
    localStorage.setItem(LS_TOKEN_KEY, token);
    localStorage.setItem(LS_EXPIRES_KEY, String(nowSec() + 30 * 24 * 60 * 60));

    expect(getStoredActorToken()).toBe(token);
    // Backfilled, so a later gateway clear is recoverable.
    expect(localStorage.getItem(LS_ACTOR_TOKEN_KEY)).toBe(token);
    expect(isStoredActorTokenValid()).toBe(true);

    localStorage.removeItem(LS_TOKEN_KEY);
    expect(rehydrateGatewayTokenFromActor()).toBe(true);
    expect(localStorage.getItem(LS_TOKEN_KEY)).toBe(token);
  });
});

describe("isCueSelfHostDeploy — instance-host safety net", () => {
  function setHost(hostname: string) {
    // happy-dom lets the whole URL be reassigned; hostname is derived from it.
    window.location.href = `https://${hostname}/assistant/`;
  }

  test("a *.justcue.app instance is self-host even without the build flag", () => {
    // The "Vellum page" bug: a web-dist missing VITE_CUE_SELF_HOST=1 fell
    // through to the Vellum-Platform auth. The instance host now settles it.
    setHost("cue-ada-1234.justcue.app");
    expect(isCueSelfHostDeploy()).toBe(true);
  });

  test("also covers the .justcue.io instance domain", () => {
    setHost("cue-ada-1234.justcue.io");
    expect(isCueSelfHostDeploy()).toBe(true);
  });

  test("a non-instance host is NOT auto-detected as self-host", () => {
    // The Vellum platform (*.vellum.ai) and HQ (justcue.ai) must not match.
    setHost("app.vellum.ai");
    expect(isCueSelfHostDeploy()).toBe(false);
    setHost("justcue.ai");
    expect(isCueSelfHostDeploy()).toBe(false);
  });
});

describe("expired token must not skip the Connect screen", () => {
  const TOKEN_KEY = "vellum:gw:token";
  const EXP_KEY = "vellum:gw:expiresAt";
  const FLAG = "cue:selfHost";

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(FLAG, "1");
    // Self-host detection is host-based; put us on a real instance host so
    // these assertions exercise the token-expiry branch, not the host branch.
    window.location.href = "https://manav.justcue.app/assistant/";
  });
  afterEach(() => localStorage.clear());

  test("a token seeded by the REAL writer is NOT treated as expired", () => {
    // The loop bug: writeSelfHostToken stores `expiresAt` in SECONDS, but the
    // reader treated it as MILLISECONDS, so every freshly-issued token looked
    // decades expired and the user bounced straight back to the sign-in screen.
    // Hand-written ms fixtures hid this — only the real seeding path catches it.
    const future = Math.floor(Date.now() / 1000) + 3600; // seconds, like a JWT
    const jwt = [
      btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      btoa(JSON.stringify({ exp: future })),
      "sig",
    ].join(".");
    expect(seedCueToken(jwt)).toBe(true);
    expect(shouldShowCueConnect()).toBe(false);
  });

  test("seconds-vs-ms: a seconds stamp in the future is not expired", () => {
    localStorage.setItem(TOKEN_KEY, "some.token.value");
    localStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + 3600));
    expect(shouldShowCueConnect()).toBe(false);
  });

  test("an EXPIRED token shows Connect (the dead-end bug)", () => {
    // Regression: presence-only checks treated a stale token as a session, so
    // the app skipped Connect and fell into platform OAuth that a self-host
    // instance can't do — a dead end the user couldn't escape.
    localStorage.setItem(TOKEN_KEY, "stale.token.value");
    localStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) - 3600));
    expect(shouldShowCueConnect()).toBe(true);
  });

  test("a LIVE token does not show Connect", () => {
    localStorage.setItem(TOKEN_KEY, "live.token.value");
    localStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + 3600));
    expect(shouldShowCueConnect()).toBe(false);
  });

  test("a token with an unreadable expiry is trusted (gateway decides)", () => {
    // Must not bounce a signed-in user out to Connect on a parse failure.
    localStorage.setItem(TOKEN_KEY, "opaque-token-without-jwt-shape");
    expect(shouldShowCueConnect()).toBe(false);
  });

  test("no token at all shows Connect", () => {
    expect(shouldShowCueConnect()).toBe(true);
  });
});
