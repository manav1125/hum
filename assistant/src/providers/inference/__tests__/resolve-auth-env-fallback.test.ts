import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * Regression coverage for the Docker/Render self-host inference auth path.
 *
 * The canonical `openrouter` / `anthropic-personal` connections store
 * `auth.type === "api_key"` with an EXPLICIT credential key
 * (`credential/<provider>/api_key`). In the single-tenant container deploy the
 * boot-time socket seed of that credential can fail (daemon IPC not yet
 * accepting), leaving the secure store empty. The provider env var
 * (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY`) is always present there, so
 * `resolveAuth` must fall back to it instead of returning
 * `credential_not_found` — otherwise every inference call has no key and the
 * turn hangs / 401s.
 */

// Mock secure-keys so we control what the store returns. We mirror the real
// env-var fallback in getProviderKeyAsync so the test exercises the actual
// resolution semantics resolveAuth depends on.
let _storeValue: string | undefined;
const _providerEnv: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => _storeValue,
  getProviderKeyAsync: async (provider: string) => {
    if (_storeValue) return _storeValue;
    const envVar = _providerEnv[provider];
    return envVar ? process.env[envVar] : undefined;
  },
}));

import { resolveAuth } from "../resolve-auth.js";

afterEach(() => {
  _storeValue = undefined;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("resolveAuth — api_key env-var fallback", () => {
  test("uses the secure store value when present", async () => {
    _storeValue = "sk-stored";
    process.env.OPENROUTER_API_KEY = "sk-env-should-be-ignored";

    const r = await resolveAuth(
      { type: "api_key", credential: "credential/openrouter/api_key" },
      "openrouter",
    );

    expect(r.ok).toBe(true);
    if (r.ok && r.resolved.kind === "header") {
      expect(r.resolved.headers.Authorization).toBe("Bearer sk-stored");
    } else {
      throw new Error("expected header auth");
    }
  });

  test("falls back to the provider env var when the store is empty", async () => {
    _storeValue = undefined;
    process.env.OPENROUTER_API_KEY = "sk-env-or";

    const r = await resolveAuth(
      { type: "api_key", credential: "credential/openrouter/api_key" },
      "openrouter",
    );

    expect(r.ok).toBe(true);
    if (r.ok && r.resolved.kind === "header") {
      expect(r.resolved.headers.Authorization).toBe("Bearer sk-env-or");
    } else {
      throw new Error("expected header auth");
    }
  });

  test("falls back for anthropic too", async () => {
    _storeValue = undefined;
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";

    const r = await resolveAuth(
      { type: "api_key", credential: "credential/anthropic/api_key" },
      "anthropic",
    );

    expect(r.ok).toBe(true);
    if (r.ok && r.resolved.kind === "header") {
      expect(r.resolved.headers.Authorization).toBe("Bearer sk-ant-env");
    } else {
      throw new Error("expected header auth");
    }
  });

  test("reports credential_not_found when neither store nor env has a key", async () => {
    _storeValue = undefined;
    // no env var set

    const r = await resolveAuth(
      { type: "api_key", credential: "credential/openrouter/api_key" },
      "openrouter",
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("credential_not_found");
    }
  });
});
