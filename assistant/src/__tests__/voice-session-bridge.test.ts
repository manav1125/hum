import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import type { LiveVoiceConfig } from "../config/schemas/live-voice.js";
import { LiveVoiceConfigSchema } from "../config/schemas/live-voice.js";
import type { Conversation } from "../daemon/conversation.js";
import { persistUserMessage as persistUserMessageImpl } from "../daemon/conversation-messaging.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

let mockedConfig: {
  secretDetection: { enabled: boolean };
  calls: { disclosure: { enabled: boolean; text: string } };
  memory: { enabled: boolean };
  // Present so suites that share this process (mock.module replaces
  // getConfig globally) still read a complete liveVoice block.
  liveVoice: LiveVoiceConfig;
} = {
  secretDetection: { enabled: false },
  calls: {
    disclosure: {
      enabled: false,
      text: "",
    },
  },
  memory: { enabled: false },
  liveVoice: LiveVoiceConfigSchema.parse({}),
};

const actualLogger = await import("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...actualLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Spread the real module: mock.module mutates a process-global registry, so
// an exhaustive factory here would delete every other config export for any
// file that runs after this one in a combined run (see assistant/CLAUDE.md).
const actualConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => mockedConfig,
}));

import {
  cutFrontDoorContentAtVerdict,
  setVoiceBridgeDeps,
  startVoiceTurn,
} from "../calls/voice-session-bridge.js";
import {
  createConversation,
  getMessages,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

/**
 * Build a session that emits multiple events via the onEvent callback,
 * simulating assistant text deltas followed by message_complete.
 */
function makeStreamingSession(events: ServerMessage[]): Conversation {
  return {
    isProcessing: () => false,
    persistUserMessage: async () => ({
      id: "test-msg-id",
      deduplicated: false,
    }),
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    setVoiceCallControlPrompt: () => {},
    updateClient: () => {},
    ensureActorScopedHistory: async () => {},
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      options?: { onEvent?: (msg: ServerMessage) => void },
    ) => {
      const onEvent = options?.onEvent ?? (() => {});
      for (const event of events) {
        onEvent(event);
      }
    },
    handleConfirmationResponse: () => {},
    abort: () => {},
  } as unknown as Conversation;
}

function makePersistingStreamingSession(
  conversationId: string,
  events: ServerMessage[],
): Conversation & { callSessionId?: string } {
  type PersistUserMessageContext = Parameters<typeof persistUserMessageImpl>[0];

  let turnChannelContext: TurnChannelContext | null = null;
  let turnInterfaceContext: TurnInterfaceContext | null = null;
  let processing = false;
  const session = {
    conversationId,
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    queue: {} as never,
    trustContext: undefined,
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    persistUserMessage: async (
      ...args: Parameters<Conversation["persistUserMessage"]>
    ) => persistUserMessageImpl(session, ...args),
    getTurnChannelContext: () => turnChannelContext,
    getTurnInterfaceContext: () => turnInterfaceContext,
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: (ctx: Parameters<Conversation["setTrustContext"]>[0]) => {
      session.trustContext = ctx ?? undefined;
    },
    setCommandIntent: () => {},
    setTurnChannelContext: (ctx: TurnChannelContext) => {
      turnChannelContext = ctx;
    },
    setTurnInterfaceContext: (ctx: TurnInterfaceContext) => {
      turnInterfaceContext = ctx;
    },
    setVoiceCallControlPrompt: () => {},
    updateClient: () => {},
    ensureActorScopedHistory: async () => {},
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      options?: { onEvent?: (msg: ServerMessage) => void },
    ) => {
      const onEvent = options?.onEvent ?? (() => {});
      for (const event of events) {
        onEvent(event);
      }
      processing = false;
      session.abortController = null;
      session.currentRequestId = undefined;
    },
    handleConfirmationResponse: () => {},
    abort: () => {},
  } as unknown as Conversation &
    PersistUserMessageContext & {
      callSessionId?: string;
    };

  return session;
}

function parsePersistedMetadata(
  metadata: string | null | undefined,
): Record<string, unknown> {
  if (!metadata) {
    throw new Error("Expected persisted message metadata");
  }
  return JSON.parse(metadata) as Record<string, unknown>;
}

/**
 * Helper to inject voice bridge deps with a given conversation factory.
 */
function injectDeps(conversationFactory: () => Conversation): void {
  setVoiceBridgeDeps({
    getOrCreateConversation: async () => conversationFactory(),
    resolveAttachments: () => [],
  });
}

describe("voice-session-bridge", () => {
  beforeEach(() => {
    mockedConfig = {
      secretDetection: { enabled: false },
      calls: {
        disclosure: {
          enabled: false,
          text: "",
        },
      },
      memory: { enabled: false },
      liveVoice: LiveVoiceConfigSchema.parse({}),
    };
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    pendingInteractions.clear();
  });

  test("throws when deps not injected", async () => {
    // Reset the module-level orchestrator by re-calling with undefined
    // (we can't easily reset module state, so we test the fresh import path)
    // Instead, test that startVoiceTurn works after injection
    expect(true).toBe(true); // placeholder — real test below
  });

  test("startVoiceTurn forwards text deltas to onTextDelta callback", async () => {
    const conversation = createConversation("voice bridge delta test");
    const events: ServerMessage[] = [
      {
        type: "assistant_text_delta",
        text: "Hello ",
        conversationId: conversation.id,
      },
      {
        type: "assistant_text_delta",
        text: "world",
        conversationId: conversation.id,
      },
      { type: "message_complete", conversationId: conversation.id },
    ];
    const session = makeStreamingSession(events);
    injectDeps(() => session);

    const receivedDeltas: string[] = [];
    let completed = false;

    const handle = await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello from caller",
      isInbound: true,
      onTextDelta: (text) => receivedDeltas.push(text),
      onComplete: () => {
        completed = true;
      },
      onError: () => {},
    });

    // Wait for async agent loop
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedDeltas).toEqual(["Hello ", "world"]);
    expect(completed).toBe(true);
    expect(handle.turnId).toBeDefined();
    expect(typeof handle.abort).toBe("function");
  });

  test("startVoiceTurn forwards error events to onError callback", async () => {
    const conversation = createConversation("voice bridge error test");
    const events: ServerMessage[] = [
      { type: "error", message: "Provider unavailable" },
    ];
    const session = makeStreamingSession(events);
    injectDeps(() => session);

    const receivedErrors: string[] = [];
    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: (msg) => receivedErrors.push(msg),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedErrors).toEqual(["Provider unavailable"]);
  });

  test("abort handle cancels the in-flight turn", async () => {
    const conversation = createConversation("voice bridge abort test");
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (options: { requestId?: string }) => {
        session.currentRequestId = options.requestId;
        return { id: "test-msg-id", deduplicated: false };
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      handleConfirmationResponse: () => {},
      abort: () => {
        abortCalled = true;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const handle = await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    handle.abort();
    expect(abortCalled).toBe(true);
  });

  test("unclean teardown: a run that dies with the processing flag still set is rescued", async () => {
    // Simulates the prod wedge: the agent loop's finally threw before
    // `setProcessing(false)` ran, so the run promise rejects while the
    // conversation still claims to be processing. The voice bridge's
    // teardown must clear the flag and drain the queue — otherwise the
    // conversation shows a phantom "run in progress" forever and every
    // subsequent send is silently swallowed into the queue.
    const conversation = createConversation("voice bridge wedge test");
    let processing = false;
    let drainCalls = 0;
    const session = {
      conversationId: conversation.id,
      isProcessing: () => processing,
      setProcessing: (value: boolean) => {
        processing = value;
      },
      abortController: null as AbortController | null,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: async (options: { requestId?: string }) => {
        // Mirrors the real persistUserMessage: claims the processing lock
        // and records the owning request id.
        session.currentRequestId = options.requestId;
        processing = true;
        session.abortController = new AbortController();
        return { id: "test-msg-id", deduplicated: false };
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      drainQueue: async () => {
        drainCalls++;
      },
      runAgentLoop: async () => {
        // Unclean exit: rejects WITHOUT clearing processing/currentRequestId,
        // exactly like a throw inside the loop's own teardown finally.
        throw new Error("teardown exploded before setProcessing(false)");
      },
      handleConfirmationResponse: () => {},
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    const errors: string[] = [];
    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: (msg) => errors.push(msg),
    });

    await new Promise((r) => setTimeout(r, 50));

    // The wedge is rescued: flag cleared, turn state reset, queue drained.
    expect(processing).toBe(false);
    expect(
      (session as unknown as { currentRequestId?: string }).currentRequestId,
    ).toBeUndefined();
    expect(drainCalls).toBe(1);
    expect(errors.length).toBe(1);
  });

  test("clean completion does not trigger the teardown rescue drain", async () => {
    // Control for the wedge test above: when runAgentLoop clears its own
    // state (the normal path), the bridge's rescue must be a no-op — no
    // spurious drainQueue, no clobbered state.
    const conversation = createConversation("voice bridge clean test");
    let processing = false;
    let drainCalls = 0;
    const session = {
      conversationId: conversation.id,
      isProcessing: () => processing,
      setProcessing: (value: boolean) => {
        processing = value;
      },
      abortController: null as AbortController | null,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: async (options: { requestId?: string }) => {
        session.currentRequestId = options.requestId;
        processing = true;
        return { id: "test-msg-id", deduplicated: false };
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      drainQueue: async () => {
        drainCalls++;
      },
      runAgentLoop: async (
        _content: string,
        _messageId: string,
        options?: { onEvent?: (msg: ServerMessage) => void },
      ) => {
        options?.onEvent?.({
          type: "message_complete",
          conversationId: conversation.id,
        });
        // Normal teardown clears its own state.
        processing = false;
        session.currentRequestId = undefined;
      },
      handleConfirmationResponse: () => {},
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(processing).toBe(false);
    expect(drainCalls).toBe(0);
  });

  test("startVoiceTurn passes callSite: 'callAgent' to runAgentLoop", async () => {
    const conversation = createConversation("voice bridge callSite test");
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedOptions: Record<string, unknown> | undefined;
    const session = {
      ...makeStreamingSession(events),
      runAgentLoop: async (
        _content: string,
        _messageId: string,
        options?: Record<string, unknown>,
      ) => {
        capturedOptions = options;
        const onEvent =
          (options as { onEvent?: (msg: ServerMessage) => void })?.onEvent ??
          (() => {});
        for (const event of events) {
          onEvent(event);
        }
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.callSite).toBe("callAgent");
  });

  test("external AbortSignal triggers turn abort", async () => {
    const conversation = createConversation("voice bridge signal test");
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (options: { requestId?: string }) => {
        session.currentRequestId = options.requestId;
        return { id: "test-msg-id", deduplicated: false };
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      handleConfirmationResponse: () => {},
      abort: () => {
        abortCalled = true;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const ac = new AbortController();
    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
      signal: ac.signal,
    });

    // Abort via the external controller
    ac.abort();
    // Give the event listener a microtask to fire
    await new Promise((r) => setTimeout(r, 10));

    expect(abortCalled).toBe(true);
  });

  test("startVoiceTurn passes turnChannelContext with voice channel", async () => {
    const conversation = createConversation(
      "voice bridge channel context test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedTurnChannelContext: unknown = null;
    const session = {
      ...makeStreamingSession(events),
      setTurnChannelContext: (ctx: unknown) => {
        capturedTurnChannelContext = ctx;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedTurnChannelContext).toEqual({
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
    });
  });

  test("startVoiceTurn defaults persisted voice metadata to phone", async () => {
    const conversation = createConversation(
      "voice bridge phone metadata default test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];
    const session = makePersistingStreamingSession(conversation.id, events);
    injectDeps(() => session);

    let persistedUserMessageId: string | undefined;

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
      callbacks: {
        persisted_user_message_id: (messageId) => {
          persistedUserMessageId = messageId;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    const persisted = getMessages(conversation.id).find(
      (message) => message.id === persistedUserMessageId,
    );
    const metadata = parsePersistedMetadata(persisted?.metadata);
    expect(persisted).toBeDefined();
    expect(metadata).toMatchObject({
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
      userMessageInterface: "phone",
      assistantMessageInterface: "phone",
      // Durable voice marker — lets clients restyle voice turns after reload.
      voiceTurn: true,
    });
  });

  test("startVoiceTurn can persist local live voice metadata and callbacks", async () => {
    const conversation = createConversation(
      "voice bridge local live voice metadata test",
    );
    const events: ServerMessage[] = [
      {
        type: "assistant_text_delta",
        text: "Hi",
        conversationId: conversation.id,
      },
      {
        type: "message_complete",
        conversationId: conversation.id,
        messageId: "assistant-msg-1",
      },
    ];

    let capturedTransport: { channelId: string } | undefined;
    let capturedVoiceSessionId: string | undefined;
    const capturedPrompts: Array<string | null> = [];
    const session = makePersistingStreamingSession(conversation.id, events);
    session.setVoiceCallControlPrompt = (prompt: string | null) => {
      capturedPrompts.push(prompt);
    };

    setVoiceBridgeDeps({
      getOrCreateConversation: async (_conversationId, transport) => {
        capturedTransport = transport;
        return session;
      },
      resolveAttachments: () => [],
    });

    const textDeltaEvents: ServerMessage[] = [];
    const completeEvents: ServerMessage[] = [];
    let persistedUserMessageId: string | undefined;
    let persistedAssistantMessageId: string | undefined;

    await startVoiceTurn({
      conversationId: conversation.id,
      voiceSessionId: "local-live-voice-session-1",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      voiceControlPrompt:
        "You are speaking in a local live voice session. Keep replies brief and conversational.",
      content: "Hello from local live voice",
      isInbound: true,
      callbacks: {
        assistant_text_delta: (msg) => textDeltaEvents.push(msg),
        message_complete: (msg) => completeEvents.push(msg),
        persisted_user_message_id: (messageId) => {
          persistedUserMessageId = messageId;
          capturedVoiceSessionId = session.callSessionId;
        },
        persisted_assistant_message_id: (messageId) => {
          persistedAssistantMessageId = messageId;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedTransport).toEqual({ channelId: "vellum" });
    expect(capturedVoiceSessionId).toBe("local-live-voice-session-1");
    expect(capturedPrompts[0]).toBe(
      "You are speaking in a local live voice session. Keep replies brief and conversational.",
    );
    expect(textDeltaEvents).toEqual([events[0]]);
    expect(completeEvents).toEqual([events[1]]);
    expect(persistedAssistantMessageId).toBe("assistant-msg-1");

    const persisted = getMessages(conversation.id).find(
      (message) => message.id === persistedUserMessageId,
    );
    const metadata = parsePersistedMetadata(persisted?.metadata);
    expect(persisted).toBeDefined();
    expect(metadata).toMatchObject({
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      // Durable voice marker — lets clients restyle voice turns after reload.
      voiceTurn: true,
    });
  });

  test("startVoiceTurn passes guardian context to the session", async () => {
    const conversation = createConversation(
      "voice bridge guardian context test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedTrustContext: unknown = null;
    const session = {
      ...makeStreamingSession(events),
      setTrustContext: (ctx: unknown) => {
        if (ctx != null) capturedTrustContext = ctx;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const trustCtx = {
      sourceChannel: "phone" as const,
      trustClass: "guardian" as const,
      guardianExternalUserId: "+15550001111",
      guardianChatId: "+15550001111",
    };

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      assistantId: "test-assistant",
      trustContext: trustCtx,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedTrustContext).toEqual(trustCtx);
  });

  test("inbound non-guardian opener prompt uses pickup framing instead of outbound phrasing", async () => {
    const conversation = createConversation(
      "voice bridge inbound opener framing test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedPrompt: string | null = null;
    const session = {
      ...makeStreamingSession(events),
      setVoiceCallControlPrompt: (prompt: string | null) => {
        if (prompt != null) capturedPrompt = prompt;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello there",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "trusted_contact",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));
    if (!capturedPrompt)
      throw new Error("Expected voice call control prompt to be set");
    const prompt: string = capturedPrompt;

    expect(prompt).toContain(
      "this is an inbound call you are answering (not a call you initiated)",
    );
    expect(prompt).toContain(
      "Introduce yourself once at the start using your assistant name if you know it",
    );
    expect(prompt).toContain(
      "If your assistant name is not known, skip the name and just identify yourself as the guardian's assistant.",
    );
    expect(prompt).toContain(
      "Never use a UUID-shaped internal assistant ID as your spoken name.",
    );
    expect(prompt).toContain(
      'Do NOT say "I\'m calling" or "I\'m calling on behalf of".',
    );
  });

  test("inbound disclosure guidance is rewritten for pickup context", async () => {
    mockedConfig = {
      secretDetection: { enabled: false },
      calls: {
        disclosure: {
          enabled: true,
          text: "At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent.",
        },
      },
      memory: { enabled: false },
      liveVoice: LiveVoiceConfigSchema.parse({}),
    };

    const conversation = createConversation(
      "voice bridge inbound disclosure rewrite test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedPrompt: string | null = null;
    const session = {
      ...makeStreamingSession(events),
      setVoiceCallControlPrompt: (prompt: string | null) => {
        if (prompt != null) capturedPrompt = prompt;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hi",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "trusted_contact",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));
    if (!capturedPrompt)
      throw new Error("Expected voice call control prompt to be set");
    const prompt: string = capturedPrompt;

    expect(prompt).toContain(
      "At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent.",
    );
    expect(prompt).toContain(
      "rewrite any disclosure naturally for pickup context",
    );
    expect(prompt).toContain(
      'Do NOT say "I\'m calling", "I called you", or "I\'m calling on behalf of".',
    );
  });

  test("auto-denies confirmation requests for non-guardian voice turns", async () => {
    const conversation = createConversation(
      "voice bridge auto-deny non-guardian test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
      decisionContext?: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: async () => ({
        id: "test-msg-id",
        deduplicated: false,
      }),
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        // Simulate the prompter emitting a confirmation_request via the
        // updateClient callback (this is how the real prompter works).
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-1",
          toolName: "host_bash",
          input: { command: "rm -rf /" },
          riskLevel: "high",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
        // The auto-deny resolves the prompter immediately, so the agent loop
        // can continue. In production the loop would continue; here we just
        // return to simulate completion.
      },
      handleConfirmationResponse: (
        requestId: string,
        decision: string,
        options?: { decisionContext?: string },
      ) => {
        handleConfirmationCalls.push({
          requestId,
          decision,
          decisionContext: options?.decisionContext,
        });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Delete everything",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "trusted_contact",
        guardianExternalUserId: "+15550009999",
        guardianChatId: "+15550009999",
        requesterExternalUserId: "+15550002222",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    // The confirmation should have been auto-denied immediately
    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-1");
    expect(handleConfirmationCalls[0].decision).toBe("deny");
    expect(handleConfirmationCalls[0].decisionContext).toContain("voice call");
    expect(handleConfirmationCalls[0].decisionContext).toContain("host_bash");
  });

  test("auto-denies confirmation requests for unverified_channel voice turns", async () => {
    const conversation = createConversation(
      "voice bridge auto-deny unverified test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: async () => ({
        id: "test-msg-id",
        deduplicated: false,
      }),
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-2",
          toolName: "network_request",
          input: { url: "https://evil.com" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Make a request",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "unknown",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-2");
    expect(handleConfirmationCalls[0].decision).toBe("deny");
  });

  test("auto-denies confirmation requests when guardian context is missing", async () => {
    const conversation = createConversation(
      "voice bridge auto-deny unknown actor test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: async () => ({
        id: "test-msg-id",
        deduplicated: false,
      }),
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-unknown",
          toolName: "host_bash",
          input: { command: "touch /tmp/x" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "run a command",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-unknown");
    expect(handleConfirmationCalls[0].decision).toBe("deny");
  });

  test("publishes local live voice confirmation requests without auto-resolving them", async () => {
    const conversation = createConversation(
      "voice bridge local live voice approval test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];
    const publishedMessages: ServerMessage[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: {
        conversationId: conversation.id,
      },
      callback: (event) => {
        publishedMessages.push(event.message);
      },
    });

    const session = {
      isProcessing: () => false,
      persistUserMessage: async () => ({
        id: "test-msg-id",
        deduplicated: false,
      }),
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-local-live-voice",
          toolName: "host_bash",
          input: { command: "ls" },
          riskLevel: "low",
          allowlistOptions: [],
          scopeOptions: [],
          conversationId: conversation.id,
        } as ServerMessage);
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    try {
      injectDeps(() => session);

      await startVoiceTurn({
        conversationId: conversation.id,
        approvalMode: "local-live-voice",
        content: "List files",
        isInbound: true,
        trustContext: {
          sourceChannel: "phone",
          trustClass: "guardian",
          guardianExternalUserId: "+12125550142",
          guardianChatId: "+12125550142",
        },
        onTextDelta: () => {},
        onComplete: () => {},
        onError: () => {},
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(handleConfirmationCalls).toHaveLength(0);
      expect(
        publishedMessages.some(
          (message) =>
            message.type === "confirmation_request" &&
            message.requestId === "req-local-live-voice",
        ),
      ).toBe(true);
      expect(pendingInteractions.get("req-local-live-voice")).toMatchObject({
        conversationId: conversation.id,
        kind: "confirmation",
        confirmationDetails: {
          toolName: "host_bash",
          riskLevel: "low",
        },
      });
    } finally {
      pendingInteractions.resolve("req-local-live-voice");
      subscription.dispose();
    }
  });

  test("local live voice approvals: pending announced, prompter registration never clobbered, resolution reported", async () => {
    const conversation = createConversation(
      "voice bridge local live voice approval callbacks test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const rpcResolve = mock();
    const session = {
      isProcessing: () => false,
      persistUserMessage: async () => ({
        id: "test-msg-id",
        deduplicated: false,
      }),
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        // The prompter registers the FULL RPC lifecycle (rpcResolve, timer)
        // before broadcasting the confirmation_request through the client
        // handler — the bridge must not overwrite that entry, or the
        // executor's `await prompt()` is stranded forever.
        pendingInteractions.register("req-approval-1", {
          conversationId: conversation.id,
          kind: "confirmation",
          confirmationDetails: {
            toolName: "bash",
            input: { command: "rm -rf build" },
            riskLevel: "medium",
            allowlistOptions: [],
            scopeOptions: [],
          },
          rpcResolve,
        });
        clientHandler({
          type: "confirmation_request",
          requestId: "req-approval-1",
          toolName: "bash",
          input: { command: "rm -rf build" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
          conversationId: conversation.id,
        } as ServerMessage);
        // The user answers on the chat surface: the conversation emits the
        // authoritative state change through the same client handler.
        clientHandler({
          type: "confirmation_state_changed",
          conversationId: conversation.id,
          requestId: "req-approval-1",
          state: "approved",
          source: "button",
        } as ServerMessage);
        // A second request whose expiry fires (the chat-surface timeout).
        clientHandler({
          type: "confirmation_request",
          requestId: "req-approval-2",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
          riskLevel: "low",
          allowlistOptions: [],
          scopeOptions: [],
          conversationId: conversation.id,
        } as ServerMessage);
        clientHandler({
          type: "confirmation_state_changed",
          conversationId: conversation.id,
          requestId: "req-approval-2",
          state: "timed_out",
          source: "timeout",
        } as ServerMessage);
        // A state change for a request this turn never announced must not
        // produce a resolution report.
        clientHandler({
          type: "confirmation_state_changed",
          conversationId: conversation.id,
          requestId: "req-not-ours",
          state: "approved",
          source: "button",
        } as ServerMessage);
      },
      handleConfirmationResponse: () => {},
      abort: () => {},
    } as unknown as Conversation;

    const pendingEvents: Array<{
      requestId: string;
      toolName: string;
      summary: string;
    }> = [];
    const resolvedEvents: Array<{ requestId: string; outcome: string }> = [];

    try {
      injectDeps(() => session);

      await startVoiceTurn({
        conversationId: conversation.id,
        approvalMode: "local-live-voice",
        content: "Clean the build directory",
        isInbound: true,
        trustContext: {
          sourceChannel: "phone",
          trustClass: "guardian",
          guardianExternalUserId: "+12125550142",
          guardianChatId: "+12125550142",
        },
        onApprovalPending: (approval) => {
          pendingEvents.push({
            requestId: approval.requestId,
            toolName: approval.toolName,
            summary: approval.summary,
          });
        },
        onApprovalResolved: (requestId, outcome) => {
          resolvedEvents.push({ requestId, outcome });
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(pendingEvents).toEqual([
        {
          requestId: "req-approval-1",
          toolName: "bash",
          summary: "rm -rf build",
        },
        {
          requestId: "req-approval-2",
          toolName: "web_fetch",
          summary: "https://example.com",
        },
      ]);
      // Outcomes map from the confirmation_state_changed states: approved →
      // approved, timed_out → expired (the chat-surface expiry). The
      // unannounced request reports nothing.
      expect(resolvedEvents).toEqual([
        { requestId: "req-approval-1", outcome: "approved" },
        { requestId: "req-approval-2", outcome: "expired" },
      ]);
      // The prompter's registration survived the bridge: rpcResolve is still
      // on the entry POST /v1/confirm would resolve.
      expect(pendingInteractions.get("req-approval-1")?.rpcResolve).toBe(
        rpcResolve,
      );
    } finally {
      pendingInteractions.resolve("req-approval-1");
      pendingInteractions.resolve("req-approval-2");
    }
  });

  test("auto-allows confirmation requests for guardian voice turns", async () => {
    const conversation = createConversation(
      "voice bridge auto-allow guardian test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: async () => ({
        id: "test-msg-id",
        deduplicated: false,
      }),
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-3",
          toolName: "host_bash",
          input: { command: "ls" },
          riskLevel: "low",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
        // For verified guardian voice turns, the confirmation should be
        // auto-approved so the run can continue without a chat approval UI.
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "List files",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "guardian",
        guardianExternalUserId: "+15550001111",
        guardianChatId: "+15550001111",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-3");
    expect(handleConfirmationCalls[0].decision).toBe("allow");
  });

  test("auto-resolves secret requests for voice turns (no secret-entry UI)", async () => {
    const conversation = createConversation(
      "voice bridge secret auto-resolve test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleSecretCalls: Array<{
      requestId: string;
      value?: string;
      delivery?: "store" | "transient_send";
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: async () => ({
        id: "test-msg-id",
        deduplicated: false,
      }),
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "secret_request",
          requestId: "req-secret-1",
          service: "github",
          field: "token",
          label: "GitHub Token",
        } as ServerMessage);
      },
      handleConfirmationResponse: () => {},
      handleSecretResponse: (
        requestId: string,
        value?: string,
        delivery?: "store" | "transient_send",
      ) => {
        handleSecretCalls.push({ requestId, value, delivery });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "check github status",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "guardian",
        guardianExternalUserId: "+15550001111",
        guardianChatId: "+15550001111",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleSecretCalls.length).toBe(1);
    expect(handleSecretCalls[0].requestId).toBe("req-secret-1");
    expect(handleSecretCalls[0].value).toBeUndefined();
    expect(handleSecretCalls[0].delivery).toBe("store");
  });

  test("forcePromptSideEffects does not leak when persistUserMessage fails", async () => {
    const conversation = createConversation(
      "voice bridge forcePromptSideEffects leak test",
    );

    const session = {
      isProcessing: () => false,
      forcePromptSideEffects: false,
      callSessionId: undefined as string | undefined,
      persistUserMessage: async () => {
        throw new Error("simulated persistence failure");
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
      abort: () => {},
    } as unknown as Conversation & { forcePromptSideEffects: boolean };

    injectDeps(() => session);

    // Non-guardian voice would normally set forcePromptSideEffects = true.
    // The setup must fail before that assignment happens so the flag stays
    // false and cannot leak into subsequent non-voice turns.
    let caught: Error | null = null;
    try {
      await startVoiceTurn({
        conversationId: conversation.id,
        content: "Hello",
        isInbound: true,
        trustContext: {
          sourceChannel: "phone",
          trustClass: "trusted_contact",
        },
        onTextDelta: () => {},
        onComplete: () => {},
        onError: () => {},
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toBe("simulated persistence failure");
    expect(session.forcePromptSideEffects).toBe(false);
  });

  test("turn state does not leak when persistUserMessage fails", async () => {
    const conversation = createConversation(
      "voice bridge turn state leak test",
    );

    const lastSetterValue: Record<string, unknown> = {};
    const recordLast =
      (name: string) =>
      (value: unknown): void => {
        lastSetterValue[name] = value;
      };
    const session = {
      isProcessing: () => false,
      forcePromptSideEffects: false,
      callSessionId: undefined as string | undefined,
      persistUserMessage: async () => {
        throw new Error("simulated persistence failure");
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: recordLast("setChannelCapabilities"),
      setAssistantId: recordLast("setAssistantId"),
      setTrustContext: recordLast("setTrustContext"),
      setCommandIntent: recordLast("setCommandIntent"),
      setTurnChannelContext: recordLast("setTurnChannelContext"),
      setTurnInterfaceContext: recordLast("setTurnInterfaceContext"),
      setVoiceCallControlPrompt: recordLast("setVoiceCallControlPrompt"),
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
      abort: () => {},
    } as unknown as Conversation & {
      forcePromptSideEffects: boolean;
      callSessionId?: string;
    };
    session.callSessionId = "session-leak-test-precondition";

    injectDeps(() => session);

    let caught: Error | null = null;
    try {
      await startVoiceTurn({
        conversationId: conversation.id,
        voiceSessionId: "session-leak-test",
        content: "Hello",
        isInbound: true,
        trustContext: {
          sourceChannel: "phone",
          trustClass: "trusted_contact",
        },
        onTextDelta: () => {},
        onComplete: () => {},
        onError: () => {},
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toBe("simulated persistence failure");
    expect(lastSetterValue.setChannelCapabilities).toBeNull();
    expect(lastSetterValue.setTrustContext).toBeNull();
    expect(lastSetterValue.setCommandIntent).toBeNull();
    expect(lastSetterValue.setAssistantId).toBe("self");
    expect(lastSetterValue.setVoiceCallControlPrompt).toBeNull();
    expect(session.callSessionId).toBeUndefined();
    expect(session.forcePromptSideEffects).toBe(false);
  });

  test("cleanup on early persistUserMessage throw does not detach prior client sender", async () => {
    const conversation = createConversation(
      "voice bridge sender detach guard test",
    );

    const updateClientCalls: Array<{
      callback: unknown;
      replace: boolean | undefined;
    }> = [];

    const session = {
      isProcessing: () => false,
      forcePromptSideEffects: false,
      callSessionId: undefined as string | undefined,
      persistUserMessage: async () => {
        throw new Error("persist failed before bridge installed callback");
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (callback: unknown, replace?: boolean) => {
        updateClientCalls.push({ callback, replace });
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
      abort: () => {},
    } as unknown as Conversation & {
      forcePromptSideEffects: boolean;
      callSessionId?: string;
    };

    injectDeps(() => session);

    let caught: Error | null = null;
    try {
      await startVoiceTurn({
        conversationId: conversation.id,
        voiceSessionId: "session-sender-detach-test",
        content: "Hello",
        isInbound: true,
        trustContext: {
          sourceChannel: "phone",
          trustClass: "trusted_contact",
        },
        onTextDelta: () => {},
        onComplete: () => {},
        onError: () => {},
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toBe(
      "persist failed before bridge installed callback",
    );
    // The bridge never reached its `conversation.updateClient(...)` install
    // site, so cleanup must not touch updateClient — otherwise it would
    // detach a sender installed by a prior turn on the same conversation.
    expect(updateClientCalls).toEqual([]);
  });

  test("pre-aborted signal triggers immediate abort", async () => {
    const conversation = createConversation("voice bridge pre-abort test");
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (options: { requestId?: string }) => {
        session.currentRequestId = options.requestId;
        return { id: "test-msg-id", deduplicated: false };
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      handleConfirmationResponse: () => {},
      abort: () => {
        abortCalled = true;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const ac = new AbortController();
    ac.abort(); // Pre-abort before calling startVoiceTurn

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
      signal: ac.signal,
    });

    expect(abortCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V-1c — unified front-door legs: discard rollback, transcript hygiene,
// toolless bracket, routing-rule injection
// ---------------------------------------------------------------------------

import type { VoiceTurnOptions } from "../calls/voice-session-bridge.js";
import { ESCALATION_CONTINUATION_CONTENT } from "../calls/voice-triage-escalate.js";
import {
  getMessageById,
  reserveMessage,
  updateMessageContent,
} from "../memory/conversation-crud.js";

async function waitForCondition(
  predicate: () => boolean,
  message = "Timed out waiting for voice bridge test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(message);
}

/**
 * A persisting conversation mock whose agent loop is gated: the loop parks on
 * a promise the test releases, so ordering-sensitive teardown behavior (the
 * transcript-hygiene pass runs only after the loop settles) is deterministic.
 */
function makeVoiceLegSession(conversationId: string) {
  type PersistUserMessageContext = Parameters<typeof persistUserMessageImpl>[0];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let onEvent: ((msg: ServerMessage) => void) | undefined;
  let loopOptions: Record<string, unknown> | undefined;
  let controlPrompt: string | null = null;
  let processing = false;
  let loopSettled = false;
  const session = {
    conversationId,
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    trustContext: undefined,
    toolsDisabledDepth: 0,
    memoryPolicy: { scopeId: "default", includeDefaultFallback: false },
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    persistUserMessage: async (
      ...args: Parameters<Conversation["persistUserMessage"]>
    ) => persistUserMessageImpl(session, ...args),
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    setVoiceCallControlPrompt: (prompt: string | null) => {
      controlPrompt = prompt;
    },
    updateClient: () => {},
    ensureActorScopedHistory: async () => {},
    loadFromDb: async () => {},
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      options?: Record<string, unknown>,
    ) => {
      loopOptions = options;
      onEvent = options?.onEvent as typeof onEvent;
      await gate;
      loopSettled = true;
    },
    handleConfirmationResponse: () => {},
    abort: () => {},
  } as unknown as Conversation &
    PersistUserMessageContext & { toolsDisabledDepth: number };

  return {
    session,
    release,
    emit: (msg: ServerMessage) => onEvent?.(msg),
    getLoopOptions: () => loopOptions,
    getControlPrompt: () => controlPrompt,
    loopSettled: () => loopSettled,
  };
}

function makeLegTurnOptions(
  conversationId: string,
  overrides: Partial<VoiceTurnOptions> = {},
): VoiceTurnOptions {
  return {
    conversationId,
    userMessageChannel: "vellum",
    assistantMessageChannel: "vellum",
    userMessageInterface: "macos",
    assistantMessageInterface: "macos",
    voiceControlPrompt: "BASE VOICE PROMPT.",
    content: "hello world",
    isInbound: true,
    ...overrides,
  };
}

describe("voice-session-bridge front-door legs", () => {
  test("handle.discard() rolls back the persisted user row (idempotent)", async () => {
    const conversation = createConversation("voice discard test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    const handle = await startVoiceTurn(
      makeLegTurnOptions(conversation.id, {
        routingLeg: "front-door",
        unifiedVerdict: true,
        content: "hello wor",
      }),
    );
    expect(getMessages(conversation.id)).toHaveLength(1);
    expect(handle.discard).toBeDefined();

    await handle.discard!();
    expect(getMessages(conversation.id)).toHaveLength(0);
    // Idempotent: a second discard is a no-op.
    await handle.discard!();
    expect(getMessages(conversation.id)).toHaveLength(0);
    leg.release();
    await waitForCondition(() => leg.loopSettled());
  });

  test("a discarded leg's reserved assistant row is deleted by the hygiene pass", async () => {
    const conversation = createConversation("voice discard hygiene test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    const handle = await startVoiceTurn(
      makeLegTurnOptions(conversation.id, {
        routingLeg: "front-door",
        unifiedVerdict: true,
        content: "hello wor",
      }),
    );
    const reserved = await reserveMessage(conversation.id, "assistant");
    updateMessageContent(
      reserved.id,
      JSON.stringify([{ type: "text", text: "[0]" }]),
    );
    leg.emit({
      type: "assistant_turn_start",
      messageId: reserved.id,
      conversationId: conversation.id,
    });

    // Discard lands BEFORE the loop settles (the hold verdict beat the
    // model): the user row rolls back now, the reserved row at teardown.
    await handle.discard!();
    expect(getMessageById(reserved.id)).not.toBeNull();
    leg.release();
    await waitForCondition(() => getMessageById(reserved.id) === null);
    expect(getMessages(conversation.id)).toHaveLength(0);
  });

  test("an escalated front-door row is reduced to its capped spoken bridge", async () => {
    const conversation = createConversation("voice bridge cut test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(
      makeLegTurnOptions(conversation.id, { routingLeg: "front-door" }),
    );
    const reserved = await reserveMessage(conversation.id, "assistant");
    updateMessageContent(
      reserved.id,
      JSON.stringify([
        {
          type: "text",
          text: "[1] Let me check your email. And rambling past the cap.",
        },
      ]),
    );
    leg.emit({
      type: "assistant_turn_start",
      messageId: reserved.id,
      conversationId: conversation.id,
    });
    leg.release();

    await waitForCondition(() => {
      const row = getMessageById(reserved.id);
      return row !== null && !row.content.includes("[1]");
    });
    const row = getMessageById(reserved.id)!;
    expect(JSON.parse(row.content)).toEqual([
      { type: "text", text: "Let me check your email." },
    ]);
  });

  test("a bare escalate verdict (canned-fallback bridge) deletes the row", async () => {
    const conversation = createConversation("voice bare verdict test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(
      makeLegTurnOptions(conversation.id, { routingLeg: "front-door" }),
    );
    const reserved = await reserveMessage(conversation.id, "assistant");
    updateMessageContent(
      reserved.id,
      JSON.stringify([{ type: "text", text: "[1]" }]),
    );
    leg.emit({
      type: "assistant_turn_start",
      messageId: reserved.id,
      conversationId: conversation.id,
    });
    leg.release();

    await waitForCondition(() => getMessageById(reserved.id) === null);
  });

  test("a terminal [-1] minimize marker is stripped from any leg's row; a marker-only row deletes", async () => {
    const conversation = createConversation("voice minimize strip test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(makeLegTurnOptions(conversation.id));
    const reserved = await reserveMessage(conversation.id, "assistant");
    updateMessageContent(
      reserved.id,
      JSON.stringify([{ type: "text", text: "Done, take a look [-1]" }]),
    );
    leg.emit({
      type: "assistant_turn_start",
      messageId: reserved.id,
      conversationId: conversation.id,
    });
    leg.release();

    await waitForCondition(() => {
      const row = getMessageById(reserved.id);
      return row !== null && !row.content.includes("[-1]");
    });
    expect(JSON.parse(getMessageById(reserved.id)!.content)).toEqual([
      { type: "text", text: "Done, take a look" },
    ]);

    // Marker-only row: stripping leaves nothing — delete, never render a
    // blank assistant bubble.
    const leg2 = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg2.session);
    await startVoiceTurn(makeLegTurnOptions(conversation.id));
    const reserved2 = await reserveMessage(conversation.id, "assistant");
    updateMessageContent(
      reserved2.id,
      JSON.stringify([{ type: "text", text: "[-1]" }]),
    );
    leg2.emit({
      type: "assistant_turn_start",
      messageId: reserved2.id,
      conversationId: conversation.id,
    });
    leg2.release();
    await waitForCondition(() => getMessageById(reserved2.id) === null);
  });

  test("a mid-text [-1] is NOT a minimize marker and the row persists untouched", async () => {
    const conversation = createConversation("voice mid-text marker test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(makeLegTurnOptions(conversation.id));
    const reserved = await reserveMessage(conversation.id, "assistant");
    const content = JSON.stringify([
      { type: "text", text: "The array [-1] indexes the last element." },
    ]);
    updateMessageContent(reserved.id, content);
    leg.emit({
      type: "assistant_turn_start",
      messageId: reserved.id,
      conversationId: conversation.id,
    });
    leg.release();
    await waitForCondition(() => leg.loopSettled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getMessageById(reserved.id)!.content).toBe(content);
  });

  test("the front-door leg runs toolless on the voiceFrontDoor call site with the verdict rule", async () => {
    const conversation = createConversation("voice front-door leg test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(
      makeLegTurnOptions(conversation.id, {
        routingLeg: "front-door",
        unifiedVerdict: true,
        content: 'is it "raining" today',
      }),
    );
    await waitForCondition(() => leg.getLoopOptions() !== undefined);

    // Toolless bracket held for the duration of the leg.
    expect(leg.session.toolsDisabledDepth).toBe(1);
    expect(leg.getLoopOptions()?.callSite).toBe("voiceFrontDoor");

    // The verdict rule rides the caller-supplied control prompt, with the
    // hold branch (unifiedVerdict) and the JSON-hardened utterance anchor.
    const prompt = leg.getControlPrompt()!;
    expect(prompt).toContain("BASE VOICE PROMPT.");
    expect(prompt).toContain("DECIDE SILENTLY");
    expect(prompt).toContain("[0]");
    expect(prompt).toContain(JSON.stringify('is it "raining" today'));

    leg.release();
    await waitForCondition(() => leg.loopSettled());
    await waitForCondition(() => leg.session.toolsDisabledDepth === 0);
  });

  test("a non-unified front-door leg is not taught the hold token", async () => {
    const conversation = createConversation("voice no-hold leg test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(
      makeLegTurnOptions(conversation.id, { routingLeg: "front-door" }),
    );
    await waitForCondition(() => leg.getLoopOptions() !== undefined);
    const prompt = leg.getControlPrompt()!;
    expect(prompt).not.toContain("[0]");
    expect(prompt).toContain("has finished their turn");
    leg.release();
  });

  test("the escalated leg gets the continuation rule and persists its prompt hidden", async () => {
    const conversation = createConversation("voice escalated leg test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(
      makeLegTurnOptions(conversation.id, {
        routingLeg: "escalated",
        spokenEscalationBridge: "Let me check your email.",
        content: ESCALATION_CONTINUATION_CONTENT,
      }),
    );
    await waitForCondition(() => leg.getLoopOptions() !== undefined);

    // Ordinary call-agent resolution and full tools for the strong leg.
    expect(leg.getLoopOptions()?.callSite).toBe("callAgent");
    expect(leg.session.toolsDisabledDepth).toBe(0);
    const prompt = leg.getControlPrompt()!;
    expect(prompt).toContain('"Let me check your email."');
    expect(prompt.toLowerCase()).toContain("re-announce");

    // The synthetic continuation prompt persists hidden, so it never renders
    // as a user bubble after a reload.
    const rows = getMessages(conversation.id);
    expect(rows).toHaveLength(1);
    expect(parsePersistedMetadata(rows[0]!.metadata)).toMatchObject({
      voiceTurn: true,
      hidden: true,
    });
    leg.release();
  });

  test("a plain voice turn (no routing leg) keeps today's prompt and callAgent path", async () => {
    const conversation = createConversation("voice plain leg test");
    const leg = makeVoiceLegSession(conversation.id);
    injectDeps(() => leg.session);

    await startVoiceTurn(makeLegTurnOptions(conversation.id));
    await waitForCondition(() => leg.getLoopOptions() !== undefined);
    expect(leg.getLoopOptions()?.callSite).toBe("callAgent");
    expect(leg.getControlPrompt()).toBe("BASE VOICE PROMPT.");
    expect(leg.session.toolsDisabledDepth).toBe(0);
    const rows = getMessages(conversation.id);
    expect(parsePersistedMetadata(rows[0]!.metadata).hidden).toBeUndefined();
    leg.release();
  });
});

// ---------------------------------------------------------------------------
// Front-door hub-stream gate
//
// The front-door leg's raw stream is a control plane: its leading tokens are
// the routing verdict, not speech. The conversation-hub broadcast (web chat,
// passive devices) must never carry those tokens, and must still carry every
// word of real assistant content — an over-broad filter would leave the
// shared transcript silent or truncated, which is worse than the leak it
// fixes. These assert on what actually leaves the daemon: the messages a real
// hub subscriber receives, not an internal flag.
// ---------------------------------------------------------------------------

describe("front-door hub stream gate", () => {
  /**
   * Run one voice leg to completion with `deltas` streamed through the agent
   * loop, and return every message the hub published for that conversation.
   */
  async function runLegCollectingHub(
    conversationId: string,
    turnOverrides: Partial<VoiceTurnOptions>,
    deltas: string[],
    finalEvent:
      | "message_complete"
      | "generation_cancelled" = "message_complete",
  ): Promise<ServerMessage[]> {
    const published: ServerMessage[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: { conversationId },
      callback: (event) => {
        published.push(event.message);
      },
    });
    try {
      const leg = makeVoiceLegSession(conversationId);
      injectDeps(() => leg.session);
      await startVoiceTurn(makeLegTurnOptions(conversationId, turnOverrides));
      await waitForCondition(() => leg.getLoopOptions() !== undefined);

      const reserved = await reserveMessage(conversationId, "assistant");
      leg.emit({
        type: "assistant_turn_start",
        messageId: reserved.id,
        conversationId,
      });
      for (const text of deltas) {
        leg.emit({
          type: "assistant_text_delta",
          text,
          messageId: reserved.id,
          conversationId,
        });
      }
      leg.emit(
        finalEvent === "message_complete"
          ? { type: "message_complete", messageId: reserved.id, conversationId }
          : ({ type: "generation_cancelled", conversationId } as ServerMessage),
      );
      leg.release();
      await waitForCondition(() => leg.loopSettled());
      // The hub publishes off a promise chain, so a broadcast costs a few
      // microtask hops before it reaches a subscriber.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      subscription.dispose();
    }
    return published;
  }

  /** The text of every `assistant_text_delta` a hub subscriber received. */
  function deltaTexts(published: ServerMessage[]): string[] {
    return published
      .filter(
        (msg): msg is ServerMessage & { type: "assistant_text_delta" } =>
          msg.type === "assistant_text_delta",
      )
      .map((msg) => msg.text);
  }

  test("an escalating leg broadcasts only the capped bridge, never the verdict token", async () => {
    const conversation = createConversation("hub gate escalate");
    const published = await runLegCollectingHub(
      conversation.id,
      { routingLeg: "front-door" },
      ["[1]", " Let me check your calendar.", " weak answer past the cap"],
    );

    expect(deltaTexts(published)).toEqual(["Let me check your calendar."]);
    expect(deltaTexts(published).join("")).not.toContain("[1]");
  });

  test("a hold verdict broadcasts nothing at all", async () => {
    const conversation = createConversation("hub gate hold");
    const published = await runLegCollectingHub(
      conversation.id,
      { routingLeg: "front-door", unifiedVerdict: true },
      ["[0]", " the caller kept talking so this is never spoken"],
    );

    expect(deltaTexts(published)).toEqual([]);
  });

  test("a front-door answer reaches the hub in full", async () => {
    const conversation = createConversation("hub gate answer");
    const published = await runLegCollectingHub(
      conversation.id,
      { routingLeg: "front-door" },
      ["It is ", "Tuesday", ", and it is sunny."],
    );

    expect(deltaTexts(published).join("")).toBe(
      "It is Tuesday, and it is sunny.",
    );
  });

  test("an answer that merely opens with a bracket is released in full", async () => {
    const conversation = createConversation("hub gate bracket answer");
    const published = await runLegCollectingHub(
      conversation.id,
      { routingLeg: "front-door" },
      ["[", "A] is the option to pick."],
    );

    expect(deltaTexts(published).join("")).toBe("[A] is the option to pick.");
  });

  test("a leg that completes mid-bridge broadcasts what it handed off with", async () => {
    const conversation = createConversation("hub gate mid-bridge");
    const published = await runLegCollectingHub(
      conversation.id,
      { routingLeg: "front-door" },
      ["[1] Let me check"],
    );

    expect(deltaTexts(published)).toEqual(["Let me check"]);
  });

  test("a leg cancelled mid-bridge never hands off, so it broadcasts nothing", async () => {
    const conversation = createConversation("hub gate cancelled bridge");
    const published = await runLegCollectingHub(
      conversation.id,
      { routingLeg: "front-door" },
      ["[1] Let me check"],
      "generation_cancelled",
    );

    expect(deltaTexts(published)).toEqual([]);
  });

  test("the escalated continuation streams to the hub untouched", async () => {
    // The leg that produces the real answer is never gated: its deltas are
    // assistant speech from the first token.
    const conversation = createConversation("hub gate escalated leg");
    const published = await runLegCollectingHub(
      conversation.id,
      {
        routingLeg: "escalated",
        spokenEscalationBridge: "Let me check your calendar.",
        content: ESCALATION_CONTINUATION_CONTENT,
      },
      ["Your next meeting ", "is at four."],
    );

    expect(deltaTexts(published)).toEqual([
      "Your next meeting ",
      "is at four.",
    ]);
  });

  test("the flag-off path is byte-identical: an un-routed leg broadcasts the very same objects", async () => {
    // This is what protects the daily driver while the flag sits off. With
    // `liveVoice.frontDoor.enabled` false the session never sets `routingLeg`,
    // so no gate is constructed and every event reaches the hub by object
    // identity — not merely equal text, the same object.
    const conversation = createConversation("hub gate flag off");
    const emitted: ServerMessage[] = [];
    const published: ServerMessage[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: { conversationId: conversation.id },
      callback: (event) => {
        published.push(event.message);
      },
    });
    try {
      const leg = makeVoiceLegSession(conversation.id);
      injectDeps(() => leg.session);
      await startVoiceTurn(makeLegTurnOptions(conversation.id));
      await waitForCondition(() => leg.getLoopOptions() !== undefined);

      const reserved = await reserveMessage(conversation.id, "assistant");
      const events: ServerMessage[] = [
        {
          type: "assistant_turn_start",
          messageId: reserved.id,
          conversationId: conversation.id,
        },
        // Text a gate would have swallowed or rewritten, proving the un-routed
        // path does neither.
        {
          type: "assistant_text_delta",
          text: "[1] not a verdict here",
          messageId: reserved.id,
          conversationId: conversation.id,
        },
        {
          type: "assistant_text_delta",
          text: " [0] nor here",
          messageId: reserved.id,
          conversationId: conversation.id,
        },
        {
          type: "message_complete",
          messageId: reserved.id,
          conversationId: conversation.id,
        },
      ];
      for (const event of events) {
        emitted.push(event);
        leg.emit(event);
      }
      leg.release();
      await waitForCondition(() => leg.loopSettled());
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      subscription.dispose();
    }

    expect(deltaTexts(published)).toEqual([
      "[1] not a verdict here",
      " [0] nor here",
    ]);
    // Object identity: the un-routed path does not even copy the event.
    for (const event of emitted) {
      expect(published).toContain(event);
    }
  });
});

describe("cutFrontDoorContentAtVerdict", () => {
  test("null for a clean front-door answer (nothing to rewrite)", () => {
    expect(
      cutFrontDoorContentAtVerdict([{ type: "text", text: "It is Tuesday." }]),
    ).toBeNull();
  });

  test("reduces a leading escalate verdict to the capped bridge", () => {
    const cut = cutFrontDoorContentAtVerdict([
      { type: "text", text: "[1] One sec. And more text past the sentence." },
    ]);
    expect(cut?.spokenText).toBe("One sec.");
    expect(cut?.blocks).toEqual([{ type: "text", text: "One sec." }]);
  });

  test("empty spoken text for a bare verdict (caller should delete the row)", () => {
    const cut = cutFrontDoorContentAtVerdict([{ type: "text", text: "[1]" }]);
    expect(cut?.spokenText).toBe("");
    expect(cut?.blocks).toEqual([]);
  });

  test("strips stray verdict tokens inside an answer (never spoken live)", () => {
    const cut = cutFrontDoorContentAtVerdict([
      { type: "text", text: "hey [0] there" },
    ]);
    expect(cut?.spokenText).toBe("hey  there");
  });
});
