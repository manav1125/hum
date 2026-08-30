/**
 * Unit tests for the generateVoiceIntake service.
 *
 * The service is driven directly (no HTTP routing). Memory CRUD, the provider
 * abstraction, the config loader, graph extraction, and the action-item →
 * work-item bridge are mocked so the tests exercise the validation, no-provider
 * fallback, and live (forced-tool) paths without any DB or LLM spend. The
 * assertions focus on the magic contract: a thread is created, the spoken
 * action items become work items tagged "voice", and the action-item list is
 * written into the thread as the first assistant message.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
const VOICE_CONV_ID = "voice-conv-1";
const mockCreateConversation = mock((_opts?: Record<string, unknown>) => ({
  id: VOICE_CONV_ID,
}));
interface AddMessageCall {
  conversationId: string;
  role: string;
  content: string;
}
let addMessageCalls: AddMessageCall[] = [];
const mockAddMessage = mock(
  async (conversationId: string, role: string, content: string) => {
    addMessageCalls.push({ conversationId, role, content });
    return { id: `msg-${addMessageCalls.length}` };
  },
);

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
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b) => b.type === "tool_use"),
  userMessage: (text: string): Message => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

// ── Config loader + graph extraction (best-effort side effect) ───────
// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../../../config/loader.js");
mock.module("../../../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => ({}) as Record<string, unknown>,
}));
mock.module("../../../memory/graph/extraction.js", () => ({
  runGraphExtraction: mock(async () => ({
    nodesCreated: 0,
    nodesUpdated: 0,
    nodesReinforced: 0,
    edgesCreated: 0,
    triggersCreated: 0,
  })),
}));

// ── Action-item → work-item bridge ───────────────────────────────────
interface BridgeCall {
  actionItems: Array<{ text: string; owner: string | null; done: boolean }>;
  sourceType: string;
  conversationId: string;
}
let bridgeCalls: BridgeCall[] = [];
const mockActionItemsToWorkItems = mock(
  async (
    actionItems: BridgeCall["actionItems"],
    sourceType: string,
    conversationId: string,
  ) => {
    bridgeCalls.push({ actionItems, sourceType, conversationId });
    // The real bridge triages each item and folds the resolved project/mission
    // filing into the ref. Here we stamp deterministic filing so the service's
    // pass-through of the filing fields is covered: the first item lands on a
    // mission-linked project, the rest file onto nothing (neutral state).
    return actionItems
      .filter((i) => !i.done)
      .map((i, idx) => ({
        id: `wi-${idx}`,
        title: i.text,
        created: true,
        projectId: idx === 0 ? "proj-1" : null,
        projectTitle: idx === 0 ? "Q3 planning" : null,
        missionId: idx === 0 ? "mission-1" : null,
        missionTitle: idx === 0 ? "Hit Q3 targets" : null,
      }));
  },
);
mock.module("../action-item-work-items.js", () => ({
  actionItemsToWorkItems: mockActionItemsToWorkItems,
}));

import { generateVoiceIntake } from "../voice-intake.js";

const TRANSCRIPT =
  "Hey Cue, remind me to send Dana the Q3 forecast tomorrow, and book a dentist " +
  "appointment for next week. Also I was thinking the pricing looks fine.";

function toolResponse(input: Record<string, unknown>): ProviderResponse {
  return {
    content: [{ type: "tool_use", name: "capture_voice_intake", input }],
  } as unknown as ProviderResponse;
}

beforeEach(() => {
  mockCreateConversation.mockClear();
  mockAddMessage.mockClear();
  mockGetConfiguredProvider.mockClear();
  mockActionItemsToWorkItems.mockClear();
  addMessageCalls = [];
  bridgeCalls = [];
  providerToReturn = null;
});

describe("generateVoiceIntake — validation", () => {
  test("returns BAD_REQUEST for an empty transcript and creates no thread", async () => {
    const result = await generateVoiceIntake("   ");
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.status).toBe(400);
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });
});

describe("generateVoiceIntake — no provider configured", () => {
  test("still creates a thread with the raw words and a graceful assistant message", async () => {
    providerToReturn = null;
    const result = await generateVoiceIntake(TRANSCRIPT);

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected error");
    expect(result.conversationId).toBe(VOICE_CONV_ID);
    expect(result.actionItems).toEqual([]);
    expect(result.workItems).toEqual([]);

    // user transcript + one assistant fallback message
    const roles = addMessageCalls.map((c) => c.role);
    expect(roles).toEqual(["user", "assistant"]);
    // No extraction → the bridge is never invoked.
    expect(mockActionItemsToWorkItems).not.toHaveBeenCalled();
  });
});

describe("generateVoiceIntake — live extraction path", () => {
  test("extracts action items, bridges them as 'voice' work items, and lists them in the thread", async () => {
    providerToReturn = {
      sendMessage: async () =>
        toolResponse({
          summary:
            "You want to send Dana the forecast and book a dentist visit.",
          action_items: [
            { text: "Send Dana the Q3 forecast", owner: "Dana", done: false },
            {
              text: "Book a dentist appointment for next week",
              owner: null,
              done: false,
            },
          ],
        }),
    };

    const result = await generateVoiceIntake(TRANSCRIPT);

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected error");

    // Two action items extracted and returned.
    expect(result.actionItems).toHaveLength(2);
    expect(result.actionItems[0]?.text).toBe("Send Dana the Q3 forecast");

    // The bridge was called with the voice source type and the conversation.
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]?.sourceType).toBe("voice");
    expect(bridgeCalls[0]?.conversationId).toBe(VOICE_CONV_ID);
    expect(result.workItems).toHaveLength(2);

    // The per-item filing the bridge resolved (project + mission it was filed
    // onto) is carried through in the response so the client shows the real ⟡
    // tag; an unfiled item reports null (the neutral "Filed to Activity" state).
    expect(result.workItems[0]?.projectId).toBe("proj-1");
    expect(result.workItems[0]?.projectTitle).toBe("Q3 planning");
    expect(result.workItems[0]?.missionId).toBe("mission-1");
    expect(result.workItems[0]?.missionTitle).toBe("Hit Q3 targets");
    expect(result.workItems[1]?.projectId).toBeNull();
    expect(result.workItems[1]?.projectTitle).toBeNull();

    // The assistant message (2nd addMessage) lists both action items.
    const assistantCall = addMessageCalls.find((c) => c.role === "assistant");
    expect(assistantCall).toBeDefined();
    expect(assistantCall?.content).toContain("Send Dana the Q3 forecast");
    expect(assistantCall?.content).toContain(
      "Book a dentist appointment for next week",
    );
  });

  test("degrades gracefully when the model returns no tool_use block", async () => {
    providerToReturn = {
      sendMessage: async () =>
        ({
          content: [{ type: "text", text: "ok" }],
        }) as unknown as ProviderResponse,
    };

    const result = await generateVoiceIntake(TRANSCRIPT);

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected error");
    expect(result.actionItems).toEqual([]);
    // Thread is still created with user + assistant messages.
    expect(addMessageCalls.map((c) => c.role)).toEqual(["user", "assistant"]);
  });
});
