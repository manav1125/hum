/**
 * The one Google Calendar HTTP client.
 *
 * Every caller reaches the API through {@link listEvents}, which goes over an
 * `OAuthConnection` — on this install that resolves to the Composio-backed
 * connection (`resolveOAuthConnection("google")`), so the same helper works
 * whether the credential is Composio-proxied, platform-managed or BYO.
 *
 * ── The `nextSyncToken` / `timeMin` trap ───────────────────────────────────
 * Google suppresses `nextSyncToken` on any request that carries `timeMin`,
 * `timeMax`, `q`, `updatedMin` or `orderBy`: a filtered view cannot seed an
 * incremental sync, so no token is issued. That matters enormously to the
 * watcher (which is syncing) and not at all to a plain bounded read (which is
 * not). The two use cases therefore pass opposite options and both are right:
 *
 *  · Syncing — no `timeMin`/`timeMax`, `singleEvents: false`, walk to the last
 *    page for the token. See `watcher/providers/google-calendar.ts`.
 *  · Reading a day — `timeMin`/`timeMax` bounding the window plus
 *    `singleEvents: true` so recurring events are expanded into the concrete
 *    instances that actually land on that day. Without the bounds,
 *    `singleEvents: true` expands a daily recurrence into effectively
 *    unbounded future instances.
 */

import type { OAuthConnection } from "../oauth/connection.js";

export const GOOGLE_CALENDAR_BASE_URL =
  "https://www.googleapis.com/calendar/v3";

/** Event time — a `dateTime` for timed events, a `date` for all-day events. */
export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** Calendar event attendee. */
export interface EventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
}

/** Calendar event organizer. */
export interface EventOrganizer {
  email?: string;
  displayName?: string;
  self?: boolean;
}

/** A single Google Calendar event. */
export interface CalendarEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  attendees?: EventAttendee[];
  organizer?: EventOrganizer;
  transparency?: "opaque" | "transparent";
  htmlLink?: string;
  created?: string;
  updated?: string;
}

/** Events list response. */
export interface CalendarEventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export class CalendarApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

export interface ListEventsOptions {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  query?: string;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
  pageToken?: string;
  syncToken?: string;
  signal?: AbortSignal;
}

/** List events from a calendar. */
export async function listEvents(
  connection: OAuthConnection,
  calendarId = "primary",
  options?: ListEventsOptions,
): Promise<CalendarEventsListResponse> {
  const query: Record<string, string> = {};

  if (options?.timeMin) query.timeMin = options.timeMin;
  if (options?.timeMax) query.timeMax = options.timeMax;
  query.maxResults = String(options?.maxResults ?? 25);
  if (options?.query) query.q = options.query;

  // Default to expanding recurring events into instances
  const singleEvents = options?.singleEvents ?? true;
  query.singleEvents = String(singleEvents);

  if (singleEvents && options?.orderBy) {
    query.orderBy = options.orderBy;
  } else if (singleEvents) {
    query.orderBy = "startTime";
  }

  if (options?.pageToken) query.pageToken = options.pageToken;
  if (options?.syncToken) query.syncToken = options.syncToken;

  const resp = await connection.request({
    method: "GET",
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    query,
    baseUrl: GOOGLE_CALENDAR_BASE_URL,
    headers: {
      "Content-Type": "application/json",
    },
    signal: options?.signal,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const bodyStr =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new CalendarApiError(
      resp.status,
      "",
      `Calendar API ${resp.status}: ${bodyStr}`,
    );
  }

  if (resp.status === 204 || resp.body === undefined) {
    return undefined as unknown as CalendarEventsListResponse;
  }
  return resp.body as CalendarEventsListResponse;
}
