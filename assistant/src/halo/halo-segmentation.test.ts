/**
 * The cuts, as rules.
 *
 * Segmentation is where the Day either reads as a journal or as noise, so
 * these tests assert the boundary grammar the design specifies rather than
 * particular outputs: a human mark outranks a machine boundary, absences are
 * never filled, and a short day is still a day.
 */
import { describe, expect, test } from "bun:test";

import {
  gapsBetween,
  segmentDay,
  type SegmentInput,
} from "./halo-segmentation.js";

const T0 = Date.UTC(2026, 7, 30, 9, 0, 0);
const SEGMENT_MS = 20_000;

/** `n` back-to-back 20s segments — what continuous sync actually delivers. */
function run(from: number, n: number, place?: string): SegmentInput[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${from}-${i}`,
    startedAt: from + i * SEGMENT_MS,
    coveredThrough: from + (i + 1) * SEGMENT_MS,
    placeLabel: place ?? null,
  }));
}

describe("segmentDay", () => {
  test("continuous audio is one chapter, not one per file", () => {
    const episodes = segmentDay(run(T0, 30));
    expect(episodes).toHaveLength(1);
    expect(episodes[0].chapterIndex).toBe(1);
    expect(episodes[0].heardSeconds).toBe(600);
  });

  test("a long silence ends a chapter", () => {
    const morning = run(T0, 12);
    const afternoon = run(T0 + 4 * 60 * 60 * 1000, 12);
    const episodes = segmentDay([...morning, ...afternoon]);
    expect(episodes).toHaveLength(2);
    expect(episodes[1].boundaryReason).toBe("silence");
  });

  test("a natural pause does not", () => {
    // 90s of quiet mid-conversation is somebody reading something, not the end.
    const before = run(T0, 6);
    const after = run(T0 + 6 * SEGMENT_MS + 90_000, 6);
    expect(segmentDay([...before, ...after])).toHaveLength(1);
  });

  test("a bookmark cuts, even mid-conversation", () => {
    // The one signal a person can give with their hand must outrank silence.
    const before = run(T0, 6);
    const after = run(T0 + 6 * SEGMENT_MS, 6);
    const episodes = segmentDay(
      [...before, ...after],
      [{ id: "m1", markedAt: T0 + 6 * SEGMENT_MS }],
    );
    expect(episodes).toHaveLength(2);
    expect(episodes[1].boundaryReason).toBe("bookmark");
    expect(episodes[1].markIds).toEqual(["m1"]);
  });

  test("a marked fragment is never merged away", () => {
    // Short, but a person pressed the button — the mark IS the point.
    const long = run(T0, 30);
    const fragment = run(T0 + 30 * SEGMENT_MS, 1);
    const episodes = segmentDay(
      [...long, ...fragment],
      [{ id: "m1", markedAt: T0 + 30 * SEGMENT_MS }],
    );
    expect(episodes).toHaveLength(2);
    expect(episodes[1].heardSeconds).toBe(20);
  });

  test("a change of place cuts", () => {
    const office = run(T0, 9, "OFFICE");
    const cafe = run(T0 + 9 * SEGMENT_MS, 9, "VERVE");
    const episodes = segmentDay([...office, ...cafe]);
    expect(episodes).toHaveLength(2);
    expect(episodes[1].boundaryReason).toBe("place");
    expect(episodes[1].placeLabel).toBe("VERVE");
  });

  test("a calendar start cuts a run of audio", () => {
    const before = run(T0, 6);
    const meeting = run(T0 + 6 * SEGMENT_MS, 12);
    const episodes = segmentDay(
      [...before, ...meeting],
      [],
      [{ startsAt: T0 + 6 * SEGMENT_MS, title: "Acme" }],
    );
    expect(episodes).toHaveLength(2);
    expect(episodes[1].boundaryReason).toBe("calendar");
  });

  test("place is the one you spent the time in, not the last one seen", () => {
    const episodes = segmentDay([
      ...run(T0, 1, "WALKING"),
      ...run(T0 + SEGMENT_MS, 20, "VERVE"),
      ...run(T0 + 21 * SEGMENT_MS, 1, "WALKING"),
    ]);
    expect(episodes[0].placeLabel).toBe("VERVE");
  });

  test("fragments merge forward into the chapter they precede", () => {
    // A stray minute before a meeting belongs to the meeting.
    const stray = run(T0, 2);
    const meeting = run(T0 + 4 * 60 * 60 * 1000, 20);
    const episodes = segmentDay([...stray, ...meeting]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startedAt).toBe(T0);
    expect(episodes[0].segmentIds).toHaveLength(22);
  });

  test("a day of only a fragment is still a day", () => {
    const episodes = segmentDay(run(T0, 2));
    expect(episodes).toHaveLength(1);
  });

  test("out-of-order arrival is sorted, not trusted", () => {
    // Wi-Fi catch-up can deliver an older session after a newer one.
    const first = run(T0, 6);
    const second = run(T0 + 4 * 60 * 60 * 1000, 6);
    const episodes = segmentDay([...second, ...first]);
    expect(episodes[0].startedAt).toBe(T0);
    expect(episodes[1].startedAt).toBeGreaterThan(T0);
  });

  test("nothing heard produces nothing", () => {
    expect(segmentDay([])).toEqual([]);
  });
});

describe("gapsBetween", () => {
  test("an unheard stretch becomes a gap with an honest default reason", () => {
    const dayStart = Date.UTC(2026, 7, 30, 6, 0, 0);
    const dayEnd = Date.UTC(2026, 7, 30, 22, 0, 0);
    const episodes = segmentDay(run(Date.UTC(2026, 7, 30, 12, 0, 0), 30));
    const gaps = gapsBetween(episodes, dayStart, dayEnd);

    expect(gaps).toHaveLength(2);
    // Never inferred further: this cannot know battery from a 3s hold.
    expect(gaps.every((g) => g.reason === "not_worn")).toBe(true);
    expect(gaps[0].startedAt).toBe(dayStart);
    expect(gaps[1].endedAt).toBe(dayEnd);
  });

  test("short quiet between chapters is not a gap", () => {
    const dayStart = T0;
    const a = run(T0, 12);
    const b = run(T0 + 12 * SEGMENT_MS + 5 * 60 * 1000, 12);
    const episodes = segmentDay([...a, ...b]);
    const gaps = gapsBetween(
      episodes,
      dayStart,
      episodes[episodes.length - 1].endedAt,
    );
    expect(gaps).toEqual([]);
  });
});
