/**
 * `RetryProvider` derivation of the per-conversation `promptCacheKey` from
 * `selectionSeed` (adopted from upstream 473f1b5a8f): stamped only for
 * providers whose transport consumes it as the OpenAI `prompt_cache_key`
 * request param, with `selectionSeed` itself still stripped from the wire
 * config, and an explicit caller-set key always winning.
 */

import { describe, expect, test } from "bun:test";

import { RetryProvider } from "../retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

const DUMMY_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function makeProvider(
  name: string,
  onCall: (options: SendMessageOptions | undefined) => void,
): Provider {
  return {
    name,
    async sendMessage(
      _messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      onCall(options);
      return {
        content: [{ type: "text", text: "ok" }],
        model: "test-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function seenConfig(options: SendMessageOptions | undefined) {
  return (options?.config ?? {}) as Record<string, unknown>;
}

describe("RetryProvider promptCacheKey stamping", () => {
  test("copies selectionSeed into promptCacheKey for the openai provider", async () => {
    // GIVEN a send on the openai transport carrying the conversation seed
    let seen: SendMessageOptions | undefined;
    const provider = new RetryProvider(
      makeProvider("openai", (o) => (seen = o)),
    );

    // WHEN the options are normalized
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { selectionSeed: "conv-42" },
    });

    // THEN the wire config carries the cache key and the seed is stripped
    expect(seenConfig(seen).promptCacheKey).toBe("conv-42");
    expect(seenConfig(seen).selectionSeed).toBeUndefined();
  });

  test("an explicit caller-set promptCacheKey wins over the seed", async () => {
    let seen: SendMessageOptions | undefined;
    const provider = new RetryProvider(
      makeProvider("openai", (o) => (seen = o)),
    );

    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { selectionSeed: "conv-42", promptCacheKey: "pinned-key" },
    });

    expect(seenConfig(seen).promptCacheKey).toBe("pinned-key");
  });

  test("does not stamp promptCacheKey for providers whose clients never read it", async () => {
    // GIVEN a send on a chat-completions transport that spreads no cache key
    let seen: SendMessageOptions | undefined;
    const provider = new RetryProvider(
      makeProvider("fireworks", (o) => (seen = o)),
    );

    // WHEN the options are normalized
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { selectionSeed: "conv-42" },
    });

    // THEN no non-wire field is created for a client that would leak it
    expect(seenConfig(seen).promptCacheKey).toBeUndefined();
    expect(seenConfig(seen).selectionSeed).toBeUndefined();
  });
});
