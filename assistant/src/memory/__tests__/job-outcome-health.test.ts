/**
 * The run of empty outcomes, counted.
 *
 * One empty run is a quiet week. A run of them is the bug that shipped four
 * times. These tests pin the difference, and pin the two cases that must NOT
 * accumulate a run: a switch the owner threw (`skipped`), and a handler that
 * cannot yet answer (`unreported`).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  JOB_OUTCOME_UNREPORTED,
  jobEmpty,
  jobProduced,
  jobSkipped,
} from "../job-outcome.js";
import {
  EMPTY_RUN_WARN_AT,
  getMemoryJobOutcomeHealth,
  recordJobOutcome,
  resetMemoryJobOutcomeHealth,
} from "../job-outcome-health.js";

function statsFor(type: string) {
  return getMemoryJobOutcomeHealth().types.find((t) => t.type === type);
}

beforeEach(() => {
  resetMemoryJobOutcomeHealth();
});

describe("counting the run", () => {
  test("consecutive empty outcomes accumulate", () => {
    for (let i = 0; i < 4; i++) {
      recordJobOutcome("graph_extract", jobEmpty("found nothing"));
    }
    expect(statsFor("graph_extract")?.consecutiveEmpty).toBe(4);
    expect(statsFor("graph_extract")?.emptyRuns).toBe(4);
  });

  test("a productive run resets the streak but keeps the high-water mark", () => {
    for (let i = 0; i < 6; i++) {
      recordJobOutcome("graph_extract", jobEmpty("found nothing"));
    }
    recordJobOutcome("graph_extract", jobProduced(3));

    const stats = statsFor("graph_extract");
    expect(stats?.consecutiveEmpty).toBe(0);
    expect(stats?.longestEmptyRun).toBe(6);
    expect(stats?.totalProduced).toBe(3);
  });

  test("`skipped` neither extends nor resets the run", () => {
    // A subsystem being switched off must never accumulate into something
    // that reads as breakage — nor should it launder a real streak away.
    recordJobOutcome("memory_v2_sweep", jobEmpty("quiet"));
    recordJobOutcome("memory_v2_sweep", jobEmpty("quiet"));
    recordJobOutcome("memory_v2_sweep", jobSkipped("sweep is switched off"));

    const stats = statsFor("memory_v2_sweep");
    expect(stats?.consecutiveEmpty).toBe(2);
    expect(stats?.skippedRuns).toBe(1);
    expect(stats?.emptyRuns).toBe(2);
  });

  test("`unreported` is counted on its own and does not touch the run", () => {
    recordJobOutcome("embed_segment", jobEmpty("nothing"));
    recordJobOutcome("embed_segment", JOB_OUTCOME_UNREPORTED);

    const stats = statsFor("embed_segment");
    expect(stats?.unreportedRuns).toBe(1);
    expect(stats?.consecutiveEmpty).toBe(1);
    // Critically: it did not land in the produced bucket.
    expect(stats?.producedRuns).toBe(0);
    expect(stats?.totalProduced).toBe(0);
  });
});

describe("degraded, and how long the run is", () => {
  test("healthy below the threshold", () => {
    for (let i = 0; i < EMPTY_RUN_WARN_AT - 1; i++) {
      recordJobOutcome("contact_memory_extract", jobEmpty("nobody named"));
    }
    const health = getMemoryJobOutcomeHealth();
    expect(health.degraded).toBe(false);
    expect(health.degradedReason).toBeNull();
  });

  test("degraded at the threshold, and the reason names the run length", () => {
    for (let i = 0; i < EMPTY_RUN_WARN_AT; i++) {
      recordJobOutcome(
        "contact_memory_extract",
        jobEmpty("found nothing worth remembering about anyone"),
      );
    }
    const health = getMemoryJobOutcomeHealth();
    expect(health.degraded).toBe(true);
    expect(health.degradedReason).toContain(String(EMPTY_RUN_WARN_AT));
    expect(health.degradedReason).toContain("contact_memory_extract");
    // "ever" — this type has never produced anything in this process.
    expect(health.degradedReason).toContain("ever");
  });

  test("a type that has produced before says so differently", () => {
    recordJobOutcome("graph_extract", jobProduced(2));
    for (let i = 0; i < EMPTY_RUN_WARN_AT; i++) {
      recordJobOutcome("graph_extract", jobEmpty("nothing to add"));
    }
    expect(getMemoryJobOutcomeHealth().degradedReason).toContain(
      "since it last did",
    );
  });

  test("the worst run sorts first", () => {
    recordJobOutcome("memory_v2_sweep", jobEmpty("quiet"));
    for (let i = 0; i < 5; i++) {
      recordJobOutcome("graph_extract", jobEmpty("nothing"));
    }
    expect(getMemoryJobOutcomeHealth().types[0]?.type).toBe("graph_extract");
  });

  test("a run of `skipped` alone never reports as degraded", () => {
    for (let i = 0; i < EMPTY_RUN_WARN_AT * 3; i++) {
      recordJobOutcome("embed_segment", jobSkipped("memory.v2 is active"));
    }
    expect(getMemoryJobOutcomeHealth().degraded).toBe(false);
  });
});

describe("snapshot isolation", () => {
  test("the caller cannot mutate the live record", () => {
    recordJobOutcome("graph_extract", jobEmpty("nothing"));
    const snapshot = getMemoryJobOutcomeHealth();
    snapshot.types[0]!.consecutiveEmpty = 999;
    expect(statsFor("graph_extract")?.consecutiveEmpty).toBe(1);
  });
});
