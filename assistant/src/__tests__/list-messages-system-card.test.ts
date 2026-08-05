/**
 * Tests for handleListMessages systemCard projection.
 *
 * The daemon's canned-card paths (the /compact, /clean, and summarize-up-to
 * result cards) stamp `systemCard: "<kind>"` in message metadata at persist
 * time. The messages snapshot must surface that marker on the wire row so
 * clients render the row with the quiet centered system-card treatment
 * (design ruling 4, Wave C) instead of an assistant bubble.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const actualLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualLoader,
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
  systemCard?: string;
}

function textContent(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

describe("handleListMessages systemCard", () => {
  beforeEach(resetTables);

  test("surfaces the persisted system-card marker on the assistant row", async () => {
    // GIVEN a canned result card persisted with the metadata marker
    const conv = createConversation();
    await addMessage(
      conv.id,
      "assistant",
      textContent("Compacted · 41 messages → 1 summary\nContext facts"),
      {
        metadata: { systemCard: "compact" },
        skipIndexing: true,
      },
    );

    // WHEN the messages snapshot is built
    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the wire row carries the marker
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("assistant");
    expect(body.messages[0].systemCard).toBe("compact");
  });

  test("omits systemCard on ordinary assistant rows", async () => {
    const conv = createConversation();
    await addMessage(conv.id, "assistant", textContent("a model reply"), {
      skipIndexing: true,
    });

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].systemCard).toBeUndefined();
  });

  test("never emits systemCard on user rows even if metadata carries it", async () => {
    // Defensive: only assistant rows are daemon-authored cards; a stray
    // marker on a user row must not leak onto the wire.
    const conv = createConversation();
    await addMessage(conv.id, "user", textContent("/compact"), {
      metadata: { systemCard: "compact" },
      skipIndexing: true,
    });

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].systemCard).toBeUndefined();
  });
});
