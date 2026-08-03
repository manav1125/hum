/**
 * Google Calendar watcher provider — uses incremental sync for efficient change detection.
 *
 * On first poll, performs a full sync to capture the current syncToken as the watermark.
 * Subsequent polls use the syncToken with events.list to detect new/updated events.
 * Falls back to listing recent upcoming events if the syncToken has expired (410 Gone).
 */

import {
  detectCalendarDecisions,
  resolvedDecisionKeys,
} from "../../calendar/calendar-decisions.js";
import type { CalendarEvent } from "../../calendar/google-calendar-client.js";
import {
  CalendarApiError,
  GOOGLE_CALENDAR_BASE_URL,
  listEvents,
} from "../../calendar/google-calendar-client.js";
import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { wrapUntrustedContent } from "../../security/untrusted-content.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherDecisionSet,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";
import type { WatcherEvent } from "../watcher-store.js";

const log = getLogger("watcher:google-calendar");

/** The credential service — calendar shares OAuth tokens with Gmail. */
const CREDENTIAL_SERVICE = "google";

function eventToItem(event: CalendarEvent, eventType: string): WatcherItem {
  const start = event.start?.dateTime ?? event.start?.date ?? "";
  const end = event.end?.dateTime ?? event.end?.date ?? "";

  // Include updated timestamp in the dedup key so subsequent edits to the
  // same event aren't silently dropped by the watcher_id + external_id constraint.
  const version = event.updated ?? "";
  return {
    externalId: version ? `${event.id}@${version}` : event.id,
    eventType,
    summary: `Calendar event: ${event.summary ?? "(no title)"} — ${start}`,
    payload: {
      id: event.id,
      summary: event.summary ?? "",
      start,
      end,
      location: event.location ?? "",
      description: event.description
        ? wrapUntrustedContent(event.description, {
            source: "calendar",
            maxChars: 5000,
          })
        : "",
      status: event.status ?? "confirmed",
      organizer: event.organizer?.email ?? "",
      attendees:
        event.attendees?.map((a) => ({
          email: a.email,
          responseStatus: a.responseStatus,
        })) ?? [],
      htmlLink: event.htmlLink ?? "",
    },
    timestamp: event.updated ? new Date(event.updated).getTime() : null,
  };
}

interface SyncResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * How long after an event has ended a change to it is still worth recording.
 *
 * A day, so "the 9am you just came out of moved" still registers, and the
 * watcher is not sensitive to clock skew or to a poll that ran late.
 */
const PAST_EVENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** End of an event in epoch ms, or null when it cannot be read. */
function eventEndMs(event: CalendarEvent): number | null {
  const raw =
    event.end?.dateTime ??
    event.end?.date ??
    event.start?.dateTime ??
    event.start?.date;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * True when this event is finished and a change to it cannot matter.
 *
 * ── Why this bound exists ──────────────────────────────────────────────────
 * Google's sync feed is keyed on the event RESOURCE, not on when the event
 * happens. One present-day edit to a long-running recurring series rewrites
 * `updated` on the series master AND on every stored exception in it, back to
 * the first instance anybody ever moved. On this install a single write at
 * 02:10:31.928Z touched 70 resources belonging to one weekly sync that has run
 * since 2020, and the incremental sync — correctly — reported all 70 as
 * changed. Each one carries its own start date, so the feed reads as six years
 * of history replaying even though nothing historical happened.
 *
 * There is no request-side fix: sync tokens cannot be filtered (`timeMin`
 * suppresses the token entirely), so the bound has to be applied to what comes
 * back. Bounding on the event's OWN time rather than on the change time is what
 * makes it correct in general — a change to a meeting that finished in 2020 is
 * not a schedule change the owner can act on, whatever caused it.
 *
 * A series master is exempt: its dates describe the first occurrence, not the
 * series, so judging it by them would drop precisely the useful signal ("the
 * weekly sync moved"). An event whose time cannot be read is kept — this
 * filter must never be the reason a real change goes unseen.
 */
function isOverAndDone(event: CalendarEvent, now: number): boolean {
  if (event.recurrence && event.recurrence.length > 0) return false;
  const end = eventEndMs(event);
  if (end === null) return false;
  return end < now - PAST_EVENT_GRACE_MS;
}

/**
 * Perform an incremental sync using the stored syncToken.
 * Follows pagination (nextPageToken) until the final page returns nextSyncToken.
 * Returns all accumulated events and the final nextSyncToken.
 */
async function incrementalSync(
  connection: OAuthConnection,
  syncToken: string,
): Promise<SyncResponse> {
  let allItems: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const query: Record<string, string> = { syncToken };
    if (pageToken) query.pageToken = pageToken;

    const resp = await connection.request({
      method: "GET",
      path: "/calendars/primary/events",
      query,
      baseUrl: GOOGLE_CALENDAR_BASE_URL,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const bodyStr =
        typeof resp.body === "string"
          ? resp.body
          : JSON.stringify(resp.body ?? "");
      if (resp.status === 410) {
        throw new SyncTokenExpiredError(bodyStr);
      }
      throw new CalendarApiError(
        resp.status,
        "",
        `Calendar Sync API ${resp.status}: ${bodyStr}`,
      );
    }

    const page = resp.body as SyncResponse;
    if (page.items) allItems = allItems.concat(page.items);
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  return { items: allItems, nextSyncToken };
}

class SyncTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncTokenExpiredError";
  }
}

/**
 * Page size and hard page cap for the one-time full sync that establishes a
 * sync token. Measured against a real account: 20 pages at 2500, ~103s. The cap
 * is well above that so a genuinely enormous calendar still completes, and it
 * exists only so a pagination bug cannot spin forever — the watcher job's own
 * timeout is 15 minutes, which this fits inside comfortably.
 */
const BOOTSTRAP_PAGE_SIZE = 2500;
const BOOTSTRAP_MAX_PAGES = 60;

/**
 * Walk a full event list to its last page and return the `nextSyncToken`.
 *
 * The query shape here is load-bearing and counter-intuitive. Google suppresses
 * `nextSyncToken` entirely when a request carries `timeMin` (or `timeMax`, `q`,
 * `updatedMin`, `orderBy`) — a filtered view cannot seed an incremental sync, so
 * no token is issued. The previous implementation passed `timeMin: now` to keep
 * the sync narrow, which meant the token could never arrive: it paginated until
 * it ran out and then threw "Calendar API did not return a syncToken" on every
 * poll, forever. Verified on the live API — with `timeMin` the token never
 * appears; without it, page 20 carries one.
 *
 * `singleEvents` is left off for the same reason of scale: expanding recurring
 * events into individual instances made the walk effectively unbounded, since a
 * single daily recurrence generates future instances without end. Expansion is
 * a reading concern, not a sync concern.
 */
async function fullSyncToken(
  connection: Awaited<ReturnType<typeof resolveOAuthConnection>>,
): Promise<string> {
  let pageToken: string | undefined;
  for (let page = 0; page < BOOTSTRAP_MAX_PAGES; page++) {
    const result = await listEvents(connection, "primary", {
      maxResults: BOOTSTRAP_PAGE_SIZE,
      singleEvents: false,
      pageToken,
    });
    if (result.nextSyncToken) return result.nextSyncToken;
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  throw new Error(
    `Calendar API did not return a syncToken within ${BOOTSTRAP_MAX_PAGES} pages`,
  );
}

/**
 * How far ahead the decision detector looks.
 *
 * Generous on purpose. A conflict is only ever noticed while one of the two
 * events is arriving, and an event that arrives once never arrives again — so
 * anything beyond this horizon is not "checked later", it is missed. Ninety
 * days covers the bookings people actually collide on (travel, dinners,
 * quarterly reviews) at a bounded cost, and the miss beyond it is a real
 * limitation rather than a rounding error: a flight booked eight months out
 * will not be matched against the dinner it lands on.
 */
const DECISION_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

/** Page size and hard page cap for the horizon read. */
const DECISION_PAGE_SIZE = 250;
const DECISION_MAX_PAGES = 4;

/**
 * Every concrete instance on the primary calendar between now and the horizon.
 *
 * `singleEvents: true` is required — a conflict is between OCCURRENCES, and an
 * unexpanded series master carries the date of its first occurrence, which for
 * a weekly meeting running since 2020 is six years ago. The `timeMin`/`timeMax`
 * pair suppresses `nextSyncToken`, which is exactly right here and exactly
 * wrong in `fullSyncToken` above; see the header of the calendar client.
 */
async function fetchHorizon(
  connection: OAuthConnection,
  now: number,
): Promise<{ events: CalendarEvent[]; complete: boolean }> {
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + DECISION_HORIZON_MS).toISOString();
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < DECISION_MAX_PAGES; page++) {
    const result = await listEvents(connection, "primary", {
      timeMin,
      timeMax,
      maxResults: DECISION_PAGE_SIZE,
      singleEvents: true,
      orderBy: "startTime",
      ...(pageToken ? { pageToken } : {}),
    });
    if (result?.items) events.push(...result.items);
    pageToken = result?.nextPageToken;
    if (!pageToken) break;
  }

  // A page token still in hand after the last permitted page means the window
  // is only partly read. Detection tolerates that — it can only ever miss a
  // conflict. Retirement cannot: "absent from the calendar" and "past the page
  // limit" look identical, so the flag is carried out rather than dropped.
  return { events, complete: pageToken === undefined };
}

/** The Google event id inside a recorded watcher payload, when it is readable. */
function payloadEventId(event: WatcherEvent): string | null {
  try {
    const parsed: unknown = JSON.parse(event.payloadJson);
    if (!parsed || typeof parsed !== "object") return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export const googleCalendarProvider: WatcherProvider = {
  id: "google-calendar",
  displayName: "Google Calendar",
  requiredCredentialService: CREDENTIAL_SERVICE,

  // A meeting is something you attend, not something in your queue. The day
  // rail (`calendar/day-rail.ts`, GET /v1/calendar/day) is how the calendar
  // reaches the owner, and it reads the Calendar API directly — so a work item
  // per event is a second, worse copy of a surface that already exists. The
  // change stream is still recorded in `watcher_events`; it just does not
  // become work.
  pinnedIntakeMode: "record_only",

  async getInitialWatermark(credentialService: string): Promise<string> {
    const connection = await resolveOAuthConnection(credentialService);
    return fullSyncToken(connection);
  },

  // The exception to the pin above: a calendar arrival becomes work when — and
  // only when — it creates a decision. The rules live in
  // `calendar/calendar-decisions.ts`; this method's whole job is to hand them
  // the two things they need and cannot compute: which events changed, and
  // what else is on the calendar. The other half of a conflict did not change,
  // so it is not in the sync feed and has to be read.
  async decisionsFrom(
    credentialService: string,
    events: readonly WatcherEvent[],
    openKeys: readonly string[],
  ): Promise<WatcherDecisionSet> {
    const changedIds = events
      .map(payloadEventId)
      .filter((id): id is string => id !== null);
    if (changedIds.length === 0 && openKeys.length === 0) {
      return { decisions: [], resolved: [] };
    }

    const now = Date.now();
    const connection = await resolveOAuthConnection(credentialService);
    const horizon = await fetchHorizon(connection, now);
    const decisions = detectCalendarDecisions({
      changedIds,
      horizon: horizon.events,
      now,
    });
    const resolved = resolvedDecisionKeys({
      openKeys,
      horizon: horizon.events,
      horizonComplete: horizon.complete,
      now,
    });

    if (decisions.length > 0 || resolved.length > 0) {
      log.info(
        {
          count: decisions.length,
          resolved: resolved.length,
          changed: changedIds.length,
        },
        "Calendar: changes created decisions",
      );
    }
    return {
      decisions: decisions.map((d) => ({
        externalId: d.externalId,
        title: d.title,
        snippet: d.snippet,
        reason: d.reason,
        ruleId: d.ruleId,
        kind: d.kind,
      })),
      resolved,
    };
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const connection = await resolveOAuthConnection(credentialService);

    if (!watermark) {
      // No watermark yet — establish one and report nothing this round. The
      // token marks "from here", so the first poll after it deliberately
      // returns no items rather than back-filling the calendar's history.
      return { items: [], watermark: await fullSyncToken(connection) };
    }

    try {
      const syncResp = await incrementalSync(connection, watermark);
      const newWatermark = syncResp.nextSyncToken ?? watermark;

      if (!syncResp.items || syncResp.items.length === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Convert events to watcher items, distinguishing new vs updated
      const now = Date.now();
      const items: WatcherItem[] = [];
      let finished = 0;
      for (const event of syncResp.items) {
        if (event.status === "cancelled") continue;
        if (isOverAndDone(event, now)) {
          finished++;
          continue;
        }

        const eventType =
          event.created === event.updated
            ? "new_calendar_event"
            : "updated_calendar_event";
        items.push(eventToItem(event, eventType));
      }

      log.info(
        { count: items.length, finished, watermark: newWatermark },
        "Calendar: fetched event changes",
      );
      return { items, watermark: newWatermark };
    } catch (err) {
      if (err instanceof SyncTokenExpiredError) {
        log.warn("Calendar syncToken expired, falling back to recent events");
        return fallbackFetch(connection);
      }
      throw err;
    }
  },
};

/**
 * Fallback when syncToken expires: list upcoming events from today.
 */
async function fallbackFetch(
  connection: OAuthConnection,
): Promise<FetchResult> {
  const now = new Date().toISOString();
  const result = await listEvents(connection, "primary", {
    timeMin: now,
    maxResults: 25,
    singleEvents: true,
    orderBy: "startTime",
  });

  const items = (result.items ?? []).map((event) =>
    eventToItem(event, "new_calendar_event"),
  );

  // Paginate through to get a fresh syncToken for the next watermark
  let pageToken: string | undefined;
  let syncToken: string | undefined;

  do {
    const syncResult = await listEvents(connection, "primary", {
      timeMin: now,
      maxResults: 250,
      singleEvents: true,
      pageToken,
    });
    syncToken = syncResult.nextSyncToken;
    pageToken = syncResult.nextPageToken;
  } while (pageToken && !syncToken);

  return { items, watermark: syncToken ?? "" };
}
