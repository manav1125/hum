/**
 * Day-rail free-block maths.
 *
 * The cases that actually bite: back-to-back events must not leave a phantom
 * zero-minute gap between them, overlapping events must not be double-counted
 * out of the unbooked total, all-day events must not swallow the working
 * window, and an empty day must report the whole window as one free block.
 */
import { describe, expect, test } from "bun:test";

import {
  buildDayRail,
  DEFAULT_WINDOW_END_MINUTE,
  DEFAULT_WINDOW_START_MINUTE,
  isAllDay,
  localDate,
  mergeIntervals,
  minuteOfDay,
  zonedWallClockToMs,
} from "./day-rail.js";
import type { CalendarEvent } from "./google-calendar-client.js";

const TZ = "America/New_York";
const DATE = "2026-08-03"; // a Monday, well clear of any DST transition

/** Build a timed event from local `HH:MM` strings in {@link TZ}. */
function timed(
  id: string,
  startClock: string,
  endClock: string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  const toIso = (clock: string): string => {
    const [h, m] = clock.split(":").map(Number);
    return new Date(zonedWallClockToMs(DATE, h * 60 + m, TZ)).toISOString();
  };
  return {
    id,
    summary: `event ${id}`,
    start: { dateTime: toIso(startClock) },
    end: { dateTime: toIso(endClock) },
    ...extra,
  };
}

function allDay(id: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    summary: `all-day ${id}`,
    start: { date: DATE },
    end: { date: "2026-08-04" },
    ...extra,
  };
}

function rail(events: CalendarEvent[]) {
  return buildDayRail({
    events,
    date: DATE,
    timeZone: TZ,
    windowStartMinute: DEFAULT_WINDOW_START_MINUTE,
    windowEndMinute: DEFAULT_WINDOW_END_MINUTE,
  });
}

const WINDOW_MINUTES = DEFAULT_WINDOW_END_MINUTE - DEFAULT_WINDOW_START_MINUTE; // 540

describe("timezone arithmetic", () => {
  test("round-trips a local wall clock through the zone", () => {
    const ms = zonedWallClockToMs(DATE, 13 * 60 + 30, TZ);
    expect(localDate(ms, TZ)).toBe(DATE);
    expect(minuteOfDay(ms, DATE, TZ)).toBe(13 * 60 + 30);
  });

  test("a local date is zone-relative, not the daemon's", () => {
    // 01:00 UTC on the 4th is still the 3rd in New York.
    const ms = Date.parse("2026-08-04T01:00:00Z");
    expect(localDate(ms, TZ)).toBe("2026-08-03");
    expect(localDate(ms, "UTC")).toBe("2026-08-04");
  });
});

describe("mergeIntervals", () => {
  test("collapses adjacent intervals into one", () => {
    const merged = mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 100, endMs: 200 },
    ]);
    expect(merged).toEqual([{ startMs: 0, endMs: 200 }]);
  });

  test("collapses a fully contained interval", () => {
    const merged = mergeIntervals([
      { startMs: 0, endMs: 500 },
      { startMs: 100, endMs: 200 },
    ]);
    expect(merged).toEqual([{ startMs: 0, endMs: 500 }]);
  });

  test("drops zero-length intervals", () => {
    expect(mergeIntervals([{ startMs: 50, endMs: 50 }])).toEqual([]);
  });
});

describe("buildDayRail", () => {
  test("an empty day is one free block covering the whole window", () => {
    const out = rail([]);
    expect(out.commitments).toEqual([]);
    expect(out.bookedMinutes).toBe(0);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES);
    expect(out.freeBlocks).toHaveLength(1);
    expect(out.largestFreeBlock?.minutes).toBe(WINDOW_MINUTES);
    expect(out.largestFreeBlock?.startMinuteOfDay).toBe(
      DEFAULT_WINDOW_START_MINUTE,
    );
    expect(out.largestFreeBlock?.endMinuteOfDay).toBe(
      DEFAULT_WINDOW_END_MINUTE,
    );
  });

  test("adjacent events merge — no phantom zero-minute gap between them", () => {
    const out = rail([
      timed("a", "10:00", "11:00"),
      timed("b", "11:00", "12:00"),
    ]);
    expect(out.bookedMinutes).toBe(120);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES - 120);
    // 09:00–10:00 and 12:00–18:00 only. A third, zero-minute block at 11:00
    // would be the bug this case exists for.
    expect(out.freeBlocks.map((b) => b.minutes)).toEqual([60, 360]);
    expect(out.freeBlocks.every((b) => b.minutes > 0)).toBe(true);
    expect(out.largestFreeBlock?.minutes).toBe(360);
    expect(out.largestFreeBlock?.startMinuteOfDay).toBe(12 * 60);
  });

  test("overlapping events count their union once", () => {
    const out = rail([
      timed("a", "10:00", "12:00"),
      timed("b", "11:00", "11:30"), // fully inside a
      timed("c", "11:45", "13:00"), // partially overlaps a
    ]);
    // Union is 10:00–13:00 = 180 minutes, not 120 + 30 + 75.
    expect(out.bookedMinutes).toBe(180);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES - 180);
    expect(out.freeBlocks.map((b) => b.minutes)).toEqual([60, 300]);
    expect(out.largestFreeBlock?.startMinuteOfDay).toBe(13 * 60);
    expect(out.largestFreeBlock?.minutes).toBe(300);
  });

  test("all-day events never occupy the working window", () => {
    const out = rail([allDay("ooo"), timed("a", "10:00", "11:00")]);
    expect(out.allDayCommitments).toEqual([
      { id: "ooo", title: "all-day ooo", isOrganizer: null },
    ]);
    expect(out.commitments.map((c) => c.id)).toEqual(["a"]);
    expect(out.bookedMinutes).toBe(60);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES - 60);
  });

  test("an all-day-only day is still entirely unbooked", () => {
    const out = rail([allDay("birthday")]);
    expect(out.bookedMinutes).toBe(0);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES);
    expect(out.largestFreeBlock?.minutes).toBe(WINDOW_MINUTES);
  });

  test("isAllDay keys off the absence of dateTime", () => {
    expect(isAllDay(allDay("x"))).toBe(true);
    expect(isAllDay(timed("y", "09:00", "10:00"))).toBe(false);
  });

  test("events outside the window are listed but do not book time", () => {
    const out = rail([
      timed("early", "07:00", "08:00"),
      timed("late", "19:00", "20:00"),
    ]);
    expect(out.commitments.map((c) => c.id)).toEqual(["early", "late"]);
    expect(out.bookedMinutes).toBe(0);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES);
  });

  test("an event straddling the window edge is clipped, not dropped", () => {
    const out = rail([timed("standup", "08:30", "09:30")]);
    expect(out.commitments[0].minutes).toBe(60);
    expect(out.bookedMinutes).toBe(30);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES - 30);
    expect(out.largestFreeBlock?.startMinuteOfDay).toBe(9 * 60 + 30);
  });

  test("cancelled events are ignored entirely", () => {
    const out = rail([
      timed("gone", "10:00", "12:00", { status: "cancelled" }),
    ]);
    expect(out.commitments).toEqual([]);
    expect(out.bookedMinutes).toBe(0);
  });

  test("events marked Free or declined are listed but not busy", () => {
    const out = rail([
      timed("focus", "10:00", "11:00", { transparency: "transparent" }),
      timed("skipped", "14:00", "15:00", {
        attendees: [
          { email: "u@example.com", self: true, responseStatus: "declined" },
        ],
      }),
    ]);
    expect(out.commitments.map((c) => c.busy)).toEqual([false, false]);
    expect(out.bookedMinutes).toBe(0);
    expect(out.unbookedMinutes).toBe(WINDOW_MINUTES);
  });

  test("organiser is read off organizer.self without an extra call", () => {
    const out = rail([
      timed("mine", "10:00", "11:00", { organizer: { self: true } }),
      timed("theirs", "11:00", "12:00", {
        organizer: { email: "someone@example.com" },
      }),
      timed("unknown", "12:00", "13:00"),
    ]);
    expect(out.commitments.map((c) => c.isOrganizer)).toEqual([
      true,
      false,
      null,
    ]);
  });

  test("commitments come back in start order regardless of input order", () => {
    const out = rail([
      timed("c", "15:00", "16:00"),
      timed("a", "09:30", "10:00"),
      timed("b", "11:00", "11:15"),
    ]);
    expect(out.commitments.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("a fully booked window has no free block at all", () => {
    const out = rail([timed("marathon", "09:00", "18:00")]);
    expect(out.bookedMinutes).toBe(WINDOW_MINUTES);
    expect(out.unbookedMinutes).toBe(0);
    expect(out.freeBlocks).toEqual([]);
    expect(out.largestFreeBlock).toBeNull();
  });

  test("ties resolve to the earliest free block", () => {
    // 09:00-12:00 free, 12:00-13:00 busy, 13:00-16:00 free, 16:00-18:00 busy.
    const out = rail([
      timed("noon", "12:00", "13:00"),
      timed("evening", "16:00", "18:00"),
    ]);
    expect(out.freeBlocks.map((b) => b.minutes)).toEqual([180, 180]);
    expect(out.largestFreeBlock?.startMinuteOfDay).toBe(9 * 60);
  });

  test("honours a custom working window", () => {
    const out = buildDayRail({
      events: [timed("a", "10:00", "11:00")],
      date: DATE,
      timeZone: TZ,
      windowStartMinute: 8 * 60,
      windowEndMinute: 20 * 60,
    });
    expect(out.unbookedMinutes).toBe(12 * 60 - 60);
    expect(out.largestFreeBlock?.minutes).toBe(9 * 60); // 11:00 → 20:00
  });
});
