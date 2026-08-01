/**
 * Automations behaviour (WS-F): the playbook runtime (trigger→action +
 * autonomy-cap enforcement) and the watcher intake (Came-in filing) exercised
 * against their REAL logic. Only leaf modules (task/work-item/triage stores,
 * the playbook store, and the global dial) are mocked, so playbook selection,
 * the cap, and the watcher→playbook→came-in hand-off are all real.
 *
 * Runtime and intake live in one file on purpose: bun's `mock.module` is
 * process-global, so splitting them into two files that each mock the same
 * downstream modules would let one file's stubs clobber the other's.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Watcher, WatcherEvent } from "../../watcher/watcher-store.js";
import type { PlaybookRecord } from "../playbook-store.js";

// ── Controllable leaves ───────────────────────────────────────────────
let dial: "observe" | "assist" | "autonomous" = "assist";
let matchable: PlaybookRecord[] = [];
const firedIds: string[] = [];
const createWorkItemCalls: Array<Record<string, unknown>> = [];
const triageCalls: Array<{ id: string; skipAutoRun?: boolean }> = [];

mock.module("../../missions/mission-store.js", () => ({
  getCompanyProfile: () => ({
    identity: null,
    direction: null,
    neverLines: [],
    workspaceMode: dial,
    updatedAt: null,
  }),
  // The relevance gate's safety floor reads active missions by name. This
  // file mocks the whole module, so a new import from it must be stubbed here
  // or the intake import fails at load time.
  listMissions: () => [],
}));

// The arrivals ledger is a leaf store like the others: every hit is recorded
// here so the intake hand-off can be asserted without a database.
const recordedArrivals: Array<Record<string, unknown>> = [];
mock.module("../../arrivals/arrival-store.js", () => ({
  recordArrival: (input: Record<string, unknown>) => {
    recordedArrivals.push(input);
    return {
      ...input,
      id: `arr-${recordedArrivals.length}`,
      sourceContext: input.sourceContext ?? null,
      workItemId: null,
    };
  },
  attachWorkItemToArrival: () => {},
}));

mock.module("../playbook-store.js", () => ({
  listMatchablePlaybooks: () => matchable,
  markPlaybookFired: (id: string) => firedIds.push(id),
}));

mock.module("../../tasks/task-store.js", () => ({
  createTask: (opts: { title: string }) => ({ id: `task-${opts.title}` }),
}));

mock.module("../../work-items/work-item-store.js", () => ({
  createWorkItem: (opts: Record<string, unknown>) => {
    createWorkItemCalls.push(opts);
    return { id: `wi-${createWorkItemCalls.length}` };
  },
}));

mock.module("../../work-items/work-item-triage.js", () => ({
  triageAndMaybeAutoRunWorkItem: (
    id: string,
    opts: { skipAutoRun?: boolean } = {},
  ) => {
    triageCalls.push({ id, skipAutoRun: opts.skipAutoRun });
    return Promise.resolve({ autoRunStarted: false, reason: "ok" });
  },
}));

// Import the REAL modules under test after the leaf mocks are registered.
const { evaluatePlaybooksForEvent, selectPlaybookForEvent } =
  await import("../playbook-runtime.js");
const { fileWatcherEventsToCameIn, watcherChannel } =
  await import("../../watcher/watcher-intake.js");

/**
 * An empty safety floor. The floor's real inputs (contacts, missions,
 * projects) are exercised against a real database in
 * watcher/__tests__/watcher-intake-relevance.test.ts; here they are injected
 * empty so this file stays about the playbook → intake hand-off.
 */
const NO_FLOOR = { lookupContact: () => null, namedWork: [] };

function pb(overrides: Partial<PlaybookRecord>): PlaybookRecord {
  return {
    id: "p1",
    name: "rule",
    triggerText: "invoice",
    channel: "*",
    watcherId: null,
    action: "file it",
    autonomyLevel: "auto",
    priority: 0,
    enabled: true,
    lastFiredAt: null,
    scopeId: "default",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  dial = "assist";
  matchable = [];
  firedIds.length = 0;
  createWorkItemCalls.length = 0;
  triageCalls.length = 0;
  recordedArrivals.length = 0;
});

describe("selectPlaybookForEvent (trigger→action matching)", () => {
  test("matches trigger substring case-insensitively", () => {
    matchable = [pb({ triggerText: "Invoice" })];
    expect(
      selectPlaybookForEvent({
        channel: "gmail",
        title: "Your INVOICE is ready",
      })?.id,
    ).toBe("p1");
  });

  test("returns null when the trigger text is absent", () => {
    matchable = [pb({ triggerText: "refund" })];
    expect(
      selectPlaybookForEvent({ channel: "gmail", title: "invoice ready" }),
    ).toBeNull();
  });

  test("'*'/empty trigger matches anything on scope", () => {
    matchable = [pb({ triggerText: "*" })];
    expect(
      selectPlaybookForEvent({ channel: "gmail", title: "whatever" }),
    ).not.toBeNull();
  });

  test("highest priority wins (store yields priority-ordered)", () => {
    matchable = [pb({ id: "hi", priority: 9 }), pb({ id: "lo", priority: 1 })];
    expect(
      selectPlaybookForEvent({ channel: "gmail", title: "invoice" })?.id,
    ).toBe("hi");
  });
});

describe("autonomy-cap enforcement on fire", () => {
  test("observe forces auto→notify (parked, no auto-run)", async () => {
    dial = "observe";
    matchable = [pb({ autonomyLevel: "auto" })];
    const res = await evaluatePlaybooksForEvent({
      channel: "gmail",
      title: "invoice",
    });
    expect(res?.autonomy.effective).toBe("notify");
    expect(res?.autonomy.capped).toBe(true);
    expect(createWorkItemCalls[0]?.autoRunEligibility).toBe("parked");
    expect(triageCalls[0]?.skipAutoRun).toBe(true);
    expect(firedIds).toEqual(["p1"]);
  });

  test("assist holds auto→draft (queued, no auto-run)", async () => {
    dial = "assist";
    matchable = [pb({ autonomyLevel: "auto" })];
    const res = await evaluatePlaybooksForEvent({
      channel: "gmail",
      title: "invoice",
    });
    expect(res?.autonomy.effective).toBe("draft");
    expect(createWorkItemCalls[0]?.autoRunEligibility).toBeUndefined();
    expect(triageCalls[0]?.skipAutoRun).toBe(true);
  });

  test("autonomous lets auto auto-run", async () => {
    dial = "autonomous";
    matchable = [pb({ autonomyLevel: "auto" })];
    const res = await evaluatePlaybooksForEvent({
      channel: "gmail",
      title: "invoice",
    });
    expect(res?.autonomy.effective).toBe("auto");
    expect(res?.autonomy.capped).toBe(false);
    expect(triageCalls[0]?.skipAutoRun).toBe(false);
  });

  test("no match fires nothing", async () => {
    matchable = [pb({ triggerText: "nope" })];
    const res = await evaluatePlaybooksForEvent({
      channel: "gmail",
      title: "invoice",
    });
    expect(res).toBeNull();
    expect(createWorkItemCalls).toHaveLength(0);
    expect(firedIds).toHaveLength(0);
  });
});

// ── Watcher intake (Came-in filing) ───────────────────────────────────
function makeWatcher(): Watcher {
  return {
    id: "w-1",
    name: "Inbox",
    providerId: "gmail",
    enabled: true,
    pollIntervalMs: 300000,
    actionPrompt: "",
    watermark: null,
    conversationId: null,
    status: "idle",
    consecutiveErrors: 0,
    lastError: null,
    lastPollAt: null,
    nextPollAt: 0,
    configJson: null,
    credentialService: "google",
    intakeMode: "came_in",
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeEvent(id: string): WatcherEvent {
  return {
    id,
    watcherId: "w-1",
    externalId: `ext-${id}`,
    eventType: "new_email",
    summary: `Email ${id}`,
    payloadJson: "{}",
    disposition: "pending",
    llmAction: null,
    processedAt: null,
    createdAt: 100,
  };
}

describe("watcher intake → Came-in", () => {
  test("watcherChannel namespaces by provider", () => {
    expect(watcherChannel(makeWatcher())).toBe("watcher:gmail");
  });

  test("no playbook match → parked Came-in work item", async () => {
    matchable = []; // nothing matches → falls through to came-in
    const d = await fileWatcherEventsToCameIn(makeWatcher(), [makeEvent("a")], {
      floorContext: NO_FLOOR,
    });
    expect(d.get("a")).toBe("came_in");
    expect(createWorkItemCalls).toHaveLength(1);
    expect(createWorkItemCalls[0]?.autoRunEligibility).toBe("parked");
    expect(createWorkItemCalls[0]?.sourceType).toBe("watcher:gmail");
    expect(createWorkItemCalls[0]?.sourceId).toBe("ext-a");
    expect(triageCalls[0]?.skipAutoRun).toBe(true);
  });

  test("matching playbook handles the event (no bare Came-in item)", async () => {
    // A '*'-trigger playbook fires for every event via the real runtime.
    matchable = [pb({ triggerText: "*", autonomyLevel: "draft" })];
    const d = await fileWatcherEventsToCameIn(makeWatcher(), [makeEvent("b")], {
      floorContext: NO_FLOOR,
    });
    expect(d.get("b")).toBe("playbook");
    // Even a playbook-claimed hit is recorded, so the arrived/filed/kept
    // census stays a census rather than an estimate.
    expect(recordedArrivals).toHaveLength(1);
    expect(recordedArrivals[0]?.decidedBy).toBe("playbook");
    // Exactly one work item — created by the playbook, not a second came-in one.
    expect(createWorkItemCalls).toHaveLength(1);
    expect(firedIds).toEqual(["p1"]);
  });

  test("each deduped event processed exactly once", async () => {
    matchable = [];
    const d = await fileWatcherEventsToCameIn(
      makeWatcher(),
      [makeEvent("a"), makeEvent("b"), makeEvent("c")],
      { floorContext: NO_FLOOR },
    );
    expect(createWorkItemCalls).toHaveLength(3);
    expect([...d.values()]).toEqual(["came_in", "came_in", "came_in"]);
    // Nothing a watcher saw is dropped: one arrival row per event.
    expect(recordedArrivals).toHaveLength(3);
  });
});
