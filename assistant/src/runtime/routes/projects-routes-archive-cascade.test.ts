/**
 * Archive-cascade regression tests (UAT 2026-07-21 P2): archiving a project
 * must park + archive its still-open work items so nothing stays runnable
 * inside an archived container, while terminal items (done/cancelled) keep
 * their status. Also covers the archived-projects listing path the mobile
 * Done tab reads (`listProjects({ status: "archived" })`).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createProject,
  getProject,
  listProjects,
} from "../../work-items/project-store.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { archiveProjectWorkItems, ROUTES } from "./projects-routes.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
});

function seedProjectWithItems() {
  const project = createProject({ title: "Cascade" });
  const taskId = createTask({ title: "t", template: "do it" }).id;

  const queued = createWorkItem({
    taskId,
    title: "Queued",
    projectId: project.id,
  });
  const review = createWorkItem({
    taskId,
    title: "Review",
    projectId: project.id,
  });
  updateWorkItem(review.id, { status: "awaiting_review" });
  const failed = createWorkItem({
    taskId,
    title: "Failed",
    projectId: project.id,
  });
  updateWorkItem(failed.id, { status: "failed" });
  const done = createWorkItem({
    taskId,
    title: "Done",
    projectId: project.id,
  });
  updateWorkItem(done.id, { status: "done" });
  const running = createWorkItem({
    taskId,
    title: "Running",
    projectId: project.id,
  });
  updateWorkItem(running.id, { status: "running" });

  return { project, queued, review, failed, done, running };
}

describe("archiveProjectWorkItems", () => {
  test("archives open items (queued/awaiting_review/failed) and parks them", () => {
    const { project, queued, review, failed, done, running } =
      seedProjectWithItems();

    const archived = archiveProjectWorkItems(project.id);
    expect(archived).toBe(3);

    expect(getWorkItem(queued.id)!.status).toBe("archived");
    expect(getWorkItem(queued.id)!.autoRunEligibility).toBe("parked");
    expect(getWorkItem(review.id)!.status).toBe("archived");
    expect(getWorkItem(failed.id)!.status).toBe("archived");
    // Terminal + in-flight items are untouched.
    expect(getWorkItem(done.id)!.status).toBe("done");
    expect(getWorkItem(running.id)!.status).toBe("running");
  });
});

describe("updateProject route archive transition", () => {
  const patchRoute = ROUTES.find((r) => r.operationId === "updateProject")!;

  test("archiving via PATCH cascades to open work items", async () => {
    const { project, queued, done } = seedProjectWithItems();

    await patchRoute.handler({
      pathParams: { id: project.id },
      body: { status: "archived" },
    } as never);

    expect(getProject(project.id)!.status).toBe("archived");
    expect(getWorkItem(queued.id)!.status).toBe("archived");
    expect(getWorkItem(done.id)!.status).toBe("done");

    // The archived project shows up under the Done/Archived listing filter.
    const archivedProjects = listProjects({ status: "archived" });
    expect(archivedProjects.map((p) => p.id)).toContain(project.id);
  });

  test("a non-status PATCH on an already-archived project does not re-cascade", async () => {
    const { project } = seedProjectWithItems();
    await patchRoute.handler({
      pathParams: { id: project.id },
      body: { status: "archived" },
    } as never);

    // Restore one item; a rename PATCH must not re-archive it.
    const taskId = createTask({ title: "t2", template: "x" }).id;
    const fresh = createWorkItem({
      taskId,
      title: "Fresh after archive",
      projectId: project.id,
    });
    await patchRoute.handler({
      pathParams: { id: project.id },
      body: { title: "Renamed" },
    } as never);
    expect(getWorkItem(fresh.id)!.status).toBe("queued");
  });
});
