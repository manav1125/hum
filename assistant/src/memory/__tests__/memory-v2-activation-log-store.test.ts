import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getMemoryDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import {
  backfillMemoryV2ActivationMessageId,
  getMemoryV2ActivationLogByMessageIds,
  type MemoryV2ConceptRowRecord,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import { memoryV2ActivationLogs } from "../schema.js";
import {
  sampleConcepts,
  sampleConfig,
} from "./fixtures/memory-v2-activation-fixtures.js";

initializeDb();

function resetTables(): void {
  // Activation logs live in the dedicated memory DB (migration 326).
  const db = getMemoryDb();
  db.delete(memoryV2ActivationLogs).run();
}

describe("memory-v2-activation-log-store", () => {
  beforeEach(() => {
    resetTables();
  });

  test("round-trip: record → backfill messageId → query by messageId", () => {
    const conversationId = "conv-1";
    const messageId = "msg-1";

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 3,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const result = getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(conversationId);
    expect(result!.turn).toBe(3);
    expect(result!.mode).toBe("per-turn");
    expect(result!.concepts).toEqual(sampleConcepts);
    expect(result!.config).toEqual(sampleConfig);
  });

  test("round-trip: router-mode log row with zeroed activations and source: 'router'", () => {
    const conversationId = "conv-router";
    const messageId = "msg-router";

    const routerConcepts: MemoryV2ConceptRowRecord[] = [
      {
        slug: "concept-router-a",
        finalActivation: 0,
        ownActivation: 0,
        priorActivation: 0,
        simUser: 0,
        simAssistant: 0,
        simNow: 0,
        simUserRerankBoost: 0,
        simAssistantRerankBoost: 0,
        inRerankPool: false,
        spreadContribution: 0,
        source: "router",
        status: "injected",
      },
      {
        slug: "concept-router-b",
        finalActivation: 0,
        ownActivation: 0,
        priorActivation: 0,
        simUser: 0,
        simAssistant: 0,
        simNow: 0,
        simUserRerankBoost: 0,
        simAssistantRerankBoost: 0,
        inRerankPool: false,
        spreadContribution: 0,
        source: "router",
        status: "not_injected",
      },
    ];

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 7,
      mode: "router",
      concepts: routerConcepts,
      config: sampleConfig,
    });

    backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const result = getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(conversationId);
    expect(result!.turn).toBe(7);
    expect(result!.mode).toBe("router");
    expect(result!.concepts).toEqual(routerConcepts);
    expect(result!.config).toEqual(sampleConfig);
    for (const concept of result!.concepts) {
      expect(concept.source).toBe("router");
      expect(concept.finalActivation).toBe(0);
      expect(concept.ownActivation).toBe(0);
      expect(concept.priorActivation).toBe(0);
      expect(concept.simUser).toBe(0);
      expect(concept.simAssistant).toBe(0);
      expect(concept.simNow).toBe(0);
      expect(concept.simUserRerankBoost).toBe(0);
      expect(concept.simAssistantRerankBoost).toBe(0);
      expect(concept.spreadContribution).toBe(0);
    }
  });

  test("returns null for empty messageIds array", () => {
    const result = getMemoryV2ActivationLogByMessageIds([]);
    expect(result).toBeNull();
  });

  test("caps serialized concepts at maxConcepts, always keeping non-not_injected rows", () => {
    const conversationId = "conv-cap";
    const messageId = "msg-cap";

    const makeRow = (
      slug: string,
      finalActivation: number,
      status: MemoryV2ConceptRowRecord["status"],
    ): MemoryV2ConceptRowRecord => ({
      slug,
      finalActivation,
      ownActivation: 0,
      priorActivation: 0,
      simUser: 0,
      simAssistant: 0,
      simNow: 0,
      simUserRerankBoost: 0,
      simAssistantRerankBoost: 0,
      inRerankPool: false,
      spreadContribution: 0,
      source: "ann_top50",
      status,
    });

    // 10 candidates: 2 meaningful outcomes buried at LOW activation, 8
    // not_injected fillers at higher activation. Cap of 5 must keep both
    // meaningful rows plus the 3 highest-activation fillers.
    const concepts: MemoryV2ConceptRowRecord[] = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeRow(`filler-${i}`, 0.9 - i * 0.1, "not_injected"),
      ),
      makeRow("kept-injected", 0.01, "injected"),
      makeRow("kept-corrupt", 0.005, "corrupt"),
    ];

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 1,
      mode: "context-load",
      concepts,
      config: sampleConfig,
      maxConcepts: 5,
    });

    backfillMemoryV2ActivationMessageId(conversationId, messageId);
    const result = getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.concepts).toHaveLength(5);
    const slugs = result!.concepts.map((c) => c.slug);
    expect(slugs).toContain("kept-injected");
    expect(slugs).toContain("kept-corrupt");
    // Highest-activation not_injected fillers survive; the tail is dropped.
    expect(slugs).toContain("filler-0");
    expect(slugs).toContain("filler-1");
    expect(slugs).toContain("filler-2");
  });

  test("maxConcepts: null preserves every concept row", () => {
    const conversationId = "conv-uncapped";

    const concepts: MemoryV2ConceptRowRecord[] = Array.from(
      { length: 400 },
      (_, i) => ({
        slug: `c-${i}`,
        finalActivation: 0,
        ownActivation: 0,
        priorActivation: 0,
        simUser: 0,
        simAssistant: 0,
        simNow: 0,
        simUserRerankBoost: 0,
        simAssistantRerankBoost: 0,
        inRerankPool: false,
        spreadContribution: 0,
        source: "ann_top50",
        status: "not_injected",
      }),
    );

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 1,
      mode: "context-load",
      concepts,
      config: sampleConfig,
      maxConcepts: null,
    });

    const db = getMemoryDb();
    const rows = db.select().from(memoryV2ActivationLogs).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.conceptsJson)).toHaveLength(400);
  });

  test("omitted maxConcepts applies the default cap", () => {
    const conversationId = "conv-default-cap";

    const concepts: MemoryV2ConceptRowRecord[] = Array.from(
      { length: 400 },
      (_, i) => ({
        slug: `c-${i}`,
        finalActivation: 400 - i,
        ownActivation: 0,
        priorActivation: 0,
        simUser: 0,
        simAssistant: 0,
        simNow: 0,
        simUserRerankBoost: 0,
        simAssistantRerankBoost: 0,
        inRerankPool: false,
        spreadContribution: 0,
        source: "ann_top50",
        status: "not_injected",
      }),
    );

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 1,
      mode: "context-load",
      concepts,
      config: sampleConfig,
    });

    const db = getMemoryDb();
    const rows = db.select().from(memoryV2ActivationLogs).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.conceptsJson)).toHaveLength(300);
  });

  test("backfill only updates rows with NULL messageId", () => {
    const conversationId = "conv-2";

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 1,
      mode: "context-load",
      concepts: sampleConcepts,
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 2,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    // First backfill: both rows should now have msg-a.
    backfillMemoryV2ActivationMessageId(conversationId, "msg-a");

    const db = getMemoryDb();
    const afterFirstBackfill = db.select().from(memoryV2ActivationLogs).all();
    expect(afterFirstBackfill).toHaveLength(2);
    for (const row of afterFirstBackfill) {
      expect(row.messageId).toBe("msg-a");
    }

    // Record a third row (messageId is NULL initially).
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 3,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    // Second backfill with msg-b should only set the third row,
    // and must not overwrite the first two rows already set to msg-a.
    backfillMemoryV2ActivationMessageId(conversationId, "msg-b");

    const afterSecondBackfill = db.select().from(memoryV2ActivationLogs).all();
    const byTurn = new Map(afterSecondBackfill.map((r) => [r.turn, r]));
    expect(byTurn.get(1)!.messageId).toBe("msg-a");
    expect(byTurn.get(2)!.messageId).toBe("msg-a");
    expect(byTurn.get(3)!.messageId).toBe("msg-b");
  });

  test("backfill skips v3_shadow rows, leaving their messageId null", () => {
    const conversationId = "conv-shadow-backfill";

    // A live router row (null messageId) and a detached v3_shadow row (null
    // messageId) coexist in the same conversation.
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 5,
      mode: "router",
      concepts: sampleConcepts,
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 5,
      mode: "v3_shadow",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    backfillMemoryV2ActivationMessageId(conversationId, "msg-live");

    const db = getMemoryDb();
    const rows = db.select().from(memoryV2ActivationLogs).all();
    const byMode = new Map(rows.map((r) => [r.mode, r]));
    // The live router row got stamped; the shadow row stayed null (not
    // mis-attributed to the live message).
    expect(byMode.get("router")!.messageId).toBe("msg-live");
    expect(byMode.get("v3_shadow")!.messageId).toBeNull();
  });
});
