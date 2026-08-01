/**
 * Day-rail route — what is on the user's calendar today.
 *
 * `GET /v1/calendar/day` is the only thing the K1 day rail needs: the strip's
 * working window, the timed commitments sitting on it, a now-marker, the total
 * unbooked minutes, and the largest contiguous free block (the one the "use it
 * on X?" offer is made against).
 *
 * Read-only and side-effect-free: it resolves the existing Google Calendar
 * connection, issues one bounded `events.list`, and does arithmetic. Nothing is
 * written, queued or cached.
 *
 * The response distinguishes "nothing today" from "no calendar" — see
 * `calendar/today.ts` for why every derived number goes null rather than zero
 * when there is no connection.
 */

import { z } from "zod";

import {
  DEFAULT_WINDOW_END_MINUTE,
  DEFAULT_WINDOW_START_MINUTE,
  localDate,
} from "../../calendar/day-rail.js";
import { type DayRailPayload, getDayRail } from "../../calendar/today.js";
import { getConfig } from "../../config/loader.js";
import { canonicalizeTimeZone } from "../../daemon/date-context.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PATTERN = /^(\d{1,2}):([0-5]\d)$/;

/**
 * The timezone the rail's local times are expressed in: an explicit `tz`
 * query param, else the user's configured/detected timezone, else the
 * daemon host's. A client that knows its own zone should always send it —
 * the daemon may run in a different one entirely (prod is UTC).
 */
export function resolveRailTimeZone(tz: string | undefined): string {
  if (tz != null && tz.trim().length > 0) {
    const canonical = canonicalizeTimeZone(tz);
    if (!canonical) {
      throw new BadRequestError(
        `Invalid "tz" value: "${tz}". Must be an IANA timezone identifier.`,
      );
    }
    return canonical;
  }
  try {
    const ui = getConfig().ui;
    const configured =
      canonicalizeTimeZone(ui?.userTimezone) ??
      canonicalizeTimeZone(ui?.detectedTimezone);
    if (configured) return configured;
  } catch {
    // Config unreadable (early boot, test harness) — fall through to host tz.
  }
  return (
    canonicalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
    "UTC"
  );
}

/** `HH:MM` → minutes from midnight. */
export function parseClockMinute(
  raw: string | undefined,
  fallback: number,
  paramName: string,
): number {
  if (raw == null || raw.trim().length === 0) return fallback;
  const match = CLOCK_PATTERN.exec(raw.trim());
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!match || hours > 24 || (hours === 24 && minutes > 0)) {
    throw new BadRequestError(
      `Invalid "${paramName}" value: "${raw}". Must be a 24-hour clock time such as "09:00".`,
    );
  }
  return hours * 60 + minutes;
}

export function resolveRailDate(
  raw: string | undefined,
  timeZone: string,
  nowMs: number,
): string {
  if (raw == null || raw.trim().length === 0) return localDate(nowMs, timeZone);
  const value = raw.trim();
  if (
    !DATE_PATTERN.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00Z`))
  ) {
    throw new BadRequestError(
      `Invalid "date" value: "${raw}". Must be a calendar date in YYYY-MM-DD form.`,
    );
  }
  return value;
}

export async function handleCalendarDay({
  queryParams,
}: RouteHandlerArgs): Promise<DayRailPayload> {
  const qp = queryParams ?? {};
  const nowMs = Date.now();
  const timeZone = resolveRailTimeZone(qp.tz);
  const date = resolveRailDate(qp.date, timeZone, nowMs);
  const windowStartMinute = parseClockMinute(
    qp.windowStart,
    DEFAULT_WINDOW_START_MINUTE,
    "windowStart",
  );
  const windowEndMinute = parseClockMinute(
    qp.windowEnd,
    DEFAULT_WINDOW_END_MINUTE,
    "windowEnd",
  );
  if (windowEndMinute <= windowStartMinute) {
    throw new BadRequestError(
      `"windowEnd" must be later than "windowStart" (got ${qp.windowStart ?? "09:00"} → ${qp.windowEnd ?? "18:00"}).`,
    );
  }

  return getDayRail({
    date,
    timeZone,
    windowStartMinute,
    windowEndMinute,
    nowMs,
  });
}

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const blockSchema = z.object({
  start: z.string(),
  end: z.string(),
  startMinuteOfDay: z.number(),
  endMinuteOfDay: z.number(),
  minutes: z.number(),
});

const commitmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  startMinuteOfDay: z.number(),
  endMinuteOfDay: z.number(),
  minutes: z.number(),
  isOrganizer: z.boolean().nullable(),
  responseStatus: z
    .enum(["needsAction", "declined", "tentative", "accepted"])
    .nullable(),
  busy: z.boolean(),
});

const calendarDayResponseSchema = z.object({
  date: z.string(),
  timeZone: z.string(),
  connection: z.object({
    state: z.enum(["connected", "not_connected", "unavailable"]),
    detail: z.string().nullable(),
  }),
  window: z.object({
    start: z.string(),
    end: z.string(),
    startMinuteOfDay: z.number(),
    endMinuteOfDay: z.number(),
    minutes: z.number(),
  }),
  now: z.object({
    iso: z.string(),
    minuteOfDay: z.number().nullable(),
    isToday: z.boolean(),
  }),
  commitments: z.array(commitmentSchema),
  allDayCommitments: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      isOrganizer: z.boolean().nullable(),
    }),
  ),
  bookedMinutes: z.number().nullable(),
  unbookedMinutes: z.number().nullable(),
  freeBlocks: z.array(blockSchema),
  largestFreeBlock: blockSchema.nullable(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getCalendarDay",
    endpoint: "calendar/day",
    method: "GET",
    // Mirror `getMorningBrief` / `get_next_move`: a read scope, actor principals.
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get today's calendar picture for the day rail",
    description:
      "One local day of the primary Google Calendar, reduced to what the day " +
      "rail draws: timed commitments with their placement on the hour strip, " +
      "all-day entries kept separate (they never occupy the working window), " +
      "a now-marker, total unbooked minutes inside the working window, every " +
      "free gap, and the largest contiguous free block. Read-only. " +
      "`connection.state` distinguishes a genuinely quiet day " +
      "(`connected`, empty commitments, real numbers) from having no calendar " +
      "at all (`not_connected`) or a calendar that could not be read right now " +
      "(`unavailable`) — in both of the latter, every derived number is null " +
      "rather than zero, so an empty rail can never be mistaken for a free day.",
    tags: ["activity"],
    queryParams: [
      {
        name: "date",
        type: "string",
        required: false,
        description:
          "Local calendar date to read, YYYY-MM-DD. Defaults to today in `tz`.",
      },
      {
        name: "tz",
        type: "string",
        required: false,
        description:
          "IANA timezone the day and all local times are expressed in. " +
          "Defaults to ui.userTimezone, then ui.detectedTimezone, then the daemon host's zone.",
      },
      {
        name: "windowStart",
        type: "string",
        required: false,
        description:
          'Start of the working window as a 24-hour clock time (default "09:00").',
      },
      {
        name: "windowEnd",
        type: "string",
        required: false,
        description:
          'End of the working window as a 24-hour clock time (default "18:00"). Must be later than windowStart.',
      },
    ],
    responseBody: calendarDayResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "Invalid date, timezone, or working window (windowEnd not later than windowStart).",
      },
    },
    handler: handleCalendarDay,
  },
];
