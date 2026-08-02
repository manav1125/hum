/**
 * The auto-filer must never wedge on a batch it cannot score.
 *
 * What happened in production, and what these tests exist to stop happening
 * again: the batched flash call was given a 20-second budget on the reasoning
 * that "a missed sweep just waits 5 min". It does not wait five minutes. The
 * sweep takes the OLDEST slice of the waiting pool and a scorer miss stamps
 * nothing, so the next sweep offers the same slice, and the next, and the
 * next. The real batch needed 61 seconds. Twelve sweeps out of twelve aborted
 * at a dead-constant 20.000s, 76 items sat unfiled behind a slice of 20, and
 * every log line the filer emitted said it was running.
 *
 * The lesson is not "the timeout was too small" — that is the surface. It is
 * that a retry which always retries THE SAME THING is not a retry, and a queue
 * whose head can never be consumed is not a queue. So the invariant under test
 * is the one that holds whatever the cause: repeated misses must change what
 * the next sweep tries.
 */

import { describe, expect, test } from "bun:test";

import {
  type AutoFileParseStats,
  MAX_ITEMS_PER_SWEEP,
  MISSES_BEFORE_ROTATE,
  parseAutoFileResponse,
  sweepWindow,
} from "../work-item-auto-file.js";

describe("sweepWindow — the healthy path", () => {
  test("a filer with no misses takes the full oldest-first batch", () => {
    expect(sweepWindow(100, 0)).toEqual({
      offset: 0,
      size: MAX_ITEMS_PER_SWEEP,
    });
  });

  test("a pool smaller than the batch is still served from the head", () => {
    const { offset, size } = sweepWindow(3, 0);
    expect(offset).toBe(0);
    // `size` is the CAP, not a demand — the caller slices, so asking for more
    // than exists is fine and must not shift the window off the pool.
    expect(size).toBe(MAX_ITEMS_PER_SWEEP);
  });
});

describe("sweepWindow — shrinking", () => {
  test("each miss halves the batch, down to one item", () => {
    const sizes = [0, 1, 2, 3, 4, 5].map((m) => sweepWindow(100, m).size);
    expect(sizes).toEqual([8, 4, 2, 1, 1, 1]);
  });

  test("the batch never shrinks below one — a zero-size window scores nothing", () => {
    // A window of 0 would make `slice()` empty, the sweep report
    // "no_candidates" with a full pool waiting, and the filer would look idle
    // rather than stuck. Silence is the failure mode this whole file is about.
    for (const misses of [3, 10, 100, 1_000]) {
      expect(sweepWindow(100, misses).size).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("sweepWindow — rotation", () => {
  test("the head slice is re-offered while shrinking might still help", () => {
    // Shrinking is tried FIRST because an oversized batch is the more common
    // cause, and rotating away from a batch that would have scored at half the
    // size just defers the same work.
    for (const misses of [1, 2, 3]) {
      expect(sweepWindow(100, misses).offset).toBe(0);
    }
  });

  test("past the shrink budget the window walks forward", () => {
    // This is the anti-wedge property: at one item at a time the batch size is
    // no longer the problem, so the head item must stop blocking the pool.
    expect(sweepWindow(100, 4).offset).toBe(1);
    expect(sweepWindow(100, 5).offset).toBe(2);
    expect(sweepWindow(100, 9).offset).toBe(6);
  });

  test("the offset always lands inside the pool", () => {
    for (let misses = 0; misses < 500; misses++) {
      const { offset } = sweepWindow(7, misses);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(7);
    }
  });

  test("an empty pool never produces an offset to divide by", () => {
    // `% 0` is NaN, and a NaN offset makes `slice(NaN, NaN)` return the whole
    // array — the sweep would silently score the entire pool in one call.
    const { offset, size } = sweepWindow(0, 50);
    expect(offset).toBe(0);
    expect(Number.isFinite(size)).toBe(true);
  });

  test("rotation eventually reaches every item in the pool", () => {
    // The guarantee an alpha user actually cares about: a task that arrived
    // behind a poisoned one still gets looked at.
    //
    // Counting from misses=0 would make this test vacuous — the first sweep
    // asks for 8 and a small pool is covered in one go, so it passed with
    // rotation deleted. Start at the fully-shrunk state, where the window is a
    // single item and rotation is the ONLY thing that can move it.
    const poolSize = 5;
    const reached = new Set<number>();
    for (let misses = MISSES_BEFORE_ROTATE; misses < 60; misses++) {
      const { offset, size } = sweepWindow(poolSize, misses);
      expect(size).toBe(1);
      reached.add(offset);
    }
    expect([...reached].sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("the batch size is sized off measured behaviour", () => {
  test("a sweep asks for few enough items to answer inside its budget", () => {
    // Twenty real items cost 3,147 completion tokens and 61 seconds against
    // the configured flash model. This assertion is a tripwire: raising the
    // batch back up without re-measuring is how the original defect was
    // introduced, and the number was chosen from synthetic data that answered
    // in eight seconds.
    expect(MAX_ITEMS_PER_SWEEP).toBeLessThanOrEqual(10);
  });
});

describe("the parse says which kind of nothing it produced", () => {
  /**
   * The scorer's failure log carried the reply length and nothing else, and
   * "we could use none of it" is true of four different defects: a reply that
   * never came, one that would not parse, one that was not an array, and one
   * that parsed perfectly into entries naming ids we never asked about. Each
   * needs a different fix, and narrowing between them cost a round trip to
   * production every time.
   */

  const ids = (...v: string[]) => new Set(v);
  const fresh = (): AutoFileParseStats => ({
    entries: 0,
    unknownIds: 0,
    malformed: 0,
    duplicates: 0,
    outcome: "ok",
  });

  test("a fluent answer about the wrong items is not an empty answer", () => {
    // The case that mattered: eight well-formed entries, zero recognised.
    const stats = fresh();
    const reply = JSON.stringify([
      { id: "not-in-batch-1", projectId: null, confidence: 0 },
      { id: "not-in-batch-2", projectId: null, confidence: 0 },
    ]);
    const out = parseAutoFileResponse(reply, ids("real-1"), ids(), stats);
    expect(out).toEqual([]);
    expect(stats.outcome).toBe("ok");
    expect(stats.entries).toBe(2);
    expect(stats.unknownIds).toBe(2);
  });

  test("no array at all is distinguishable from an empty one", () => {
    const stats = fresh();
    expect(
      parseAutoFileResponse(
        "I'm sorry, I can't help with that.",
        ids(),
        ids(),
        stats,
      ),
    ).toBeNull();
    expect(stats.outcome).toBe("no_array");
    expect(stats.entries).toBe(0);
  });

  test("a reply cut off mid-array is truncated, not absent", () => {
    // A cut-off reply has no closing bracket, so the array regex finds
    // nothing — and calling that "no array" points the reader at the prompt
    // when the fault is the token budget. The distinction is the difference
    // between "the model refused" and "we did not let it finish".
    const stats = fresh();
    expect(
      parseAutoFileResponse(
        '[{"id": "a", "projectId": nul',
        ids("a"),
        ids(),
        stats,
      ),
    ).toBeNull();
    expect(stats.outcome).toBe("truncated");
  });

  test("a closed array with broken JSON inside is unparseable", () => {
    const stats = fresh();
    expect(
      parseAutoFileResponse('[{"id": "a",,}]', ids("a"), ids(), stats),
    ).toBeNull();
    expect(stats.outcome).toBe("unparseable");
  });

  test("malformed and duplicate entries are counted apart from unknown ids", () => {
    const stats = fresh();
    const reply = JSON.stringify([
      "just a string",
      { projectId: null, confidence: 0 },
      { id: "a", projectId: null, confidence: 0.5 },
      { id: "a", projectId: null, confidence: 0.9 },
      { id: "zz", projectId: null, confidence: 0 },
    ]);
    const out = parseAutoFileResponse(reply, ids("a"), ids(), stats);
    expect(out).toHaveLength(1);
    expect(stats.entries).toBe(5);
    expect(stats.malformed).toBe(2);
    expect(stats.duplicates).toBe(1);
    expect(stats.unknownIds).toBe(1);
  });

  test("a healthy parse reports ok and leaves the counters at zero", () => {
    const stats = fresh();
    const reply = JSON.stringify([
      { id: "a", projectId: "p", confidence: 0.9 },
    ]);
    const out = parseAutoFileResponse(reply, ids("a"), ids("p"), stats);
    expect(out).toEqual([{ id: "a", projectId: "p", confidence: 0.9 }]);
    expect(stats).toEqual({
      entries: 1,
      unknownIds: 0,
      malformed: 0,
      duplicates: 0,
      outcome: "ok",
    });
  });
});
