/**
 * Verifies that `GET /v1/config` tells a client whether an image can be
 * attached — and that the answer follows the model that will actually serve
 * the turn plus vision-tier routing, not the model id sitting in the profile.
 *
 * The per-profile `supportsVision` flag is still emitted alongside, as a plain
 * fact about the profile's own model. It is not the attachment gate.
 */

import { describe, expect, mock, test } from "bun:test";

import { LLMSchema } from "../config/schemas/llm.js";
import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// ---------------------------------------------------------------------------
// Mocks for handleGetConfig's transitive deps
// ---------------------------------------------------------------------------

let rawConfig: Record<string, unknown> = {};

const actualLoader = await import("../config/loader.js");

/**
 * `getConfig()` returns the *parsed* config in production (schema defaults
 * applied, e.g. `llm.visionTier`), and the image-input resolution runs against
 * that shape. Parsing here rather than handing back `rawConfig` keeps the
 * fixture honest — a raw object would send the resolver down its fail-open
 * catch and every case would report `true`.
 */
mock.module("../config/loader.js", () => ({
  ...actualLoader,
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: () => {},
  deepMergeOverwrite: () => {},
  getConfig: () => ({
    ...rawConfig,
    llm: LLMSchema.parse(rawConfig.llm ?? {}),
  }),
  getDeploymentContextDefaults: () => ({}),
  fillContextDefaultsForMissingKeys: () => {},
  invalidateConfigCache: () => {},
  setNestedValue: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  validateAllowlistFile: () => null,
}));

import { ROUTES } from "../runtime/routes/conversation-query-routes.js";

const configGetRoute = ROUTES.find((r) => r.operationId === "config_get")!;

interface WireConfig {
  llm?: {
    imageInputSupported?: boolean;
    profiles?: Record<
      string,
      { supportsVision?: boolean; imageInputSupported?: boolean }
    >;
  };
}

function getConfigWire(): WireConfig {
  return configGetRoute.handler({}) as WireConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/config image-input support", () => {
  test("a text-only brain still accepts images — vision routing reads them", () => {
    // The reported bug, in its production shape: the brain cannot read an
    // image, so the composer refused one, while the daemon would have routed
    // the round to a model that could.
    rawConfig = {
      llm: {
        profiles: {
          brain: { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
        },
        activeProfile: "brain",
      },
    };

    const wire = getConfigWire();
    expect(wire.llm?.profiles?.brain?.supportsVision).toBe(false);
    expect(wire.llm?.profiles?.brain?.imageInputSupported).toBe(true);
    expect(wire.llm?.imageInputSupported).toBe(true);
  });

  test("a workspace with no vision path anywhere reports false", () => {
    rawConfig = {
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        profiles: { local: { provider: "ollama", model: "llama3.2" } },
        activeProfile: "local",
      },
    };

    const wire = getConfigWire();
    expect(wire.llm?.profiles?.local?.imageInputSupported).toBe(false);
    expect(wire.llm?.imageInputSupported).toBe(false);
  });

  test("turning vision routing off is honoured", () => {
    rawConfig = {
      llm: {
        profiles: {
          brain: { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
        },
        activeProfile: "brain",
        visionTier: { enabled: false },
      },
    };

    expect(getConfigWire().llm?.profiles?.brain?.imageInputSupported).toBe(
      false,
    );
  });

  test("the flag is answered per profile", () => {
    rawConfig = {
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        profiles: {
          local: { provider: "ollama", model: "llama3.2" },
          cloud: { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
        },
        activeProfile: "local",
      },
    };

    const profiles = getConfigWire().llm?.profiles;
    expect(profiles?.local?.imageInputSupported).toBe(false);
    expect(profiles?.cloud?.imageInputSupported).toBe(true);
  });

  test("profile with a vision-capable model gets supportsVision: true", () => {
    rawConfig = {
      llm: {
        profiles: {
          "test-vision": { provider: "anthropic", model: "claude-opus-4-6" },
        },
      },
    };

    const profiles = getConfigWire().llm?.profiles;
    expect(profiles?.["test-vision"]?.supportsVision).toBe(true);
    expect(profiles?.["test-vision"]?.imageInputSupported).toBe(true);
  });

  test("profile with an unknown model defaults supportsVision to true (fail-open)", () => {
    rawConfig = {
      llm: {
        profiles: {
          "test-unknown": {
            provider: "anthropic",
            model: "some-unknown-model-xyz",
          },
        },
      },
    };

    const profiles = getConfigWire().llm?.profiles;
    expect(profiles?.["test-unknown"]?.supportsVision).toBe(true);
    expect(profiles?.["test-unknown"]?.imageInputSupported).toBe(true);
  });

  test("profile without provider/model is left without supportsVision", () => {
    rawConfig = { llm: { profiles: { "test-empty": {} } } };

    const profiles = getConfigWire().llm?.profiles;
    expect(profiles?.["test-empty"]?.supportsVision).toBeUndefined();
    // The attachment answer is still given: an empty profile inherits
    // `llm.default`, which is a resolvable path like any other.
    expect(profiles?.["test-empty"]?.imageInputSupported).toBe(true);
  });
});
