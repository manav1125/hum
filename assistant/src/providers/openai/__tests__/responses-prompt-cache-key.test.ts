/**
 * `prompt_cache_key` emission on the OpenAI Responses transport (adopted from
 * upstream 473f1b5a8f): every direct-API model receives the per-conversation
 * key so OpenAI's cache router has a stable affinity key, in implicit caching
 * mode as much as explicit mode. Only the Codex subscription endpoint — which
 * rejects extra params — skips it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../../types.js";

// ---------------------------------------------------------------------------
// Mock openai module — must be before importing the provider. Spread the real
// module so named exports survive for every later file in the run; statics
// (e.g. `OpenAI.APIError`) are copied onto the mock class for the same reason.
// ---------------------------------------------------------------------------

interface FakeStreamEvent {
  type: string;
  [key: string]: unknown;
}

let fakeStreamEvents: FakeStreamEvent[] = [];
let lastStreamParams: Record<string, unknown> | null = null;

const actualOpenAIModule = await import("openai");

class MockOpenAI {
  responses = {
    create: async (params: Record<string, unknown>) => {
      lastStreamParams = params;
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const event of fakeStreamEvents) {
            yield event;
          }
        },
      };
    },
  };
}
Object.assign(MockOpenAI, actualOpenAIModule.default);

mock.module("openai", () => ({
  ...actualOpenAIModule,
  default: MockOpenAI,
}));

// Import after mocking
import { OpenAIResponsesProvider } from "../responses-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completedEvent(model: string): FakeStreamEvent {
  return {
    type: "response.completed",
    response: {
      model,
      status: "completed",
      output: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

beforeEach(() => {
  lastStreamParams = null;
  fakeStreamEvents = [
    { type: "response.output_text.delta", delta: "hi" },
    completedEvent("gpt-5.5"),
  ];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAI Responses prompt_cache_key", () => {
  test("sends prompt_cache_key for a direct-API model when the config carries one", async () => {
    // GIVEN a direct-API provider on an implicit-caching model
    const provider = new OpenAIResponsesProvider("test-key", "gpt-5.5");

    // WHEN a send carries the per-conversation key
    await provider.sendMessage([userMsg("hello")], {
      config: { promptCacheKey: "conv-abc-123" },
    });

    // THEN the wire request carries the routing-affinity key
    expect(lastStreamParams?.prompt_cache_key).toBe("conv-abc-123");
  });

  test("omits prompt_cache_key when the config carries none", async () => {
    const provider = new OpenAIResponsesProvider("test-key", "gpt-5.5");

    await provider.sendMessage([userMsg("hello")], { config: {} });

    expect(lastStreamParams).not.toBeNull();
    expect("prompt_cache_key" in (lastStreamParams ?? {})).toBe(false);
  });

  test("skips prompt_cache_key on the Codex subscription endpoint", async () => {
    // GIVEN the Codex subscription transport, which rejects extra params
    const provider = new OpenAIResponsesProvider("test-key", "gpt-5.6-sol", {
      codexSubscription: true,
    });

    // WHEN a send carries the per-conversation key
    await provider.sendMessage([userMsg("hello")], {
      config: { promptCacheKey: "conv-abc-123" },
    });

    // THEN the key never reaches the wire
    expect(lastStreamParams).not.toBeNull();
    expect("prompt_cache_key" in (lastStreamParams ?? {})).toBe(false);
  });
});
