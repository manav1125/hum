/**
 * web-research bundled skill — key resolution + missing-key behavior.
 *
 * Verifies the WS2 non-regression contract: when no API key resolves, each
 * executor RETURNS a clean actionable error (isError result), never throws;
 * and the daemon-process env-var reading path (CUE_*_API_KEY) works.
 * No test here performs a live network call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";
import { resolveToolApiKey } from "../../_shared/tool-api-keys.js";
import { run as serperImages } from "../tools/serper-images.js";
import { run as serperSearch } from "../tools/serper-search.js";
import { run as tavilySearch } from "../tools/tavily-search.js";

const context = { conversationId: "test", workingDir: "/tmp" } as ToolContext;

const KEY_ENV_VARS = [
  "CUE_TAVILY_API_KEY",
  "CUE_FIRECRAWL_API_KEY",
  "CUE_SERPER_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of KEY_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEY_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolveToolApiKey", () => {
  test("missing key resolves to a clean actionable error (not a throw)", () => {
    const result = resolveToolApiKey("tavily", { config: {}, env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Tavily key not configured");
      expect(result.error).toContain("CUE_TAVILY_API_KEY");
    }
  });

  test("daemon config takes precedence over the env var", () => {
    const result = resolveToolApiKey("tavily", {
      config: { tavilyKey: "cfg-key" },
      env: { CUE_TAVILY_API_KEY: "env-key" },
    });
    expect(result).toEqual({ ok: true, key: "cfg-key" });
  });

  test("env var is the fallback when config has no key", () => {
    const result = resolveToolApiKey("serper", {
      config: {},
      env: { CUE_SERPER_API_KEY: "env-key" },
    });
    expect(result).toEqual({ ok: true, key: "env-key" });
  });

  test("reads the real daemon process env (CUE_*_API_KEY path)", () => {
    process.env.CUE_TAVILY_API_KEY = "process-env-key";
    const result = resolveToolApiKey("tavily");
    expect(result).toEqual({ ok: true, key: "process-env-key" });
  });

  test("blank/whitespace keys are treated as missing", () => {
    const result = resolveToolApiKey("firecrawl", {
      config: { firecrawlKey: "   " },
      env: { CUE_FIRECRAWL_API_KEY: "  " },
    });
    expect(result.ok).toBe(false);
  });
});

describe("executors with a missing key", () => {
  test("tavily_search returns the clean error and does not throw", async () => {
    const result = await tavilySearch({ query: "latest ai news" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Tavily key not configured");
    expect(result.content).toContain("CUE_TAVILY_API_KEY");
  });

  test("serper_search returns the clean error and does not throw", async () => {
    const result = await serperSearch({ query: "best crm" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Serper key not configured");
    expect(result.content).toContain("CUE_SERPER_API_KEY");
  });

  test("serper_images returns the clean error and does not throw", async () => {
    const result = await serperImages({ query: "red panda" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Serper key not configured");
    expect(result.content).toContain("CUE_SERPER_API_KEY");
  });
});

describe("input validation (before any key or network use)", () => {
  test("tavily_search rejects an empty query", async () => {
    const result = await tavilySearch({ query: "  " }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  });

  test("serper_search rejects a missing query", async () => {
    const result = await serperSearch({}, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  });

  test("serper_images rejects a missing query", async () => {
    const result = await serperImages({}, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  });
});
