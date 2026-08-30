/**
 * Tests for POST /v1/conversations/summarize ("summarize up to here").
 *
 * Validates that:
 * - The route 202s immediately and runs summarization async, persisting a
 *   result card via the canned-message path (text delta + message_complete +
 *   sync invalidation) exactly like the /compact branch.
 * - The feature flag gates the endpoint: flag-off behaves as an unknown
 *   endpoint (404).
 * - Busy conversations are rejected with 409 without touching processing.
 * - Boundary UserErrors surface as a "Summarization skipped" card, not a
 *   conversation_error.
 * - Unexpected errors broadcast a retryable conversation_error.
 * - Processing is cleared and the queue drained on every outcome.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

// Mutable flag value — the flag-off test flips it.
let summarizeFlagEnabled = true;
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => summarizeFlagEnabled,
}));

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

const formatSummarizeUpToResultMock = mock(
  (result: { compactedMessages: number }) =>
    `**Conversation summarized**\nSummarized ${result.compactedMessages} earlier messages.`,
);

mock.module("../daemon/conversation-process.js", () => ({
  formatSummarizeUpToResult: formatSummarizeUpToResultMock,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: async () => 0,
  regenerateResponse: async () => null,
  switchConversation: async () => null,
  undoLastMessage: async () => null,
}));

const addMessageMock = mock(
  async (
    _conversationId: string,
    _role: string,
    _content: string,
    _options?: { metadata?: Record<string, unknown> },
  ) => ({ id: "persisted-assistant-id", deduplicated: false }),
);

const getConversationMock = mock((id: string) =>
  id === "conv-summarize-test" ? { id } : null,
);

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConversationCrud = await import("../memory/conversation-crud.js");
mock.module("../memory/conversation-crud.js", () => ({
  ...actualConversationCrud,
  addMessage: addMessageMock,
  archiveConversation: () => true,
  batchSetDisplayOrders: () => {},
  countConversationsByScheduleJobId: () => 0,
  deleteConversation: () => ({ segmentIds: [], deletedSummaryIds: [] }),
  extractImageSourcePaths: () => undefined,
  forkConversation: () => ({ id: "forked" }),
  getConversation: getConversationMock,
  provenanceFromTrustContext: (ctx: unknown) =>
    ctx
      ? { provenanceTrustClass: (ctx as Record<string, unknown>).trustClass }
      : { provenanceTrustClass: "unknown" },
  setConversationSurfaced: () => null,
  unarchiveConversation: () => true,
  updateConversationTitle: () => {},
  wipeConversation: () => ({
    segmentIds: [],
    deletedSummaryIds: [],
    cancelledJobCount: 0,
  }),
}));

mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({
    conversationId: "conv-summarize-test",
    created: false,
  }),
  resolveConversationId: (id: string) => id,
  setConversationKeyIfAbsent: () => {},
}));

mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

mock.module("../schedule/schedule-store.js", () => ({
  deleteSchedule: async () => {},
}));

mock.module("../home/feed-writer.js", () => ({
  stripConversationIds: async () => {},
}));

const broadcastEvents: Array<Record<string, unknown>> = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: Record<string, unknown>) => {
    broadcastEvents.push(msg);
  },
}));

mock.module("../runtime/services/conversation-serializer.js", () => ({
  buildConversationDetailResponse: () => null,
}));

const publishConversationMessagesChangedMock = mock(
  (_conversationId: string, _originClientId?: string) => {},
);
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationListAndMetadataChanged: () => {},
  publishConversationListChanged: () => {},
  publishConversationMessagesChanged: publishConversationMessagesChangedMock,
  publishConversationTitleChanged: () => {},
}));

mock.module("../runtime/routes/inference-profile-session-handler.js", () => ({
  setInferenceProfileSession: async () => ({}),
}));

mock.module("../runtime/routes/conversation-list-routes.js", () => ({
  conversationSummarySchema: z.object({}),
}));

// Each test installs its fake conversation here for the store mock to serve.
let activeConversation: ReturnType<typeof makeConversation>["conversation"];
mock.module("../daemon/conversation-store.js", () => ({
  destroyActiveConversation: () => {},
  getOrCreateConversation: async () => activeConversation,
}));

import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { UserError } from "../util/errors.js";
import { callHandler } from "./helpers/call-route-handler.js";

const summarizeRoute = ROUTES.find(
  (r) => r.operationId === "summarizeConversation",
)!;
const summarizeHandler = async (
  args: Parameters<typeof summarizeRoute.handler>[0],
) => summarizeRoute.handler(args);

function makeConversation(opts: { processing?: boolean } = {}) {
  let processing = opts.processing ?? false;
  const setProcessing = mock((value: boolean) => {
    processing = value;
  });
  const summarizeUpToMessage = mock(async (_beforeMessageId: string) => ({
    messages: [],
    compacted: true,
    previousEstimatedInputTokens: 12000,
    estimatedInputTokens: 4000,
    maxInputTokens: 200000,
    thresholdTokens: 160000,
    compactedMessages: 12,
    compactedPersistedMessages: 12,
    preservedTailMessages: 4,
    summaryCalls: 1,
    summaryInputTokens: 500,
    summaryOutputTokens: 100,
    summaryModel: "test-model",
  }));
  const emitActivityState = mock(
    (_phase: string, _reason: string, _options?: { statusText?: string }) => {},
  );
  const drainQueue = mock(async () => {});
  const messages: unknown[] = [];
  const conversation = {
    conversationId: "conv-summarize-test",
    trustContext: undefined,
    isProcessing: () => processing,
    setProcessing,
    summarizeUpToMessage,
    emitActivityState,
    drainQueue,
    getMessages: () => messages,
  };
  return {
    conversation,
    setProcessing,
    summarizeUpToMessage,
    emitActivityState,
    drainQueue,
    messages,
  };
}

function makeRequest(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return new Request("http://localhost/v1/conversations/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** Flush the fire-and-forget async block (macrotask + queued microtasks). */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  summarizeFlagEnabled = true;
  addMessageMock.mockClear();
  getConversationMock.mockClear();
  formatSummarizeUpToResultMock.mockClear();
  publishConversationMessagesChangedMock.mockClear();
  broadcastEvents.length = 0;
});

describe("POST /v1/conversations/summarize", () => {
  test("202s immediately, then persists the result card and emits turn events", async () => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest(
        {
          conversationId: "conv-summarize-test",
          beforeMessageId: "msg-42",
        },
        // A real initiating client id — the card must still surface here.
        { "X-Vellum-Client-Id": "web-client-xyz" },
      ),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      accepted: true,
      conversationId: "conv-summarize-test",
    });

    await settle();

    // The second arg is the sink the context-window usage push rides. This
    // route's conversation may hold the store's no-op sender, so it hands in
    // the broadcast path its result card goes out on.
    expect(ctx.summarizeUpToMessage).toHaveBeenCalledWith(
      "msg-42",
      expect.any(Function),
    );
    expect(ctx.emitActivityState).toHaveBeenCalledWith(
      "thinking",
      "context_compacting",
      { statusText: "Summarizing conversation" },
    );

    // Card persisted as an assistant message and pushed onto in-memory history.
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const [convId, role, content, options] = addMessageMock.mock.calls[0];
    expect(convId).toBe("conv-summarize-test");
    expect(role).toBe("assistant");
    expect(content).toContain("Conversation summarized");
    // Metadata mirrors the /compact card shape (channel keys + provenance);
    // interface keys are omitted because the route receives no interface id.
    // `systemCard` is the ruling-4 marker clients use to render the row with
    // the quiet centered system-card treatment.
    expect(options?.metadata).toEqual({
      provenanceTrustClass: "unknown",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      systemCard: "summarize",
    });
    expect(ctx.messages).toHaveLength(1);

    // The card is announced exactly like the /compact card: the full text as
    // one delta, then message_complete with the persisted assistant id. The
    // delta must carry the persisted row id AND the systemCard marker —
    // without them the web client folds the card text into the previous
    // assistant bubble instead of opening its own system-card row.
    const delta = broadcastEvents.find(
      (e) => e.type === "assistant_text_delta",
    );
    expect(String(delta?.text)).toContain("Conversation summarized");
    expect(delta?.messageId).toBe("persisted-assistant-id");
    expect(delta?.systemCard).toBe("summarize");
    const complete = broadcastEvents.find((e) => e.type === "message_complete");
    expect(complete?.messageId).toBe("persisted-assistant-id");

    expect(publishConversationMessagesChangedMock).toHaveBeenCalledTimes(1);
    expect(publishConversationMessagesChangedMock.mock.calls[0]).toEqual([
      "conv-summarize-test",
      "web-client-xyz",
    ]);

    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.drainQueue).toHaveBeenCalledTimes(1);
  });

  test("flag off → 404 with the router's unknown-endpoint shape", async () => {
    summarizeFlagEnabled = false;
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );

    expect(res.status).toBe(404);
    expect(ctx.setProcessing).not.toHaveBeenCalled();
    expect(ctx.summarizeUpToMessage).not.toHaveBeenCalled();
  });

  test("busy conversation → 409 without claiming processing", async () => {
    const ctx = makeConversation({ processing: true });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("currently responding");
    expect(ctx.setProcessing).not.toHaveBeenCalled();
    expect(ctx.summarizeUpToMessage).not.toHaveBeenCalled();
  });

  test("unknown conversation → 404", async () => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-missing",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );

    expect(res.status).toBe(404);
    expect(ctx.summarizeUpToMessage).not.toHaveBeenCalled();
  });

  test("boundary UserError → skipped card, no conversation_error", async () => {
    const ctx = makeConversation();
    ctx.summarizeUpToMessage.mockImplementationOnce(async () => {
      throw new UserError("Nothing to summarize before this message");
    });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-1",
      }),
      undefined,
      202,
    );
    expect(res.status).toBe(202);

    await settle();

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const [, role, content] = addMessageMock.mock.calls[0];
    expect(role).toBe("assistant");
    // Microlabel-first system-card shape (ruling 4): headline line, then
    // the reason as the muted body line.
    expect(content).toContain(
      "Summarization skipped\\nNothing to summarize before this message",
    );
    expect(broadcastEvents.some((e) => e.type === "conversation_error")).toBe(
      false,
    );
    // The skip card streams as its own message: the delta is stamped with
    // the persisted row id and the systemCard marker so the client opens a
    // fresh system-card row instead of appending the text onto the previous
    // assistant reply.
    const skipDelta = broadcastEvents.find(
      (e) => e.type === "assistant_text_delta",
    );
    expect(String(skipDelta?.text)).toContain("Summarization skipped");
    expect(skipDelta?.messageId).toBe("persisted-assistant-id");
    expect(skipDelta?.systemCard).toBe("summarize");
    expect(broadcastEvents.some((e) => e.type === "message_complete")).toBe(
      true,
    );
    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.drainQueue).toHaveBeenCalledTimes(1);
  });

  test("unexpected error → retryable conversation_error, processing cleared", async () => {
    const ctx = makeConversation();
    ctx.summarizeUpToMessage.mockImplementationOnce(async () => {
      throw new Error("summary call exploded");
    });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );
    expect(res.status).toBe(202);

    await settle();

    expect(addMessageMock).not.toHaveBeenCalled();
    const error = broadcastEvents.find((e) => e.type === "conversation_error");
    expect(error).toBeDefined();
    expect(error?.code).toBe("UNKNOWN");
    expect(error?.retryable).toBe(true);
    expect(String(error?.userMessage)).toContain("summary call exploded");
    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.drainQueue).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ beforeMessageId: "msg-42" }, "conversationId"],
    [{ conversationId: "conv-summarize-test" }, "beforeMessageId"],
    [{ conversationId: 7, beforeMessageId: "msg-42" }, "conversationId"],
    [
      { conversationId: "conv-summarize-test", beforeMessageId: 7 },
      "beforeMessageId",
    ],
  ])("invalid body %j → 400 mentioning %s", async (body, field) => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest(body as Record<string, unknown>),
      undefined,
      202,
    );

    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { message: string } };
    expect(parsed.error.message).toContain(field);
    expect(ctx.setProcessing).not.toHaveBeenCalled();
  });
});
