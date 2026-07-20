/**
 * Tests for the project store's cowork PM fields (migration 288):
 * category/context/sortIndex/pinned round-tripping, the pinned/sortIndex
 * ordering in listProjects, reorderProjects, and getProjectWithStats
 * (per-status counts + most-urgent next task).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  createProject,
  getProject,
  getProjectWithStats,
  listProjects,
  listProjectsWithStats,
  reorderProjects,
  updateProject,
} from "./project-store.js";
import { createWorkItem, updateWorkItem } from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
});

describe("createProject / getProject with cowork fields", () => {
  test("round-trips category, context, sortIndex, and pinned", () => {
    const p = createProject({
      title: "Q4 launch",
      category: "professional",
      context: "Ship the new pricing page. Voice: confident, concise.",
      sortIndex: 3,
      pinned: true,
    });
    const fetched = getProject(p.id)!;
    expect(fetched.category).toBe("professional");
    expect(fetched.context).toContain("pricing page");
    expect(fetched.sortIndex).toBe(3);
    expect(fetched.pinned).toBe(1);
  });

  test("defaults the new fields when omitted", () => {
    const p = getProject(createProject({ title: "Bare" }).id)!;
    expect(p.category).toBeNull();
    expect(p.context).toBeNull();
    expect(p.sortIndex).toBeNull();
    expect(p.pinned).toBe(0);
  });

  test("updateProject can set and clear the new fields", () => {
    const p = createProject({ title: "P" });
    updateProject(p.id, {
      category: "personal",
      context: "brief",
      sortIndex: 1,
      pinned: 1,
    });
    let fetched = getProject(p.id)!;
    expect(fetched.category).toBe("personal");
    expect(fetched.pinned).toBe(1);
    updateProject(p.id, { context: null, pinned: 0 });
    fetched = getProject(p.id)!;
    expect(fetched.context).toBeNull();
    expect(fetched.pinned).toBe(0);
  });
});

describe("listProjects ordering", () => {
  test("pinned projects come first, then by sortIndex, then newest", () => {
    const a = createProject({ title: "A", sortIndex: 2 });
    const b = createProject({ title: "B", sortIndex: 1 });
    const pinned = createProject({
      title: "Pinned",
      pinned: true,
      sortIndex: 9,
    });
    const unordered = createProject({ title: "NoIndex" }); // sortIndex null → last

    const ids = listProjects().map((p) => p.id);
    // Pinned first regardless of its high sortIndex.
    expect(ids[0]).toBe(pinned.id);
    // Then the two with real sortIndex, ascending (b=1 before a=2).
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    // Null sortIndex sorts to the back.
    expect(ids[ids.length - 1]).toBe(unordered.id);
  });
});

describe("reorderProjects", () => {
  test("stamps sortIndex by position and reorders the list", () => {
    const a = createProject({ title: "A" });
    const b = createProject({ title: "B" });
    const c = createProject({ title: "C" });

    reorderProjects([c.id, a.id, b.id]);

    expect(getProject(c.id)!.sortIndex).toBe(0);
    expect(getProject(a.id)!.sortIndex).toBe(1);
    expect(getProject(b.id)!.sortIndex).toBe(2);

    expect(listProjects().map((p) => p.id)).toEqual([c.id, a.id, b.id]);
  });

  test("skips unknown ids without throwing", () => {
    const a = createProject({ title: "A" });
    expect(() => reorderProjects(["missing", a.id])).not.toThrow();
    expect(getProject(a.id)!.sortIndex).toBe(1);
  });
});

describe("getProjectWithStats", () => {
  test("returns undefined for a missing project", () => {
    expect(getProjectWithStats("nope")).toBeUndefined();
  });

  test("counts tasks by status and surfaces the most-urgent next task", () => {
    const project = createProject({ title: "Proj" });
    const taskId = createTask({ title: "t", template: "do it" }).id;

    // queued x2, one with a soon deadline; one awaiting_review; one done.
    const soon = Date.now() + 60_000;
    const queuedFar = createWorkItem({
      taskId,
      title: "Queued far",
      projectId: project.id,
    });
    const queuedDue = createWorkItem({
      taskId,
      title: "Queued due soon",
      projectId: project.id,
      dueAt: soon,
    });
    const review = createWorkItem({
      taskId,
      title: "Needs review",
      projectId: project.id,
    });
    updateWorkItem(review.id, { status: "awaiting_review" });
    const done = createWorkItem({
      taskId,
      title: "Finished",
      projectId: project.id,
    });
    updateWorkItem(done.id, { status: "done" });

    const stats = getProjectWithStats(project.id)!.stats;
    expect(stats.counts.queued).toBe(2);
    expect(stats.counts.awaiting_review).toBe(1);
    expect(stats.counts.done).toBe(1);
    expect(stats.counts.open).toBe(3); // 2 queued + 1 awaiting_review
    expect(stats.counts.total).toBe(4);

    // awaiting_review outranks queued for "next task".
    expect(stats.nextTask?.id).toBe(review.id);

    // With no awaiting_review, the due-soon queued item wins over the far one.
    updateWorkItem(review.id, { status: "done" });
    const stats2 = getProjectWithStats(project.id)!.stats;
    expect(stats2.nextTask?.id).toBe(queuedDue.id);
    expect(stats2.nextTask?.id).not.toBe(queuedFar.id);
  });

  test("archived and cancelled items stay out of the progress denominator", () => {
    const project = createProject({ title: "Denominator" });
    const taskId = createTask({ title: "t", template: "do it" }).id;

    const doneItem = createWorkItem({
      taskId,
      title: "Done",
      projectId: project.id,
    });
    updateWorkItem(doneItem.id, { status: "done" });
    const dismissed = createWorkItem({
      taskId,
      title: "Dismissed",
      projectId: project.id,
    });
    updateWorkItem(dismissed.id, { status: "archived" });
    const cancelled = createWorkItem({
      taskId,
      title: "Cancelled",
      projectId: project.id,
    });
    updateWorkItem(cancelled.id, { status: "cancelled" });

    const stats = getProjectWithStats(project.id)!.stats;
    // 1 done of 1 counted — the dismissed/cancelled captures don't deflate %.
    expect(stats.counts.done).toBe(1);
    expect(stats.counts.total).toBe(1);
    expect(stats.counts.open).toBe(0);
  });

  test("listProjectsWithStats attaches stats to every project", () => {
    const p = createProject({ title: "P" });
    const taskId = createTask({ title: "t", template: "x" }).id;
    createWorkItem({ taskId, title: "one", projectId: p.id });

    const withStats = listProjectsWithStats();
    const entry = withStats.find((x) => x.id === p.id)!;
    expect(entry.stats.counts.queued).toBe(1);
  });
});
