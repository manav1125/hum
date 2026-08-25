/**
 * Unit tests for the unified Mission Control read model (`activity_list`).
 *
 * Seeds a couple of work-items, a schedule, and a pending interaction in the
 * per-test temp workspace, calls the handler, and asserts the rows land in the
 * right lanes, carry the canonical controls, and the per-lane counts add up.
 */
import { describe, expect, test } from "bun:test";

import { initializeDb } from "../../memory/db-init.js";
import { createSchedule } from "../../schedule/schedule-store.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { register as registerInteraction } from "../pending-interactions.js";
import {
  type ActivityItem,
  buildActivityList,
  ROUTES,
} from "./activity-routes.js";

initializeDb();

function findById(items: ActivityItem[], id: string): ActivityItem | undefined {
  return items.find((i) => i.id === id);
}

describe("activity_list read model", () => {
  test("unions stores into lanes with canonical controls + counts", () => {
    const task = createTask({ title: "Activity task", template: "Do it" });

    // A queued work-item → scheduled lane (Run now + Cancel).
    const queued = createWorkItem({
      taskId: task.id,
      title: "Queued item",
    });

    // A running work-item → in_progress lane (Output + Cancel).
    const running = createWorkItem({
      taskId: task.id,
      title: "Running item",
    });
    updateWorkItem(running.id, { status: "running" });

    // A schedule → scheduled lane (Run now + Pause + Cancel).
    const schedule = createSchedule({
      name: "Daily digest",
      message: "Summarize the day",
      cronExpression: "0 9 * * *",
      enabled: true,
    });

    // A pending interaction → awaiting_you lane (Approve + Decline).
    registerInteraction("req-activity-1", {
      conversationId: "conv-activity-1",
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

    const { items, counts } = buildActivityList();

    // --- queued work-item: scheduled lane, Run now + Cancel ---
    const queuedItem = findById(items, `wi:${queued.id}`);
    expect(queuedItem).toBeDefined();
    expect(queuedItem!.lane).toBe("scheduled");
    expect(queuedItem!.controls.map((c) => c.id).sort()).toEqual([
      "cancel",
      "run",
    ]);
    const runControl = queuedItem!.controls.find((c) => c.id === "run")!;
    expect(runControl.method).toBe("POST");
    expect(runControl.endpoint).toBe(`/v1/work-items/${queued.id}/run`);

    // --- running work-item: in_progress lane, Output + Cancel ---
    const runningItem = findById(items, `wi:${running.id}`);
    expect(runningItem).toBeDefined();
    expect(runningItem!.lane).toBe("in_progress");
    expect(runningItem!.controls.map((c) => c.id).sort()).toEqual([
      "cancel",
      "output",
    ]);

    // --- schedule: scheduled lane, Run now + Pause + Cancel ---
    const scheduleItem = findById(items, `sched:${schedule.id}`);
    expect(scheduleItem).toBeDefined();
    expect(scheduleItem!.lane).toBe("scheduled");
    expect(scheduleItem!.kind).toBe("schedule");
    expect(scheduleItem!.controls.map((c) => c.id).sort()).toEqual([
      "cancel",
      "pause",
      "run",
    ]);

    // --- pending interaction: awaiting_you lane, Approve + Decline ---
    const interactionItem = findById(items, "int:req-activity-1");
    expect(interactionItem).toBeDefined();
    expect(interactionItem!.lane).toBe("awaiting_you");
    expect(interactionItem!.urgency).toBe("critical");
    expect(interactionItem!.controls.map((c) => c.id).sort()).toEqual([
      "approve",
      "decline",
    ]);
    expect(interactionItem!.controls[0].endpoint).toBe("/v1/confirm");

    // --- counts add up: every item is tallied into exactly one lane ---
    const total =
      counts.inbound +
      counts.awaiting_you +
      counts.in_progress +
      counts.scheduled +
      counts.done;
    expect(total).toBe(items.length);
    expect(counts.in_progress).toBeGreaterThanOrEqual(1);
    expect(counts.scheduled).toBeGreaterThanOrEqual(2); // queued WI + schedule
    expect(counts.awaiting_you).toBeGreaterThanOrEqual(1);
  });

  test("the route handler returns the same { items, counts } shape", () => {
    const route = ROUTES.find(
      (r) => r.operationId === "activity_list" && r.method === "GET",
    )!;
    expect(route).toBeDefined();
    expect(route.endpoint).toBe("activity");

    const result = route.handler({ headers: {} }) as {
      items: ActivityItem[];
      counts: Record<string, number>;
    };
    expect(Array.isArray(result.items)).toBe(true);
    expect(typeof result.counts.scheduled).toBe("number");
  });

  test("done work-items carry an inline result when a run conversation exists", () => {
    const task = createTask({ title: "Done task", template: "Do it" });
    const done = createWorkItem({ taskId: task.id, title: "Done item" });
    // Mark terminal but with no run conversation — result is omitted, not thrown.
    updateWorkItem(done.id, { status: "done" });

    const { items } = buildActivityList();
    const doneItem = findById(items, `wi:${done.id}`);
    expect(doneItem).toBeDefined();
    expect(doneItem!.lane).toBe("done");
    // No run conversation → no result attached (but no crash).
    expect(doneItem!.result).toBeUndefined();
  });
});
