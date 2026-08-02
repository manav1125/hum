/**
 * A calendar CONFLICT is work — and almost nothing else on a calendar is.
 *
 * The sibling file `calendar-record-only.test.ts` pins the default: a calendar
 * poll puts nothing in the owner's queue. This file pins the one exception on
 * top of it, and it is written to be adversarial about the exception rather
 * than about the default — a narrow allowlist is only worth having if the
 * "narrow" part is load-bearing, so most of the tests below assert that
 * something did NOT mint.
 *
 * It drives the REAL path: `runWatchersOnce` over a real watcher row, the real
 * provider, the real engine branch, the real intake, a real database. The only
 * things mocked are what would leave the process — the OAuth-backed HTTP call
 * and the LLM sidechains. In particular the decision rules themselves are not
 * mocked or re-implemented here; asserting against an extracted copy would pass
 * happily while production minted 111 rows.
 *
 * The fake Calendar API answers two different questions, which is the shape the
 * provider really makes:
 *   · a request carrying `syncToken`  → the incremental change feed
 *   · a request carrying `timeMin`    → the forward horizon (`singleEvents`)
 * The horizon fake deliberately IGNORES `timeMin` and hands back whatever the
 * test set, including events in the past. That makes the past-event assertions
 * claims about Cue's own bound rather than about Google's query filter.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/** Events the incremental sync reports as changed. */
let changedItems: unknown[] = [];
/** Everything "on the calendar" for the forward horizon read. */
let horizonItems: unknown[] = [];
/** How many horizon reads the provider made. */
let horizonReads = 0;
/** When set, the horizon read fails the way a real API outage would. */
let horizonFails = false;

mock.module("../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => ({
    id: "conn",
    request: async (req: { query?: Record<string, string> }) => {
      // The incremental change feed.
      if (req.query?.syncToken) {
        return {
          status: 200,
          headers: {},
          body: { items: changedItems, nextSyncToken: "sync-next" },
        };
      }
      // The forward horizon. `timeMin` is what tells the two reads apart in
      // production too — it is the option that suppresses `nextSyncToken`.
      if (req.query?.timeMin) {
        horizonReads++;
        if (horizonFails) return { status: 503, headers: {}, body: "upstream" };
        return { status: 200, headers: {}, body: { items: horizonItems } };
      }
      // The one-time bootstrap walk that establishes a sync token.
      return {
        status: 200,
        headers: {},
        body: { items: [], nextSyncToken: "sync-0" },
      };
    },
  }),
}));

mock.module("../../credential-health/credential-health-service.js", () => ({
  hasPollableCredential: () => true,
  checkCredentialForProvider: async () => null,
}));

const realTriage = await import("../../work-items/work-item-triage.js");
mock.module("../../work-items/work-item-triage.js", () => ({
  ...realTriage,
  triageAndMaybeAutoRunWorkItem: async () => ({
    autoRunStarted: false,
    reason: "skipped",
  }),
}));

const realJobs = await import("../../runtime/background-job-runner.js");
mock.module("../../runtime/background-job-runner.js", () => ({
  ...realJobs,
  runBackgroundJob: async () => ({ conversationId: "conv", ok: true }),
}));

// ── Real modules, imported after the mocks are in place ───────────────

const { getDb } = await import("../../memory/db-connection.js");
const { initializeDb } = await import("../../memory/db-init.js");
const { listWorkItems } = await import("../../work-items/work-item-store.js");
const { registerWatcherProvider } = await import("../provider-registry.js");
const { googleCalendarProvider } =
  await import("../providers/google-calendar.js");
const { createWatcher, listWatcherEvents } =
  await import("../watcher-store.js");
const { runWatchersOnce } = await import("../engine.js");
const { CALENDAR_CHANNELS } = await import("../calendar-work-item-cleanup.js");

afterAll(() => {
  mock.module("../../work-items/work-item-triage.js", () => realTriage);
  mock.module("../../runtime/background-job-runner.js", () => realJobs);
});

initializeDb();
registerWatcherProvider(googleCalendarProvider);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * An ISO instant with an explicit offset, because the decision snippet quotes
 * the wall clock straight out of the string rather than converting it.
 */
function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString().replace("Z", "+00:00");
}

/** A concrete calendar instance as the API returns it. */
function event(over: Record<string, unknown> = {}) {
  return {
    id: "evt",
    status: "confirmed",
    summary: "Something",
    start: { dateTime: iso(2 * DAY) },
    end: { dateTime: iso(2 * DAY + HOUR) },
    created: "2026-07-01T00:00:00.000Z",
    updated: "2026-08-02T02:10:31.928Z",
    ...over,
  };
}

/** A timed instance spanning [from, to] relative to now. */
function timed(
  id: string,
  summary: string,
  fromMs: number,
  toMs: number,
  over: Record<string, unknown> = {},
) {
  return event({
    id,
    summary,
    start: { dateTime: iso(fromMs) },
    end: { dateTime: iso(toMs) },
    ...over,
  });
}

function makeCalendarWatcher() {
  return createWatcher({
    name: "Google Calendar — schedule changes",
    providerId: "google-calendar",
    credentialService: "google",
    actionPrompt: "Monitor Google Calendar",
    intakeMode: "came_in",
  });
}

/** Let the watcher be claimed again, so a test can poll a second time. */
function makeDueAgain() {
  getDb().run("UPDATE watchers SET next_poll_at = 0, status = 'idle'");
}

function calendarWorkItems() {
  return listWorkItems({ includeUnComprehended: true }).filter(
    (i) =>
      i.sourceType !== null &&
      CALENDAR_CHANNELS.includes(i.sourceType as never),
  );
}

beforeEach(() => {
  changedItems = [];
  horizonItems = [];
  horizonReads = 0;
  horizonFails = false;
  getDb().run("DELETE FROM watcher_events");
  getDb().run("DELETE FROM watchers");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM arrivals");
});

// ---------------------------------------------------------------------------
// The exception
// ---------------------------------------------------------------------------

describe("a conflict is a decision, and a decision is work", () => {
  /** The flight lands on the dinner. The dinner was already there. */
  function dinnerAndFlight() {
    const dinner = timed(
      "dinner",
      "Dinner with Ana",
      2 * DAY,
      2 * DAY + 2 * HOUR,
    );
    const flight = timed(
      "flight",
      "Flight CX 784",
      2 * DAY + HOUR,
      2 * DAY + 5 * HOUR,
    );
    return { dinner, flight };
  }

  test("two overlapping busy events mint exactly ONE decision item", async () => {
    makeCalendarWatcher();
    const { dinner, flight } = dinnerAndFlight();
    changedItems = [flight];
    horizonItems = [dinner, flight];

    await runWatchersOnce(() => {});

    const items = calendarWorkItems();
    expect(items).toHaveLength(1);
    expect(horizonReads).toBe(1);
  });

  test("the title is the DECISION, not the event", async () => {
    makeCalendarWatcher();
    const { dinner, flight } = dinnerAndFlight();
    changedItems = [flight];
    horizonItems = [dinner, flight];

    await runWatchersOnce(() => {});

    const [item] = calendarWorkItems();
    // Design's example, which has to survive: the thing that was already there
    // is what is in conflict; the thing that arrived is what overlaps it.
    expect(item!.title).toBe(
      "Resolve the Dinner with Ana conflict — Flight CX 784 overlaps",
    );
    expect(item!.title).not.toContain("Calendar event:");
    expect(item!.sourceId).toBe("decision:conflict:dinner+flight");
  });

  test("the change itself is still only recorded, never minted", async () => {
    makeCalendarWatcher();
    const { dinner, flight } = dinnerAndFlight();
    changedItems = [flight];
    horizonItems = [dinner, flight];

    await runWatchersOnce(() => {});

    // One item, and it is the decision — not the flight, and not the dinner.
    const items = calendarWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceId).toStartWith("decision:");
    // The change stream is intact: recording is still the watcher's day job.
    expect(listWatcherEvents({ limit: 50 })).toHaveLength(1);
  });

  test("an unanswered invite is a decision too", async () => {
    makeCalendarWatcher();
    const invite = timed("invite", "Board review", 3 * DAY, 3 * DAY + HOUR, {
      organizer: { email: "chair@example.com", displayName: "Priya" },
      attendees: [
        { email: "chair@example.com", responseStatus: "accepted" },
        {
          email: "owner@example.com",
          self: true,
          responseStatus: "needsAction",
        },
      ],
    });
    changedItems = [invite];
    horizonItems = [invite];

    await runWatchersOnce(() => {});

    const items = calendarWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Answer the invite to Board review");
  });
});

// ---------------------------------------------------------------------------
// The narrowness — every one of these must mint nothing
// ---------------------------------------------------------------------------

describe("the default is still to mint nothing", () => {
  test("an ordinary non-conflicting meeting mints nothing", async () => {
    makeCalendarWatcher();
    const meeting = timed("mtg", "Board meeting", 2 * DAY, 2 * DAY + HOUR);
    const later = timed("other", "1:1", 3 * DAY, 3 * DAY + HOUR);
    changedItems = [meeting];
    horizonItems = [meeting, later];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
    expect(listWatcherEvents({ limit: 50 })).toHaveLength(1);
  });

  test("a declined event is not a busy commitment, so it does not conflict", async () => {
    makeCalendarWatcher();
    const declined = timed(
      "declined",
      "Optional sync",
      2 * DAY,
      2 * DAY + 2 * HOUR,
      {
        attendees: [
          {
            email: "owner@example.com",
            self: true,
            responseStatus: "declined",
          },
        ],
      },
    );
    const flight = timed(
      "flight",
      "Flight CX 784",
      2 * DAY + HOUR,
      2 * DAY + 5 * HOUR,
    );
    changedItems = [flight];
    horizonItems = [declined, flight];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("an event marked Free does not conflict", async () => {
    makeCalendarWatcher();
    const free = timed("free", "Reading time", 2 * DAY, 2 * DAY + 2 * HOUR, {
      transparency: "transparent",
    });
    const flight = timed(
      "flight",
      "Flight CX 784",
      2 * DAY + HOUR,
      2 * DAY + 5 * HOUR,
    );
    changedItems = [flight];
    horizonItems = [free, flight];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("an all-day event over a meeting is not a conflict", async () => {
    makeCalendarWatcher();
    const allDay = event({
      id: "ooo",
      summary: "Out of office",
      start: { date: "2026-08-04" },
      end: { date: "2026-08-05" },
    });
    const meeting = timed("mtg", "Board meeting", 2 * DAY, 2 * DAY + HOUR);
    changedItems = [meeting];
    horizonItems = [allDay, meeting];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("back-to-back is not overlap", async () => {
    makeCalendarWatcher();
    const first = timed("first", "Standup", 2 * DAY, 2 * DAY + HOUR);
    const second = timed(
      "second",
      "Review",
      2 * DAY + HOUR,
      2 * DAY + 2 * HOUR,
    );
    changedItems = [second];
    horizonItems = [first, second];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("a conflict nothing arrived into is not news", async () => {
    // Both events overlap, but the poll reported a THIRD, unrelated change.
    // A double-booking the owner has lived with is not a calendar audit item.
    makeCalendarWatcher();
    const dinner = timed(
      "dinner",
      "Dinner with Ana",
      2 * DAY,
      2 * DAY + 2 * HOUR,
    );
    const flight = timed(
      "flight",
      "Flight CX 784",
      2 * DAY + HOUR,
      2 * DAY + 5 * HOUR,
    );
    const unrelated = timed("mtg", "Board meeting", 5 * DAY, 5 * DAY + HOUR);
    changedItems = [unrelated];
    horizonItems = [dinner, flight, unrelated];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("an invite you organised has nothing to answer", async () => {
    makeCalendarWatcher();
    const own = timed("own", "My review", 3 * DAY, 3 * DAY + HOUR, {
      organizer: { email: "owner@example.com", self: true },
      attendees: [
        {
          email: "owner@example.com",
          self: true,
          responseStatus: "needsAction",
        },
      ],
    });
    changedItems = [own];
    horizonItems = [own];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("a decision detection failure mints nothing and does not wedge the poll", async () => {
    makeCalendarWatcher();
    const dinner = timed(
      "dinner",
      "Dinner with Ana",
      2 * DAY,
      2 * DAY + 2 * HOUR,
    );
    const flight = timed(
      "flight",
      "Flight CX 784",
      2 * DAY + HOUR,
      2 * DAY + 5 * HOUR,
    );
    changedItems = [flight];
    horizonItems = [dinner, flight];
    // The horizon read fails. Intake normally biases toward surfacing when it
    // cannot judge; this path does the opposite, on purpose.
    horizonFails = true;

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
    // The change was still recorded, which is the watcher's actual job.
    expect(listWatcherEvents({ limit: 50 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The past-event bound
// ---------------------------------------------------------------------------

describe("never for an event in the past", () => {
  test("a conflict that is already over mints nothing", async () => {
    // Deliberately INSIDE the provider's 24h grace, so the change is recorded
    // and reaches intake. What stops it is the decision detector's own bound on
    // the event's own time — remove `endMs > now` in `conflictDecisions` and
    // this test goes red.
    makeCalendarWatcher();
    const dinner = timed("dinner", "Dinner with Ana", -4 * HOUR, -2 * HOUR);
    const flight = timed("flight", "Flight CX 784", -3 * HOUR, -1 * HOUR);
    changedItems = [flight];
    horizonItems = [dinner, flight];

    await runWatchersOnce(() => {});

    expect(listWatcherEvents({ limit: 50 })).toHaveLength(1);
    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("an invite to a meeting that has started mints nothing", async () => {
    makeCalendarWatcher();
    const invite = timed("invite", "Board review", -2 * HOUR, HOUR, {
      organizer: { email: "chair@example.com" },
      attendees: [
        {
          email: "owner@example.com",
          self: true,
          responseStatus: "needsAction",
        },
      ],
    });
    changedItems = [invite];
    horizonItems = [invite];

    await runWatchersOnce(() => {});

    expect(calendarWorkItems()).toHaveLength(0);
  });

  test("the 2020 replay still leaves nothing behind", async () => {
    // One series edit rewrites `updated` on six years of stored exceptions.
    // They never even reach `watcher_events` — and the horizon read below
    // returns them anyway, so this is a claim about both bounds at once.
    makeCalendarWatcher();
    const old = Array.from({ length: 111 }, (_, i) => ({
      ...timed(
        `4vm32g7jqnu2jh6o5tpf9mha3f_2020${String(i).padStart(4, "0")}`,
        "GBA-HK: G&M Sync",
        -2000 * DAY,
        -2000 * DAY + HOUR,
      ),
    }));
    changedItems = old;
    horizonItems = [
      ...old,
      timed(
        "overlapper",
        "Something else",
        -2000 * DAY,
        -2000 * DAY + 2 * HOUR,
      ),
    ];

    await runWatchersOnce(() => {});

    expect(listWatcherEvents({ limit: 200 })).toHaveLength(0);
    expect(calendarWorkItems()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("the same conflict twice mints once", () => {
  test("a re-edited event re-derives the decision and does not duplicate it", async () => {
    makeCalendarWatcher();
    const dinner = timed(
      "dinner",
      "Dinner with Ana",
      2 * DAY,
      2 * DAY + 2 * HOUR,
    );
    const flight = timed(
      "flight",
      "Flight CX 784",
      2 * DAY + HOUR,
      2 * DAY + 5 * HOUR,
    );
    changedItems = [flight];
    horizonItems = [dinner, flight];

    await runWatchersOnce(() => {});
    expect(calendarWorkItems()).toHaveLength(1);

    // Second poll. The flight is edited again — a NEW `watcher_events` row, so
    // the dedup that saves us cannot be the event-level one. The decision key
    // is derived from the pair, so the arrival is found and nothing is minted.
    makeDueAgain();
    changedItems = [{ ...flight, updated: "2026-08-02T09:00:00.000Z" }];

    await runWatchersOnce(() => {});

    expect(listWatcherEvents({ limit: 50 })).toHaveLength(2);
    expect(calendarWorkItems()).toHaveLength(1);
  });

  test("a weekly series that collides every week is one decision, not fifty-two", async () => {
    makeCalendarWatcher();
    const instances = Array.from({ length: 8 }, (_, week) => [
      timed(
        `sync_2026080${week}T010000Z`,
        "Weekly sync",
        (week + 1) * 7 * DAY,
        (week + 1) * 7 * DAY + HOUR,
        { recurringEventId: "sync" },
      ),
      timed(
        `pt_2026080${week}T010000Z`,
        "Physio",
        (week + 1) * 7 * DAY + HOUR / 2,
        (week + 1) * 7 * DAY + 2 * HOUR,
        { recurringEventId: "pt" },
      ),
    ]).flat();
    // The sync feed reports the series MASTER, whose own dates are the first
    // occurrence in 2020 — the exact shape that caused the flood.
    changedItems = [
      timed("sync", "Weekly sync", -2000 * DAY, -2000 * DAY + HOUR, {
        recurrence: ["RRULE:FREQ=WEEKLY"],
      }),
    ];
    horizonItems = instances;

    await runWatchersOnce(() => {});

    const items = calendarWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceId).toBe("decision:conflict:pt+sync");
  });
});
