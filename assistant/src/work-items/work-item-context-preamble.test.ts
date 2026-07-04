/**
 * Tests for the cowork context preamble the runner prepends to a work item's
 * run message: the parent project's brief + the task's own context. This is how
 * cowork "extends context per project/task" — the agent reads project/task
 * instructions before executing.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createProject } from "./project-store.js";
import { buildWorkItemContextPreamble } from "./work-item-runner.js";
import { createWorkItem, getWorkItem } from "./work-item-store.js";

initializeDb();

let taskId = "";
beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
  taskId = createTask({ title: "t", template: "do it" }).id;
});

describe("buildWorkItemContextPreamble", () => {
  test("empty when the item has neither a project nor task context", () => {
    const item = createWorkItem({ taskId, title: "Plain task" });
    expect(buildWorkItemContextPreamble(item)).toBe("");
  });

  test("includes the parent project's brief", () => {
    const project = createProject({
      title: "Q4 launch",
      context: "Ship the pricing page. Tone: confident.",
    });
    const item = createWorkItem({
      taskId,
      title: "Draft copy",
      projectId: project.id,
    });
    const preamble = buildWorkItemContextPreamble(getWorkItem(item.id)!);
    expect(preamble).toContain("Project: Q4 launch");
    expect(preamble).toContain("Ship the pricing page");
  });

  test("includes the task's own context", () => {
    const item = createWorkItem({
      taskId,
      title: "Draft copy",
      context: "Keep it under 80 words.",
    });
    const preamble = buildWorkItemContextPreamble(getWorkItem(item.id)!);
    expect(preamble).toContain("Task context");
    expect(preamble).toContain("under 80 words");
  });

  test("combines both project brief and task context", () => {
    const project = createProject({ title: "Proj", context: "PROJECT_BRIEF" });
    const item = createWorkItem({
      taskId,
      title: "Task",
      projectId: project.id,
      context: "TASK_NOTE",
    });
    const preamble = buildWorkItemContextPreamble(getWorkItem(item.id)!);
    expect(preamble).toContain("PROJECT_BRIEF");
    expect(preamble).toContain("TASK_NOTE");
    expect(preamble.indexOf("PROJECT_BRIEF")).toBeLessThan(
      preamble.indexOf("TASK_NOTE"),
    );
  });

  test("names the project even when it has no brief", () => {
    const project = createProject({ title: "Untyped project" });
    const item = createWorkItem({
      taskId,
      title: "Task",
      projectId: project.id,
    });
    const preamble = buildWorkItemContextPreamble(getWorkItem(item.id)!);
    expect(preamble).toContain("Project: Untyped project");
  });
});
