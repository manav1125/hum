/**
 * Regression test for the "no episodic/semantic memories since v2 was enabled"
 * bug.
 *
 * Root cause: when `memory.v2.enabled` is true the `graph_extract` job (which
 * writes typed nodes into `memory_graph_nodes`) was suppressed both at
 * enqueue time (`indexer.ts`) and at dispatch time (`jobs-worker.ts`). v2's
 * own capture path (buffer.md → concept pages) never classifies facts into the
 * episodic / semantic / emotional / behavioral / narrative / prospective
 * buckets the Memory page reads, so the graph store froze and every new
 * conversation produced zero non-procedural memory-items.
 *
 * The fix runs `graph_extract` under BOTH v1 and v2. This test proves that a
 * real extraction run under v2 lands episodic + semantic nodes in the graph
 * store AND that the memory-item list handler (what the Memory page calls)
 * returns them — i.e. it asserts an actual store write, not just a file write.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ProviderResponse } from "../../../providers/types.js";

// The extraction pipeline resolves a provider via `getConfiguredProvider`.
// Return a stub whose forced-tool `sendMessage` yields a fixed
// `extract_graph_diff` tool call containing one episodic and one semantic
// node. `extractToolUse`/`userMessage` keep their real implementations.
const EXTRACT_TOOL_INPUT = {
  create_nodes: [
    {
      content: "We stayed up late getting the deploy pipeline green.",
      type: "episodic",
      emotional_charge: {
        valence: 0.4,
        intensity: 0.5,
        decay_curve: "linear",
        decay_rate: 0.05,
      },
      significance: 0.6,
      confidence: 0.9,
      source_type: "direct",
    },
    {
      content: "User prefers TypeScript over JavaScript for new services.",
      type: "semantic",
      emotional_charge: {
        valence: 0.2,
        intensity: 0.1,
        decay_curve: "linear",
        decay_rate: 0.05,
      },
      significance: 0.5,
      confidence: 0.95,
      source_type: "direct",
    },
  ],
  reinforce_node_ids: [],
};

const stubProvider = {
  async sendMessage(): Promise<ProviderResponse> {
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

// Candidate search embeds the transcript via `embedWithRetry`. In the test
// environment there is no embedding backend, so make it throw — extraction is
// designed to continue without candidates when embedding fails.
mock.module("../../embed.js", () => ({
  embedWithRetry: async () => {
    throw new Error("no embedding backend in test");
  },
}));

// New nodes enqueue an embed job (fire-and-forget). Stub the graph-search
// embed enqueues so the test needs no Qdrant/jobs worker.
mock.module("../graph-search.js", () => ({
  enqueueGraphNodeEmbed: () => {},
  enqueueGraphTriggerEmbed: () => {},
  searchGraphNodes: async () => [],
  embedGraphNodeDirect: async () => {},
}));

const { getDb, getMemoryDb } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { resetTestMemoryTables, resetTestTables } =
  await import("../../raw-query.js");
const { conversations, messages, memoryGraphNodes } =
  await import("../../schema.js");
const { applyNestedDefaults } = await import("../../../config/loader.js");
const { graphExtractJob } = await import("../extraction-job.js");

beforeEach(() => {
  initializeDb();
  resetTestMemoryTables("memory_graph_nodes");
  resetTestTables("messages", "conversations", "memory_checkpoints");
});

function buildConfig() {
  const config = applyNestedDefaults({});
  config.memory.enabled = true;
  // The whole point: v2 is ON, the default for new users.
  config.memory.v2.enabled = true;
  config.memory.extraction.useLLM = true;
  return config;
}

function seedConversation(conversationId: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({ id: conversationId, createdAt: now, updatedAt: now })
    .run();

  const transcript = [
    "We spent the evening getting the deploy pipeline green — it took hours.",
    "For the new services I'd rather we standardize on TypeScript, not plain JS.",
    "Sounds good, I'll note both of those.",
  ];
  transcript.forEach((text, i) => {
    db.insert(messages)
      .values({
        id: `${conversationId}-msg-${i}`,
        conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: now + i,
      })
      .run();
  });
}

describe("graph_extract under memory.v2.enabled", () => {
  test("creates episodic + semantic graph nodes the Memory page can read", async () => {
    const conversationId = "conv-v2-extract";
    seedConversation(conversationId);
    const config = buildConfig();

    // Sanity: v2 is enabled and the store starts empty.
    expect(config.memory.v2.enabled).toBe(true);
    expect(getMemoryDb().select().from(memoryGraphNodes).all()).toHaveLength(0);

    await graphExtractJob(
      {
        id: "job-1",
        type: "graph_extract",
        payload: { conversationId, scopeId: "default" },
      } as never,
      config,
    );

    // The extraction run must have written typed nodes into the graph store —
    // the store the memory-item route reads.
    const rows = getMemoryDb().select().from(memoryGraphNodes).all();
    const byType = new Map(rows.map((r) => [r.type, r]));
    expect(byType.has("episodic")).toBe(true);
    expect(byType.has("semantic")).toBe(true);
    expect(byType.get("episodic")!.content).toContain("deploy pipeline");
    expect(byType.get("semantic")!.content).toContain("TypeScript");

    // And the Memory page's list handler surfaces them (non-procedural counts
    // are no longer stuck at zero).
    const { ROUTES } =
      await import("../../../runtime/routes/memory-item-routes.js");
    const listRoute = ROUTES.find((r) => r.operationId === "listMemoryItems")!;
    const result = (await listRoute.handler({ queryParams: {} })) as {
      items: Array<{ kind: string }>;
      kindCounts: Record<string, number>;
    };
    expect(result.kindCounts.episodic).toBeGreaterThanOrEqual(1);
    expect(result.kindCounts.semantic).toBeGreaterThanOrEqual(1);
  });
});
