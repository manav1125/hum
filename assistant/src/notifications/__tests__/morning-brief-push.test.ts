/**
 * Tests for the Morning Brief push job: the deterministic summary-line
 * composer (review-leads / all-quiet / ask-present variants), the
 * should-fire-now logic (time window, per-day idempotence, timezone), and
 * the emission path (pipeline payload, per-day dedupe key, self-host APNs
 * mirror gating).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Capture pipeline emissions instead of running the real decision engine.
import type { EmitSignalParams, EmitSignalResult } from "../emit-signal.js";

const emitted: EmitSignalParams[] = [];
let emitResult: EmitSignalResult;
mock.module("../emit-signal.js", () => ({
  emitNotificationSignal: async (
    params: EmitSignalParams,
  ): Promise<EmitSignalResult> => {
    emitted.push(params);
    return emitResult;
  },
}));

let apnsConfigured = false;
mock.module("../apns-sender.js", () => ({
  isApnsConfigured: () => apnsConfigured,
  sendApnsAlert: async () => ({ ok: true }),
}));

// The brief's device mirror goes through the interruption budget. Only that
// seam is overridden — the rest of the real module is spread through, and it
// is copied into a plain object first because `mock.module` rebinds the live
// namespace (see assistant/CLAUDE.md). The budget's own decisions are covered
// in push-budget.test.ts and push-dispatch.test.ts; here we only care that the
// brief asks it, and asks it as the ambient tier.
const realDispatch = { ...(await import("../push-dispatch.js")) };
const apnsAlerts: Array<Record<string, unknown>> = [];
const budgetedIntents: Array<Record<string, unknown>> = [];
mock.module("../push-dispatch.js", () => ({
  ...realDispatch,
  sendBudgetedAlert: async (opts: {
    intent: Record<string, unknown>;
    alert: Record<string, unknown>;
  }) => {
    budgetedIntents.push(opts.intent);
    apnsAlerts.push(opts.alert);
    return { deliver: true, tier: "ambient" };
  },
}));

import { initializeDb } from "../../memory/db-init.js";
import type {
  BriefAsk,
  OvernightItem,
} from "../../runtime/routes/morning-brief-routes.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItem,
  listWorkItems,
  removeWorkItemFromQueue,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import {
  composeMorningBriefCopy,
  localClock,
  MORNING_BRIEF_PATH,
  parseBriefTime,
  sendMorningBriefPush,
  shouldFireNow,
} from "../morning-brief-push.js";

initializeDb();

function overnightItem(state: "done" | "review", n: number): OvernightItem {
  return {
    id: `wi-${state}-${n}`,
    title: `Item ${n}`,
    state,
    kind: "work_item",
    completedAt: new Date().toISOString(),
  };
}

function items(done: number, review: number): OvernightItem[] {
  return [
    ...Array.from({ length: done }, (_, i) => overnightItem("done", i)),
    ...Array.from({ length: review }, (_, i) => overnightItem("review", i)),
  ];
}

const approvalAsk: BriefAsk = {
  id: "req-1",
  kind: "approval",
  title: "Approve: send_email",
  actions: [],
};

const reviewAsk: BriefAsk = {
  id: "wi-old",
  kind: "review",
  title: "Old review item",
  actions: [],
};

function dispatchedResult(
  deliveryResults: EmitSignalResult["deliveryResults"] = [
    {
      channel: "vellum",
      destination: "broadcast",
      status: "sent",
    },
  ],
): EmitSignalResult {
  return {
    signalId: "sig-1",
    deduplicated: false,
    dispatched: true,
    reason: "ok",
    deliveryResults,
  };
}

beforeEach(() => {
  emitted.length = 0;
  apnsAlerts.length = 0;
  budgetedIntents.length = 0;
  apnsConfigured = false;
  emitResult = dispatchedResult();
  for (const i of listWorkItems()) removeWorkItemFromQueue(i.id);
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

describe("composeMorningBriefCopy", () => {
  test("finished + review items compose the two-part line", () => {
    const copy = composeMorningBriefCopy({
      overnight: items(3, 1),
      ask: reviewAsk,
    });
    expect(copy.title).toBe("Your morning brief is ready");
    expect(copy.body).toBe("3 finished overnight · 1 needs your OK");
  });

  test("all quiet gets the calm variant", () => {
    const copy = composeMorningBriefCopy({ overnight: [], ask: null });
    expect(copy.body).toBe("All quiet overnight — your day's ready.");
  });

  test("done-only night omits the OK part", () => {
    const copy = composeMorningBriefCopy({ overnight: items(2, 0), ask: null });
    expect(copy.body).toBe("2 finished overnight");
  });

  test("a pending approval counts on top of review items", () => {
    const copy = composeMorningBriefCopy({
      overnight: items(0, 2),
      ask: approvalAsk,
    });
    expect(copy.body).toBe("3 need your OK");
  });

  test("a review ask older than the window still counts once", () => {
    const copy = composeMorningBriefCopy({
      overnight: items(1, 0),
      ask: reviewAsk,
    });
    expect(copy.body).toBe("1 finished overnight · 1 needs your OK");
  });

  test("review ask is not double-counted against windowed review items", () => {
    const copy = composeMorningBriefCopy({
      overnight: items(0, 1),
      ask: reviewAsk,
    });
    expect(copy.body).toBe("1 needs your OK");
  });
});

// ---------------------------------------------------------------------------
// Should-fire logic
// ---------------------------------------------------------------------------

describe("shouldFireNow", () => {
  const base = { time: "07:30", timezone: null, lastSentDateKey: null };

  test("before the configured time: no fire", () => {
    const { fire } = shouldFireNow({
      ...base,
      now: new Date(2026, 6, 18, 7, 29),
    });
    expect(fire).toBe(false);
  });

  test("at and shortly after the configured time: fires with the local date key", () => {
    const at = shouldFireNow({ ...base, now: new Date(2026, 6, 18, 7, 30) });
    expect(at).toEqual({ fire: true, dateKey: "2026-07-18" });
    const later = shouldFireNow({ ...base, now: new Date(2026, 6, 18, 9, 15) });
    expect(later.fire).toBe(true);
  });

  test("after the fire window closes: no stale morning brief at night", () => {
    const { fire } = shouldFireNow({
      ...base,
      now: new Date(2026, 6, 18, 10, 30),
    });
    expect(fire).toBe(false);
    expect(
      shouldFireNow({ ...base, now: new Date(2026, 6, 18, 21, 0) }).fire,
    ).toBe(false);
  });

  test("already sent today: idempotent; yesterday's send does not block", () => {
    const now = new Date(2026, 6, 18, 7, 45);
    expect(
      shouldFireNow({ ...base, now, lastSentDateKey: "2026-07-18" }).fire,
    ).toBe(false);
    expect(
      shouldFireNow({ ...base, now, lastSentDateKey: "2026-07-17" }).fire,
    ).toBe(true);
  });

  test("configured timezone shifts both the clock and the date key", () => {
    // 14:30Z = 07:30 in Los Angeles (UTC-7 in July) — fires there, not in UTC.
    const now = new Date("2026-07-18T14:30:00Z");
    expect(
      shouldFireNow({ ...base, now, timezone: "America/Los_Angeles" }),
    ).toEqual({ fire: true, dateKey: "2026-07-18" });
    expect(shouldFireNow({ ...base, now, timezone: "UTC" }).fire).toBe(false);

    // 19:30Z = 07:30 *next day* in Auckland (UTC+12 in July).
    const nz = shouldFireNow({
      ...base,
      now: new Date("2026-07-18T19:30:00Z"),
      timezone: "Pacific/Auckland",
    });
    expect(nz).toEqual({ fire: true, dateKey: "2026-07-19" });
  });

  test("invalid timezone falls back to the daemon-local clock", () => {
    const now = new Date(2026, 6, 18, 7, 30);
    const result = shouldFireNow({ ...base, now, timezone: "Not/AZone" });
    expect(result).toEqual(shouldFireNow({ ...base, now, timezone: null }));
    expect(result.fire).toBe(true);
  });

  test("parseBriefTime defaults malformed input to 07:30", () => {
    expect(parseBriefTime("07:30")).toBe(450);
    expect(parseBriefTime("22:05")).toBe(22 * 60 + 5);
    expect(parseBriefTime(undefined)).toBe(450);
    expect(parseBriefTime("")).toBe(450);
    expect(parseBriefTime("25:00")).toBe(450);
    expect(parseBriefTime("junk")).toBe(450);
  });

  test("localClock local path formats a stable date key", () => {
    const clock = localClock(new Date(2026, 0, 5, 6, 7), null);
    expect(clock).toEqual({ dateKey: "2026-01-05", minutesOfDay: 6 * 60 + 7 });
  });
});

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

describe("sendMorningBriefPush", () => {
  test("emits real counts through the pipeline with the per-day dedupe key", async () => {
    const task = createTask({ title: "t", template: "..." });
    const done = createWorkItem({ taskId: task.id, title: "Filed overnight" });
    updateWorkItem(done.id, { status: "done" });
    const review = createWorkItem({ taskId: task.id, title: "Acme one-pager" });
    updateWorkItem(review.id, { status: "awaiting_review" });

    const result = await sendMorningBriefPush("2026-07-18");
    expect(result).toEqual({ handled: true, deduplicated: false });

    expect(emitted).toHaveLength(1);
    const signal = emitted[0];
    expect(signal.sourceEventName).toBe("brief.morning_ready");
    expect(signal.sourceChannel).toBe("assistant_tool");
    expect(signal.dedupeKey).toBe("morning-brief:2026-07-18");
    expect(signal.contextPayload).toMatchObject({
      requestedTitle: "Your morning brief is ready",
      requestedMessage: "1 finished overnight · 1 needs your OK",
      preferredChannels: ["platform"],
      deepLinkMetadata: {
        kind: "morning_brief",
        path: MORNING_BRIEF_PATH,
        dateKey: "2026-07-18",
      },
    });
    expect(signal.attentionHints.urgency).toBe("medium");
  });

  test("all-quiet day emits the honest calm line", async () => {
    await sendMorningBriefPush("2026-07-18");
    expect(
      (emitted[0].contextPayload as Record<string, unknown>).requestedMessage,
    ).toBe("All quiet overnight — your day's ready.");
  });

  test("pipeline dedupe (daemon restarted after sending) reports handled", async () => {
    emitResult = {
      ...dispatchedResult(),
      deduplicated: true,
      dispatched: false,
    };
    const result = await sendMorningBriefPush("2026-07-18");
    expect(result).toEqual({ handled: true, deduplicated: true });
    expect(apnsAlerts).toHaveLength(0);
  });

  test("undispatched signal reports unhandled so the tick can retry", async () => {
    emitResult = {
      ...dispatchedResult(),
      dispatched: false,
      reason: "suppressed",
    };
    const result = await sendMorningBriefPush("2026-07-18");
    expect(result).toEqual({ handled: false, deduplicated: false });
    expect(apnsAlerts).toHaveLength(0);
  });

  test("self-host APNs mirror fires when platform did not deliver", async () => {
    apnsConfigured = true;
    await sendMorningBriefPush("2026-07-18");
    expect(apnsAlerts).toHaveLength(1);
    expect(apnsAlerts[0]).toMatchObject({
      title: "Your morning brief is ready",
      collapseId: "brief-2026-07-18",
      threadId: "cue-morning-brief",
      data: { kind: "morning_brief", path: MORNING_BRIEF_PATH },
    });
    // The brief is the ambient tier — exactly what the three-a-day ceiling is
    // for, and the one tier it is allowed to hold back.
    expect(budgetedIntents[0]).toEqual({
      sourceEventName: "brief.morning_ready",
    });
  });

  test("APNs mirror is skipped when the platform channel delivered (no double push)", async () => {
    apnsConfigured = true;
    emitResult = dispatchedResult([
      { channel: "vellum", destination: "broadcast", status: "sent" },
      { channel: "platform", destination: "apns", status: "sent" },
    ]);
    await sendMorningBriefPush("2026-07-18");
    expect(apnsAlerts).toHaveLength(0);
  });

  test("APNs mirror is skipped when APNs is unconfigured", async () => {
    apnsConfigured = false;
    await sendMorningBriefPush("2026-07-18");
    expect(apnsAlerts).toHaveLength(0);
  });
});
