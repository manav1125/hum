import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearSelfHostMode,
  decodeActorTokenExpMs,
  getStoredActorToken,
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

describe("isStoredActorTokenValid", () => {
  test("false with no token", () => {
    expect(isStoredActorTokenValid()).toBe(false);
  });

  test("false once the actor token has passed its exp (with skew margin)", () => {
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");
    localStorage.setItem(
      LS_ACTOR_TOKEN_KEY,
      makeToken({ exp: nowSec() - 10 }),
    );
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
    localStorage.setItem(
      LS_ACTOR_TOKEN_KEY,
      makeToken({ exp: nowSec() - 10 }),
    );
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
