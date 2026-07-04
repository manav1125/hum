/**
 * Regression tests for empty required_tools snapshot bypass.
 *
 * Verifies that an explicitly empty `requiredTools: "[]"` snapshot on a work
 * item falls back to the task-level required tools instead of silently
 * skipping permission checks.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

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

// Stub the task runner so "Run now" doesn't drive a real LLM turn. The
// callback is never invoked, so the background run resolves with a
// completed status and the work item transitions to awaiting_review.
mock.module("../../tasks/task-runner.js", () => ({
  runTask: async () => ({
    status: "completed",
    taskRunId: "test-run",
    conversationId: "test-convo",
  }),
}));

// The createWorkItem route fires a fire-and-forget triage pass; stub it for
// this file's tests so no flash-LLM sidechain spins up in the background, and
// record the calls so the skipAutoRun contract is assertable. Captured by
// value + restored in afterAll so the mock doesn't leak into other test files
// sharing the same `bun test` process (mirrors work-item-triage.test.ts).
import * as workItemTriage from "../../work-items/work-item-triage.js";

const realTriageAndMaybeAutoRunWorkItem =
  workItemTriage.triageAndMaybeAutoRunWorkItem;

const triageCalls: Array<{ id: string; opts: unknown }> = [];

beforeAll(() => {
  mock.module("../../work-items/work-item-triage.js", () => ({
    ...workItemTriage,
    triageAndMaybeAutoRunWorkItem: (id: string, opts: unknown) => {
      triageCalls.push({ id, opts });
      return Promise.resolve({ autoRunStarted: false, reason: "skipped" });
    },
  }));
});

afterAll(() => {
  mock.module("../../work-items/work-item-triage.js", () => ({
    ...workItemTriage,
    triageAndMaybeAutoRunWorkItem: realTriageAndMaybeAutoRunWorkItem,
  }));
});

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import { createProject } from "../../work-items/project-store.js";
import {
  createWorkItem,
  getWorkItem,
  type WorkItem,
} from "../../work-items/work-item-store.js";
import { preflightWorkItem, ROUTES } from "./work-items-routes.js";

initializeDb();

// This suite assumes a clean work_items table. Clear DB-backed state before
// each test so it doesn't depend on rows left behind by an earlier test file
// running in the same `bun test` process (mirrors work-item-triage.test.ts and
// project-store.test.ts).
beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM projects");
});

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

  test("run auto-approves required tools and starts the background run", async () => {
    // Clicking "Run now" is explicit user consent: the route delegates to
    // the canonical background runner (the same path the working CLI uses),
    // which auto-approves the work item's required tools instead of
    // rejecting with a 403 when nothing was pre-approved. The previous
    // 403-on-unapproved behavior was the "Run now does nothing" bug.
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

    const result = (await runRoute.handler({
      pathParams: { id: workItem.id },
      headers: {},
    })) as { id: string; success: boolean };

    expect(result.success).toBe(true);
    expect(result.id).toBe(workItem.id);
    // The runner flips the item out of "queued" synchronously before the
    // async run begins.
    expect(getWorkItem(workItem.id)!.status).not.toBe("queued");
  });

  test("run rejects a non-existent work item with NotFoundError", () => {
    const runRoute = ROUTES.find(
      (r) => r.endpoint === "work-items/:id/run" && r.method === "POST",
    )!;

    // The handler is synchronous (it kicks off the run in the background and
    // returns immediately), so the not-found guard throws synchronously.
    expect(() =>
      runRoute.handler({
        pathParams: { id: "does-not-exist" },
        headers: {},
      }),
    ).toThrow("Work item not found");
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

describe("POST work-items (createWorkItem)", () => {
  const createRoute = ROUTES.find(
    (r) => r.endpoint === "work-items" && r.method === "POST",
  )!;
  const listRoute = ROUTES.find(
    (r) => r.endpoint === "work-items" && r.method === "GET",
  )!;

  test("creates a queued item filed into the project, visible in GET ?projectId=", () => {
    // The project-board quick-add path: one POST with title + projectId must
    // land a persisted, filed work item (the old create→find→patch dance went
    // through /tasks/queue/add, which is LOCAL_PRINCIPALS-only and 403'd for
    // web actor principals — no item was ever created).
    const project = createProject({ title: "Launch" });

    const result = createRoute.handler({
      headers: {},
      body: {
        title: "Draft the launch email",
        notes: "Keep it under 200 words",
        projectId: project.id,
      },
    }) as { item: WorkItem };

    expect(result.item.id).toBeTruthy();
    expect(result.item.status).toBe("queued");
    expect(result.item.title).toBe("Draft the launch email");
    expect(result.item.notes).toBe("Keep it under 200 words");
    expect(result.item.projectId).toBe(project.id);

    // Manual origin is stamped at creation (not left for triage to guess).
    const sourceContext = JSON.parse(result.item.sourceContext!) as {
      origin: string;
      snippet: string;
    };
    expect(sourceContext.origin).toBe("manual");
    expect(sourceContext.snippet).toBe("Keep it under 200 words");

    // Persisted, and round-trips through the project-filtered list the
    // board reads.
    expect(getWorkItem(result.item.id)!.projectId).toBe(project.id);
    const listed = listRoute.handler({
      queryParams: { projectId: project.id },
      headers: {},
    }) as { items: Array<{ id: string }> };
    expect(listed.items.some((i) => i.id === result.item.id)).toBe(true);
  });

  test("runs triage with auto-run suppressed", () => {
    triageCalls.length = 0;

    const result = createRoute.handler({
      headers: {},
      body: { title: "Manual add, no project" },
    }) as { item: WorkItem };

    expect(triageCalls).toHaveLength(1);
    expect(triageCalls[0].id).toBe(result.item.id);
    expect(triageCalls[0].opts).toEqual({ skipAutoRun: true });
  });

  test("400s on a missing or blank title", () => {
    expect(() => createRoute.handler({ headers: {}, body: {} })).toThrow(
      "title is required",
    );
    expect(() =>
      createRoute.handler({ headers: {}, body: { title: "   " } }),
    ).toThrow("title is required");
  });
});

describe("PATCH work-items/:id", () => {
  const patchRoute = ROUTES.find(
    (r) => r.endpoint === "work-items/:id" && r.method === "PATCH",
  )!;

  test("404s on a nonexistent work item instead of 200 {item: null}", () => {
    // Regression: the handler used to fall through to updateWorkItem (a
    // no-op on a missing row) and return {"item": null} with a 200, so
    // clients patching a stale/deleted id never learned the item was gone.
    expect(() =>
      patchRoute.handler({
        pathParams: { id: "wi-does-not-exist" },
        headers: {},
        body: { title: "new title" },
      }),
    ).toThrow("Work item not found");
  });

  test("updates an existing work item and returns it", () => {
    const task = createTask({ title: "Patch me", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Patch me" });

    const result = patchRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
      body: { title: "Patched title", priorityTier: 0 },
    }) as { item: { id: string; title: string; priorityTier: number } };

    expect(result.item).not.toBeNull();
    expect(result.item.id).toBe(wi.id);
    expect(result.item.title).toBe("Patched title");
    expect(result.item.priorityTier).toBe(0);
  });
});
