/**
 * Tests for the gateway pairing client.
 *
 * Covers:
 *   - isLoopbackGatewayUrl: loopback vs. remote classification.
 *   - looksLikeJwt: three-segment shape check.
 *   - requestLoopbackPairToken: zero-auth POST /v1/pair, headers, errors.
 *   - requestSessionPairToken: session Bearer on POST /v1/pair/session, the
 *     https-only guard, headers, and error mapping.
 */

import { describe, test, expect } from "bun:test";

import {
  isLoopbackGatewayUrl,
  looksLikeJwt,
  requestLoopbackPairToken,
  requestSessionPairToken,
  PairError,
  LOOPBACK_PAIR_PATH,
  SESSION_PAIR_PATH,
} from "../pair-client.js";

/** A JWT-shaped string. */
const JWT = "aaa.bbb.ccc";

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A fetch stub returning a scripted response and recording the call. */
function makeFetch(response: { status: number; body?: unknown }): {
  fn: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("isLoopbackGatewayUrl", () => {
  test("classifies loopback hosts as loopback", () => {
    for (const url of [
      "http://127.0.0.1:7830",
      "http://localhost:7830",
      "https://localhost",
      "http://127.5.5.5:9000",
      "http://[::1]:7830",
      "http://foo.localhost:7830",
    ]) {
      expect(isLoopbackGatewayUrl(url)).toBe(true);
    }
  });

  test("classifies real instance origins as remote", () => {
    for (const url of [
      "https://manav.justcue.app",
      "https://cue.example.com",
      "http://192.168.1.10:7830", // LAN, but not loopback
    ]) {
      expect(isLoopbackGatewayUrl(url)).toBe(false);
    }
  });

  test("returns false for unparseable input", () => {
    expect(isLoopbackGatewayUrl("not a url")).toBe(false);
  });
});

describe("looksLikeJwt", () => {
  test("accepts three-segment strings, rejects others", () => {
    expect(looksLikeJwt("a.b.c")).toBe(true);
    expect(looksLikeJwt("a.b")).toBe(false);
    expect(looksLikeJwt("")).toBe(false);
    expect(looksLikeJwt(null)).toBe(false);
    expect(looksLikeJwt(undefined)).toBe(false);
  });
});

describe("requestLoopbackPairToken", () => {
  test("POSTs zero-auth to /v1/pair and returns the token", async () => {
    const { fn, calls } = makeFetch({ status: 200, body: { token: JWT } });
    const result = await requestLoopbackPairToken("http://127.0.0.1:7830", fn);

    expect(result.token).toBe(JWT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:7830${LOOPBACK_PAIR_PATH}`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-vellum-interface-id"]).toBe("chrome-extension");
    // Loopback pairing must NOT carry an Authorization header.
    expect(headers["authorization"]).toBeUndefined();
  });

  test("trims a trailing slash off the gateway URL", async () => {
    const { fn, calls } = makeFetch({ status: 200, body: { token: JWT } });
    await requestLoopbackPairToken("http://127.0.0.1:7830/", fn);
    expect(calls[0].url).toBe(`http://127.0.0.1:7830${LOOPBACK_PAIR_PATH}`);
  });

  test("throws PairError with the status on a non-2xx response", async () => {
    const { fn } = makeFetch({ status: 403 });
    await expect(
      requestLoopbackPairToken("http://127.0.0.1:7830", fn),
    ).rejects.toMatchObject({ name: "PairError", status: 403 });
  });

  test("throws PairError when the response has no token", async () => {
    const { fn } = makeFetch({ status: 200, body: {} });
    await expect(
      requestLoopbackPairToken("http://127.0.0.1:7830", fn),
    ).rejects.toBeInstanceOf(PairError);
  });
});

describe("requestSessionPairToken", () => {
  test("POSTs the session Bearer to /v1/pair/session and returns the minted token", async () => {
    const { fn, calls } = makeFetch({
      status: 200,
      body: {
        token: "narrow.minted.token",
        expiresAt: "2026-07-24T00:00:00.000Z",
        guardianId: "g-1",
        assistantId: "self",
      },
    });
    const result = await requestSessionPairToken(
      "https://manav.justcue.app",
      JWT,
      fn,
    );

    expect(result).toEqual({
      token: "narrow.minted.token",
      expiresAt: "2026-07-24T00:00:00.000Z",
      guardianId: "g-1",
      assistantId: "self",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://manav.justcue.app${SESSION_PAIR_PATH}`,
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${JWT}`);
    expect(headers["x-vellum-interface-id"]).toBe("chrome-extension");
    expect(calls[0].init.credentials).toBe("omit");
  });

  test("refuses to send the session token over http (never leaves the machine in plaintext)", async () => {
    const { fn, calls } = makeFetch({ status: 200, body: { token: JWT } });
    await expect(
      requestSessionPairToken("http://manav.justcue.app", JWT, fn),
    ).rejects.toBeInstanceOf(PairError);
    // The guard fires BEFORE any network call — the token is never transmitted.
    expect(calls).toHaveLength(0);
  });

  test("rejects a malformed session token without calling the network", async () => {
    const { fn, calls } = makeFetch({ status: 200, body: { token: JWT } });
    await expect(
      requestSessionPairToken("https://manav.justcue.app", "not-a-jwt", fn),
    ).rejects.toBeInstanceOf(PairError);
    expect(calls).toHaveLength(0);
  });

  test("maps a 401 from the gateway to a PairError carrying the status", async () => {
    const { fn } = makeFetch({ status: 401 });
    await expect(
      requestSessionPairToken("https://manav.justcue.app", JWT, fn),
    ).rejects.toMatchObject({ name: "PairError", status: 401 });
  });
});
