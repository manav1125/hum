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
let pages: Array<{ nextPageToken?: string; nextSyncToken?: string }> = [];
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
