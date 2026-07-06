import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createCustomerKey,
  deleteKey,
  disableKey,
  getKey,
  isOpenRouterConfigured,
  provisionLlmKey,
  updateKeyLimit,
} from "../openrouter.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENROUTER_PROVISIONING_KEY", "OPENROUTER_SHARED_KEY"];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Records every call and answers with the provisioning-API shapes. */
function mockOpenRouter() {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    });
    if (init?.method === "POST") {
      return Response.json({
        key: "sk-or-v1-runtime-key",
        data: { hash: "kh_123", name: "cue-test", disabled: false, limit: 2.5, usage: 0 },
      });
    }
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    return Response.json({
      data: { hash: "kh_123", name: "cue-test", disabled: init?.method === "PATCH", limit: 5, usage: 1.25 },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("not-configured mode", () => {
  test("every management call returns a typed error, never throws", async () => {
    expect(isOpenRouterConfigured()).toBe(false);
    const { fetchImpl, calls } = mockOpenRouter();
    expect(await createCustomerKey("n", 1, fetchImpl)).toEqual({
      ok: false,
      reason: "openrouter_not_configured",
    });
    expect((await updateKeyLimit("h", 1, fetchImpl)).ok).toBe(false);
    expect((await disableKey("h", fetchImpl)).ok).toBe(false);
    expect((await deleteKey("h", fetchImpl)).ok).toBe(false);
    expect((await getKey("h", fetchImpl)).ok).toBe(false);
    expect(calls.length).toBe(0); // nothing ever hits the network
  });

  test("provisionLlmKey falls back to the shared key, then to none", async () => {
    const { fetchImpl, calls } = mockOpenRouter();

    process.env.OPENROUTER_SHARED_KEY = "sk-or-shared";
    const shared = await provisionLlmKey("cue-x", 10, fetchImpl);
    expect(shared).toEqual({
      ok: true,
      apiKey: "sk-or-shared",
      keyHash: null,
      mode: "shared",
    });

    delete process.env.OPENROUTER_SHARED_KEY;
    const none = await provisionLlmKey("cue-x", 10, fetchImpl);
    expect(none).toEqual({ ok: true, keyHash: null, mode: "none" });
    expect(calls.length).toBe(0);
  });
});

describe("configured mode (mock fetch)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
  });

  test("createCustomerKey posts name + limit and returns key + hash", async () => {
    const { fetchImpl, calls } = mockOpenRouter();
    const result = await createCustomerKey("cue-ada-1234", 2.5, fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key).toBe("sk-or-v1-runtime-key");
    expect(result.info.hash).toBe("kh_123");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://openrouter.ai/api/v1/keys",
      body: { name: "cue-ada-1234", limit: 2.5 },
      auth: "Bearer pk_test",
    });
  });

  test("update / disable / delete hit the keyHash endpoints", async () => {
    const { fetchImpl, calls } = mockOpenRouter();
    await updateKeyLimit("kh_123", 27, fetchImpl);
    await disableKey("kh_123", fetchImpl);
    await deleteKey("kh_123", fetchImpl);
    expect(calls.map((c) => ({ method: c.method, url: c.url, body: c.body }))).toEqual([
      { method: "PATCH", url: "https://openrouter.ai/api/v1/keys/kh_123", body: { limit: 27 } },
      { method: "PATCH", url: "https://openrouter.ai/api/v1/keys/kh_123", body: { disabled: true } },
      { method: "DELETE", url: "https://openrouter.ai/api/v1/keys/kh_123", body: undefined },
    ]);
  });

  test("getKey parses limit + usage from the data envelope", async () => {
    const { fetchImpl } = mockOpenRouter();
    const result = await getKey("kh_123", fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info).toMatchObject({ hash: "kh_123", limit: 5, usage: 1.25 });
  });

  test("provisionLlmKey mints a capped child key", async () => {
    const { fetchImpl } = mockOpenRouter();
    const result = await provisionLlmKey("cue-x", 10, fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("provisioned");
    expect(result.apiKey).toBe("sk-or-v1-runtime-key");
    expect(result.keyHash).toBe("kh_123");
  });

  test("API errors surface as typed reasons", async () => {
    const fetch500 = (async (_input: RequestInfo | URL) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    const result = await createCustomerKey("n", 1, fetch500);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toStartWith("openrouter_error_500");
  });
});
