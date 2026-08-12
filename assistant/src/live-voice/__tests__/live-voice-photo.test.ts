/**
 * `persistLiveVoicePhoto` — a mid-call camera photo persists into the
 * conversation as its own user message, runs NO turn, and never throws.
 * Ported behaviour from upstream 48a63d28d7 / 639f7bc1cb.
 *
 * Unit-level: every collaborator is a module seam, mocked by spreading the
 * real module and overriding only the seam being driven (see
 * assistant/CLAUDE.md on `mock.module`).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Seams ──────────────────────────────────────────────────────────────

const storedAttachments = new Map<
  string,
  { originalFilename: string; mimeType: string; dataBase64: string }
>();
const sourcePaths = new Map<string, string>();

const attachmentsActual = await import("../../memory/attachments-store.js");
mock.module("../../memory/attachments-store.js", () => ({
  ...attachmentsActual,
  getAttachmentsByIds: (
    ids: string[],
    options?: { hydrateFileData?: boolean },
  ) => {
    // The photo path must hydrate bytes (file-backed rows store "" inline).
    expect(options?.hydrateFileData).toBe(true);
    return ids.flatMap((id) => {
      const row = storedAttachments.get(id);
      return row ? [{ id, ...row }] : [];
    });
  },
  getSourcePathsForAttachments: (ids: string[]) =>
    new Map([...sourcePaths].filter(([id]) => ids.includes(id))),
}));

interface FakeConversation {
  processing: boolean;
  isProcessing: () => boolean;
  setProcessing: (value: boolean) => void;
  drainQueue: ReturnType<typeof mock>;
}

let conversation: FakeConversation;
const conversationStoreActual =
  await import("../../daemon/conversation-store.js");
mock.module("../../daemon/conversation-store.js", () => ({
  ...conversationStoreActual,
  getOrCreateConversation: async () => conversation,
}));

let persistCalls: Array<Record<string, unknown>> = [];
let persistImpl: () => Promise<{ id: string; deduplicated: boolean }>;
const messagingActual = await import("../../daemon/conversation-messaging.js");
mock.module("../../daemon/conversation-messaging.js", () => ({
  ...messagingActual,
  persistQueuedMessageBody: async (
    _ctx: unknown,
    options: Record<string, unknown>,
  ) => {
    persistCalls.push(options);
    return persistImpl();
  },
}));

let broadcasts: Array<Record<string, unknown>> = [];
const hubActual = await import("../../runtime/assistant-event-hub.js");
mock.module("../../runtime/assistant-event-hub.js", () => ({
  ...hubActual,
  broadcastMessage: (event: Record<string, unknown>) => {
    broadcasts.push(event);
  },
}));

let syncPublishes: string[] = [];
const syncActual = await import("../../runtime/sync/resource-sync-events.js");
mock.module("../../runtime/sync/resource-sync-events.js", () => ({
  ...syncActual,
  publishConversationMessagesChanged: (conversationId: string) => {
    syncPublishes.push(conversationId);
  },
}));

const { persistLiveVoicePhoto } = await import("../live-voice-photo.js");

// ── Harness ────────────────────────────────────────────────────────────

function makeConversation(): FakeConversation {
  const fake: FakeConversation = {
    processing: false,
    isProcessing: () => fake.processing,
    setProcessing: (value: boolean) => {
      fake.processing = value;
    },
    drainQueue: mock(async () => {}),
  };
  return fake;
}

beforeEach(() => {
  storedAttachments.clear();
  sourcePaths.clear();
  storedAttachments.set("att-1", {
    originalFilename: "photo-1.jpg",
    mimeType: "image/jpeg",
    dataBase64: "aGVsbG8=",
  });
  conversation = makeConversation();
  persistCalls = [];
  persistImpl = async () => ({ id: "msg-1", deduplicated: false });
  broadcasts = [];
  syncPublishes = [];
});

describe("persistLiveVoicePhoto", () => {
  test("persists the photo as its own user message and echoes it", async () => {
    sourcePaths.set("att-1", "/workspace/photos/photo-1.jpg");

    const result = await persistLiveVoicePhoto("conv-1", "att-1");

    expect(result).toEqual({ ok: true, messageId: "msg-1" });
    expect(persistCalls).toHaveLength(1);
    const options = persistCalls[0]!;
    expect(options.content).toBe("here's a photo:");
    expect(options.metadata).toEqual({
      voiceSessionTurn: true,
      livePhoto: true,
    });
    // Request ids are UUID v4 (never v7 — our uuid dependency has no v7).
    expect(String(options.requestId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(options.attachments).toEqual([
      {
        id: "att-1",
        filename: "photo-1.jpg",
        mimeType: "image/jpeg",
        data: "aGVsbG8=",
        filePath: "/workspace/photos/photo-1.jpg",
      },
    ]);

    // The row runs no turn, so the clients are told directly.
    expect(broadcasts).toEqual([
      {
        type: "user_message_echo",
        text: "here's a photo:",
        conversationId: "conv-1",
        messageId: "msg-1",
      },
    ]);
    expect(syncPublishes).toEqual(["conv-1"]);

    // Lock released, queue kicked so nothing parked behind the write waits.
    expect(conversation.processing).toBe(false);
    expect(conversation.drainQueue).toHaveBeenCalledWith("loop_complete");
  });

  test("waits for an in-flight turn to go idle before taking the lock", async () => {
    conversation.processing = true;
    setTimeout(() => {
      conversation.processing = false;
    }, 150);

    const result = await persistLiveVoicePhoto("conv-1", "att-1");

    expect(result.ok).toBe(true);
    expect(persistCalls).toHaveLength(1);
  });

  test("holds the processing lock across the persist", async () => {
    let processingDuringPersist: boolean | null = null;
    persistImpl = async () => {
      processingDuringPersist = conversation.processing;
      return { id: "msg-1", deduplicated: false };
    };

    await persistLiveVoicePhoto("conv-1", "att-1");

    // Widen at the read: TS narrows the closed-over `let` to its `null`
    // initializer at this point (the assignment happens inside the
    // persistImpl closure), which fails `toBe(true)` at the type level.
    expect(processingDuringPersist as boolean | null).toBe(true);
    expect(conversation.processing).toBe(false);
  });

  test("an unresolvable attachment fails softly, storing nothing", async () => {
    const result = await persistLiveVoicePhoto("conv-1", "att-missing");

    expect(result).toEqual({ ok: false });
    expect(persistCalls).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  test("a throwing persist never escapes — the call must not die", async () => {
    persistImpl = async () => {
      throw new Error("disk full");
    };

    const result = await persistLiveVoicePhoto("conv-1", "att-1");

    expect(result).toEqual({ ok: false });
    // The lock is still released and the queue still kicked on the way out.
    expect(conversation.processing).toBe(false);
    expect(conversation.drainQueue).toHaveBeenCalled();
    expect(broadcasts).toHaveLength(0);
  });
});
