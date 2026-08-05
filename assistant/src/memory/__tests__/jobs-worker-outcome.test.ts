/**
 * The mutation check for the whole class.
 *
 * A handler is made to write zero rows and the worker is driven for real. The
 * assertion is not "the job completed" — it did, and that is the bug — but
 * that the completed row is distinguishable from one that wrote something.
 * Flip `graphExtractJob`'s outcome back to an unconditional success and the
 * "run that wrote nothing" test below goes red.
 *
 * Also covers the largest zero-write population on the owner's instance:
 * ~13,000 `embed_segment` rows a week that reach `completed` without touching
 * a store because memory-v2 is active. Correct behaviour, but it must report
 * as `skipped`, never as work.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () => makeMockLogger(),
}));

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    v2: { ...DEFAULT_CONFIG.memory.v2, enabled: true },
  },
};

const configActual = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...configActual,
  getConfig: () => TEST_CONFIG,
  loadConfig: () => TEST_CONFIG,
}));

/**
 * What `runGraphExtraction` will claim it did on the next run. Driving the
 * seam rather than the whole module — per `assistant/AGENTS.md`, the real
 * module is spread and only this one export is overridden.
 */
let extractionResult = {
  nodesCreated: 0,
  nodesUpdated: 0,
  nodesReinforced: 0,
  edgesCreated: 0,
  triggersCreated: 0,
  lastProcessedTimestamp: 1_700_000_000_000,
};

const extractionActual = await import("../graph/extraction.js");
mock.module("../graph/extraction.js", () => ({
  ...extractionActual,
  runGraphExtraction: async () => extractionResult,
}));

const dbMaintenanceActual = await import("../db-maintenance.js");
mock.module("../db-maintenance.js", () => ({
  ...dbMaintenanceActual,
  maybeRunDbMaintenance: async () => {},
}));

const snapshotActual = await import("../../backup/db-snapshot.js");
mock.module("../../backup/db-snapshot.js", () => ({
  ...snapshotActual,
  maybeRunDbSnapshot: async () => {},
}));

const tmpWorkspace = mkdtempSync(join(tmpdir(), "jobs-worker-outcome-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

const { getMemoryDb } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { enqueueMemoryJob, summarizeJobOutcomes } =
  await import("../jobs-store.js");
const { runMemoryJobsOnce } = await import("../jobs-worker.js");
const { getMemoryJobOutcomeHealth, resetMemoryJobOutcomeHealth } =
  await import("../job-outcome-health.js");
const { _resetQdrantBreaker } = await import("../qdrant-circuit-breaker.js");
const { memoryJobs } = await import("../schema.js");

function jobRow(id: string) {
  return getMemoryDb()
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, id))
    .get();
}

const QUIET_EXTRACTION = {
  nodesCreated: 0,
  nodesUpdated: 0,
  nodesReinforced: 0,
  edgesCreated: 0,
  triggersCreated: 0,
  lastProcessedTimestamp: 1_700_000_000_000,
};

// One workspace for the whole file: the temp dir IS the database, so tearing
// it down inside a describe would leave every later describe without one.
beforeAll(() => {
  initializeDb();
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

beforeEach(() => {
  getMemoryDb().run("DELETE FROM memory_jobs");
  resetMemoryJobOutcomeHealth();
  _resetQdrantBreaker();
  extractionResult = { ...QUIET_EXTRACTION };
});

describe("a job that completes having written nothing", () => {
  test("is recorded as `empty`, not as ordinary completion", async () => {
    const jobId = enqueueMemoryJob("graph_extract", {
      conversationId: "conv-quiet",
    });

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    // It still completed — zero-write is not an error.
    expect(row?.status).toBe("completed");
    // …and it is no longer indistinguishable from a run that did the work.
    expect(row?.outcome).toBe("empty");
    expect(row?.producedCount).toBe(0);
    expect(row?.outcomeReason).toContain("nothing");
  });

  test("a run that wrote something is `produced`, with the count", async () => {
    extractionResult = {
      nodesCreated: 2,
      nodesUpdated: 1,
      nodesReinforced: 0,
      edgesCreated: 3,
      triggersCreated: 0,
      lastProcessedTimestamp: 1_700_000_000_000,
    };
    const jobId = enqueueMemoryJob("graph_extract", {
      conversationId: "conv-busy",
    });

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("completed");
    expect(row?.outcome).toBe("produced");
    expect(row?.producedCount).toBe(6);
  });

  test("the two are not the same row shape — which is the whole point", async () => {
    const emptyId = enqueueMemoryJob("graph_extract", {
      conversationId: "conv-a",
    });
    await runMemoryJobsOnce();

    extractionResult = { ...extractionResult, nodesCreated: 4 };
    const producedId = enqueueMemoryJob("graph_extract", {
      conversationId: "conv-b",
    });
    await runMemoryJobsOnce();

    const a = jobRow(emptyId);
    const b = jobRow(producedId);
    expect(a?.status).toBe(b?.status);
    expect(a?.outcome).not.toBe(b?.outcome);
  });
});

describe("the empty run is visible without reading logs", () => {
  test("summarizeJobOutcomes separates runs from rows produced", async () => {
    for (let i = 0; i < 3; i++) {
      enqueueMemoryJob("graph_extract", { conversationId: `conv-${i}` });
      await runMemoryJobsOnce();
    }

    const summary = summarizeJobOutcomes().find(
      (row) => row.type === "graph_extract",
    );
    // The 697/0 shape, answerable as a property of the job table.
    expect(summary?.runs).toBe(3);
    expect(summary?.empty).toBe(3);
    expect(summary?.produced).toBe(0);
    expect(summary?.totalProduced).toBe(0);
    expect(summary?.lastEmptyReason).toContain("nothing");
  });

  test("the health record carries the run length", async () => {
    for (let i = 0; i < 3; i++) {
      enqueueMemoryJob("graph_extract", { conversationId: `conv-${i}` });
      await runMemoryJobsOnce();
    }
    const stats = getMemoryJobOutcomeHealth().types.find(
      (t) => t.type === "graph_extract",
    );
    expect(stats?.consecutiveEmpty).toBe(3);
  });
});

describe("a no-op that is correct is `skipped`, never work", () => {
  test("embed_segment under memory-v2 completes as skipped", async () => {
    const jobId = enqueueMemoryJob("embed_segment", { segmentId: "seg-1" });

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("completed");
    expect(row?.outcome).toBe("skipped");
    expect(row?.outcomeReason).toContain("v2");
  });

  test("skipped runs never accumulate a degraded streak", async () => {
    for (let i = 0; i < 15; i++) {
      enqueueMemoryJob("embed_segment", { segmentId: `seg-${i}` });
      await runMemoryJobsOnce();
    }
    const health = getMemoryJobOutcomeHealth();
    expect(health.degraded).toBe(false);
    const stats = health.types.find((t) => t.type === "embed_segment");
    expect(stats?.skippedRuns).toBe(15);
    expect(stats?.consecutiveEmpty).toBe(0);
  });
});
