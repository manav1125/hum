/**
 * Memory-graph extraction must never put image content on the wire.
 *
 * The bug, from prod (2026-08-13): a photo taken during a live-voice call is
 * persisted as its own user message, so the conversation's rows carry an image
 * block from that moment on. End-of-call synthesis calls
 * `runGraphExtraction(conversationId, "default", config, { transcript })` with
 * a plain TEXT transcript — but extraction re-read the conversation from the DB
 * regardless and, on finding images, sent the multimodal message instead. The
 * `memoryExtraction` call site is a cost-optimized TEXT model, so the request
 * died with `This model (deepseek/deepseek-v4-pro) doesn't support image
 * input` (404), and every call containing a photo wrote nothing to memory
 * while logging one warn line nobody was reading.
 *
 * The invariant these tests hold: whatever the caller passes, and whatever the
 * conversation's rows contain, the provider receives text blocks only.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message, ProviderResponse } from "../../../providers/types.js";

/** Every `sendMessage` call the extraction run made, in order. */
const sentMessages: Message[][] = [];

const EXTRACT_TOOL_INPUT = {
  create_nodes: [
    {
      content: "User showed Cue the whiteboard from the offsite.",
      type: "episodic",
      emotional_charge: {
        valence: 0.2,
        intensity: 0.2,
        decay_curve: "linear",
        decay_rate: 0.05,
      },
      significance: 0.5,
      confidence: 0.9,
      source_type: "direct",
    },
  ],
  reinforce_node_ids: [],
};

const stubProvider = {
  async sendMessage(messages: Message[]): Promise<ProviderResponse> {
    sentMessages.push(messages);
    return {
      content: [
        {
          type: "tool_use",
          id: "toolu_extract_1",
          name: "extract_graph_diff",
          input: EXTRACT_TOOL_INPUT,
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as ProviderResponse;
  },
};

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => stubProvider,
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b) => b.type === "tool_use"),
  userMessage: (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  }),
}));

// Candidate search embeds the transcript; there is no embedding backend in
// tests and extraction is designed to continue without candidates.
mock.module("../../embed.js", () => ({
  embedWithRetry: async () => {
    throw new Error("no embedding backend in test");
  },
}));

mock.module("../graph-search.js", () => ({
  enqueueGraphNodeEmbed: () => {},
  enqueueGraphTriggerEmbed: () => {},
  searchGraphNodes: async () => [],
  embedGraphNodeDirect: async () => {},
}));

const { getDb } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { resetTestMemoryTables, resetTestTables } =
  await import("../../raw-query.js");
const { conversations, messages } = await import("../../schema.js");
const { applyNestedDefaults } = await import("../../../config/loader.js");
const { runGraphExtraction, stripImageContent } =
  await import("../extraction.js");

const CONVERSATION_ID = "conv-photo-extraction";

/** A 1x1 transparent PNG — the smallest thing that is unmistakably an image. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeEach(() => {
  initializeDb();
  resetTestMemoryTables("memory_graph_nodes");
  resetTestTables("messages", "conversations", "memory_checkpoints");
  sentMessages.length = 0;
});

/**
 * Seed a conversation shaped like a live-voice call with a photo in it: real
 * spoken turns, plus the camera's own user message carrying an image block
 * exactly as `live-voice-photo.ts` persists it.
 */
function seedConversationWithPhoto(): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({ id: CONVERSATION_ID, createdAt: now, updatedAt: now })
    .run();

  const rows: Array<{ role: string; content: unknown[] }> = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "We spent the whole offsite on the pricing model and finally landed on usage-based tiers.",
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "here's a photo:" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: TINY_PNG,
          },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Got it — usage-based tiers, and I can see the whiteboard. I'll remember both.",
        },
      ],
    },
  ];

  rows.forEach((row, i) => {
    db.insert(messages)
      .values({
        id: `${CONVERSATION_ID}-msg-${i}`,
        conversationId: CONVERSATION_ID,
        role: row.role,
        content: JSON.stringify(row.content),
        createdAt: now + i,
      })
      .run();
  });
}

function buildConfig() {
  const config = applyNestedDefaults({});
  config.memory.enabled = true;
  config.memory.extraction.useLLM = true;
  return config;
}

/** Every content block the provider was handed, across all messages. */
function blocksSentToProvider(): Array<{ type?: string }> {
  return sentMessages.flatMap((batch) =>
    batch.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as Array<{ type?: string }>)
        : [{ type: "text" }],
    ),
  );
}

describe("graph extraction is text-only on the wire", () => {
  test("a conversation containing a photo extracts without sending the image", async () => {
    seedConversationWithPhoto();

    const result = await runGraphExtraction(
      CONVERSATION_ID,
      "default",
      buildConfig(),
    );

    // It ran — this is the half the 404 was destroying.
    expect(sentMessages).toHaveLength(1);
    expect(result.nodesCreated).toBe(1);

    // And it ran on text alone.
    const blocks = blocksSentToProvider();
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(blocks.every((b) => b.type === "text")).toBe(true);
  });

  test("the photo's pointer tag survives so image_refs still have coordinates", async () => {
    seedConversationWithPhoto();

    await runGraphExtraction(CONVERSATION_ID, "default", buildConfig());

    const text = blocksSentToProvider()
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
    expect(text).toContain(`<image message_id="${CONVERSATION_ID}-msg-1"`);
    // The spoken content is still what extraction actually reads.
    expect(text).toContain("usage-based tiers");
  });

  test("a caller-supplied transcript is used verbatim, images and all", async () => {
    // The live-voice path: synthesis hands over a text transcript it built
    // from the thread. Extraction must take it at its word rather than
    // re-reading the conversation's own (image-bearing) rows.
    seedConversationWithPhoto();

    await runGraphExtraction(CONVERSATION_ID, "default", buildConfig(), {
      transcript:
        "User: We spent the whole offsite on the pricing model and finally landed on usage-based tiers.\n" +
        "Cue (me): Got it — usage-based tiers. I'll remember that.",
    });

    const blocks = blocksSentToProvider();
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    const text = blocks
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
    expect(text).toContain("usage-based tiers");
    expect(text).not.toContain("<image");
  });
});

describe("stripImageContent", () => {
  test("drops image blocks and keeps everything else in order", () => {
    const stripped = stripImageContent([
      { type: "text", text: "before" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: TINY_PNG },
      },
      { type: "text", text: "after" },
    ]);
    expect(stripped).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
  });

  test("is a no-op on text-only content", () => {
    const blocks = [
      { type: "text" as const, text: "a" },
      { type: "text" as const, text: "b" },
    ];
    expect(stripImageContent(blocks)).toEqual(blocks);
  });
});
