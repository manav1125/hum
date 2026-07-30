/**
 * B1 regression guard: a self-host instance provisioned with nothing but an
 * `OPENROUTER_API_KEY` must never resolve to a model that key cannot serve.
 *
 * HQ provisions exactly that — one OpenRouter key — so whatever the resolver's
 * built-in fallback says is what every call site on a freshly provisioned
 * instance actually runs. The fallback used to name `anthropic/claude-sonnet-4.5`
 * / `anthropic/claude-haiku-4.5`, which the platform OpenRouter account is
 * ToS-blocked from: both return HTTP 403 "prohibited due to a violation of
 * provider Terms Of Service". Every new user's first message failed.
 *
 * The resolver reads `OPENROUTER_API_KEY` per call, so these tests set it in
 * `beforeEach` and restore the ambient value afterwards. An earlier revision of
 * this file set it once at module scope to satisfy a module-load constant, and
 * the tests then passed alone but failed inside the suite — whichever file
 * imported the resolver first decided whether the force was armed at all.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_OPENROUTER_FLASH_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  resolveCallSiteConfig,
} from "../llm-resolver.js";
import { LLMSchema } from "../schemas/llm.js";

const AMBIENT_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
afterAll(() => {
  if (AMBIENT_OPENROUTER_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = AMBIENT_OPENROUTER_KEY;
  }
});

/** The un-seeded shape of a brand-new instance: no profiles, no call sites. */
function freshInstanceLlm() {
  return LLMSchema.parse({});
}

describe("self-host OpenRouter force (B1)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-b1";
    delete process.env.CUE_OPENROUTER_MODEL;
    delete process.env.CUE_OPENROUTER_FLASH_MODEL;
    // The direct-BYO routes are checked before the force and would short-
    // circuit it; a provisioned instance has none of them set.
    delete process.env.CUE_ANTHROPIC_CALLSITES;
    delete process.env.CUE_OPENAI_CALLSITES;
  });

  test("a bare OPENROUTER_API_KEY instance resolves no anthropic/* model", () => {
    const llm = freshInstanceLlm();
    // A representative spread: the strong tier, plus flash call sites that
    // drive first-run UX (the greeting a new user actually sees first).
    for (const callSite of [
      "mainAgent",
      "conversationTitle",
      "homeGreeting",
      "emptyStateGreeting",
      "identityIntro",
    ] as const) {
      const resolved = resolveCallSiteConfig(callSite, llm);
      expect(resolved.provider).toBe("openrouter");
      // The assertion that matters: not merely "some model", but not one of
      // the families this key is blocked from.
      expect(resolved.model).not.toMatch(/^(anthropic|openai)\//i);
      expect(resolved.model).toBe(
        callSite === "mainAgent"
          ? DEFAULT_OPENROUTER_MODEL
          : DEFAULT_OPENROUTER_FLASH_MODEL,
      );
    }
  });

  test("the force also rewrites a profile pinned to a blocked model", () => {
    // Simulates an instance whose config was seeded (or hand-edited) onto the
    // blocked family: provider is already correct, so only the model check can
    // catch it.
    const llm = LLMSchema.parse({
      activeProfile: "blocked",
      profiles: {
        blocked: {
          provider: "openrouter",
          provider_connection: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
        },
      },
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).not.toMatch(/^anthropic\//i);
  });

  test("CUE_OPENROUTER_MODEL overrides the built-in default", () => {
    process.env.CUE_OPENROUTER_MODEL = "moonshotai/kimi-k3";
    process.env.CUE_OPENROUTER_FLASH_MODEL = "z-ai/glm-5.2";
    const llm = freshInstanceLlm();
    expect(resolveCallSiteConfig("mainAgent", llm).model).toBe(
      "moonshotai/kimi-k3",
    );
    expect(resolveCallSiteConfig("conversationTitle", llm).model).toBe(
      "z-ai/glm-5.2",
    );
  });

  test("the seeded managed pair is re-pinned to the current env", () => {
    // An instance seeded with the default pair, then re-pointed by an operator
    // via HQ env: the config on disk still says the old model, and the env must
    // win at call time.
    process.env.CUE_OPENROUTER_MODEL = "moonshotai/kimi-k3";
    const llm = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: {
        balanced: {
          provider: "openrouter",
          provider_connection: "openrouter",
          model: DEFAULT_OPENROUTER_MODEL,
        },
      },
    });
    expect(resolveCallSiteConfig("mainAgent", llm).model).toBe(
      "moonshotai/kimi-k3",
    );
  });

  test("an explicit BYO call-site route still bypasses the force", () => {
    // Guards the "anthropic for serious tasks" escape hatch: CUE_ANTHROPIC_
    // CALLSITES routes to Anthropic-direct on the operator's own key, which is
    // not subject to the OpenRouter ToS block, and must win over the force.
    process.env.CUE_ANTHROPIC_CALLSITES = "mainAgent";
    const resolved = resolveCallSiteConfig("mainAgent", freshInstanceLlm());
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-sonnet-4-6");
  });
});
