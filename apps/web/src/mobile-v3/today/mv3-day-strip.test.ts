/**
 * The day strip states two things, and both can be wrong quietly.
 *
 * A band that drops a commitment reads as free time. A "3h free" label that is
 * not a computed minute count is a fake number attached to the one claim the
 * band exists to make. Both are asserted on the pure segment builder, so the
 * rules are testable without a layout.
 */

import { describe, expect, test } from "bun:test";

import type { DayPicture } from "@/pages/hq/hq-k1-modules";

import {
  activeFreeBlock,
  daySegments,
  daySentence,
  freeLabel,
} from "./mv3-day-strip";

/** 2026-08-03, a Monday. The rail runs 08:00 → 19:00 local. */
const NOW = new Date(2026, 7, 3, 9, 0, 0).getTime();
const at = (hour: number, minute = 0) =>
  new Date(2026, 7, 3, hour, minute, 0).getTime();

function day(overrides: Partial<DayPicture> = {}): DayPicture {
  return {
    commitments: [],
    unbookedMinutes: 0,
    freeBlock: null,
    ...overrides,
  };
}

describe("segments", () => {
  test("an empty day is one idle stretch, never a busy one", () => {
    const segments = daySegments(day(), NOW);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("idle");
  });

  test("a commitment becomes a busy segment weighted by its minutes", () => {
    const segments = daySegments(
      day({
        commitments: [
          { id: "c1", title: "Standup", startMs: at(10), endMs: at(11) },
        ],
      }),
      NOW,
    );
    expect(segments.map((s) => s.kind)).toEqual(["idle", "busy", "idle"]);
    expect(segments[1]!.minutes).toBe(60);
  });

  test("overlapping commitments merge — two calendars are not two meetings", () => {
    const segments = daySegments(
      day({
        commitments: [
          { id: "a", title: "Sync", startMs: at(10), endMs: at(11) },
          { id: "b", title: "Sync (copy)", startMs: at(10, 30), endMs: at(12) },
        ],
      }),
      NOW,
    );
    const busy = segments.filter((s) => s.kind === "busy");
    expect(busy).toHaveLength(1);
    expect(busy[0]!.minutes).toBe(120);
  });

  test("time outside 8–19 is clamped, never dropped into a phantom gap", () => {
    const segments = daySegments(
      day({
        commitments: [
          { id: "a", title: "Red-eye", startMs: at(5), endMs: at(9) },
        ],
      }),
      NOW,
    );
    expect(segments[0]!.kind).toBe("busy");
    expect(segments[0]!.minutes).toBe(60); // 08:00 → 09:00
  });

  test("the free block splits the idle stretch and carries the only label", () => {
    const segments = daySegments(
      day({
        commitments: [
          { id: "a", title: "Standup", startMs: at(9), endMs: at(10) },
        ],
        freeBlock: { startMs: at(13, 30), endMs: at(16, 30), minutes: 180 },
      }),
      NOW,
    );
    const free = segments.filter((s) => s.kind === "free");
    expect(free).toHaveLength(1);
    expect(free[0]!.label).toBe("3h free");
    expect(segments.filter((s) => s.label !== null)).toHaveLength(1);
  });
});

describe("the free label is a computed number or it is absent", () => {
  test("hours, minutes and both", () => {
    expect(freeLabel(180)).toBe("3h free");
    expect(freeLabel(45)).toBe("45m free");
    expect(freeLabel(150)).toBe("2h 30m free");
  });

  test("a sliver is not a block, and a non-number is never a label", () => {
    // "0h free" beside a full calendar is the fake number this guards.
    expect(freeLabel(10)).toBeNull();
    expect(freeLabel(Number.NaN)).toBeNull();
  });
});

describe("the sentence the band shows", () => {
  test("says what the bars say", () => {
    expect(
      daySentence(
        day({
          commitments: [
            { id: "a", title: "Standup", startMs: at(9), endMs: at(10) },
          ],
          freeBlock: { startMs: at(13), endMs: at(16), minutes: 180 },
        }),
        NOW,
      ),
    ).toBe("1 commitment today · 3h free");
  });

  test("an empty day says so rather than saying nothing", () => {
    expect(daySentence(day(), NOW)).toBe("Nothing is booked today");
  });
});

/*
 * The owner's real day, read off prod on 2026-08-03: 09:00–18:00 booked solid
 * but for one fifteen-minute gap at 12:15. Opening the phone at 23:11 showed a
 * teal "15m free" chip — a present-tense offer for time that had gone eleven
 * hours earlier. The minutes were real; the claim was not.
 */
describe("a free block that has already ended is not free", () => {
  const past = day({
    commitments: [
      { id: "a", title: "All morning", startMs: at(8), endMs: at(12, 15) },
      { id: "b", title: "All afternoon", startMs: at(12, 30), endMs: at(19) },
    ],
    freeBlock: { startMs: at(12, 15), endMs: at(12, 30), minutes: 15 },
  });
  const evening = at(23, 11);

  test("it is dropped once it has ended", () => {
    expect(activeFreeBlock(past, at(12, 20))).not.toBeNull();
    // Exactly at the end is over — the block is `endMs`-exclusive.
    expect(activeFreeBlock(past, at(12, 30))).toBeNull();
    expect(activeFreeBlock(past, evening)).toBeNull();
  });

  test("the band shows a passed gap as plain idle, never a teal offer", () => {
    const live = daySegments(past, at(12, 20));
    expect(live.filter((s) => s.kind === "free")).toHaveLength(1);

    const stale = daySegments(past, evening);
    expect(stale.filter((s) => s.kind === "free")).toHaveLength(0);
    // The gap is still drawn — it is unbooked time, just not an offer.
    expect(stale.filter((s) => s.kind === "idle").length).toBeGreaterThan(0);
    expect(stale.every((s) => s.label === null)).toBe(true);
  });

  test("the sentence stops claiming it too", () => {
    expect(daySentence(past, at(12, 20))).toBe("2 commitments today · 15m free");
    expect(daySentence(past, evening)).toBe("2 commitments today");
  });

  test("a block still ahead of you is untouched", () => {
    const ahead = day({
      commitments: [{ id: "a", title: "Standup", startMs: at(9), endMs: at(10) }],
      freeBlock: { startMs: at(13, 30), endMs: at(16, 30), minutes: 180 },
    });
    expect(activeFreeBlock(ahead, NOW)).not.toBeNull();
    expect(daySentence(ahead, NOW)).toBe("1 commitment today · 3h free");
  });
});
