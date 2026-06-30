import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  GatewayTokenError,
  clearGatewayToken,
  ensureGatewayToken,
  isRepairableGatewayTokenError,
} from "@/lib/auth/gateway-session";

const realFetch = globalThis.fetch;

beforeEach(() => {
  // The token cache is module-level; start every test with no cached token so
  // `ensureGatewayToken` always reaches the mint.
  clearGatewayToken();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearGatewayToken();
});

describe("ensureGatewayToken mint failure", () => {
  test("throws a GatewayTokenError carrying the response status on a 401", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof fetch;

    const err = await ensureGatewayToken(
      "/assistant/__gateway/20100/auth/token",
      "guardian-token",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayTokenError);
    expect((err as GatewayTokenError).status).toBe(401);
  });

  test("preserves a non-401 status (e.g. 403 boundary refusal)", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch;

    const err = await ensureGatewayToken(
      "/assistant/__gateway/20100/auth/token",
      "guardian-token",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayTokenError);
    expect((err as GatewayTokenError).status).toBe(403);
  });

  test("returns the minted token on success", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ token: "minted", expiresAt: 9_999_999_999 }),
    })) as unknown as typeof fetch;

    const token = await ensureGatewayToken(
      "/assistant/__gateway/20100/auth/token",
      "guardian-token",
    );
    expect(token).toBe("minted");
  });
});

describe("ensureGatewayToken source mismatch", () => {
  test("keeps a still-valid token when the source changes (lazy clear, no re-mint)", async () => {
    // Mint a token under source A (the local mint URL).
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ token: "tok-A", expiresAt: 9_999_999_999 }),
    })) as unknown as typeof fetch;
    const first = await ensureGatewayToken(
      "/assistant/__gateway/7831/auth/token",
      "guardian-token",
    );
    expect(first).toBe("tok-A");

    // Now ask again under a DIFFERENT source string (e.g. the page origin a
    // self-host seed would have stamped). The still-valid token must be reused,
    // NOT discarded and re-minted — re-minting would call fetch (and fail here).
    let reminted = false;
    globalThis.fetch = mock(async () => {
      reminted = true;
      return { ok: false, status: 500 };
    }) as unknown as typeof fetch;
    const second = await ensureGatewayToken("http://127.0.0.1:7831", "g");
    expect(second).toBe("tok-A");
    expect(reminted).toBe(false);
  });
});

describe("isRepairableGatewayTokenError", () => {
  test("true only for a 401 GatewayTokenError", () => {
    expect(isRepairableGatewayTokenError(new GatewayTokenError(401, "x"))).toBe(
      true,
    );
  });

  test("false for a 403 (boundary refusal) and 5xx (transient)", () => {
    expect(isRepairableGatewayTokenError(new GatewayTokenError(403, "x"))).toBe(
      false,
    );
    expect(isRepairableGatewayTokenError(new GatewayTokenError(500, "x"))).toBe(
      false,
    );
  });

  test("false for a plain Error or a non-error value", () => {
    expect(isRepairableGatewayTokenError(new Error("nope"))).toBe(false);
    expect(isRepairableGatewayTokenError(undefined)).toBe(false);
  });
});
