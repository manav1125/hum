/**
 * The outcome type itself: four kinds, and the boundary between "wrote
 * something" and "ran and wrote nothing" landing on the right side.
 */
import { describe, expect, test } from "bun:test";

import {
  JOB_OUTCOME_UNREPORTED,
  jobEmpty,
  jobOutcomeFromDetail,
  jobOutcomeRan,
  jobProduced,
  jobProducedOrEmpty,
  jobSkipped,
  sumDetail,
} from "../job-outcome.js";

describe("jobProducedOrEmpty", () => {
  test("a positive count is `produced` and carries the count", () => {
    expect(jobProducedOrEmpty(3, "found nothing")).toMatchObject({
      kind: "produced",
      produced: 3,
      reason: null,
    });
  });

  test("zero is `empty` and carries the reason, not a failure", () => {
    const outcome = jobProducedOrEmpty(0, "read the window and found nothing");
    expect(outcome.kind).toBe("empty");
    expect(outcome.produced).toBe(0);
    expect(outcome.reason).toBe("read the window and found nothing");
  });

  test("one is the boundary — it must not round down to empty", () => {
    expect(jobProducedOrEmpty(1, "nothing").kind).toBe("produced");
  });
});

describe("jobOutcomeFromDetail", () => {
  test("any positive sub-count makes the run productive", () => {
    const outcome = jobOutcomeFromDetail(
      { nodesCreated: 0, edgesCreated: 2 },
      "nothing worth adding",
    );
    expect(outcome).toMatchObject({ kind: "produced", produced: 2 });
    expect(outcome.detail).toEqual({ nodesCreated: 0, edgesCreated: 2 });
  });

  test("all-zero sub-counts are `empty`, and the breakdown survives", () => {
    // This is the graph-extraction shape: the counts existed all along and
    // were spent on a log line that said "complete".
    const outcome = jobOutcomeFromDetail(
      {
        nodesCreated: 0,
        nodesUpdated: 0,
        nodesReinforced: 0,
        edgesCreated: 0,
        triggersCreated: 0,
      },
      "found nothing worth adding to the graph",
    );
    expect(outcome.kind).toBe("empty");
    expect(outcome.detail?.nodesCreated).toBe(0);
  });

  test("negative sub-counts cannot manufacture or cancel production", () => {
    expect(sumDetail({ a: -5, b: 2 })).toBe(2);
  });
});

describe("the four kinds stay four", () => {
  test("`skipped` and `empty` are different answers to different questions", () => {
    expect(jobSkipped("switched off").kind).toBe("skipped");
    expect(jobEmpty("nothing to say").kind).toBe("empty");
    expect(jobSkipped("switched off").kind).not.toBe(
      jobEmpty("nothing to say").kind,
    );
  });

  test("`unreported` is never mistaken for produced", () => {
    expect(JOB_OUTCOME_UNREPORTED.kind).toBe("unreported");
    expect(JOB_OUTCOME_UNREPORTED.produced).toBe(0);
    expect(jobOutcomeRan(JOB_OUTCOME_UNREPORTED)).toBe(false);
  });

  test("only `produced` and `empty` count as having attempted the work", () => {
    expect(jobOutcomeRan(jobProduced(1))).toBe(true);
    expect(jobOutcomeRan(jobEmpty("quiet week"))).toBe(true);
    expect(jobOutcomeRan(jobSkipped("disabled"))).toBe(false);
  });
});
