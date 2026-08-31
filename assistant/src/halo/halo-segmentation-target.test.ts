/**
 * S6 ruling 2: tune to the count, not the constants.
 *
 * The arc is a story rail, so the number of beads is a readability property
 * of the day rather than a consequence of one global threshold. What has to
 * hold: a finely-chopped day loosens until it fits, a thin day is never
 * padded, and a ⚑ is never merged away to make room.
 */
import { describe, expect, test } from "bun:test";

import { segmentDayToTarget, type SegmentInput } from "./halo-segmentation.js";

const T0 = Date.UTC(2026, 7, 30, 8, 0, 0);
const SEGMENT_MS = 20_000;

/** A stretch of `minutes` of audio starting at `from`. */
function stretch(from: number, minutes: number): SegmentInput[] {
  const n = Math.round((minutes * 60_000) / SEGMENT_MS);
  return Array.from({ length: n }, (_, i) => ({
    id: `s${from}-${i}`,
    startedAt: from + i * SEGMENT_MS,
    coveredThrough: from + (i + 1) * SEGMENT_MS,
  }));
}

/** `count` ten-minute stretches, each separated by five minutes of quiet. */
function choppedDay(count: number): SegmentInput[] {
  const segments: SegmentInput[] = [];
  let cursor = T0;
  for (let i = 0; i < count; i++) {
    segments.push(...stretch(cursor, 10));
    cursor += 15 * 60_000;
  }
  return segments;
}

describe("segmentDayToTarget", () => {
  test("a normal day is left alone", () => {
    const episodes = segmentDayToTarget(choppedDay(7));
    expect(episodes).toHaveLength(7);
  });

  test("a day chopped past the cap loosens until it fits", () => {
    // Twenty stretches at the default threshold; the cap is twelve.
    const plain = segmentDayToTarget(choppedDay(20), [], [], {
      maxChapters: 1000,
    });
    expect(plain.length).toBe(20);

    const tuned = segmentDayToTarget(choppedDay(20));
    expect(tuned.length).toBeLessThanOrEqual(12);
    expect(tuned.length).toBeGreaterThan(0);
  });

  test("a thin day is never padded", () => {
    // Below the target there is no adjustment at all — a two-bead day is a
    // two-bead day, and inventing chapters would be guessing into the day.
    expect(segmentDayToTarget(choppedDay(2))).toHaveLength(2);
    expect(segmentDayToTarget(choppedDay(1))).toHaveLength(1);
  });

  test("marks are never merged away to make room", () => {
    // Fourteen marked moments beat a twelve-bead preference: a cap that could
    // swallow a ⚑ would outrank the one thing the wearer said by hand.
    const segments = stretch(T0, 120);
    const marks = Array.from({ length: 14 }, (_, i) => ({
      id: `m${i}`,
      markedAt: T0 + (i + 1) * 8 * 60_000,
    }));
    const episodes = segmentDayToTarget(segments, marks);

    expect(episodes.length).toBeGreaterThan(12);
    // Every mark still lands in exactly one chapter.
    const claimed = episodes.flatMap((e) => e.markIds);
    expect(new Set(claimed).size).toBe(14);
  });

  test("loosening stops rather than merging a morning into an evening", () => {
    // Two stretches four hours apart must stay two chapters however few beads
    // that is — the cap is a readability preference, not a licence to merge.
    const segments = [...stretch(T0, 10), ...stretch(T0 + 4 * 3600_000, 10)];
    expect(
      segmentDayToTarget(segments, [], [], { maxChapters: 1 }),
    ).toHaveLength(2);
  });
});
