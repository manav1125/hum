/**
 * Tests for the Google Calendar sync-token bootstrap.
 *
 * The bug these pin: the bootstrap passed `timeMin: now`, and Google suppresses
 * `nextSyncToken` entirely for any request carrying `timeMin` — a filtered view
 * cannot seed an incremental sync, so no token is ever issued. The watcher
 * therefore failed on every single poll with "Calendar API did not return a
 * syncToken" and never captured a watermark, which meant it could never detect
 * a change. Verified against the live API: with `timeMin` the token never
 * arrives; without it, page 20 carries one.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

/** Pages the fake Calendar API will serve, in order. */
let pages: Array<{
  items?: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
}> = [];
/** Every query the provider sent, so the tests can assert the shape. */
let queries: Array<Record<string, string>> = [];

const request = mock(async (req: { query?: Record<string, string> }) => {
  queries.push(req.query ?? {});
  const page = pages.shift() ?? {};
  return {
    status: 200,
    headers: {},
    // listEvents returns `resp.body` as-is — an object, not a JSON string.
    body: { items: [], ...page },
  };
});

mock.module("../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mock(async () => ({ id: "conn", request })),
}));

const { googleCalendarProvider } =
  await import("../providers/google-calendar.js");

afterEach(() => {
  pages = [];
  queries = [];
  request.mockClear();
});

describe("calendar sync-token bootstrap", () => {
  test("never sends timeMin — it suppresses the token Google must return", async () => {
    pages = [{ nextSyncToken: "sync-1" }];
    await googleCalendarProvider.getInitialWatermark("google");
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q.timeMin).toBeUndefined();
  });

  test("does not expand recurring events during the walk", async () => {
    // singleEvents:true turns one daily recurrence into unbounded future
    // instances, which made the walk never reach a last page. Expansion is a
    // reading concern, not a sync concern.
    pages = [{ nextSyncToken: "sync-1" }];
    await googleCalendarProvider.getInitialWatermark("google");
    expect(queries[0]!.singleEvents).toBe("false");
  });

  test("follows pagination until a page carries the token", async () => {
    pages = [
      { nextPageToken: "p1" },
      { nextPageToken: "p2" },
      { nextSyncToken: "sync-final" },
    ];
    const token = await googleCalendarProvider.getInitialWatermark("google");
    expect(token).toBe("sync-final");
    expect(queries).toHaveLength(3);
    expect(queries[2]!.pageToken).toBe("p2");
  });

  test("gives up with a clear error rather than paginating forever", async () => {
    // A pagination bug upstream must not spin until the job timeout.
    pages = Array.from({ length: 200 }, () => ({ nextPageToken: "more" }));
    await expect(
      googleCalendarProvider.getInitialWatermark("google"),
    ).rejects.toThrow(/within \d+ pages/);
  });

  test("a first fetch with no watermark establishes one and reports nothing", async () => {
    // The token means "from here" — back-filling the whole calendar as if it
    // just arrived would bury the user on day one.
    pages = [{ nextSyncToken: "sync-1" }];
    const r = await googleCalendarProvider.fetchNew("google", null, {}, "k");
    expect(r.watermark).toBe("sync-1");
    expect(r.items).toHaveLength(0);
  });
});

// ── The historical-instance flood ─────────────────────────────────────────
//
// What actually happened on the owner's instance: one edit to a weekly series
// at 02:10:31.928Z rewrote `updated` on 70 stored exception instances of that
// series, the oldest from 2020. The sync feed reported all 70 as changed —
// correctly, they are changed resources — and the provider turned each into an
// item titled with its own six-year-old start date. These pin the bound that
// stops that, and the two things it must not break.

/** An event as the sync API returns it, with everything the provider reads. */
function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt",
    status: "confirmed",
    summary: "GBA-HK: G&M Sync",
    start: { dateTime: "2020-05-04T09:00:00+08:00" },
    end: { dateTime: "2020-05-04T09:30:00+08:00" },
    created: "2020-04-01T00:00:00.000Z",
    updated: "2026-08-02T02:10:31.928Z",
    ...over,
  };
}

/** One incremental poll returning `items`. */
async function poll(items: unknown[]) {
  pages = [{ items, nextSyncToken: "sync-next" }];
  return googleCalendarProvider.fetchNew("google", "sync-prev", {}, "k");
}

describe("calendar change horizon", () => {
  test("a recurring instance from 2020 is not reported as new work", async () => {
    // The exact shape of the 111: Google's instance id, a start six years ago,
    // and an `updated` from minutes before the poll.
    const r = await poll([
      event({ id: "4vm32g7jqnu2jh6o5tpf9mha3f_20200622T010000Z" }),
    ]);
    expect(r.items).toHaveLength(0);
    // The watermark still advances — dropping the item must not strand the
    // sync, or the same batch arrives again on every poll forever.
    expect(r.watermark).toBe("sync-next");
  });

  test("70 instances of one series produce nothing", async () => {
    const r = await poll(
      Array.from({ length: 70 }, (_, i) =>
        event({
          id: `4vm32g7jqnu2jh6o5tpf9mha3f_2020${String(i).padStart(4, "0")}`,
        }),
      ),
    );
    expect(r.items).toHaveLength(0);
  });

  test("the master of a series that started in 2020 is still reported", async () => {
    // A master's start is the FIRST occurrence, not the next one: judging the
    // series by it would silently drop "the weekly sync moved", which is the
    // one calendar change actually worth having.
    const r = await poll([
      event({
        id: "4vm32g7jqnu2jh6o5tpf9mha3f",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      }),
    ]);
    expect(r.items).toHaveLength(1);
  });

  test("an upcoming meeting is reported as a change", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const r = await poll([
      event({
        id: "next-week",
        start: { dateTime: soon },
        end: { dateTime: soon },
      }),
    ]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.eventType).toBe("updated_calendar_event");
  });

  test("this morning's meeting is still inside the window", async () => {
    // Grace, so "the 9am you just came out of moved" survives, and so a poll
    // that runs late is not silently lossy.
    const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const r = await poll([
      event({
        id: "this-morning",
        start: { dateTime: earlier },
        end: { dateTime: earlier },
      }),
    ]);
    expect(r.items).toHaveLength(1);
  });

  test("an event whose time cannot be read is kept", async () => {
    // The filter must never be the reason a real change goes unseen.
    const r = await poll([
      event({ id: "no-times", start: undefined, end: undefined }),
    ]);
    expect(r.items).toHaveLength(1);
  });

  test("an all-day event from 2021 is dropped too", async () => {
    const r = await poll([
      event({
        id: "allday",
        start: { date: "2021-02-16" },
        end: { date: "2021-02-17" },
      }),
    ]);
    expect(r.items).toHaveLength(0);
  });
});

describe("what a calendar watcher is for", () => {
  test("the provider pins record-only intake", () => {
    // A meeting is something you attend, not something in your queue. The pin
    // is what makes that true for watcher rows that already exist.
    expect(googleCalendarProvider.pinnedIntakeMode).toBe("record_only");
  });
});
