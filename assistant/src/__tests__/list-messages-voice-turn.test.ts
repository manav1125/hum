/**
 * Tests for handleListMessages voiceTurn projection.
 *
 * The daemon's voice paths (voice-session bridge, live-voice thread writer)
 * stamp `voiceTurn: true` in message metadata at persist time. The messages
 * snapshot must surface that marker on the wire row so clients can keep the
 * voice treatment (e.g. the mobile 🎙 bubble) across history reloads.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

interface MessagePayload {
  role: string;
  voiceTurn?: boolean;
}

function textContent(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

describe("handleListMessages voiceTurn", () => {
  beforeEach(resetTables);

  test("surfaces the persisted voice marker on the user row", async () => {
    // GIVEN a user message persisted through a voice path (metadata marker)
    const conv = createConversation();
    await addMessage(conv.id, "user", textContent("spoken words"), {
      metadata: { voiceTurn: true },
      skipIndexing: true,
    });

    // WHEN the messages snapshot is built
    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the wire row carries the marker
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].voiceTurn).toBe(true);
  });

  test("omits voiceTurn on ordinary typed rows", async () => {
    const conv = createConversation();
    await addMessage(conv.id, "user", textContent("typed words"), {
      skipIndexing: true,
    });

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].voiceTurn).toBeUndefined();
  });

  test("never emits voiceTurn on assistant rows even if metadata carries it", async () => {
    // Defensive: only user rows are voice turns; a stray marker on an
    // assistant row must not leak onto the wire.
    const conv = createConversation();
    await addMessage(conv.id, "user", textContent("spoken words"), {
      metadata: { voiceTurn: true },
      skipIndexing: true,
    });
    await addMessage(conv.id, "assistant", textContent("reply"), {
      metadata: { voiceTurn: true },
      skipIndexing: true,
    });

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    const assistantRow = body.messages.find((m) => m.role === "assistant");
    expect(assistantRow?.voiceTurn).toBeUndefined();
  });
});
