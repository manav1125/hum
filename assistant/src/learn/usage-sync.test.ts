import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../__tests__/helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { LearnUsageSync } from "./usage-sync.js";

initializeDb();

/** One sidecar usage record in the fork's /api/usage/records shape. */
function learnRecord(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "1756800000000-1",
    createdAt: 1756800000000,
    kind: "llm",
    source: "llm",
    providerId: "google",
    modelId: "gemini-3-flash-preview",
    modelString: "google:gemini-3-flash-preview",
    inputTokens: 1200,
    outputTokens: 400,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

function mockSidecar(pages: Array<{ records: unknown[]; hasMore?: boolean }>) {
  let call = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    const records = page.records as Array<{ createdAt: number }>;
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          records,
          nextSince: records.length ? records[records.length - 1].createdAt : 0,
          hasMore: page.hasMore ?? false,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

describe("LearnUsageSync", () => {
  beforeEach(() => {
    getSqlite().run("DELETE FROM llm_usage_events");
    process.env.LEARN_UPSTREAM_URL = "http://learn.test:3000";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.LEARN_UPSTREAM_URL;
  });

  test("imports LLM records as actor=learn rows with sidecar-id request ids", async () => {
    mockSidecar([{ records: [learnRecord()] }]);
    const result = await new LearnUsageSync().syncOnce();
    expect(result?.imported).toBe(1);
    const rows = getSqlite()
      .query(
        "SELECT actor, provider, model, input_tokens, output_tokens, request_id FROM llm_usage_events",
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("learn");
    expect(rows[0].provider).toBe("google");
    expect(rows[0].input_tokens).toBe(1200);
    expect(rows[0].request_id).toBe("learn:1756800000000-1");
  });

  test("skips non-LLM records and already-imported ids", async () => {
    mockSidecar([
      {
        records: [
          learnRecord(),
          learnRecord({
            id: "1756800000001-2",
            createdAt: 1756800000001,
            kind: "tts",
          }),
        ],
      },
    ]);
    const sync = new LearnUsageSync();
    expect((await sync.syncOnce())?.imported).toBe(1);
    // Second pass re-serves the same page; dedupe keeps the ledger unchanged.
    expect((await sync.syncOnce())?.imported).toBe(0);
    const count = getSqlite()
      .query("SELECT COUNT(*) AS n FROM llm_usage_events")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("cursors from the sidecar timestamp embedded in stored request ids", async () => {
    const calls = mockSidecar([{ records: [learnRecord()] }]);
    const sync = new LearnUsageSync();
    await sync.syncOnce();
    await sync.syncOnce();
    expect(calls[0]).toContain("since=0");
    // Second poll resumes from the imported record's sidecar timestamp, not
    // from the (much later) import wall-clock stamped on created_at.
    expect(calls[1]).toContain("since=1756800000000");
  });

  test("is a no-op without LEARN_UPSTREAM_URL", async () => {
    delete process.env.LEARN_UPSTREAM_URL;
    const calls = mockSidecar([{ records: [learnRecord()] }]);
    expect(await new LearnUsageSync().syncOnce()).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
