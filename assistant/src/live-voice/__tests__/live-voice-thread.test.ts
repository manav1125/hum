import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getMessages } from "../../memory/conversation-crud.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  ensureLiveVoiceThread,
  persistLiveVoiceTurn,
} from "../live-voice-thread.js";

initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("persistLiveVoiceTurn", () => {
  beforeEach(() => {
    resetTables();
  });

  test("stamps the durable voiceTurn marker on the persisted user row only", async () => {
    const conversationId = crypto.randomUUID();
    ensureLiveVoiceThread(conversationId);

    await persistLiveVoiceTurn(
      conversationId,
      "Spoken user words",
      "Assistant reply",
    );

    const messages = getMessages(conversationId);
    const userRow = messages.find((m) => m.role === "user");
    const assistantRow = messages.find((m) => m.role === "assistant");

    expect(userRow).toBeDefined();
    expect(assistantRow).toBeDefined();

    // User voice turns carry the marker so reloaded history can keep the
    // voice treatment (same key the voice-session bridge stamps).
    const userMetadata = JSON.parse(userRow?.metadata ?? "{}") as Record<
      string,
      unknown
    >;
    expect(userMetadata.voiceTurn).toBe(true);

    // Assistant replies are ordinary rows — no voice marker.
    const assistantMetadata = JSON.parse(
      assistantRow?.metadata ?? "{}",
    ) as Record<string, unknown>;
    expect(assistantMetadata.voiceTurn).toBeUndefined();
  });

  test("skips empty utterances without persisting marker-only rows", async () => {
    const conversationId = crypto.randomUUID();
    ensureLiveVoiceThread(conversationId);

    await persistLiveVoiceTurn(conversationId, "   ", "Assistant only");

    const messages = getMessages(conversationId);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(0);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});
