/**
 * Unit tests for the generateMeetingRecap service.
 *
 * The service is driven directly (no HTTP routing). Memory CRUD, the graph
 * store, the provider abstraction, and the config loader are mocked so the
 * tests exercise the stub path, the live (forced-tool) path, and the
 * unconfigured-provider path without any DB or LLM spend.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../../../providers/types.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Memory CRUD ──────────────────────────────────────────────────────
const MEETING_CONV_ID = "meeting-conv-1";
const mockCreateConversation = mock((_opts?: Record<string, unknown>) => ({
  id: MEETING_CONV_ID,
}));
const mockAddMessage = mock(async () => ({ id: "msg-1" }));

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConversationCrud =
  await import("../../../memory/conversation-crud.js");
mock.module("../../../memory/conversation-crud.js", () => ({
  ...actualConversationCrud,
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
}));

// ── Graph store (applyDiff) ──────────────────────────────────────────
interface CapturedDiff {
  createNodes: Array<{ sourceConversations: string[]; content: string }>;
}
let capturedApplyDiff: CapturedDiff | null = null;
const mockApplyDiff = mock(
  (diff: CapturedDiff, _opts?: Record<string, unknown>) => {
    capturedApplyDiff = diff;
    return {
      nodesCreated: diff.createNodes.length,
      nodesUpdated: 0,
      nodesDeleted: 0,
      edgesCreated: 0,
      edgesDeleted: 0,
      triggersCreated: 0,
      triggersDeleted: 0,
      nodesReinforced: 0,
      createdNodeIds: diff.createNodes.map((_n, i) => `node-${i}`),
    };
  },
);

mock.module("../../../memory/graph/store.js", () => ({
  applyDiff: mockApplyDiff,
}));

// ── Provider abstraction ─────────────────────────────────────────────
let providerToReturn: {
  sendMessage: (
    messages: Message[],
    options?: SendMessageOptions,
  ) => Promise<ProviderResponse>;
} | null = null;
const mockGetConfiguredProvider = mock(async () => providerToReturn);

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: mockGetConfiguredProvider,
  // Re-implement the small pure helpers the service uses so the live path
  // works without pulling the real provider module.
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b) => b.type === "tool_use"),
  userMessage: (text: string): Message => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

// ── Config loader + graph extraction (live path side effects) ────────
// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../../../config/loader.js");
mock.module("../../../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => ({}) as Record<string, unknown>,
}));
const mockRunGraphExtraction = mock(async () => ({
  nodesCreated: 0,
  nodesUpdated: 0,
  nodesReinforced: 0,
  edgesCreated: 0,
  triggersCreated: 0,
}));
mock.module("../../../memory/graph/extraction.js", () => ({
  runGraphExtraction: mockRunGraphExtraction,
}));

import { generateMeetingRecap } from "../meeting-recap.js";

const TRANSCRIPT =
  "Alice: Let's lock pricing for the Q3 renewal. Bob: Agreed, pricing stays. " +
  "Alice: I'll share the forecast before legal review. Bob: I still need the deck.";

beforeEach(() => {
  mockCreateConversation.mockClear();
  mockAddMessage.mockClear();
  mockApplyDiff.mockClear();
  mockGetConfiguredProvider.mockClear();
  mockRunGraphExtraction.mockClear();
  capturedApplyDiff = null;
  providerToReturn = null;
  delete process.env.RECAP_STUB;
});

afterEach(() => {
  delete process.env.RECAP_STUB;
});

describe("generateMeetingRecap — validation", () => {
  test("returns BAD_REQUEST for an empty transcript", async () => {
    const result = await generateMeetingRecap("   ");
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("BAD_REQUEST");
    expect(result.error.status).toBe(400);
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });
});

describe("generateMeetingRecap — stub path", () => {
  test("returns a valid RecapJson and writes memory nodes tagged with the meeting conversation", async () => {
    process.env.RECAP_STUB = "1";

    const result = await generateMeetingRecap(TRANSCRIPT, {
      title: "Acme sync",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");

    // RecapJson shape.
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(result.actionItems)).toBe(true);
    expect(result.actionItems.length).toBeGreaterThan(0);
    for (const item of result.actionItems) {
      expect(typeof item.text).toBe("string");
      expect(typeof item.done).toBe("boolean");
      expect(item.owner === null || typeof item.owner === "string").toBe(true);
    }
    expect(Array.isArray(result.decisions)).toBe(true);
    expect(Array.isArray(result.people)).toBe(true);
    expect(typeof result.tone).toBe("string");

    // Wired to the freshly-created meeting conversation.
    expect(result.conversationId).toBe(MEETING_CONV_ID);
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Acme sync", source: "meeting" }),
    );
    expect(mockAddMessage).toHaveBeenCalledTimes(1);

    // memoryNodeIds come from applyDiff's createdNodeIds.
    expect(result.memoryNodeIds.length).toBeGreaterThan(0);

    // Every written node is tagged with the meeting conversation id.
    expect(capturedApplyDiff).not.toBeNull();
    const nodes = capturedApplyDiff?.createNodes ?? [];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.sourceConversations).toContain(MEETING_CONV_ID);
    }

    // The stub must NOT call the provider.
    expect(mockGetConfiguredProvider).not.toHaveBeenCalled();
  });
});

describe("generateMeetingRecap — live path", () => {
  test("returns PROVIDER_UNAVAILABLE (503) when no provider is configured", async () => {
    providerToReturn = null;

    const result = await generateMeetingRecap(TRANSCRIPT);

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("PROVIDER_UNAVAILABLE");
    expect(result.error.status).toBe(503);

    // The meeting conversation is still created + transcript persisted.
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    // No memory writes when the provider is unavailable.
    expect(mockApplyDiff).not.toHaveBeenCalled();
  });

  test("parses a forced tool_use response into a RecapJson and runs graph extraction", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    providerToReturn = {
      sendMessage: async (_messages, options) => {
        capturedOptions = options;
        return {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "build_meeting_recap",
              input: {
                summary: "Pricing stays for the Q3 renewal.",
                action_items: [
                  { text: "Share the forecast", owner: "Alice", done: false },
                  { text: "Send the deck", owner: null, done: false },
                  // Malformed entry (no text) — should be dropped.
                  { owner: "Nobody", done: true },
                ],
                decisions: ["Pricing stays unchanged.", 42],
                people: [
                  {
                    name: "Alice",
                    tone: "decisive",
                    note: "owns the forecast",
                  },
                  { name: "Bob", tone: "engaged" },
                  // Malformed entry (no name) — should be dropped.
                  { tone: "unknown" },
                ],
                tone: "productive",
              },
            },
          ],
        } as unknown as ProviderResponse;
      },
    };

    const result = await generateMeetingRecap(TRANSCRIPT);

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");

    expect(result.summary).toBe("Pricing stays for the Q3 renewal.");
    expect(result.tone).toBe("productive");
    // Malformed action item without text is dropped.
    expect(result.actionItems).toHaveLength(2);
    expect(result.actionItems[0]).toEqual({
      text: "Share the forecast",
      owner: "Alice",
      done: false,
    });
    expect(result.actionItems[1].owner).toBeNull();
    // Non-string decision is filtered out.
    expect(result.decisions).toEqual(["Pricing stays unchanged."]);
    // Malformed person without name is dropped; optional note preserved.
    expect(result.people).toHaveLength(2);
    expect(result.people[0]).toEqual({
      name: "Alice",
      tone: "decisive",
      note: "owns the forecast",
    });
    expect(result.people[1].note).toBeUndefined();

    expect(result.conversationId).toBe(MEETING_CONV_ID);

    // Forced tool choice was requested at the meetingRecap call site.
    expect(capturedOptions?.config?.callSite).toBe("meetingRecap");
    expect(capturedOptions?.config?.tool_choice).toEqual({
      type: "tool",
      name: "build_meeting_recap",
    });

    // Generic 8-type extraction runs tagged with the meeting conversation id.
    expect(mockRunGraphExtraction).toHaveBeenCalledTimes(1);
    const extractionArgs = mockRunGraphExtraction.mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      { transcript: string },
    ];
    expect(extractionArgs[0]).toBe(MEETING_CONV_ID);
    expect(extractionArgs[1]).toBe("default");
  });

  test("returns RECAP_FAILED (502) when the model returns no tool_use block", async () => {
    providerToReturn = {
      sendMessage: async () =>
        ({
          content: [{ type: "text", text: "I cannot do that." }],
        }) as unknown as ProviderResponse,
    };

    const result = await generateMeetingRecap(TRANSCRIPT);

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("RECAP_FAILED");
    expect(result.error.status).toBe(502);
  });
});
