import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

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
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

import { eq } from "drizzle-orm";

import { getMemoryDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { enqueueMemoryJob, upsertDebouncedJob } from "../memory/jobs-store.js";
import { memoryJobs } from "../memory/schema.js";

describe("upsertDebouncedJob payload refresh", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    getMemoryDb().run("DELETE FROM memory_jobs");
  });

  test("merges new payload keys into existing pending row (upgrade scenario)", () => {
    // Simulate a legacy pending row enqueued before `scopeId` was
    // added to the payload shape.
    const legacyId = enqueueMemoryJob(
      "graph_extract",
      { conversationId: "conv-1" },
      Date.now() + 300_000,
    );

    // A batch trigger from the current build passes `scopeId`.
    upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-1", scopeId: "private-scope" },
      Date.now(),
    );

    const rows = getMemoryDb()
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "graph_extract"))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(legacyId);
    const payload = JSON.parse(rows[0]!.payload) as {
      conversationId: string;
      scopeId?: string;
    };
    expect(payload.conversationId).toBe("conv-1");
    expect(payload.scopeId).toBe("private-scope");
  });

  test("later call overrides existing payload keys", () => {
    enqueueMemoryJob(
      "graph_extract",
      { conversationId: "conv-2", scopeId: "default" },
      Date.now() + 300_000,
    );

    upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-2", scopeId: "newer-scope" },
      Date.now(),
    );

    const rows = getMemoryDb()
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "graph_extract"))
      .all();

    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as { scopeId?: string };
    expect(payload.scopeId).toBe("newer-scope");
  });

  test("updates runAfter on match", () => {
    const runAfterOriginal = Date.now() + 300_000;
    enqueueMemoryJob(
      "graph_extract",
      { conversationId: "conv-3", scopeId: "default" },
      runAfterOriginal,
    );

    const runAfterNew = Date.now();
    upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-3", scopeId: "default" },
      runAfterNew,
    );

    const rows = getMemoryDb()
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "graph_extract"))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.runAfter).toBe(runAfterNew);
  });

  test("inserts a new row when no pending job matches", () => {
    upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-4", scopeId: "default" },
      Date.now(),
    );

    const rows = getMemoryDb()
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "graph_extract"))
      .all();

    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as {
      conversationId: string;
      scopeId?: string;
    };
    expect(payload.conversationId).toBe("conv-4");
    expect(payload.scopeId).toBe("default");
  });
});
