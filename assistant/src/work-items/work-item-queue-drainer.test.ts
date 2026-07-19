import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  attemptCapNote,
  CAPTURE_FLIGHT_WINDOW_MS,
  DEFAULT_DRAINER_INTERVAL_MS,
  getQueueDrainerIntervalMs,
  isQueueDrainerDisabled,
  MAX_STARTS_PER_SWEEP,
  startWorkItemQueueDrainer,
  sweepWorkItemQueue,
} from "./work-item-queue-drainer.js";
import { MAX_WORK_ITEM_RECOVERY_ATTEMPTS } from "./work-item-recovery.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
} from "./work-item-store.js";
import type { AutoRunDecision } from "./work-item-triage.js";

/**
 * A `now` far enough past creation time that freshly-created rows (whose
 * createdAt/updatedAt are the real wall clock) clear the capture-flight
 * recency window.
 */
function later(): number {
  return Date.now() + CAPTURE_FLIGHT_WINDOW_MS + 60_000;
}

/** Fake auto-run gate that records call order and returns a fixed decision. */
function fakeGate(
  decision: AutoRunDecision,
  calls: string[],
): (id: string) => Promise<AutoRunDecision> {
  return (id: string) => {
    calls.push(id);
    return Promise.resolve(decision);
  };
}

const ENV_KEYS = [
  "CUE_DISABLE_QUEUE_DRAINER",
  "CUE_QUEUE_DRAINER_INTERVAL_MS",
  "CUE_DISABLE_WORKITEM_AUTORUN",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let taskId = "";

describe("sweepWorkItemQueue (DB-backed)", () => {
  initializeDb();

  beforeEach(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    taskId = createTask({ title: "Drainer task", template: "do it" }).id;
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  // Don't leak rows to a later test file sharing this `bun test` process.
  afterAll(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
  });

  test("re-dispatches queued items through the gate in sortIndex order, oldest-first tiebreak", async () => {
    const calls: string[] = [];
    const c = createWorkItem({ taskId, title: "c", sortIndex: 5 });
    const a = createWorkItem({ taskId, title: "a", sortIndex: 1 });
    const b = createWorkItem({ taskId, title: "b", sortIndex: 3 });
    const result = await sweepWorkItemQueue(
      later(),
      fakeGate({ started: true, reason: "started" }, calls),
    );
    // Per-sweep start cap: only the top MAX_STARTS_PER_SWEEP go through.
    expect(MAX_STARTS_PER_SWEEP).toBe(2);
    expect(calls).toEqual([a.id, b.id]);
    expect(result.started).toBe(2);
    expect(result.deferred).toBe(1); // c never reached the gate this sweep
    expect(getWorkItem(c.id)!.status).toBe("queued");
  });

  test("skips items still inside the capture-triage flight window", async () => {
    const calls: string[] = [];
    createWorkItem({ taskId, title: "brand new" });
    // `now` = real wall clock → the item was created milliseconds ago.
    const result = await sweepWorkItemQueue(
      Date.now(),
      fakeGate({ started: true, reason: "started" }, calls),
    );
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ started: 0, skippedRecent: 1 });
  });

  test("never starts an item the policy gate answers 'ask' for", async () => {
    const calls: string[] = [];
    const item = createWorkItem({ taskId, title: "needs a human" });
    const result = await sweepWorkItemQueue(
      later(),
      fakeGate({ started: false, reason: "policy_ask" }, calls),
    );
    expect(calls).toEqual([item.id]); // evaluated…
    expect(result.started).toBe(0); // …but never started
    expect(result.deferred).toBe(1);
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("user-parked quick-add items stay queued through the REAL gate", async () => {
    // Regression: quick-added tasks were created with capture-time auto-run
    // skipped, but the drainer swept them minutes later and started them
    // through the policy gate. The parked marker must hold here too — it is
    // checked before the policy, so this is deterministic under any policy.
    const item = createWorkItem({
      taskId,
      title: "QA-NIGHT task do not run",
      requiredTools: JSON.stringify(["web_search"]),
      autoRunEligibility: "parked",
    });
    const result = await sweepWorkItemQueue(later());
    expect(result.started).toBe(0);
    expect(result.deferred).toBe(1);
    expect(getWorkItem(item.id)!.status).toBe("queued");
    expect(getWorkItem(item.id)!.autoRunEligibility).toBe("parked");
  });

  test("hard-deny floor holds through the REAL gate (browser tools stay queued)", async () => {
    const item = createWorkItem({
      taskId,
      title: "Buy stroopwafels",
      requiredTools: JSON.stringify(["browser_navigate"]),
    });
    // Default gate = the real maybeAutoRunWorkItem; hard-deny fires before any
    // policy/runner involvement, so this is safe to exercise for real.
    const result = await sweepWorkItemQueue(later());
    expect(result.started).toBe(0);
    expect(result.deferred).toBe(1);
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("the auto-run kill switch (CUE_DISABLE_WORKITEM_AUTORUN) also gates the drainer via the real gate", async () => {
    process.env.CUE_DISABLE_WORKITEM_AUTORUN = "1";
    const item = createWorkItem({ taskId, title: "research thing" });
    const result = await sweepWorkItemQueue(later());
    expect(result.started).toBe(0);
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("skips items at the recovery-attempt cap and stamps the why-note exactly once", async () => {
    const calls: string[] = [];
    const item = createWorkItem({ taskId, title: "keeps stranding" });
    updateWorkItem(item.id, {
      recoveryAttempts: MAX_WORK_ITEM_RECOVERY_ATTEMPTS,
    });

    const first = await sweepWorkItemQueue(
      later(),
      fakeGate({ started: true, reason: "started" }, calls),
    );
    expect(calls).toEqual([]);
    expect(first.skippedAttemptCap).toBe(1);
    const afterFirst = getWorkItem(item.id)!;
    expect(afterFirst.lastProgressNote).toBe(
      attemptCapNote(MAX_WORK_ITEM_RECOVERY_ATTEMPTS),
    );

    // Second sweep: still skipped, but no repeat write (updatedAt is bumped by
    // every updateWorkItem, so a stable updatedAt proves the note wasn't
    // re-stamped).
    const second = await sweepWorkItemQueue(
      later(),
      fakeGate({ started: true, reason: "started" }, calls),
    );
    expect(second.skippedAttemptCap).toBe(1);
    expect(calls).toEqual([]);
    expect(getWorkItem(item.id)!.updatedAt).toBe(afterFirst.updatedAt);
  });

  test("stops sweeping when the gate reports the concurrency cap", async () => {
    const calls: string[] = [];
    createWorkItem({ taskId, title: "one", sortIndex: 1 });
    createWorkItem({ taskId, title: "two", sortIndex: 2 });
    createWorkItem({ taskId, title: "three", sortIndex: 3 });
    const result = await sweepWorkItemQueue(
      later(),
      fakeGate({ started: false, reason: "concurrency_cap" }, calls),
    );
    // The cap applies to every item — only the first is evaluated.
    expect(calls.length).toBe(1);
    expect(result.started).toBe(0);
    expect(result.deferred).toBe(3);
  });

  test("kill switch CUE_DISABLE_QUEUE_DRAINER=1 makes the sweep a no-op", async () => {
    const calls: string[] = [];
    createWorkItem({ taskId, title: "should not be touched" });
    process.env.CUE_DISABLE_QUEUE_DRAINER = "1";
    expect(isQueueDrainerDisabled()).toBe(true);
    const result = await sweepWorkItemQueue(
      later(),
      fakeGate({ started: true, reason: "started" }, calls),
    );
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ scanned: 0, started: 0 });
  });

  test("a throwing gate is contained per-item (log + continue)", async () => {
    const bad = createWorkItem({ taskId, title: "bad", sortIndex: 1 });
    const good = createWorkItem({ taskId, title: "good", sortIndex: 2 });
    const calls: string[] = [];
    const result = await sweepWorkItemQueue(later(), (id: string) => {
      calls.push(id);
      if (id === bad.id) throw new Error("boom");
      return Promise.resolve({ started: true, reason: "started" });
    });
    expect(calls).toEqual([bad.id, good.id]);
    expect(result.started).toBe(1);
  });
});

describe("drainer env knobs + lifecycle", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("interval defaults to 5 minutes and rejects garbage", () => {
    expect(getQueueDrainerIntervalMs()).toBe(DEFAULT_DRAINER_INTERVAL_MS);
    process.env.CUE_QUEUE_DRAINER_INTERVAL_MS = "not-a-number";
    expect(getQueueDrainerIntervalMs()).toBe(DEFAULT_DRAINER_INTERVAL_MS);
    process.env.CUE_QUEUE_DRAINER_INTERVAL_MS = "-5";
    expect(getQueueDrainerIntervalMs()).toBe(DEFAULT_DRAINER_INTERVAL_MS);
  });

  test("interval env is honored and clamped to the safety floor", () => {
    process.env.CUE_QUEUE_DRAINER_INTERVAL_MS = "120000";
    expect(getQueueDrainerIntervalMs()).toBe(120_000);
    process.env.CUE_QUEUE_DRAINER_INTERVAL_MS = "1"; // typo-proofing
    expect(getQueueDrainerIntervalMs()).toBe(10_000);
  });

  test("startWorkItemQueueDrainer is idempotent and stoppable", () => {
    const first = startWorkItemQueueDrainer();
    const second = startWorkItemQueueDrainer();
    expect(second).toBe(first);
    first.stop();
    const third = startWorkItemQueueDrainer();
    expect(third).not.toBe(first);
    third.stop();
  });
});
