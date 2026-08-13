/**
 * The queue half of the outcome-truthfulness boundary (port of upstream
 * 6d3f5d2e5b): a handler that reports failure through a returned domain
 * outcome must not land a `completed` row.
 *
 * This is the cure for the sidechain-timeout class observed in production:
 * background memory jobs whose wake aborted (returned `wake_failed` without
 * throwing) were unconditionally completed by the worker, so filing /
 * contact-memory / retrospective failures were invisible in `memory_jobs`.
 *
 * Also covers the store-level `running` guards: a late return from an
 * abandoned execution cannot overwrite a terminal state the stalled-job
 * watchdog already recorded.
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
import type { MemoryRetrospectiveOutcome } from "../memory-retrospective-job.js";

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

// Handler seams: the worker is driven for real; only the two domain handlers
// are scripted (real module spread per assistant/CLAUDE.md).
let retrospectiveOutcome: MemoryRetrospectiveOutcome = {
  kind: "no_new_messages",
};
const retroActual = await import("../memory-retrospective-job.js");
mock.module("../memory-retrospective-job.js", () => ({
  ...retroActual,
  memoryRetrospectiveJob: async () => retrospectiveOutcome,
}));

type ConsolidationOutcome =
  | { kind: "run_failed"; reason?: string }
  | { kind: "empty_buffer" };
let consolidationOutcome: ConsolidationOutcome = { kind: "empty_buffer" };
const consolidationActual = await import("../v2/consolidation-job.js");
mock.module("../v2/consolidation-job.js", () => ({
  ...consolidationActual,
  memoryV2ConsolidateJob: async () => consolidationOutcome,
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

const tmpWorkspace = mkdtempSync(join(tmpdir(), "jobs-worker-contract-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

const { getMemoryDb } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { completeMemoryJob, enqueueMemoryJob, failMemoryJob, failStalledJobs } =
  await import("../jobs-store.js");
const { runMemoryJobsOnce } = await import("../jobs-worker.js");
const { _resetQdrantBreaker } = await import("../qdrant-circuit-breaker.js");
const { memoryJobs } = await import("../schema.js");

function jobRow(id: string) {
  return getMemoryDb()
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, id))
    .get();
}

beforeAll(() => {
  initializeDb();
});

afterAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

beforeEach(() => {
  _resetQdrantBreaker();
  getMemoryDb().delete(memoryJobs).run();
  retrospectiveOutcome = { kind: "no_new_messages" };
  consolidationOutcome = { kind: "empty_buffer" };
});

describe("retrospective outcomes reach the job row honestly", () => {
  test("wake_failed dead-letters the row with the reason, never `completed`", async () => {
    retrospectiveOutcome = {
      kind: "wake_failed",
      reason: "provider timeout",
    };
    const id = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    await runMemoryJobsOnce();

    const row = jobRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("retrospective wake failed");
    expect(row?.lastError).toContain("provider timeout");
  });

  test("no_usable_output dead-letters the row, never `completed`", async () => {
    retrospectiveOutcome = {
      kind: "no_usable_output",
      reason: "run persisted no memory-writing tool call",
    };
    const id = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    await runMemoryJobsOnce();

    const row = jobRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("no usable output");
  });

  test("source_processing defers the SAME row on the deferral counter", async () => {
    retrospectiveOutcome = { kind: "source_processing" };
    const id = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    await runMemoryJobsOnce();

    const row = jobRow(id);
    expect(row?.status).toBe("pending");
    expect(row?.deferrals).toBe(1);
    expect(row?.runAfter).toBeGreaterThan(Date.now());
  });

  test("a benign no-op still completes", async () => {
    retrospectiveOutcome = { kind: "no_new_messages" };
    const id = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    await runMemoryJobsOnce();

    expect(jobRow(id)?.status).toBe("completed");
  });
});

describe("consolidation run_failed reaches the job row", () => {
  test("run_failed dead-letters with the reason", async () => {
    consolidationOutcome = { kind: "run_failed", reason: "turn timed out" };
    const id = enqueueMemoryJob("memory_v2_consolidate", {});
    await runMemoryJobsOnce();

    const row = jobRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("consolidation run failed");
    expect(row?.lastError).toContain("turn timed out");
  });
});

describe("store transitions are guarded on `running`", () => {
  test("a timed-out (watchdog-failed) job cannot be flipped back by a late completion", () => {
    const id = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    const past = Date.now() - 10 * 60 * 60 * 1000;
    getMemoryDb()
      .update(memoryJobs)
      .set({ status: "running", startedAt: past })
      .where(eq(memoryJobs.id, id))
      .run();

    // The watchdog fails the stalled row…
    expect(failStalledJobs(60 * 60 * 1000)).toBe(1);
    expect(jobRow(id)?.status).toBe("failed");
    expect(jobRow(id)?.lastError).toContain("timed out");

    // …and the abandoned execution's late return must not overwrite it.
    completeMemoryJob(id);
    const row = jobRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("timed out");
  });

  test("a late failMemoryJob cannot overwrite a completed row", () => {
    const id = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    getMemoryDb()
      .update(memoryJobs)
      .set({ status: "running", startedAt: Date.now() })
      .where(eq(memoryJobs.id, id))
      .run();
    completeMemoryJob(id);
    expect(jobRow(id)?.status).toBe("completed");

    failMemoryJob(id, "late writer", { maxAttempts: 1 });
    expect(jobRow(id)?.status).toBe("completed");
    expect(jobRow(id)?.lastError).toBeNull();
  });
});
