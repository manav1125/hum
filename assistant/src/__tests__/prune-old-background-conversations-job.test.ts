import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { AssistantConfig } from "../config/schema.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { pruneOldBackgroundConversationsJob } from "../memory/job-handlers/cleanup.js";
import type { MemoryJob } from "../memory/jobs-store.js";
import {
  conversations,
  memoryRecallLogs,
  memoryV2ActivationLogs,
  messages,
} from "../memory/schema.js";

initializeDb();

const STALE_BG_ID = "conv-bg-prune-stale";
const FRESH_BG_ID = "conv-bg-prune-fresh";
const STALE_USER_ID = "conv-bg-prune-stale-user";

const JOB = { payload: {} } as unknown as MemoryJob;
const CONFIG = {
  memory: { cleanup: { backgroundConversationRetentionDays: 30 } },
} as unknown as AssistantConfig;

function seedConversation(
  id: string,
  updatedAt: number,
  conversationType: "background" | "standard",
): void {
  const db = getDb();
  db.insert(conversations)
    .values({
      id,
      title: "test",
      createdAt: updatedAt,
      updatedAt,
      conversationType,
    })
    .run();
  db.insert(messages)
    .values({
      id: `msg-${id}`,
      conversationId: id,
      role: "assistant",
      content: "hello",
      createdAt: updatedAt,
    })
    .run();
  db.insert(memoryV2ActivationLogs)
    .values({
      id: `act-${id}`,
      conversationId: id,
      messageId: `msg-${id}`,
      turn: 1,
      mode: "context-load",
      conceptsJson: "[]",
      skillsJson: "[]",
      configJson: "{}",
      createdAt: updatedAt,
    })
    .run();
  db.insert(memoryRecallLogs)
    .values({
      id: `rec-${id}`,
      conversationId: id,
      messageId: `msg-${id}`,
      enabled: 1,
      degraded: 0,
      semanticHits: 0,
      mergedCount: 0,
      selectedCount: 0,
      tier1Count: 0,
      tier2Count: 0,
      hybridSearchLatencyMs: 0,
      sparseVectorUsed: 0,
      injectedTokens: 0,
      latencyMs: 0,
      topCandidatesJson: "[]",
      createdAt: updatedAt,
    })
    .run();
}

function countDependents(conversationId: string): {
  messages: number;
  activationLogs: number;
  recallLogs: number;
} {
  const db = getDb();
  return {
    messages: db
      .select()
      .from(messages)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
    activationLogs: db
      .select()
      .from(memoryV2ActivationLogs)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
    recallLogs: db
      .select()
      .from(memoryRecallLogs)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
  };
}

describe("pruneOldBackgroundConversationsJob", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(memoryRecallLogs).run();
    db.delete(memoryV2ActivationLogs).run();
    db.delete(messages).run();
    db.delete(conversations).run();
  });

  test("prunes stale background conversations with their dependent telemetry, keeping user and fresh conversations", () => {
    const staleUpdatedAt = Date.now() - 60 * 86_400_000;
    seedConversation(STALE_BG_ID, staleUpdatedAt, "background");
    seedConversation(FRESH_BG_ID, Date.now(), "background");
    seedConversation(STALE_USER_ID, staleUpdatedAt, "standard");

    pruneOldBackgroundConversationsJob(JOB, CONFIG);

    // Stale background conversation and every dependent row are gone.
    expect(countDependents(STALE_BG_ID)).toEqual({
      messages: 0,
      activationLogs: 0,
      recallLogs: 0,
    });
    // Fresh background and stale USER conversations are untouched.
    expect(countDependents(FRESH_BG_ID)).toEqual({
      messages: 1,
      activationLogs: 1,
      recallLogs: 1,
    });
    expect(countDependents(STALE_USER_ID)).toEqual({
      messages: 1,
      activationLogs: 1,
      recallLogs: 1,
    });
    const remaining = getDb()
      .select()
      .from(conversations)
      .all()
      .map((c) => c.id)
      .sort();
    expect(remaining).toEqual([FRESH_BG_ID, STALE_USER_ID].sort());
  });

  test("retentionDays 0 disables pruning", () => {
    const staleUpdatedAt = Date.now() - 60 * 86_400_000;
    seedConversation(STALE_BG_ID, staleUpdatedAt, "background");

    pruneOldBackgroundConversationsJob(JOB, {
      memory: { cleanup: { backgroundConversationRetentionDays: 0 } },
    } as unknown as AssistantConfig);

    expect(getDb().select().from(conversations).all()).toHaveLength(1);
  });
});
