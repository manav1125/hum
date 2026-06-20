import {
  timezoneDayStartEpoch,
  toTimezoneDateString,
} from "@/components/charts/format-date-label";

export type UsageRangeWindowId = "today" | "7d" | "30d" | "90d" | "all";

const RANGE_START_DAY_OFFSETS: Record<
  Exclude<UsageRangeWindowId, "all">,
  number
> = {
  today: 0,
  "7d": 6,
  "30d": 29,
  "90d": 89,
};

/**
 * Resolve the `{ from, to }` epoch-ms window for a usage range, with calendar
 * day boundaries computed in the effective `tz` so they stay aligned with the
 * backend's zone-aware usage buckets.
 */
export function resolveUsageRangeWindow(
  range: UsageRangeWindowId,
  tz: string,
  now: Date | number = Date.now(),
): {
  from: number;
  to: number;
} {
  const to = typeof now === "number" ? now : now.getTime();
  if (range === "all") {
    return { from: 0, to };
  }

  const dayOffset = RANGE_START_DAY_OFFSETS[range];
  const { fromDate } = resolveLastTimezoneCalendarDays(
    dayOffset + 1,
    tz,
    to,
  );
  return {
    from: timezoneDayStartEpoch(fromDate, tz),
    to,
  };
}

/**
 * Stable upper bound for usage/spend range queries.
 *
 * A raw `Date.now()` / `new Date().getTime()` used as the `to` bound of a React
 * Query key is recomputed on EVERY render, so the key changes every render and
 * React Query refetches in a tight loop. When that query polls a daemon
 * endpoint (e.g. `usage/totals`), the loop exhausts the per-client rate-limit
 * budget and every OTHER request starts returning 429 — breaking conversation
 * history, Activity sections, and action buttons app-wide.
 *
 * Rounding the upper bound up to the next whole hour keeps the key stable
 * across renders (and across the query's refetch interval) while still covering
 * "now". Spend figures are date-to-date approximations, so hour-granularity on
 * the end bound is immaterial.
 */
export function usageRangeNow(): number {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.getTime() + 60 * 60 * 1000;
}

export function resolveLastTimezoneCalendarDays(
  days: number,
  tz: string,
  now: Date | number = Date.now(),
): {
  fromDate: string;
  toDate: string;
} {
  const to = typeof now === "number" ? now : now.getTime();
  // Today's calendar date in `tz`, then step back whole days on a UTC-noon
  // anchor to avoid DST slips before resolving zone-local midnight.
  const toDate = toTimezoneDateString(new Date(to), tz);
  const [year, month, day] = toDate.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  anchor.setUTCDate(anchor.getUTCDate() - (days - 1));
  const fromDate = toTimezoneDateString(anchor, "UTC");
  return { fromDate, toDate };
}
