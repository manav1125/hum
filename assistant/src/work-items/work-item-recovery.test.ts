/**
 * WS3 startup work-item recovery: stranded `running` items are requeued
 * (bounded by recovery_attempts), then failed as a recovery incident past the
 * cap; non-running items are untouched.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { listWorkItemEvents } from "./work-item-events.js";
import {
  MAX_WORK_ITEM_RECOVERY_ATTEMPTS,
  recoverOrphanedWorkItemRuns,
} from "./work-item-recovery.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  type WorkItemStatus,
} from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM work_item_events");
  getDb().run("DELETE FROM tasks");
});

function makeRunning(recoveryAttempts = 0): string {
  const task = createTask({ title: "t", template: "do" });
  const item = createWorkItem({ taskId: task.id, title: "w" });
  updateWorkItem(item.id, { status: "running", recoveryAttempts });
  return item.id;
}

describe("recoverOrphanedWorkItemRuns", () => {
  test("requeues a stranded running item and bumps recovery_attempts", () => {
    const id = makeRunning(0);
    const r = recoverOrphanedWorkItemRuns();
    expect(r.requeued).toBe(1);
    expect(r.stalled).toBe(0);
    const item = getWorkItem(id)!;
    expect(item.status).toBe("queued");
    expect(item.recoveryAttempts).toBe(1);
    expect(item.livenessState).toBe("recovered");
    expect(item.lastProgressNote).toBeNull();
    expect(listWorkItemEvents(id).some((e) => e.kind === "run_recovered")).toBe(
      true,
    );
  });

  test("fails an item that has already stranded up to the cap", () => {
    const id = makeRunning(MAX_WORK_ITEM_RECOVERY_ATTEMPTS);
    const r = recoverOrphanedWorkItemRuns();
    expect(r.stalled).toBe(1);
    expect(r.requeued).toBe(0);
    const item = getWorkItem(id)!;
    expect(item.status).toBe("failed");
    expect(item.livenessState).toBe("stalled");
  });

  test("does not touch non-running items", () => {
    const task = createTask({ title: "t", template: "do" });
    const queued = createWorkItem({ taskId: task.id, title: "q" });
    const done = createWorkItem({ taskId: task.id, title: "d" });
    updateWorkItem(done.id, { status: "done" as WorkItemStatus });

    const r = recoverOrphanedWorkItemRuns();
    expect(r.requeued + r.stalled).toBe(0);
    expect(getWorkItem(queued.id)!.status).toBe("queued");
    expect(getWorkItem(done.id)!.status).toBe("done");
  });

  test("is a no-op with no running items", () => {
    expect(recoverOrphanedWorkItemRuns()).toEqual({
      requeued: 0,
      stalled: 0,
      ids: [],
    });
  });
});
