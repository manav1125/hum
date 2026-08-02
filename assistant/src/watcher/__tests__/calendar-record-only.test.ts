/**
 * A calendar poll must not put anything in the owner's queue.
 *
 * This drives the REAL path end to end — `runWatchersOnce` over a real watcher
 * row, the real Google Calendar provider, the real intake, a real database —
 * and then asks the only question that matters: after a poll, is there a work
 * item? Asserting that some helper was not called would pass just as happily
 * while production kept minting rows, which is the failure mode this file
 * exists to rule out.
 *
 * The mocks are the two things that would otherwise leave the process: the
 * OAuth-backed HTTP call, and the LLM sidechains intake fires (the relevance
 * judge, comprehension, triage). Everything between the poll and the work-item
 * table is the code production runs.
 *
 * The control test at the end is load-bearing: it proves the same machinery
 * DOES mint an item for an unpinned watcher, so a green "no work items" is
 * evidence about calendars rather than evidence that the test is inert.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ── Seams that would leave the process ────────────────────────────────
//
// `mock.module` is process-global AND replaces the module wholesale, so a
// factory listing only the seams it overrides deletes every other export for
// every later test file in the run. Spread the real module; override only the
// named function.

/** Events the fake Calendar API hands back on the next sync. */
let calendarItems: unknown[] = [];

mock.module("../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => ({
    id: "conn",
    request: async () => ({
      status: 200,
      headers: {},
      body: { items: calendarItems, nextSyncToken: "sync-next" },
    }),
  }),
}));

mock.module("../../credential-health/credential-health-service.js", () => ({
  hasPollableCredential: () => true,
  checkCredentialForProvider: async () => null,
}));

const realGate = await import("../../arrivals/arrival-gate.js");
mock.module("../../arrivals/arrival-gate.js", () => ({
  ...realGate,
  // Surface everything: the gate's judgement is not what is under test, and
  // biasing it toward surfacing makes "no work item" the strongest claim.
  decideArrivals: async (signals: Array<{ externalId: string }>) =>
    new Map(
      signals.map((s) => [
        s.externalId,
        {
          disposition: "surfaced" as const,
          reason: "test",
          decidedBy: "rule" as const,
          ruleId: null,
          confidence: null,
        },
      ]),
    ),
}));

const realComprehension =
  await import("../../arrivals/arrival-comprehension.js");
mock.module("../../arrivals/arrival-comprehension.js", () => ({
  ...realComprehension,
  comprehendArrivals: async () => ({ comprehended: 0, failed: 0 }),
}));

const realTriage = await import("../../work-items/work-item-triage.js");
mock.module("../../work-items/work-item-triage.js", () => ({
  ...realTriage,
  triageAndMaybeAutoRunWorkItem: async () => ({
    autoRunStarted: false,
    reason: "skipped",
  }),
}));

const realPlaybooks = await import("../../playbooks/playbook-runtime.js");
mock.module("../../playbooks/playbook-runtime.js", () => ({
  ...realPlaybooks,
  evaluatePlaybooksForEvent: async () => false,
}));

const runJobCalls: unknown[] = [];
mock.module("../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: unknown) => {
    runJobCalls.push(opts);
    return { conversationId: "conv", ok: true };
  },
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

// `mock.module` outlives this file — the last call for a specifier wins for
// every later file in the same process. `scripts/test.sh` runs one file per
// process precisely because of that, but hand the real modules back anyway so
// this file is not the reason a sibling fails under a plain `bun test <dir>`.
afterAll(() => {
  mock.module("../../arrivals/arrival-gate.js", () => realGate);
  mock.module(
    "../../arrivals/arrival-comprehension.js",
    () => realComprehension,
  );
  mock.module("../../work-items/work-item-triage.js", () => realTriage);
  mock.module("../../playbooks/playbook-runtime.js", () => realPlaybooks);
});

initializeDb();
registerWatcherProvider(googleCalendarProvider);

/** A provider with no pin, standing in for any ordinary inbound source. */
let unpinnedItems: Array<Record<string, unknown>> = [];
registerWatcherProvider({
  id: "test-inbound",
  displayName: "Test inbound",
  requiredCredentialService: "test",
  getInitialWatermark: async () => "wm",
  fetchNew: async () => ({
    items: unpinnedItems.map((i) => ({
      externalId: String(i.externalId),
      eventType: "new_message",
      summary: String(i.summary),
      payload: i,
      timestamp: Date.now(),
    })),
    watermark: "wm",
  }),
});

/** A calendar event as the sync API returns it. */
function calendarEvent(over: Record<string, unknown> = {}) {
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  return {
    id: "evt-upcoming",
    status: "confirmed",
    summary: "Board meeting",
    start: { dateTime: soon },
    end: { dateTime: soon },
    created: "2026-07-01T00:00:00.000Z",
    updated: "2026-08-02T02:10:31.928Z",
    ...over,
  };
}

function makeCalendarWatcher() {
  return createWatcher({
    name: "Google Calendar — schedule changes",
    providerId: "google-calendar",
    credentialService: "google",
    actionPrompt: "Monitor Google Calendar",
    // Deliberately the mode the live row on the owner's instance carries. The
    // provider's pin is what has to override it, so the fix reaches a watcher
    // that already exists with no data migration.
    intakeMode: "came_in",
    // The sync token is already established: this is an incremental poll, the
    // one that produced the flood.
  });
}

beforeEach(() => {
  calendarItems = [];
  unpinnedItems = [];
  runJobCalls.length = 0;
  getDb().run("DELETE FROM watcher_events");
  getDb().run("DELETE FROM watchers");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM arrivals");
});

afterEach(() => {
  getDb().run("DELETE FROM watcher_events");
  getDb().run("DELETE FROM watchers");
});

function calendarWorkItems() {
  return listWorkItems({ includeUnComprehended: true }).filter(
    (i) =>
      i.sourceType !== null &&
      CALENDAR_CHANNELS.includes(i.sourceType as never),
  );
}

describe("a calendar poll produces no work items", () => {
  test("an upcoming meeting is recorded, and stays out of the queue", async () => {
    const watcher = makeCalendarWatcher();
    calendarItems = [calendarEvent()];

    await runWatchersOnce(() => {});

    // The change IS noticed and kept — the stream is the point of the watcher.
    const events = listWatcherEvents({ watcherId: watcher.id, limit: 50 });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain("Board meeting");

    // And it is not something the owner has to do.
    expect(calendarWorkItems()).toHaveLength(0);
    // Nor did it spend an LLM turn on the legacy agent path.
    expect(runJobCalls).toHaveLength(0);
  });

  test("the event is marked processed, so it is not re-read every tick", async () => {
    const watcher = makeCalendarWatcher();
    calendarItems = [calendarEvent()];

    await runWatchersOnce(() => {});
    const [event] = listWatcherEvents({ watcherId: watcher.id, limit: 50 });
    expect(event!.disposition).toBe("silent");
    expect(event!.disposition).not.toBe("pending");
  });

  test("111 changed instances from 2020 leave nothing behind at all", async () => {
    // The live incident, replayed: one series edit bumps `updated` on six years
    // of stored exceptions. The horizon bound drops them at the provider, so
    // they never even reach `watcher_events`.
    const watcher = makeCalendarWatcher();
    calendarItems = Array.from({ length: 111 }, (_, i) =>
      calendarEvent({
        id: `4vm32g7jqnu2jh6o5tpf9mha3f_2020${String(i).padStart(4, "0")}`,
        summary: "GBA-HK: G&M Sync",
        start: { dateTime: "2020-05-04T09:00:00+08:00" },
        end: { dateTime: "2020-05-04T09:30:00+08:00" },
      }),
    );

    await runWatchersOnce(() => {});

    expect(
      listWatcherEvents({ watcherId: watcher.id, limit: 200 }),
    ).toHaveLength(0);
    expect(calendarWorkItems()).toHaveLength(0);
  });
});

describe("control — the same machinery still mints for other sources", () => {
  test("an unpinned watcher's event becomes a work item", async () => {
    // Without this, "no work items" above could just mean intake is broken.
    createWatcher({
      name: "Test inbound",
      providerId: "test-inbound",
      credentialService: "test",
      actionPrompt: "Monitor",
      intakeMode: "came_in",
    });
    unpinnedItems = [
      { externalId: "msg-1", summary: "Can you send the deck?" },
    ];

    await runWatchersOnce(() => {});

    const items = listWorkItems({ includeUnComprehended: true }).filter(
      (i) => i.sourceType === "watcher:test-inbound",
    );
    expect(items).toHaveLength(1);
  });
});
