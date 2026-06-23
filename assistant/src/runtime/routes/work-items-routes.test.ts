/**
 * Regression tests for empty required_tools snapshot bypass.
 *
 * Verifies that an explicitly empty `requiredTools: "[]"` snapshot on a work
 * item falls back to the task-level required tools instead of silently
 * skipping permission checks.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../permissions/checker.js", () => ({
  check: async () => ({ decision: "prompt" }),
  classifyRisk: async () => ({ level: "high" }),
}));

import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import { createWorkItem } from "../../work-items/work-item-store.js";
import { ForbiddenError } from "./errors.js";
import { preflightWorkItem, ROUTES } from "./work-items-routes.js";

initializeDb();

describe("empty required_tools snapshot bypass", () => {
  test("falls back to task required tools when snapshot requiredTools is empty", async () => {
    const task = createTask({
      title: "Test task",
      template: "Do something",
      requiredTools: ["host_bash"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Test work item",
      requiredTools: JSON.stringify([]),
    });

    const result = await preflightWorkItem(workItem.id);
    expect(result.success).toBe(true);
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions![0].tool).toBe("host_bash");
  });

  test("rejects run when snapshot requiredTools is empty but task tools are unapproved", async () => {
    const task = createTask({
      title: "Test task for run",
      template: "Do something",
      requiredTools: ["host_bash"],
    });

    const workItem = createWorkItem({
      taskId: task.id,
      title: "Test work item for run",
      requiredTools: JSON.stringify([]),
    });

    const runRoute = ROUTES.find(
      (r) => r.endpoint === "work-items/:id/run" && r.method === "POST",
    )!;

    await expect(
      runRoute.handler({
        pathParams: { id: workItem.id },
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("listWorkItems status filter", () => {
  const listRoute = ROUTES.find(
    (r) => r.endpoint === "work-items" && r.method === "GET",
  )!;

  function listByStatus(status?: string) {
    const result = listRoute.handler({
      queryParams: status ? { status } : {},
      headers: {},
    }) as { items: Array<{ id: string; status: string }> };
    return result.items;
  }

  test("?status=pending surfaces freshly-queued work items (alias → 'queued')", () => {
    // A "Run it" / needs_you dispatch creates a work item with store status
    // "queued". The Activity "Queued" section queries `?status=pending`. The
    // alias must translate so the item is visible rather than silently dropped.
    const task = createTask({ title: "Queued task", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Queued task" });
    expect(wi.status).toBe("queued");

    const pending = listByStatus("pending");
    expect(pending.some((i) => i.id === wi.id)).toBe(true);
    // Every returned row is genuinely queued — the alias didn't widen the query.
    expect(pending.every((i) => i.status === "queued")).toBe(true);
  });

  test("?status=queued still works directly", () => {
    const task = createTask({ title: "Direct queued", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Direct queued" });

    const queued = listByStatus("queued");
    expect(queued.some((i) => i.id === wi.id)).toBe(true);
  });
});
