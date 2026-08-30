/**
 * Boot-time hung-turn recovery (`daemon/turn-recovery.ts`).
 *
 * Simulates the daemon-death shapes directly in SQLite:
 *   - a reserved assistant row still carrying the `turnInFlight` marker
 *     (current daemons, including partially-streamed content),
 *   - a legacy reserved-but-empty row (`content === "[]"`, no marker),
 * and asserts the sweep stamps `interrupted`/`interruptedAt`, clears the
 * marker, emits a `turn_interrupted` event per orphaned row, is idempotent
 * across restarts, and leaves finalized rows untouched.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
    },
  }),
}));

import type { TurnInterruptedEvent } from "../api/events/turn-interrupted.js";
import { recoverInterruptedTurns } from "../daemon/turn-recovery.js";
import {
  INTERRUPTED_METADATA_KEY,
  TURN_IN_FLIGHT_METADATA_KEY,
} from "../daemon/turn-recovery-markers.js";
import {
  addMessage,
  createConversation,
  getMessages,
  reserveMessage,
} from "../memory/conversation-crud.js";
import { GENERATING_TITLE } from "../memory/conversation-title-service.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { conversations, messages } from "../memory/schema.js";

initializeDb();

const NOW = 1_770_000_000_000;

function runRecovery(events: TurnInterruptedEvent[] = []) {
  return recoverInterruptedTurns({
    publishEvent: (event) => events.push(event),
    regenerateTitles: false,
    now: () => NOW,
  });
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeEach(() => {
  const db = getDb();
  db.delete(messages).run();
  db.delete(conversations).run();
});

describe("recoverInterruptedTurns", () => {
  test("marks a marker-carrying orphaned row interrupted and emits the event", async () => {
    const conv = createConversation("Recovery test");
    await addMessage(conv.id, "user", "hello", { skipIndexing: true });
    // Simulate `handleLlmCallStarted`'s reservation for a turn that died:
    // the marker was stamped and never cleared, and a partial flush already
    // wrote some streamed text.
    const reserved = await reserveMessage(conv.id, "assistant", {
      [TURN_IN_FLIGHT_METADATA_KEY]: true,
      assistantMessageChannel: "vellum",
    });
    const partialContent = JSON.stringify([
      { type: "text", text: "I was halfway through answer" },
    ]);
    getDb()
      .update(messages)
      .set({ content: partialContent })
      .where(eq(messages.id, reserved.id))
      .run();

    const events: TurnInterruptedEvent[] = [];
    const result = runRecovery(events);

    expect(result.recoveredMessages).toBe(1);
    expect(result.conversationIds).toEqual([conv.id]);

    const rows = getMessages(conv.id);
    const assistantRow = rows.find((m) => m.id === reserved.id);
    expect(assistantRow).toBeDefined();
    // Partially-streamed content is preserved, not clobbered.
    expect(assistantRow!.content).toBe(partialContent);
    const meta = parseMetadata(assistantRow!.metadata);
    expect(meta[INTERRUPTED_METADATA_KEY]).toBe(true);
    expect(meta.interruptedAt).toBe(NOW);
    // Marker cleared so the row can't be re-swept.
    expect(meta[TURN_IN_FLIGHT_METADATA_KEY]).toBeUndefined();
    // Unrelated metadata survives the merge.
    expect(meta.assistantMessageChannel).toBe("vellum");

    expect(events).toEqual([
      {
        type: "turn_interrupted",
        conversationId: conv.id,
        messageId: reserved.id,
        interruptedAt: NOW,
        reason: "daemon_restart",
      },
    ]);
  });

  test("catches legacy reserved-but-empty rows without the marker", async () => {
    const conv = createConversation("Legacy orphan");
    await addMessage(conv.id, "user", "hi", { skipIndexing: true });
    // Pre-marker daemons left the reserved row exactly as created: "[]".
    const reserved = await reserveMessage(conv.id, "assistant", {
      assistantMessageChannel: "vellum",
    });

    const events: TurnInterruptedEvent[] = [];
    const result = runRecovery(events);

    expect(result.recoveredMessages).toBe(1);
    const row = getMessages(conv.id).find((m) => m.id === reserved.id);
    const meta = parseMetadata(row!.metadata);
    expect(meta[INTERRUPTED_METADATA_KEY]).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].messageId).toBe(reserved.id);
  });

  test("leaves finalized and already-recovered rows untouched (idempotent)", async () => {
    const conv = createConversation("Completed turn");
    await addMessage(conv.id, "user", "hello", { skipIndexing: true });
    // A finalized row: content written, marker cleared — the shape
    // `handleMessageComplete` leaves behind.
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "done" }]),
      { skipIndexing: true },
    );

    const firstEvents: TurnInterruptedEvent[] = [];
    expect(runRecovery(firstEvents).recoveredMessages).toBe(0);
    expect(firstEvents).toHaveLength(0);

    // Now add an orphan, recover it, and re-run: the second sweep must be
    // a no-op (restart idempotency).
    await reserveMessage(conv.id, "assistant", {
      [TURN_IN_FLIGHT_METADATA_KEY]: true,
    });
    expect(runRecovery().recoveredMessages).toBe(1);
    const secondEvents: TurnInterruptedEvent[] = [];
    expect(runRecovery(secondEvents).recoveredMessages).toBe(0);
    expect(secondEvents).toHaveLength(0);
  });

  test("does not mark user rows or rows that merely quote the marker", async () => {
    const conv = createConversation("False positives");
    // A user message whose *text* contains the marker string must not match
    // (the SQL LIKE is only a prefilter; the JS re-check keys on metadata).
    await addMessage(conv.id, "user", '{"turnInFlight":true}', {
      skipIndexing: true,
    });
    // An assistant row whose metadata says turnInFlight: false.
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "fine" }]),
      {
        skipIndexing: true,
        metadata: { [TURN_IN_FLIGHT_METADATA_KEY]: false },
      },
    );

    expect(runRecovery().recoveredMessages).toBe(0);
  });

  test("groups multiple orphaned rows under one conversation", async () => {
    const conv = createConversation({
      title: GENERATING_TITLE,
      isAutoTitle: 1,
    });
    await addMessage(conv.id, "user", "multi-call turn", {
      skipIndexing: true,
    });
    const first = await reserveMessage(conv.id, "assistant", {
      [TURN_IN_FLIGHT_METADATA_KEY]: true,
    });
    const second = await reserveMessage(conv.id, "assistant", {
      [TURN_IN_FLIGHT_METADATA_KEY]: true,
    });

    const events: TurnInterruptedEvent[] = [];
    const result = runRecovery(events);

    expect(result.recoveredMessages).toBe(2);
    expect(result.conversationIds).toEqual([conv.id]);
    expect(events.map((e) => e.messageId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});
