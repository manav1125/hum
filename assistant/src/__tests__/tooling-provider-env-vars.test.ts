import { afterEach, describe, expect, test } from "bun:test";

import {
  getAnyProviderEnvVar,
  getToolingProviderEnvKey,
  getToolingProviderEnvVar,
  TOOLING_API_KEY_PROVIDERS,
} from "../providers/provider-env-vars.js";
import { API_KEY_PROVIDERS } from "../providers/provider-secret-catalog.js";

describe("tooling provider env vars", () => {
  const saved: Record<string, string | undefined> = {};
  const trackedVars = ["REPLICATE_API_TOKEN", "APIFY_API_TOKEN", "APIFY_TOKEN"];

  function clearVars() {
    for (const v of trackedVars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  }

  afterEach(() => {
    for (const v of trackedVars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  test("canonical env var names", () => {
    expect(getToolingProviderEnvVar("replicate")).toBe("REPLICATE_API_TOKEN");
    expect(getToolingProviderEnvVar("apify")).toBe("APIFY_API_TOKEN");
    expect(getToolingProviderEnvVar("unknown")).toBeUndefined();
  });

  test("getAnyProviderEnvVar includes tooling providers", () => {
    expect(getAnyProviderEnvVar("replicate")).toBe("REPLICATE_API_TOKEN");
    expect(getAnyProviderEnvVar("apify")).toBe("APIFY_API_TOKEN");
  });

  test("replicate token resolves from REPLICATE_API_TOKEN", () => {
    clearVars();
    process.env.REPLICATE_API_TOKEN = "r8_test";
    expect(getToolingProviderEnvKey("replicate")).toBe("r8_test");
  });

  test("apify token resolves from canonical name first", () => {
    clearVars();
    process.env.APIFY_API_TOKEN = "apify_canonical";
    process.env.APIFY_TOKEN = "apify_alias";
    expect(getToolingProviderEnvKey("apify")).toBe("apify_canonical");
  });

  test("apify token falls back to APIFY_TOKEN alias", () => {
    clearVars();
    process.env.APIFY_TOKEN = "apify_alias_only";
    expect(getToolingProviderEnvKey("apify")).toBe("apify_alias_only");
  });

  test("returns undefined when no env var set", () => {
    clearVars();
    expect(getToolingProviderEnvKey("replicate")).toBeUndefined();
    expect(getToolingProviderEnvKey("apify")).toBeUndefined();
  });

  test("replicate and apify are registered as known API-key providers", () => {
    expect(API_KEY_PROVIDERS).toContain("replicate");
    expect(API_KEY_PROVIDERS).toContain("apify");
    expect([...TOOLING_API_KEY_PROVIDERS].sort()).toEqual([
      "apify",
      "replicate",
    ]);
  });

  test("API_KEY_PROVIDERS contains no duplicates", () => {
    const set = new Set(API_KEY_PROVIDERS);
    expect(set.size).toBe(API_KEY_PROVIDERS.length);
  });
});
