/**
 * Tests for the next-move "chief of staff" endpoint: deterministic candidate
 * ranking, the templated fallback (LLM never invoked on the GET path), the
 * empty "all caught up" state, and the stale-while-revalidate cache keyed on
 * the top item id.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// No provider → narration falls back to deterministic, so background
// revalidation is a safe no-op in tests (never hits a real LLM).
mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => null,
}));

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import { createProject } from "../../work-items/project-store.js";
import {
  createWorkItem,
  listWorkItems,
  removeWorkItemFromQueue,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { __resetNextMoveCacheForTest } from "../next-move.js";
import {
  clear as clearInteractions,
  register,
} from "../pending-interactions.js";
import { ROUTES } from "./next-move-routes.js";

initializeDb();

const route = ROUTES.find(
  (r) => r.endpoint === "next-move" && r.method === "GET",
)!;

interface NextMoveResponse {
  hasMove: boolean;
  itemId: string | null;
  kind: "approval" | "work_item" | "feed" | null;
  headline: string;
  reasoning: string;
  actions: Array<{ id: string; kind: string }>;
}

function callNextMove(): NextMoveResponse {
  return route.handler({ headers: {} }) as NextMoveResponse;
}

function clearWorkItems(): void {
  for (const i of listWorkItems()) removeWorkItemFromQueue(i.id);
}

// Clean both before and after so state leaked from an earlier test file in the
// same `bun test` process (this file's initializeDb is shared) can't make the
// "all caught up" case see stray candidates.
beforeEach(() => {
  clearWorkItems();
  clearInteractions();
  __resetNextMoveCacheForTest();
});

afterEach(() => {
  clearWorkItems();
  clearInteractions();
  __resetNextMoveCacheForTest();
});

describe("next-move endpoint", () => {
  test("returns 'all caught up' when nothing is pending", () => {
    const res = callNextMove();
    expect(res.hasMove).toBe(false);
    expect(res.itemId).toBeNull();
    expect(res.kind).toBeNull();
    expect(res.headline).toBe("You're all caught up.");
    expect(res.reasoning).toBe("");
    expect(res.actions).toEqual([]);
  });

  test("a queued work item surfaces a 'Run' move with run action", () => {
    const task = createTask({ title: "Reply to Aileen", template: "..." });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Reply to Aileen",
      notes: "Aileen asked about the OTP",
    });

    const res = callNextMove();
    expect(res.hasMove).toBe(true);
    expect(res.itemId).toBe(`wi:${wi.id}`);
    expect(res.kind).toBe("work_item");
    // Deterministic fallback (no provider): "Run: <title>" + notes.
    expect(res.headline).toBe("Run: Reply to Aileen");
    expect(res.reasoning).toBe("Aileen asked about the OTP");
    expect(res.actions.some((a) => a.kind === "run")).toBe(true);
  });

  test("a pending approval outranks a queued work item", () => {
    const task = createTask({ title: "Queued task", template: "..." });
    createWorkItem({ taskId: task.id, title: "Queued task" });

    register("req-1", {
      conversationId: "conv-1",
      kind: "confirmation",
      confirmationDetails: {
        toolName: "send_email",
        input: {},
        riskLevel: "high",
        reversibility: "reversible" as const,
        allowlistOptions: [],
        scopeOptions: [],
      },
    });

    const res = callNextMove();
    expect(res.kind).toBe("approval");
    expect(res.itemId).toBe("int:req-1");
    expect(res.headline).toBe("Approve: send_email");
    expect(res.actions.map((a) => a.kind).sort()).toEqual([
      "approve",
      "decline",
    ]);
  });

  test("awaiting_review outranks queued; oldest-within-tier wins", () => {
    const task = createTask({ title: "t", template: "..." });
    const queued = createWorkItem({ taskId: task.id, title: "Queued one" });
    const review = createWorkItem({ taskId: task.id, title: "Review me" });
    updateWorkItem(review.id, { status: "awaiting_review" });

    const res = callNextMove();
    expect(res.itemId).toBe(`wi:${review.id}`);
    expect(res.itemId).not.toBe(`wi:${queued.id}`);
  });

  /** Force an item's last_activity_at to a fixed epoch (bypasses the auto-bump). */
  function setLastActivity(id: string, at: number): void {
    // `at` is a caller-controlled number and `id` a store-minted uuid — safe to
    // inline. drizzle's raw .run() takes a single SQL string (no param array).
    getDb().run(
      `UPDATE work_items SET last_activity_at = ${Math.floor(at)} WHERE id = '${id}'`,
    );
  }

  const DAY = 24 * 60 * 60 * 1000;

  test("a fresh due-soon item outranks an old no-activity drifter (the stale-item fix)", () => {
    const task = createTask({ title: "t", template: "..." });

    // Old zombie: created 3 weeks ago, no activity in 20 days, no deadline.
    // Under the OLD oldest-first ranking this dominated forever.
    const drifter = createWorkItem({
      taskId: task.id,
      title: "3-week drifter",
    });
    setLastActivity(drifter.id, Date.now() - 20 * DAY);

    // Fresh, due within the hour.
    const dueSoon = createWorkItem({
      taskId: task.id,
      title: "Due within the hour",
      dueAt: Date.now() + 60 * 60 * 1000,
    });
    setLastActivity(dueSoon.id, Date.now());

    __resetNextMoveCacheForTest();
    const res = callNextMove();
    expect(res.itemId).toBe(`wi:${dueSoon.id}`);
    expect(res.itemId).not.toBe(`wi:${drifter.id}`);
  });

  test("with no deadlines, the freshest item wins (not the oldest)", () => {
    const task = createTask({ title: "t", template: "..." });
    const older = createWorkItem({
      taskId: task.id,
      title: "Older, still active",
    });
    setLastActivity(older.id, Date.now() - 2 * DAY);
    const fresher = createWorkItem({ taskId: task.id, title: "Touched today" });
    setLastActivity(fresher.id, Date.now());

    __resetNextMoveCacheForTest();
    expect(callNextMove().itemId).toBe(`wi:${fresher.id}`);
  });

  test("a due drifter is NOT deprioritized as stale — a deadline keeps it live", () => {
    const task = createTask({ title: "t", template: "..." });
    // Stale by activity (25 days) but carries an overdue deadline.
    const staleButDue = createWorkItem({
      taskId: task.id,
      title: "Overdue and untouched",
      dueAt: Date.now() - DAY,
    });
    setLastActivity(staleButDue.id, Date.now() - 25 * DAY);
    // A fresh item with no deadline.
    const freshNoDue = createWorkItem({
      taskId: task.id,
      title: "Fresh, no due",
    });
    setLastActivity(freshNoDue.id, Date.now());

    __resetNextMoveCacheForTest();
    // Due-soon/overdue beats a fresh-but-undated item.
    expect(callNextMove().itemId).toBe(`wi:${staleButDue.id}`);
  });

  test("an expired deadline (9 days past due) no longer wins the top slot", () => {
    const task = createTask({ title: "t", template: "..." });
    // The mobile-UAT bug: "HK LP trip Jul 6-10 … Review BEFORE Monday" was
    // still THE next move 9+ days after its deadline passed, because any
    // past-due date counted as "due soon" forever and the sooner-deadline
    // axis made the MOST overdue item win. An expired deadline must not
    // outrank live work.
    const expired = createWorkItem({
      taskId: task.id,
      title: "Review BEFORE Monday (trip ended)",
      dueAt: Date.now() - 9 * DAY,
    });
    setLastActivity(expired.id, Date.now() - 9 * DAY);

    const fresh = createWorkItem({
      taskId: task.id,
      title: "Touched today, no deadline",
    });
    setLastActivity(fresh.id, Date.now());

    __resetNextMoveCacheForTest();
    expect(callNextMove().itemId).toBe(`wi:${fresh.id}`);
  });

  test("an expired-deadline item is demoted, never hidden", () => {
    const task = createTask({ title: "t", template: "..." });
    // Conservative contract: when the expired item is all there is, it still
    // surfaces as the next move — expiry un-boosts, it does not filter.
    const expired = createWorkItem({
      taskId: task.id,
      title: "Only overdue thing left",
      dueAt: Date.now() - 9 * DAY,
    });
    setLastActivity(expired.id, Date.now() - 9 * DAY);

    __resetNextMoveCacheForTest();
    const res = callNextMove();
    expect(res.hasMove).toBe(true);
    expect(res.itemId).toBe(`wi:${expired.id}`);
  });

  test("overdue within the grace window still outranks fresh undated work", () => {
    const task = createTask({ title: "t", template: "..." });
    // 1 day past due (inside OVERDUE_GRACE_MS) — deadline pressure is live.
    const justOverdue = createWorkItem({
      taskId: task.id,
      title: "Missed yesterday's deadline",
      dueAt: Date.now() - DAY,
    });
    setLastActivity(justOverdue.id, Date.now() - 5 * DAY);

    const fresh = createWorkItem({
      taskId: task.id,
      title: "Fresh, no deadline",
    });
    setLastActivity(fresh.id, Date.now());

    __resetNextMoveCacheForTest();
    expect(callNextMove().itemId).toBe(`wi:${justOverdue.id}`);
  });

  test("a pinned-project item outranks an unpinned one of equal freshness", () => {
    const task = createTask({ title: "t", template: "..." });
    const pinnedProject = createProject({ title: "Pinned", pinned: true });
    const now = Date.now();

    const unpinned = createWorkItem({ taskId: task.id, title: "Unpinned" });
    setLastActivity(unpinned.id, now);
    const pinned = createWorkItem({
      taskId: task.id,
      title: "In pinned project",
      projectId: pinnedProject.id,
    });
    setLastActivity(pinned.id, now);

    __resetNextMoveCacheForTest();
    expect(callNextMove().itemId).toBe(`wi:${pinned.id}`);
  });

  test("caches by top item id and serves the same itemId on repeat calls", () => {
    const task = createTask({ title: "Cached task", template: "..." });
    const wi = createWorkItem({ taskId: task.id, title: "Cached task" });

    const a = callNextMove();
    const b = callNextMove();
    expect(a.itemId).toBe(`wi:${wi.id}`);
    expect(b.itemId).toBe(`wi:${wi.id}`);
  });
});
