/**
 * Regression proof for the conversations-table runaway (45k
 * `conversation_type='background'` rows / 500MB assistant.db): background
 * memory jobs (memory-v2 consolidation, memory retrospective) run through
 * `runBackgroundJob` with `ephemeralConversation: true`, so a settled run
 * persists ZERO new `conversations` rows — while the memory writes the run
 * performed (DB state rows, memory files) persist.
 *
 * This test exercises the REAL database path: real `bootstrapConversation`,
 * real `deleteConversation` (with its message cascade), real state-row
 * writes — only `processMessage` (the agent turn) and the pre-first-message
 * gate are stubbed. The turn stub performs the two kinds of durable memory
 * output the jobs produce in production:
 *   - a `memory_retrospective_state` row (the retrospective's persisted
 *     pointer + remembered_log), and
 *   - a memory concept file under the workspace (consolidation's output).
 * Both must survive the ephemeral conversation row's deletion.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// The unit under test is the persistence contract, not the agent loop:
// stub the turn itself. The stub body is assigned per-test.
let processMessageImpl: (
  conversationId: string,
) => Promise<unknown> = async () => ({ messageId: "msg-1" });
mock.module("../daemon/process-message.js", () => ({
  processMessage: async (conversationId: string) =>
    processMessageImpl(conversationId),
}));

// Background jobs are gated until the first real user message; that gate is
// orthogonal to what this test proves.
mock.module("../runtime/pre-first-message-gate.js", () => ({
  hasReceivedUserMessage: () => true,
}));

import type { TrustContext } from "../daemon/trust-context.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getRetrospectiveState,
  upsertRetrospectiveState,
} from "../memory/memory-retrospective-state.js";
import { conversations, messages } from "../memory/schema.js";
import { getWorkspaceDir } from "../util/platform.js";

const { runBackgroundJob } =
  await import("../runtime/background-job-runner.js");

initializeDb();

const TRUST_CONTEXT: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

const SOURCE_CONVERSATION_ID = "conv-zero-rows-source";

function countConversations(): number {
  return getDb().select().from(conversations).all().length;
}

function countMessagesFor(conversationId: string): number {
  return getDb()
    .select()
    .from(messages)
    .all()
    .filter((m) => m.conversationId === conversationId).length;
}

beforeEach(() => {
  processMessageImpl = async () => ({ messageId: "msg-1" });
});

describe("ephemeral background memory runs persist zero conversations rows", () => {
  test("consolidation/retrospective-shaped run: conversations count unchanged, memory writes persist", async () => {
    // Seed a normal user conversation to play the retrospective's SOURCE —
    // its state row is the run's durable output and must not ride the
    // ephemeral conversation's deletion.
    const now = Date.now();
    getDb()
      .insert(conversations)
      .values({
        id: SOURCE_CONVERSATION_ID,
        title: "user conversation",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const conceptPath = join(
      getWorkspaceDir(),
      "memory",
      "concepts",
      "zero-rows-test.md",
    );

    const before = countConversations();
    let ephemeralConversationId = "";
    let rowExistedDuringRun = false;

    processMessageImpl = async (conversationId: string) => {
      ephemeralConversationId = conversationId;
      // The bootstrapped background conversation row IS persisted while the
      // run executes (the agent loop needs it) …
      rowExistedDuringRun = getDb()
        .select()
        .from(conversations)
        .all()
        .some((c) => c.id === conversationId);

      // … and the run's real outputs are written elsewhere:
      // 1. the retrospective's persisted state row on the SOURCE conversation,
      upsertRetrospectiveState({
        conversationId: SOURCE_CONVERSATION_ID,
        lastProcessedMessageId: "m-cutoff",
        lastRunAt: Date.now(),
        rememberedLog: ["fact saved by the background run"],
      });
      // 2. a consolidation-style memory concept file.
      mkdirSync(dirname(conceptPath), { recursive: true });
      writeFileSync(conceptPath, "# Zero rows\nA persisted concept.\n");

      return { messageId: "msg-run" };
    };

    const result = await runBackgroundJob({
      jobName: "memory.consolidate",
      source: "memory_v2_consolidation",
      prompt: "consolidate the buffer",
      trustContext: TRUST_CONTEXT,
      callSite: "memoryV2Consolidation",
      timeoutMs: 5_000,
      origin: "memory_consolidation",
      suppressFailureNotifications: true,
      ephemeralConversation: true,
    });

    expect(result.ok).toBe(true);
    expect(ephemeralConversationId).not.toBe("");
    expect(rowExistedDuringRun).toBe(true);

    // ZERO new conversations rows persisted by the run.
    expect(countConversations()).toBe(before);
    // The cascade also removed the run's message rows — no orphans.
    expect(countMessagesFor(ephemeralConversationId)).toBe(0);

    // The memory writes performed DURING the run persist.
    const state = getRetrospectiveState(SOURCE_CONVERSATION_ID);
    expect(state?.lastProcessedMessageId).toBe("m-cutoff");
    expect(state?.rememberedLog).toEqual(["fact saved by the background run"]);
    expect(existsSync(conceptPath)).toBe(true);
    expect(readFileSync(conceptPath, "utf-8")).toContain(
      "A persisted concept.",
    );
  });

  test("failed (non-timeout) run also persists zero conversations rows", async () => {
    const before = countConversations();
    let ephemeralConversationId = "";

    processMessageImpl = async (conversationId: string) => {
      ephemeralConversationId = conversationId;
      throw new Error("provider blew up");
    };

    const result = await runBackgroundJob({
      jobName: "memory.retrospective",
      source: "memory_retrospective",
      prompt: "review the slice",
      trustContext: TRUST_CONTEXT,
      callSite: "memoryRetrospective",
      timeoutMs: 5_000,
      origin: "memory_retrospective",
      suppressFailureNotifications: true,
      ephemeralConversation: true,
    });

    expect(result.ok).toBe(false);
    expect(countConversations()).toBe(before);
    expect(countMessagesFor(ephemeralConversationId)).toBe(0);
  });
});
