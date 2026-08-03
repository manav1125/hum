import { beforeEach, describe, expect, test } from "bun:test";

// No `mock.module` here on purpose. The store under test issues plain SQL and
// never logs, so there is no seam worth faking — and `mock.module` mutates a
// process-global registry, so a factory written here would apply to every file
// that runs after this one.
import { initializeDb } from "../memory/db-init.js";
import { rawRun } from "../memory/raw-query.js";
import {
  getSystemTaskUsageSummaries,
  type SystemTaskUsageKind,
  type SystemTaskUsageSummary,
} from "../schedule/schedule-usage-store.js";

initializeDb();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Window under test: a 7-day span ending "now". */
const NOW = 1_800_000_000_000;
const FROM = NOW - 7 * DAY;
const RANGE = { from: FROM, to: NOW };

function insertUsageEvent({
  createdAt,
  conversationId,
  callSite,
  costUsd,
  llmCallCount = 1,
}: {
  createdAt: number;
  conversationId: string | null;
  callSite: string;
  costUsd: number;
  llmCallCount?: number;
}): void {
  rawRun(
    `INSERT INTO llm_usage_events (
       id, created_at, conversation_id, actor, provider, model,
       input_tokens, output_tokens, estimated_cost_usd, pricing_status,
       llm_call_count, call_site
     ) VALUES (?, ?, ?, 'main_agent', 'openrouter', 'test-model',
       100, 50, ?, 'priced', ?, ?)`,
    `evt-${Math.random().toString(36).slice(2)}-${createdAt}`,
    createdAt,
    conversationId,
    costUsd,
    llmCallCount,
    callSite,
  );
}

function insertHeartbeatRun({
  id,
  startedAt,
  status = "ok",
  conversationId = null,
}: {
  id: string;
  startedAt: number | null;
  status?: string;
  conversationId?: string | null;
}): void {
  rawRun(
    `INSERT INTO heartbeat_runs (
       id, scheduled_for, started_at, finished_at, status, conversation_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    startedAt ?? NOW,
    startedAt,
    startedAt,
    status,
    conversationId,
    startedAt ?? NOW,
  );
}

function summaryFor(
  summaries: SystemTaskUsageSummary[],
  kind: SystemTaskUsageKind,
): SystemTaskUsageSummary {
  const found = summaries.find((s) => s.kind === kind);
  if (!found) throw new Error(`no summary for kind ${kind}`);
  return found;
}

/** Round to cents so float summation noise doesn't drive assertions. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

beforeEach(() => {
  rawRun(`DELETE FROM llm_usage_events`);
  rawRun(`DELETE FROM heartbeat_runs`);
});

describe("getSystemTaskUsageSummaries", () => {
  test("always reports every system kind, zeroed when unused", () => {
    const summaries = getSystemTaskUsageSummaries(RANGE);

    expect(summaries.map((s) => s.kind).sort()).toEqual([
      "consolidation",
      "heartbeat",
      "retrospective",
    ]);
    for (const summary of summaries) {
      expect(summary.runCount).toBe(0);
      expect(summary.totalEstimatedCostUsd).toBe(0);
      expect(summary.eventCount).toBe(0);
    }
  });

  // The bug this function exists to fix. The page used to sum the newest 100
  // fetched runs and label the result "(7d)". Prod records ~380 heartbeat runs
  // a week, so the newest 100 covered under two days and the caption named a
  // period the number never touched. Feeding more runs than that page size and
  // back-loading the cost into the OLDEST runs makes a truncating sum fail
  // loudly instead of quietly returning a smaller, plausible number.
  test("totals the whole window, not the newest page of runs", () => {
    const RUN_COUNT = 150;
    const OLD_RUN_COST = 0.1;
    const RECENT_RUN_COST = 0.01;

    // Runs walk backwards from `NOW`, one per hour, so the newest 100 span
    // roughly four days and the oldest 50 fall outside any fixed page.
    for (let i = 0; i < RUN_COUNT; i++) {
      const startedAt = NOW - i * HOUR;
      const conversationId = `hb-conv-${i}`;
      insertHeartbeatRun({ id: `hb-run-${i}`, startedAt, conversationId });
      insertUsageEvent({
        createdAt: startedAt,
        conversationId,
        callSite: "heartbeatAgent",
        costUsd: i >= 100 ? OLD_RUN_COST : RECENT_RUN_COST,
      });
    }

    const heartbeat = summaryFor(
      getSystemTaskUsageSummaries(RANGE),
      "heartbeat",
    );

    const newestPageOnly = 100 * RECENT_RUN_COST;
    const trueTotal = 100 * RECENT_RUN_COST + 50 * OLD_RUN_COST;

    expect(heartbeat.runCount).toBe(RUN_COUNT);
    expect(cents(heartbeat.totalEstimatedCostUsd)).toBe(cents(trueTotal));
    // Guard the guard: if these two ever coincide, the assertion above stops
    // discriminating between a full sum and a truncated one.
    expect(cents(trueTotal)).not.toBe(cents(newestPageOnly));
  });

  test("counts skipped heartbeat runs, which bill nothing", () => {
    insertHeartbeatRun({
      id: "hb-ok",
      startedAt: NOW - HOUR,
      conversationId: "hb-conv",
    });
    insertUsageEvent({
      createdAt: NOW - HOUR,
      conversationId: "hb-conv",
      callSite: "heartbeatAgent",
      costUsd: 0.25,
    });
    // Skipped runs never start, so the window filter has to fall back to
    // `created_at` the way the run-history list does.
    insertHeartbeatRun({
      id: "hb-skipped",
      startedAt: null,
      status: "skipped",
    });

    const heartbeat = summaryFor(
      getSystemTaskUsageSummaries(RANGE),
      "heartbeat",
    );

    expect(heartbeat.runCount).toBe(2);
    expect(cents(heartbeat.totalEstimatedCostUsd)).toBe(0.25);
  });

  // Consolidation runs use `ephemeralConversation: true` — the runner deletes
  // the conversation row once the run settles. Attributing cost by joining
  // usage events to conversations therefore reports $0 for a job that really
  // spends, which is why attribution keys on `call_site` instead.
  test("attributes consolidation cost with no surviving conversation row", () => {
    for (let i = 0; i < 3; i++) {
      insertUsageEvent({
        createdAt: NOW - (i + 1) * HOUR,
        // A conversation id that has no row in `conversations`.
        conversationId: `ephemeral-consolidation-${i}`,
        callSite: "memoryV2Consolidation",
        costUsd: 0.5,
        llmCallCount: 2,
      });
    }

    const consolidation = summaryFor(
      getSystemTaskUsageSummaries(RANGE),
      "consolidation",
    );

    expect(consolidation.runCount).toBe(3);
    expect(cents(consolidation.totalEstimatedCostUsd)).toBe(1.5);
    expect(consolidation.eventCount).toBe(6);
  });

  test("counts one run per conversation when a run makes several calls", () => {
    for (let i = 0; i < 4; i++) {
      insertUsageEvent({
        createdAt: NOW - HOUR - i,
        conversationId: "retro-conv-1",
        callSite: "memoryRetrospective",
        costUsd: 0.05,
      });
    }

    const retrospective = summaryFor(
      getSystemTaskUsageSummaries(RANGE),
      "retrospective",
    );

    expect(retrospective.runCount).toBe(1);
    expect(cents(retrospective.totalEstimatedCostUsd)).toBe(0.2);
  });

  test("excludes runs and cost outside the requested window", () => {
    insertHeartbeatRun({
      id: "hb-inside",
      startedAt: FROM + HOUR,
      conversationId: "conv-inside",
    });
    insertUsageEvent({
      createdAt: FROM + HOUR,
      conversationId: "conv-inside",
      callSite: "heartbeatAgent",
      costUsd: 1,
    });

    insertHeartbeatRun({
      id: "hb-before",
      startedAt: FROM - HOUR,
      conversationId: "conv-before",
    });
    insertUsageEvent({
      createdAt: FROM - HOUR,
      conversationId: "conv-before",
      callSite: "heartbeatAgent",
      costUsd: 99,
    });

    insertUsageEvent({
      createdAt: NOW + HOUR,
      conversationId: "conv-after",
      callSite: "heartbeatAgent",
      costUsd: 99,
    });

    const heartbeat = summaryFor(
      getSystemTaskUsageSummaries(RANGE),
      "heartbeat",
    );

    expect(heartbeat.runCount).toBe(1);
    expect(cents(heartbeat.totalEstimatedCostUsd)).toBe(1);
  });

  test("ignores call sites that are not system jobs", () => {
    insertUsageEvent({
      createdAt: NOW - HOUR,
      conversationId: "user-conv",
      callSite: "mainAgent",
      costUsd: 12.5,
    });

    for (const summary of getSystemTaskUsageSummaries(RANGE)) {
      expect(summary.totalEstimatedCostUsd).toBe(0);
    }
  });
});
