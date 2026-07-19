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
import { pruneOldActivationLogsJob } from "../memory/job-handlers/cleanup.js";
import type { MemoryJob } from "../memory/jobs-store.js";
import { memoryRecallLogs, memoryV2ActivationLogs } from "../memory/schema.js";

initializeDb();

const JOB = { payload: {} } as unknown as MemoryJob;
const CONFIG = {
  memory: { cleanup: { activationLogRetentionDays: 14 } },
} as unknown as AssistantConfig;

function seedActivationLog(id: string, createdAt: number): void {
  getDb()
    .insert(memoryV2ActivationLogs)
    .values({
      id,
      conversationId: `conv-${id}`,
      turn: 1,
      mode: "context-load",
      conceptsJson: "[]",
      skillsJson: "[]",
      configJson: "{}",
      createdAt,
    })
    .run();
}

function seedRecallLog(id: string, createdAt: number): void {
  getDb()
    .insert(memoryRecallLogs)
    .values({
      id,
      conversationId: `conv-${id}`,
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
      createdAt,
    })
    .run();
}

describe("pruneOldActivationLogsJob", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(memoryV2ActivationLogs).run();
    db.delete(memoryRecallLogs).run();
  });

  test("deletes rows older than retention from both telemetry tables, keeps fresh rows", async () => {
    const staleMs = Date.now() - 30 * 86_400_000;
    seedActivationLog("act-stale", staleMs);
    seedActivationLog("act-fresh", Date.now());
    seedRecallLog("rec-stale", staleMs);
    seedRecallLog("rec-fresh", Date.now());

    await pruneOldActivationLogsJob(JOB, CONFIG);

    const db = getDb();
    expect(
      db
        .select()
        .from(memoryV2ActivationLogs)
        .all()
        .map((r) => r.id),
    ).toEqual(["act-fresh"]);
    expect(
      db
        .select()
        .from(memoryRecallLogs)
        .all()
        .map((r) => r.id),
    ).toEqual(["rec-fresh"]);
  });

  test("retentionDays 0 disables pruning", async () => {
    seedActivationLog("act-stale", Date.now() - 30 * 86_400_000);

    await pruneOldActivationLogsJob(JOB, {
      memory: { cleanup: { activationLogRetentionDays: 0 } },
    } as unknown as AssistantConfig);

    expect(getDb().select().from(memoryV2ActivationLogs).all()).toHaveLength(1);
  });

  test("job payload retentionDays overrides config", async () => {
    // 5-day-old row: config says keep (14d), payload says prune (1d).
    seedActivationLog("act-mid", Date.now() - 5 * 86_400_000);

    await pruneOldActivationLogsJob(
      { payload: { retentionDays: 1 } } as unknown as MemoryJob,
      CONFIG,
    );

    expect(getDb().select().from(memoryV2ActivationLogs).all()).toHaveLength(0);
  });
});
