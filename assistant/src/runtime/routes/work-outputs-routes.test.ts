/**
 * Round-trip tests for the work-outputs routes ("Sprint outputs"): mission
 * and work-item scoped listings, the recent-across-all brief feed, and the
 * PATCH review-state (Approve) action.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createMission } from "../../missions/mission-store.js";
import { createTask } from "../../tasks/task-store.js";
import { createProject } from "../../work-items/project-store.js";
import { createWorkItem } from "../../work-items/work-item-store.js";
import {
  createWorkOutput,
  getWorkOutput,
  type WorkOutputWithAttachment,
} from "../../work-items/work-output-store.js";
import { ROUTES } from "./work-outputs-routes.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_outputs");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM missions");
});

function route(endpoint: string, method: string) {
  const found = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!found) throw new Error(`route not found: ${method} ${endpoint}`);
  return found;
}

function seed() {
  const mission = createMission({ title: "M", outcome: "O" });
  const project = createProject({ title: "P" });
  getDb().run(
    `UPDATE projects SET mission_id = '${mission.id}' WHERE id = '${project.id}'`,
  );
  const task = createTask({ title: "T", template: "Do it" });
  const workItem = createWorkItem({
    taskId: task.id,
    title: "Build the deck",
    projectId: project.id,
  });
  const output = createWorkOutput({
    workItemId: workItem.id,
    missionId: mission.id,
    projectId: project.id,
    kind: "deck",
    title: "Pitch deck v3",
    why: 'Deliverable from "Build the deck"',
    agent: "builder",
    externalUrl: null,
  });
  return { mission, project, workItem, output };
}

describe("GET missions/:id/outputs", () => {
  test("returns the mission's outputs; 404 on unknown mission", () => {
    const { mission, output } = seed();
    const result = route("missions/:id/outputs", "GET").handler({
      pathParams: { id: mission.id },
      headers: {},
    }) as { outputs: WorkOutputWithAttachment[] };
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].id).toBe(output.id);
    expect(result.outputs[0].kind).toBe("deck");
    expect(result.outputs[0].agent).toBe("builder");
    // Link/derived outputs without a stored file enrich to attachment: null.
    expect(result.outputs[0].attachment).toBeNull();

    expect(() =>
      route("missions/:id/outputs", "GET").handler({
        pathParams: { id: "nope" },
        headers: {},
      }),
    ).toThrow("Mission not found");
  });
});

describe("GET work-items/:id/outputs", () => {
  test("returns the work item's outputs; 404 on unknown item", () => {
    const { workItem, output } = seed();
    const result = route("work-items/:id/outputs", "GET").handler({
      pathParams: { id: workItem.id },
      headers: {},
    }) as { outputs: WorkOutputWithAttachment[] };
    expect(result.outputs.map((o) => o.id)).toEqual([output.id]);

    expect(() =>
      route("work-items/:id/outputs", "GET").handler({
        pathParams: { id: "nope" },
        headers: {},
      }),
    ).toThrow("Work item not found");
  });
});

describe("GET outputs (recent across all)", () => {
  test("returns newest-first across missions and respects ?limit", () => {
    const { workItem } = seed();
    createWorkOutput({
      workItemId: workItem.id,
      kind: "spreadsheet",
      title: "Investor CRM",
    });

    const all = route("outputs", "GET").handler({
      queryParams: {},
      headers: {},
    }) as { outputs: WorkOutputWithAttachment[] };
    expect(all.outputs).toHaveLength(2);
    expect(all.outputs[0].title).toBe("Investor CRM");

    const limited = route("outputs", "GET").handler({
      queryParams: { limit: "1" },
      headers: {},
    }) as { outputs: WorkOutputWithAttachment[] };
    expect(limited.outputs).toHaveLength(1);
  });
});

describe("PATCH outputs/:id", () => {
  test("approves an output and persists the flip", () => {
    const { output } = seed();
    const result = route("outputs/:id", "PATCH").handler({
      pathParams: { id: output.id },
      body: { reviewState: "approved" },
      headers: {},
    }) as { output: WorkOutputWithAttachment };
    expect(result.output.reviewState).toBe("approved");
    expect(getWorkOutput(output.id)?.reviewState).toBe("approved");

    // …and back to pending.
    const reverted = route("outputs/:id", "PATCH").handler({
      pathParams: { id: output.id },
      body: { reviewState: "pending" },
      headers: {},
    }) as { output: WorkOutputWithAttachment };
    expect(reverted.output.reviewState).toBe("pending");
  });

  test("rejects unknown output and invalid review state", () => {
    const { output } = seed();
    expect(() =>
      route("outputs/:id", "PATCH").handler({
        pathParams: { id: "nope" },
        body: { reviewState: "approved" },
        headers: {},
      }),
    ).toThrow("Output not found");

    expect(() =>
      route("outputs/:id", "PATCH").handler({
        pathParams: { id: output.id },
        body: { reviewState: "shipped" },
        headers: {},
      }),
    ).toThrow("reviewState");
  });
});
