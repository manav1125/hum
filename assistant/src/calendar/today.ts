/**
 * Assemble today's day-rail payload: resolve the calendar connection, read the
 * bounded day window through the shared client, and hand the events to the
 * pure maths in `day-rail.ts`.
 *
 * ── Why "not connected" is a first-class state ─────────────────────────────
 * A day with no events and a day with no calendar produce the same empty
 * event list, and the design explicitly forbids the second one rendering as a
 * quiet day. So the payload never lets a client confuse them:
 *
 *  · `connection.state: "connected"`     — numbers are real.
 *  · `connection.state: "not_connected"` — no Google Calendar on this install.
 *  · `connection.state: "unavailable"`   — connected, but the read failed or
 *                                          overran its budget right now.
 *
 * In both non-connected states every derived number is `null`, not `0` and not
 * a full working window. A client that wants to print "5h unbooked" has to
 * handle the null, which is the point: it cannot accidentally claim a free day
 * it has no evidence for.
 */

import { resolveOAuthConnection } from "../oauth/connection-resolver.js";
import { getLogger } from "../util/logger.js";
import type {
  DayRailAllDayCommitment,
  DayRailBlock,
  DayRailCommitment,
} from "./day-rail.js";
import {
  buildDayRail,
  DEFAULT_WINDOW_END_MINUTE,
  DEFAULT_WINDOW_START_MINUTE,
  localDate,
  minuteOfDay,
  zonedWallClockToMs,
} from "./day-rail.js";
import type { CalendarEvent } from "./google-calendar-client.js";
import { CalendarApiError, listEvents } from "./google-calendar-client.js";

const log = getLogger("calendar:today");

/** The OAuth provider key Google Calendar rides on (shared with Gmail). */
const CALENDAR_PROVIDER = "google";

/**
 * Request-path budget for the live calendar read. The round-trip through the
 * Composio proxy measures ~1.3s in prod; 8s leaves generous headroom while
 * keeping the rail from hanging a surface render on a wedged upstream.
 */
export const CALENDAR_READ_TIMEOUT_MS = 8_000;

/**
 * Upper bound on events read for one day. A single day cannot plausibly
 * exceed this, so no pagination is needed — and the bounded `timeMin`/`timeMax`
 * window keeps `singleEvents: true` from expanding recurrences unboundedly.
 */
const MAX_EVENTS_PER_DAY = 250;

export type CalendarConnectionState =
  | "connected"
  | "not_connected"
  | "unavailable";

export interface DayRailPayload {
  /** Local calendar date the rail covers, `YYYY-MM-DD`. */
  date: string;
  /** IANA timezone every local time in this payload is expressed in. */
  timeZone: string;
  connection: {
    state: CalendarConnectionState;
    /** Human-readable reason for a non-connected state. Null when connected. */
    detail: string | null;
  };
  window: {
    start: string;
    end: string;
    startMinuteOfDay: number;
    endMinuteOfDay: number;
    minutes: number;
  };
  now: {
    iso: string;
    /** Minutes since local midnight on `date`. Null when `date` is not today. */
    minuteOfDay: number | null;
    isToday: boolean;
  };
  commitments: DayRailCommitment[];
  allDayCommitments: DayRailAllDayCommitment[];
  /** Null whenever `connection.state` is not `"connected"`. */
  bookedMinutes: number | null;
  unbookedMinutes: number | null;
  freeBlocks: DayRailBlock[];
  largestFreeBlock: DayRailBlock | null;
}

export interface DayRailRequest {
  date: string;
  timeZone: string;
  windowStartMinute?: number;
  windowEndMinute?: number;
  nowMs?: number;
  /** Test seam: inject the event fetch instead of touching the network. */
  fetchEvents?: (args: {
    timeMinIso: string;
    timeMaxIso: string;
  }) => Promise<CalendarEvent[]>;
}

/**
 * Error messages the connection layer raises when the provider simply is not
 * connected, as opposed to being connected and failing. These come from
 * `connection-resolver.ts` ("No active OAuth connection found for …", "needs
 * to be reconnected", "cannot be created: …") and `composio-oauth.ts`
 * ("Composio has no active \"googlecalendar\" connection for this user").
 */
const NOT_CONNECTED_PATTERNS: RegExp[] = [
  /no active oauth connection/i,
  /has no active ".*" connection/i,
  /needs to be connected/i,
  /needs to be reconnected/i,
  /connection for ".*" cannot be created/i,
  /no active oauth connection found for provider/i,
];

/**
 * Decide whether a thrown error means "there is no calendar here" or
 * "the calendar is there and something went wrong". Auth rejections from the
 * API itself (401/403) count as not-connected: the credential exists on paper
 * but cannot read the calendar, which is indistinguishable from unconnected
 * as far as the rail is concerned.
 */
export function classifyCalendarError(
  err: unknown,
): Exclude<CalendarConnectionState, "connected"> {
  if (err instanceof CalendarApiError) {
    return err.status === 401 || err.status === 403
      ? "not_connected"
      : "unavailable";
  }
  const message = err instanceof Error ? err.message : String(err);
  return NOT_CONNECTED_PATTERNS.some((re) => re.test(message))
    ? "not_connected"
    : "unavailable";
}

const DETAIL_BY_STATE: Record<
  Exclude<CalendarConnectionState, "connected">,
  string
> = {
  not_connected:
    "No Google Calendar is connected, so today's schedule is unknown — not empty.",
  unavailable:
    "Google Calendar is connected but could not be read just now, so today's schedule is unknown — not empty.",
};

async function fetchDayEvents(args: {
  timeMinIso: string;
  timeMaxIso: string;
}): Promise<CalendarEvent[]> {
  const connection = await resolveOAuthConnection(CALENDAR_PROVIDER);
  // `timeMin`/`timeMax` suppress `nextSyncToken`, which is irrelevant to a
  // plain read and essential here: they are what keeps `singleEvents: true`
  // from expanding every recurring event into unbounded future instances.
  const result = await listEvents(connection, "primary", {
    timeMin: args.timeMinIso,
    timeMax: args.timeMaxIso,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: MAX_EVENTS_PER_DAY,
    signal: AbortSignal.timeout(CALENDAR_READ_TIMEOUT_MS),
  });
  return result?.items ?? [];
}

/** Build the day rail for one local date. Never throws. */
export async function getDayRail(
  request: DayRailRequest,
): Promise<DayRailPayload> {
  const {
    date,
    timeZone,
    windowStartMinute = DEFAULT_WINDOW_START_MINUTE,
    windowEndMinute = DEFAULT_WINDOW_END_MINUTE,
    nowMs = Date.now(),
    fetchEvents = fetchDayEvents,
  } = request;

  const dayStartMs = zonedWallClockToMs(date, 0, timeZone);
  const dayEndMs = zonedWallClockToMs(date, 1440, timeZone);
  const windowStartMs = zonedWallClockToMs(date, windowStartMinute, timeZone);
  const windowEndMs = zonedWallClockToMs(
    date,
    Math.max(windowStartMinute, windowEndMinute),
    timeZone,
  );

  const isToday = localDate(nowMs, timeZone) === date;
  const base = {
    date,
    timeZone,
    window: {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(windowEndMs).toISOString(),
      startMinuteOfDay: windowStartMinute,
      endMinuteOfDay: Math.max(windowStartMinute, windowEndMinute),
      minutes: Math.round(Math.max(0, windowEndMs - windowStartMs) / 60_000),
    },
    now: {
      iso: new Date(nowMs).toISOString(),
      minuteOfDay: isToday ? minuteOfDay(nowMs, date, timeZone) : null,
      isToday,
    },
  };

  let events: CalendarEvent[];
  try {
    events = await fetchEvents({
      timeMinIso: new Date(dayStartMs).toISOString(),
      timeMaxIso: new Date(dayEndMs).toISOString(),
    });
  } catch (err) {
    const state = classifyCalendarError(err);
    log.info(
      { state, err: err instanceof Error ? err.message : String(err) },
      "day rail: no calendar answer",
    );
    return {
      ...base,
      connection: { state, detail: DETAIL_BY_STATE[state] },
      commitments: [],
      allDayCommitments: [],
      // Deliberately null, never 0 — see the module header.
      bookedMinutes: null,
      unbookedMinutes: null,
      freeBlocks: [],
      largestFreeBlock: null,
    };
  }

  const rail = buildDayRail({
    events,
    date,
    timeZone,
    windowStartMinute,
    windowEndMinute,
  });

  return {
    ...base,
    connection: { state: "connected", detail: null },
    ...rail,
  };
}
