/**
 * Tests for the `memory_jobs` terminal-row reaper.
 *
 * High-frequency job types (embed_segment, memory_retrospective, …) leave
 * one completed/failed row per run; without retention the table grows
 * without bound (115k rows piled up before the reaper existed). The reaper
 * must delete only TERMINAL rows past the retention window — `pending` and
 * `running` rows are live state and must never be touched, regardless of
 * age.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getMemoryCheckpoint } from "../memory/checkpoints.js";
import { getDb, getMemoryDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  MEMORY_JOBS_RETENTION_MS,
  pruneOldMemoryJobs,
} from "../memory/jobs-store.js";
import {
  maybePruneOldMemoryJobs,
  MEMORY_JOBS_PRUNE_CHECKPOINT_KEY,
} from "../memory/jobs-worker.js";
import { memoryJobs } from "../memory/schema.js";

const NOW = 1_750_000_000_000;
const OLD = NOW - MEMORY_JOBS_RETENTION_MS - 60_000; // just past retention
const RECENT = NOW - 60_000; // well within retention

let idCounter = 0;
function seedJob(status: string, updatedAt: number): string {
  idCounter += 1;
  const id = `job-reaper-${idCounter}`;
  getMemoryDb()
    .insert(memoryJobs)
    .values({
      id,
      type: "embed_segment",
      payload: "{}",
      status,
      runAfter: 0,
      createdAt: updatedAt,
      updatedAt,
    })
    .run();
  return id;
}

function remainingIds(): string[] {
  return getMemoryDb()
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .all()
    .map((r) => r.id)
    .sort();
}

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  getMemoryDb().run("DELETE FROM memory_jobs");
  getDb().run("DELETE FROM memory_checkpoints");
});

describe("pruneOldMemoryJobs", () => {
  test("deletes old completed/failed rows; keeps pending/running (any age) and recent terminal rows", () => {
    const oldCompleted = seedJob("completed", OLD);
    const oldFailed = seedJob("failed", OLD);
    const oldPending = seedJob("pending", OLD);
    const oldRunning = seedJob("running", OLD);
    const recentCompleted = seedJob("completed", RECENT);
    const recentFailed = seedJob("failed", RECENT);

    const deleted = pruneOldMemoryJobs(MEMORY_JOBS_RETENTION_MS, NOW);

    expect(deleted).toBe(2);
    expect(remainingIds()).toEqual(
      [oldPending, oldRunning, recentCompleted, recentFailed].sort(),
    );
    // The old terminal rows are the ones that went.
    expect(remainingIds()).not.toContain(oldCompleted);
    expect(remainingIds()).not.toContain(oldFailed);
  });

  test("no matching rows → returns 0 and leaves everything in place", () => {
    seedJob("completed", RECENT);
    seedJob("pending", OLD);

    expect(pruneOldMemoryJobs(MEMORY_JOBS_RETENTION_MS, NOW)).toBe(0);
    expect(remainingIds()).toHaveLength(2);
  });
});

describe("maybePruneOldMemoryJobs (checkpoint gating)", () => {
  test("first tick prunes and records the checkpoint; a second tick within the interval is a no-op", () => {
    seedJob("completed", OLD);
    maybePruneOldMemoryJobs(NOW);

    expect(remainingIds()).toHaveLength(0);
    expect(getMemoryCheckpoint(MEMORY_JOBS_PRUNE_CHECKPOINT_KEY)).toBe(
      String(NOW),
    );

    // A row that ages past retention right after the tick is NOT reaped by
    // the next tick inside the interval — the checkpoint gates the cadence.
    seedJob("failed", OLD);
    maybePruneOldMemoryJobs(NOW + 60_000);
    expect(remainingIds()).toHaveLength(1);

    // Once the interval elapses, the next tick prunes again.
    maybePruneOldMemoryJobs(NOW + 7 * 60 * 60 * 1000);
    expect(remainingIds()).toHaveLength(0);
  });
});
