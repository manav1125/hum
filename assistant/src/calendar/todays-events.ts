/**
 * "What is on the owner's calendar today", as a plain read.
 *
 * Extracted from `home/action-board.ts`. It never belonged there — it is a
 * calendar read with no opinion about the action board, and the Morning Brief
 * was importing it *through* the board purely because that is where it happened
 * to be written.
 *
 * That mattered: design has ruled the action board is deleted and folded into
 * Work, with one gate — "nothing should go silent in the handover". The brief's
 * only tie to the board was these two symbols, so moving them here is what
 * turns the deletion from risky into mechanical. The board can now be removed
 * without the 07:30 push losing its calendar.
 */

import type { OAuthConnection } from "../oauth/connection.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("todays-events");

const CALENDAR_BASE = "https://www.googleapis.com";

/**
 * Upper bound on a day's events. A calendar with more than this is not a day
 * anyone is going to read off a card, and the callers all summarise anyway.
 */
const MAX_EVENTS = 12;

export interface EventSummary {
  summary: string;
  start: string;
  end: string;
  attendees: number;
  location: string;
}

/**
 * Today's events on the primary calendar, midnight to midnight in local time.
 *
 * Returns `[]` on any non-2xx rather than throwing — every caller renders this
 * into a summary line, and a calendar outage should cost the owner their event
 * list, not their whole brief. The warn line is what keeps that from being a
 * silent empty: an empty array from a 403 and an empty array from a free day
 * are indistinguishable to the caller, so the log is the only place the
 * difference survives.
 */
export async function fetchTodaysEvents(
  conn: OAuthConnection,
  now: Date,
  signal?: AbortSignal,
): Promise<EventSummary[]> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const res = await conn.request({
    method: "GET",
    baseUrl: CALENDAR_BASE,
    path: "/calendar/v3/calendars/primary/events",
    query: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(MAX_EVENTS),
    },
    signal,
  });
  if (res.status >= 400) {
    log.warn({ status: res.status }, "Calendar list failed");
    return [];
  }
  const items =
    (
      res.body as {
        items?: Array<{
          summary?: string;
          location?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          attendees?: unknown[];
        }>;
      }
    ).items ?? [];
  return items.map((e) => ({
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
    location: e.location ?? "",
  }));
}
