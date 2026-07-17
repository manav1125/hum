import { afterEach, describe, expect, test } from "bun:test";

import { envProviderRouting } from "../openrouter/client.js";

const ENV_KEYS = [
  "CUE_OPENROUTER_PROVIDER_ORDER",
  "CUE_OPENROUTER_PROVIDER_ALLOW_FALLBACKS",
  "CUE_OPENROUTER_PROVIDER_REQUIRE_PARAMS",
  "CUE_OPENROUTER_MODEL",
  "CUE_OPENROUTER_FLASH_MODEL",
] as const;

const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

describe("envProviderRouting", () => {
  test("returns nothing when no env routing is configured", () => {
    setEnv({});
    expect(envProviderRouting("deepseek/deepseek-v4-flash")).toEqual({});
  });

  test("applies the operator pin to the configured brain models", () => {
    setEnv({
      CUE_OPENROUTER_PROVIDER_ORDER: "DeepInfra,StreamLake,GMICloud",
      CUE_OPENROUTER_PROVIDER_ALLOW_FALLBACKS: "false",
      CUE_OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
      CUE_OPENROUTER_FLASH_MODEL: "deepseek/deepseek-v4-flash",
    });
    expect(envProviderRouting("deepseek/deepseek-v4-flash")).toEqual({
      order: ["DeepInfra", "StreamLake", "GMICloud"],
      allow_fallbacks: false,
    });
  });

  test("does NOT leak the brain's provider pool onto a call site that overrides the model", () => {
    // The regression this guards: the pool was pinned for DeepSeek's providers
    // with allow_fallbacks:false. None of them serve the vision model, so
    // inheriting the pin made OpenRouter answer `404 No endpoints found` and
    // every Cue Live "Look" came back empty.
    setEnv({
      CUE_OPENROUTER_PROVIDER_ORDER: "DeepInfra,StreamLake,GMICloud",
      CUE_OPENROUTER_PROVIDER_ALLOW_FALLBACKS: "false",
      CUE_OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
      CUE_OPENROUTER_FLASH_MODEL: "deepseek/deepseek-v4-flash",
    });
    expect(envProviderRouting("qwen/qwen2.5-vl-72b-instruct")).toEqual({});
  });

  test("keeps the blanket pin when no brain model is configured", () => {
    setEnv({
      CUE_OPENROUTER_PROVIDER_ORDER: "DeepInfra",
      CUE_OPENROUTER_PROVIDER_REQUIRE_PARAMS: "true",
    });
    expect(envProviderRouting("any/model")).toEqual({
      order: ["DeepInfra"],
      require_parameters: true,
    });
  });

  test("applies the pin when the caller does not name a model", () => {
    setEnv({
      CUE_OPENROUTER_PROVIDER_ORDER: "DeepInfra",
      CUE_OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
    });
    expect(envProviderRouting()).toEqual({ order: ["DeepInfra"] });
  });
});
