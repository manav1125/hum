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
  updateWorkItem,
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

  test("an explicit run clears the user-parked marker", async () => {
    const task = createTask({
      title: "Parked task",
      template: "Do something",
      requiredTools: ["host_bash"],
    });
    const workItem = createWorkItem({
      taskId: task.id,
      title: "Parked quick-add",
      requiredTools: JSON.stringify([]),
      autoRunEligibility: "parked",
    });

    const runRoute = ROUTES.find(
      (r) => r.endpoint === "work-items/:id/run" && r.method === "POST",
    )!;
    const result = (await runRoute.handler({
      pathParams: { id: workItem.id },
      headers: {},
    })) as { success: boolean };

    expect(result.success).toBe(true);
    // Dispatch consumed the parked marker: the user said "run", so the item
    // is no longer parked (and stranded-run recovery may retry it).
    expect(getWorkItem(workItem.id)!.autoRunEligibility).toBeNull();
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

  test("a below-confidence stamp serializes for UNFILED items (the amber '?' wire shape)", () => {
    // The auto-file sweep stamps auto_file_confidence on a sub-threshold item
    // while project_id and auto_filed_by stay null. Clients feature-detect
    // exactly that trio (work-kit's isBelowConfidence), so the list DTO must
    // carry the confidence even though the item is unfiled.
    const task = createTask({ title: "Unsure task", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Unsure task" });
    updateWorkItem(wi.id, { autoFileConfidence: 0.35 });

    const result = listRoute.handler({
      queryParams: { status: "pending" },
      headers: {},
    }) as {
      items: Array<{
        id: string;
        projectId: string | null;
        autoFiledBy: string | null;
        autoFileConfidence: number | null;
      }>;
    };
    const served = result.items.find((i) => i.id === wi.id)!;
    expect(served).toBeDefined();
    expect(served.projectId).toBeNull();
    expect(served.autoFiledBy).toBeNull();
    expect(served.autoFileConfidence).toBe(0.35);
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

    // Quick-adds are user-parked: the durable marker keeps the queue
    // drainer (and any other auto-run pass) from ever starting this item
    // without an explicit run.
    expect(result.item.autoRunEligibility).toBe("parked");
    expect(getWorkItem(result.item.id)!.autoRunEligibility).toBe("parked");

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

describe("POST work-items/:id/complete", () => {
  const completeRoute = ROUTES.find(
    (r) => r.endpoint === "work-items/:id/complete" && r.method === "POST",
  )!;

  function makeItem(status?: string) {
    const task = createTask({ title: "Complete me", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Complete me" });
    if (status && status !== "queued") {
      updateWorkItem(wi.id, {
        status: status as Parameters<typeof updateWorkItem>[1]["status"],
      });
    }
    return getWorkItem(wi.id)!;
  }

  test("without the flag: awaiting_review → done, no completedElsewhere marker", () => {
    const wi = makeItem("awaiting_review");
    const result = completeRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
    }) as { item: { status: string; completedElsewhere: boolean } };

    expect(result.item.status).toBe("done");
    // Wire DTO carries the field, and it is honestly false: Cue's run was
    // reviewed and signed off — the plain complete path is unchanged.
    expect(result.item.completedElsewhere).toBe(false);
    expect(getWorkItem(wi.id)!.completedElsewhere).toBe(0);
  });

  test("without the flag: still 409s on a queued item", () => {
    const wi = makeItem();
    expect(() =>
      completeRoute.handler({ pathParams: { id: wi.id }, headers: {} }),
    ).toThrow("expected 'awaiting_review'");
  });

  test("completedElsewhere: true completes a queued item and stamps the marker", () => {
    const wi = makeItem();
    const result = completeRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
      body: { completedElsewhere: true },
    }) as {
      item: {
        status: string;
        completedElsewhere: boolean;
        ranProvenance: string | null;
      };
    };

    expect(result.item.status).toBe("done");
    expect(result.item.completedElsewhere).toBe(true);
    // The owner did the work — never "Cue finished this".
    expect(result.item.ranProvenance).toBe("manual");
    expect(getWorkItem(wi.id)!.completedElsewhere).toBe(1);
  });

  test("completedElsewhere: true from awaiting_review is manual, not approved", () => {
    const wi = makeItem("awaiting_review");
    // Simulate a prior run so the classifier would otherwise say auto.
    updateWorkItem(wi.id, {
      lastRunConversationId: "conv-x",
      lastRunStatus: "completed",
    });

    const result = completeRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
      body: { completedElsewhere: true },
    }) as { item: { completedElsewhere: boolean; ranProvenance: string } };

    expect(result.item.completedElsewhere).toBe(true);
    // The elsewhere marker wins over the run conversation: the terminal
    // outcome is the human's.
    expect(result.item.ranProvenance).toBe("manual");

    // The audit trail records completed_elsewhere, NOT the review sign-off
    // "approved" kind — the ledger must not credit Cue.
    const eventsRoute = ROUTES.find(
      (r) => r.endpoint === "work-items/:id/events" && r.method === "GET",
    )!;
    const { events } = eventsRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
    }) as { events: Array<{ kind: string }> };
    expect(events.some((e) => e.kind === "completed_elsewhere")).toBe(true);
    expect(events.some((e) => e.kind === "approved")).toBe(false);
  });

  test("completedElsewhere: true 409s on running and terminal items", () => {
    for (const status of ["running", "done", "cancelled"]) {
      const wi = makeItem(status);
      expect(() =>
        completeRoute.handler({
          pathParams: { id: wi.id },
          headers: {},
          body: { completedElsewhere: true },
        }),
      ).toThrow("Cannot complete work item as done elsewhere");
    }
  });

  test("completedElsewhere: false behaves exactly like no body", () => {
    const wi = makeItem();
    expect(() =>
      completeRoute.handler({
        pathParams: { id: wi.id },
        headers: {},
        body: { completedElsewhere: false },
      }),
    ).toThrow("expected 'awaiting_review'");
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

  test("an explicit unfile stamps the user_unfiled guard; a user filing clears auto provenance", () => {
    const project = createProject({ title: "Ops" });
    const task = createTask({ title: "Filed by cue", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Filed by cue" });
    // Simulate the auto-filer's stamp.
    updateWorkItem(wi.id, {
      projectId: project.id,
      autoFiledBy: "cue",
      autoFileConfidence: 0.9,
    });

    // User deliberately unfiles → guard stamped so the auto-filer never
    // re-files this item, confidence cleared.
    patchRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
      body: { projectId: null },
    });
    let after = getWorkItem(wi.id)!;
    expect(after.projectId).toBeNull();
    expect(after.autoFiledBy).toBe("user_unfiled");
    expect(after.autoFileConfidence).toBeNull();

    // User later files it by hand → it's a user decision now, no auto chip
    // and no lingering guard.
    patchRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
      body: { projectId: project.id },
    });
    after = getWorkItem(wi.id)!;
    expect(after.projectId).toBe(project.id);
    expect(after.autoFiledBy).toBeNull();
    expect(after.autoFileConfidence).toBeNull();
  });
});

describe("life lens + waiting fields on the work-item API", () => {
  const listRoute = ROUTES.find(
    (r) => r.endpoint === "work-items" && r.method === "GET",
  )!;
  const createRoute = ROUTES.find(
    (r) => r.endpoint === "work-items" && r.method === "POST",
  )!;
  const getRoute = ROUTES.find(
    (r) => r.endpoint === "work-items/:id" && r.method === "GET",
  )!;
  const patchRoute = ROUTES.find(
    (r) => r.endpoint === "work-items/:id" && r.method === "PATCH",
  )!;

  interface LensDto {
    id: string;
    domain: string;
    horizon: string | null;
    waitingOn: string | null;
    lastChasedAt: number | null;
    waitingState: string | null;
  }

  function list(queryParams: Record<string, string>): LensDto[] {
    return (
      listRoute.handler({ queryParams, headers: {} }) as { items: LensDto[] }
    ).items;
  }

  test("an unaware client creates exactly what it did before: a work item", () => {
    // The whole additive contract in one assertion. A caller that has never
    // heard of lenses must not be able to put anything into Life by accident,
    // because Life is what "hide for the screen-share" hides.
    const created = createRoute.handler({
      headers: {},
      body: { title: "Ship the release notes" },
    }) as { item: LensDto };

    expect(created.item.domain).toBe("work");
    expect(created.item.horizon).toBeNull();
    expect(created.item.waitingOn).toBeNull();
    expect(created.item.lastChasedAt).toBeNull();
    expect(created.item.waitingState).toBeNull();
  });

  test("create → read round-trips all four fields", () => {
    const created = (
      createRoute.handler({
        headers: {},
        body: {
          title: "Renew the passport",
          domain: "life",
          horizon: "someday",
          waitingOn: "contact-passport-office",
          lastChasedAt: 1_785_000_000_000,
        },
      }) as { item: LensDto }
    ).item;

    expect(created.domain).toBe("life");
    expect(created.horizon).toBe("someday");
    expect(created.waitingOn).toBe("contact-passport-office");
    expect(created.lastChasedAt).toBe(1_785_000_000_000);

    // …and the same four survive a separate read, not just the create echo.
    const fetched = (
      getRoute.handler({
        pathParams: { id: created.id },
        headers: {},
      }) as { item: LensDto }
    ).item;
    expect(fetched.domain).toBe("life");
    expect(fetched.horizon).toBe("someday");
    expect(fetched.waitingOn).toBe("contact-passport-office");
    expect(fetched.lastChasedAt).toBe(1_785_000_000_000);
  });

  test("PATCH moves an item into Life and sets its horizon", () => {
    const task = createTask({ title: "Book the dentist", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Book the dentist" });
    expect(wi.domain).toBe("work");

    const patched = (
      patchRoute.handler({
        pathParams: { id: wi.id },
        headers: {},
        body: { domain: "life", horizon: "this_week" },
      }) as { item: LensDto }
    ).item;

    expect(patched.domain).toBe("life");
    expect(patched.horizon).toBe("this_week");
    expect(getWorkItem(wi.id)!.horizon).toBe("this_week");
  });

  test("moving back to Work drops the horizon instead of leaving dead data", () => {
    // Work groups by mission; a lingering "someday" would be a value no
    // reader on the work side has any use for, and one the life grouping
    // would pick up again the moment the item moved back.
    const task = createTask({ title: "Fix the boiler", template: "Do it" });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Fix the boiler",
      domain: "life",
      horizon: "soon",
    });
    expect(wi.horizon).toBe("soon");

    patchRoute.handler({
      pathParams: { id: wi.id },
      headers: {},
      body: { domain: "work" },
    });

    const after = getWorkItem(wi.id)!;
    expect(after.domain).toBe("work");
    expect(after.horizon).toBeNull();
  });

  test("PATCH sets and clears the waiting fields", () => {
    const task = createTask({ title: "Acme contract", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Acme contract" });

    const chasedAt = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const waiting = (
      patchRoute.handler({
        pathParams: { id: wi.id },
        headers: {},
        body: { waitingOn: "contact-rachel", lastChasedAt: chasedAt },
      }) as { item: LensDto }
    ).item;
    expect(waiting.waitingOn).toBe("contact-rachel");
    expect(waiting.lastChasedAt).toBe(chasedAt);
    // Derived server-side so every surface draws the same line: chased, and
    // the silence has outlasted the five-day window.
    expect(waiting.waitingState).toBe("going_cold");

    const cleared = (
      patchRoute.handler({
        pathParams: { id: wi.id },
        headers: {},
        body: { waitingOn: null, lastChasedAt: null },
      }) as { item: LensDto }
    ).item;
    expect(cleared.waitingOn).toBeNull();
    expect(cleared.lastChasedAt).toBeNull();
    expect(cleared.waitingState).toBeNull();
  });

  test("the list DTO carries the derived waiting state", () => {
    const task = createTask({ title: "Legal review", template: "Do it" });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Legal review",
      waitingOn: "contact-sam",
    });

    const served = list({}).find((i) => i.id === wi.id)!;
    expect(served.waitingOn).toBe("contact-sam");
    expect(served.waitingState).toBe("on_time");
  });

  test("?domain filters the list, and omitting it returns both lenses", () => {
    const workTask = createTask({ title: "Board deck", template: "Do it" });
    const workItem = createWorkItem({
      taskId: workTask.id,
      title: "Board deck",
    });
    const lifeTask = createTask({ title: "Renew passport", template: "Do it" });
    const lifeItem = createWorkItem({
      taskId: lifeTask.id,
      title: "Renew passport",
      domain: "life",
      horizon: "soon",
    });

    const ids = (items: LensDto[]) => items.map((i) => i.id);

    // The privacy switch: ?domain=work must not leak a single life row.
    const workOnly = list({ domain: "work" });
    expect(ids(workOnly)).toContain(workItem.id);
    expect(ids(workOnly)).not.toContain(lifeItem.id);
    expect(workOnly.every((i) => i.domain === "work")).toBe(true);

    const lifeOnly = list({ domain: "life" });
    expect(ids(lifeOnly)).toEqual([lifeItem.id]);

    // No filter = the old behaviour, unchanged.
    const both = ids(list({}));
    expect(both).toContain(workItem.id);
    expect(both).toContain(lifeItem.id);
  });

  test("?domain composes with ?status instead of replacing it", () => {
    // Drizzle's `.where()` assigns rather than appends, so stacking filters
    // used to keep only the last one — with the lens on top of a status that
    // would have served done life items into a queued work list.
    const t1 = createTask({ title: "Queued work", template: "Do it" });
    const queuedWork = createWorkItem({ taskId: t1.id, title: "Queued work" });
    const t2 = createTask({ title: "Queued life", template: "Do it" });
    const queuedLife = createWorkItem({
      taskId: t2.id,
      title: "Queued life",
      domain: "life",
    });
    const t3 = createTask({ title: "Done life", template: "Do it" });
    const doneLife = createWorkItem({
      taskId: t3.id,
      title: "Done life",
      domain: "life",
    });
    updateWorkItem(doneLife.id, { status: "done" });

    const queuedLifeOnly = list({ status: "queued", domain: "life" });
    expect(queuedLifeOnly.map((i) => i.id)).toEqual([queuedLife.id]);
    expect(queuedLifeOnly.map((i) => i.id)).not.toContain(queuedWork.id);
    expect(queuedLifeOnly.map((i) => i.id)).not.toContain(doneLife.id);
  });

  test("an unknown domain is rejected rather than quietly widened", () => {
    // Failing open here would render a mistyped lens as "show everything",
    // i.e. personal work on a shared screen.
    expect(() =>
      listRoute.handler({ queryParams: { domain: "personal" }, headers: {} }),
    ).toThrow(/domain/);
    expect(() =>
      createRoute.handler({
        headers: {},
        body: { title: "x", domain: "misc" },
      }),
    ).toThrow(/domain/);
  });

  test("a PATCH that names only pre-existing fields leaves the lens alone", () => {
    // The wire contract the 21 existing callers depend on: none of the four
    // new keys is required on the request body, and omitting them is not the
    // same as clearing them.
    const task = createTask({ title: "Legacy patch", template: "Do it" });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Legacy patch",
      domain: "life",
      horizon: "soon",
      waitingOn: "contact-rachel",
    });

    const patched = (
      patchRoute.handler({
        pathParams: { id: wi.id },
        headers: {},
        body: { title: "Legacy patch, renamed", priorityTier: 0 },
      }) as { item: LensDto }
    ).item;

    expect(patched.domain).toBe("life");
    expect(patched.horizon).toBe("soon");
    expect(patched.waitingOn).toBe("contact-rachel");
  });

  test("an unknown horizon is rejected on both write paths", () => {
    const task = createTask({ title: "Horizon check", template: "Do it" });
    const wi = createWorkItem({ taskId: task.id, title: "Horizon check" });

    expect(() =>
      createRoute.handler({
        headers: {},
        body: { title: "y", domain: "life", horizon: "eventually" },
      }),
    ).toThrow(/horizon/);
    expect(() =>
      patchRoute.handler({
        pathParams: { id: wi.id },
        headers: {},
        body: { horizon: "eventually" },
      }),
    ).toThrow(/horizon/);
  });
});
