/**
 * The day rail — today's calendar reduced to what the K1 frame draws:
 * a strip of hours, the commitments sitting on it, a now-marker, the total
 * unbooked time inside a working window, and the largest contiguous free
 * block (the one the offer is made against).
 *
 * Everything in this module is pure: it takes already-fetched Google Calendar
 * events plus a window and a clock, and returns numbers. The network lives in
 * `google-calendar-client.ts`; the route lives in
 * `runtime/routes/calendar-day-routes.ts`.
 *
 * Two rules the maths must honour, both of them design requirements rather
 * than implementation details:
 *
 *  1. **All-day events do not occupy the working window.** A day marked
 *     "Out of office (all day)" or "Manav's birthday" is not nine hours of
 *     booked time. They are reported separately so the rail can render them
 *     as a band above the strip, and they are invisible to the free-block
 *     maths.
 *  2. **Only genuinely busy events consume time.** An event the user marked
 *     *Free* (`transparency: "transparent"`) or has *declined* is on the
 *     calendar but is not a commitment — counting it would under-report the
 *     time Cue can offer to spend.
 */

import type { CalendarEvent } from "./google-calendar-client.js";

/** Minutes in a day. `endMinuteOfDay` is clamped to this. */
export const MINUTES_PER_DAY = 1440;

/**
 * Default working window, 09:00–18:00 local. "Sensible" rather than correct —
 * the route accepts an override, and a future rhythms/preferences source can
 * supply the user's real hours without changing this module.
 */
export const DEFAULT_WINDOW_START_MINUTE = 9 * 60;
export const DEFAULT_WINDOW_END_MINUTE = 18 * 60;

export interface DayRailCommitment {
  id: string;
  title: string;
  /** ISO-8601 instant the event starts. */
  start: string;
  /** ISO-8601 instant the event ends. */
  end: string;
  /** Minutes from local midnight, clamped to the day. */
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  /** Duration in minutes, clamped to the day. */
  minutes: number;
  /**
   * True when the user organises the event, false when someone else does,
   * null when the event carries no organizer (Google omits it on some
   * personal-calendar entries). Read straight off `organizer.self` — no
   * extra API call.
   */
  isOrganizer: boolean | null;
  /** The user's own RSVP, when the event has an attendee list. */
  responseStatus: "needsAction" | "declined" | "tentative" | "accepted" | null;
  /**
   * False for events that are on the calendar but do not consume time —
   * `transparency: "transparent"` (marked Free) or declined by the user.
   * Only `busy: true` commitments reduce `unbookedMinutes`.
   */
  busy: boolean;
}

export interface DayRailAllDayCommitment {
  id: string;
  title: string;
  isOrganizer: boolean | null;
}

export interface DayRailBlock {
  start: string;
  end: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  minutes: number;
}

export interface DayRailShape {
  commitments: DayRailCommitment[];
  allDayCommitments: DayRailAllDayCommitment[];
  /** Busy minutes inside the working window, overlaps counted once. */
  bookedMinutes: number;
  /** Working-window minutes with nothing on them. */
  unbookedMinutes: number;
  /** Every gap inside the working window, in chronological order. */
  freeBlocks: DayRailBlock[];
  /** The longest gap; ties resolve to the earliest. Null when the day is full. */
  largestFreeBlock: DayRailBlock | null;
}

export interface DayRailInput {
  events: CalendarEvent[];
  /** Local calendar date the rail covers, `YYYY-MM-DD`. */
  date: string;
  /** IANA timezone the local date and minute-of-day are expressed in. */
  timeZone: string;
  windowStartMinute: number;
  windowEndMinute: number;
}

// ---------------------------------------------------------------------------
// Timezone arithmetic
// ---------------------------------------------------------------------------

const OFFSET_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = OFFSET_FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    OFFSET_FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in `timeZone` at instant `ms`. */
export function wallClockAt(ms: number, timeZone: string): WallClock {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type)?.value ?? "0";
    return Number(found);
  };
  // `hour12: false` still renders midnight as "24" in some ICU versions.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds. */
function tzOffsetMs(ms: number, timeZone: string): number {
  const w = wallClockAt(ms, timeZone);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  // Intl truncates to whole seconds; ignore the sub-second remainder so a
  // fractional millisecond cannot leak into the offset.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads the given local
 * date and time. Resolved by iterating the offset twice, which converges for
 * every real zone including DST transition days.
 */
export function zonedWallClockToMs(
  date: string,
  minuteOfDay: number,
  timeZone: string,
): number {
  const [year, month, day] = date.split("-").map(Number);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let ms = naive - tzOffsetMs(naive, timeZone);
  ms = naive - tzOffsetMs(ms, timeZone);
  return ms;
}

/** The local `YYYY-MM-DD` date in `timeZone` at instant `ms`. */
export function localDate(ms: number, timeZone: string): string {
  const w = wallClockAt(ms, timeZone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Minutes elapsed since local midnight on `date`, unclamped. */
export function minuteOfDay(
  ms: number,
  date: string,
  timeZone: string,
): number {
  const midnight = zonedWallClockToMs(date, 0, timeZone);
  return Math.round((ms - midnight) / 60_000);
}

// ---------------------------------------------------------------------------
// Interval maths
// ---------------------------------------------------------------------------

interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * Merge overlapping *and adjacent* intervals. Adjacency matters: two
 * back-to-back meetings (10:00–11:00, 11:00–12:00) must collapse into one
 * busy block, otherwise the complement would contain a phantom zero-minute
 * free block between them and `largestFreeBlock` could pick it.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: Interval[] = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last && cur.startMs <= last.endMs) {
      if (cur.endMs > last.endMs) last.endMs = cur.endMs;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** The gaps left inside `[startMs, endMs]` once `busy` is removed. */
function complement(
  busy: Interval[],
  startMs: number,
  endMs: number,
): Interval[] {
  const gaps: Interval[] = [];
  let cursor = startMs;
  for (const block of busy) {
    if (block.startMs > cursor) {
      gaps.push({ startMs: cursor, endMs: block.startMs });
    }
    cursor = Math.max(cursor, block.endMs);
  }
  if (cursor < endMs) gaps.push({ startMs: cursor, endMs });
  return gaps.filter((g) => g.endMs > g.startMs);
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/**
 * An all-day event carries `start.date` (a bare `YYYY-MM-DD`) with no
 * `start.dateTime`. It never occupies the working window.
 */
export function isAllDay(event: CalendarEvent): boolean {
  return !event.start?.dateTime && Boolean(event.start?.date);
}

function selfResponseStatus(
  event: CalendarEvent,
): DayRailCommitment["responseStatus"] {
  const self = event.attendees?.find((a) => a.self === true);
  return self?.responseStatus ?? null;
}

function organizerFlag(event: CalendarEvent): boolean | null {
  if (!event.organizer) return null;
  return event.organizer.self === true;
}

function isBusy(event: CalendarEvent): boolean {
  if (event.status === "cancelled") return false;
  if (event.transparency === "transparent") return false;
  if (selfResponseStatus(event) === "declined") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function toBlock(
  interval: Interval,
  date: string,
  timeZone: string,
): DayRailBlock {
  const startMinuteOfDay = minuteOfDay(interval.startMs, date, timeZone);
  const endMinuteOfDay = minuteOfDay(interval.endMs, date, timeZone);
  return {
    start: new Date(interval.startMs).toISOString(),
    end: new Date(interval.endMs).toISOString(),
    startMinuteOfDay,
    endMinuteOfDay,
    minutes: Math.round((interval.endMs - interval.startMs) / 60_000),
  };
}

/**
 * Reduce a day's events to the rail. `events` may contain anything the API
 * returned for the bounded window — cancelled entries, all-day entries and
 * events that only clip the edges of the day are all handled here.
 */
export function buildDayRail(input: DayRailInput): DayRailShape {
  const { events, date, timeZone } = input;
  const windowStartMinute = Math.max(
    0,
    Math.min(MINUTES_PER_DAY, input.windowStartMinute),
  );
  const windowEndMinute = Math.max(
    windowStartMinute,
    Math.min(MINUTES_PER_DAY, input.windowEndMinute),
  );

  const dayStartMs = zonedWallClockToMs(date, 0, timeZone);
  const dayEndMs = zonedWallClockToMs(date, MINUTES_PER_DAY, timeZone);
  const windowStartMs = zonedWallClockToMs(date, windowStartMinute, timeZone);
  const windowEndMs = zonedWallClockToMs(date, windowEndMinute, timeZone);

  const commitments: DayRailCommitment[] = [];
  const allDayCommitments: DayRailAllDayCommitment[] = [];
  const busyIntervals: Interval[] = [];

  for (const event of events) {
    if (event.status === "cancelled") continue;
    const title = event.summary?.trim() || "(no title)";

    if (isAllDay(event)) {
      allDayCommitments.push({
        id: event.id,
        title,
        isOrganizer: organizerFlag(event),
      });
      continue;
    }

    const startIso = event.start?.dateTime;
    const endIso = event.end?.dateTime ?? startIso;
    if (!startIso || !endIso) continue;
    const rawStartMs = Date.parse(startIso);
    const rawEndMs = Date.parse(endIso);
    if (Number.isNaN(rawStartMs) || Number.isNaN(rawEndMs)) continue;

    // Clip to the day so an event that straddles midnight is placed on the
    // rail rather than running off it.
    const startMs = Math.max(rawStartMs, dayStartMs);
    const endMs = Math.min(Math.max(rawEndMs, rawStartMs), dayEndMs);
    if (endMs < dayStartMs || startMs > dayEndMs) continue;

    const busy = isBusy(event);
    commitments.push({
      id: event.id,
      title,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      startMinuteOfDay: minuteOfDay(startMs, date, timeZone),
      endMinuteOfDay: minuteOfDay(endMs, date, timeZone),
      minutes: Math.round((endMs - startMs) / 60_000),
      isOrganizer: organizerFlag(event),
      responseStatus: selfResponseStatus(event),
      busy,
    });

    if (!busy) continue;
    const clippedStart = Math.max(startMs, windowStartMs);
    const clippedEnd = Math.min(endMs, windowEndMs);
    if (clippedEnd > clippedStart) {
      busyIntervals.push({ startMs: clippedStart, endMs: clippedEnd });
    }
  }

  commitments.sort(
    (a, b) =>
      a.startMinuteOfDay - b.startMinuteOfDay ||
      a.endMinuteOfDay - b.endMinuteOfDay,
  );

  const merged = mergeIntervals(busyIntervals);
  const bookedMs = merged.reduce((sum, i) => sum + (i.endMs - i.startMs), 0);
  const windowMs = Math.max(0, windowEndMs - windowStartMs);
  const bookedMinutes = Math.round(bookedMs / 60_000);
  const unbookedMinutes = Math.max(
    0,
    Math.round((windowMs - bookedMs) / 60_000),
  );

  const freeBlocks = complement(merged, windowStartMs, windowEndMs).map((gap) =>
    toBlock(gap, date, timeZone),
  );
  let largestFreeBlock: DayRailBlock | null = null;
  for (const block of freeBlocks) {
    if (!largestFreeBlock || block.minutes > largestFreeBlock.minutes) {
      largestFreeBlock = block;
    }
  }

  return {
    commitments,
    allDayCommitments,
    bookedMinutes,
    unbookedMinutes,
    freeBlocks,
    largestFreeBlock,
  };
}
