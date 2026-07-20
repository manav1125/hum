/**
 * Tests for the background auto-filer: candidate selection, provenance
 * stamping, the confidence threshold, the user-decision guards (user-filed
 * and user-unfiled items are never touched), and the parked-stays-parked
 * invariant. The LLM scorer is injected so every test is deterministic.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createProject } from "./project-store.js";
import {
  AUTO_FILE_USER_UNFILED,
  AUTO_FILED_BY_CUE,
  type AutoFileAssignment,
  buildAutoFilePrompt,
  MAX_ITEMS_PER_SWEEP,
  parseAutoFileResponse,
  sweepUnfiledWorkItems,
} from "./work-item-auto-file.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM projects");
});

function makeItem(
  title: string,
  opts: Partial<Parameters<typeof createWorkItem>[0]> = {},
): WorkItem {
  const task = createTask({ title, template: title });
  return createWorkItem({ taskId: task.id, title, ...opts });
}

describe("parseAutoFileResponse", () => {
  const itemIds = new Set(["i1", "i2"]);
  const projectIds = new Set(["p1", "p2"]);

  test("parses a clean JSON array and clamps confidence", () => {
    const parsed = parseAutoFileResponse(
      'Here you go: [{"id":"i1","projectId":"p1","confidence":1.7},{"id":"i2","projectId":null,"confidence":-2}]',
      itemIds,
      projectIds,
    );
    expect(parsed).toEqual([
      { id: "i1", projectId: "p1", confidence: 1 },
      { id: "i2", projectId: null, confidence: 0 },
    ]);
  });

  test("drops unknown item ids and treats hallucinated project ids as no-fit", () => {
    const parsed = parseAutoFileResponse(
      '[{"id":"ghost","projectId":"p1","confidence":0.9},{"id":"i1","projectId":"invented","confidence":0.9}]',
      itemIds,
      projectIds,
    );
    expect(parsed).toEqual([{ id: "i1", projectId: null, confidence: 0.9 }]);
  });

  test("returns null on prose with no array", () => {
    expect(parseAutoFileResponse("no json here", itemIds, projectIds)).toBe(
      null,
    );
  });
});

describe("buildAutoFilePrompt", () => {
  test("includes project briefs and item ids", () => {
    const project = createProject({
      title: "Q4 launch",
      context: "Ship the Q4 launch: emails, landing page, press.",
    });
    const item = makeItem("Draft the launch email");
    const prompt = buildAutoFilePrompt([item], [project]);
    expect(prompt).toContain(project.id);
    expect(prompt).toContain("Q4 launch");
    expect(prompt).toContain("Ship the Q4 launch");
    expect(prompt).toContain(item.id);
    expect(prompt).toContain("Draft the launch email");
  });
});

describe("sweepUnfiledWorkItems", () => {
  test("files a confident match with provenance, leaves low-confidence unfiled", async () => {
    const project = createProject({ title: "Q4 launch", context: "Launch." });
    const confident = makeItem("Draft the launch email");
    const unsure = makeItem("Buy milk");

    const scorer = async (): Promise<AutoFileAssignment[]> => [
      { id: confident.id, projectId: project.id, confidence: 0.92 },
      { id: unsure.id, projectId: project.id, confidence: 0.3 },
    ];

    const result = await sweepUnfiledWorkItems(scorer);
    expect(result.scanned).toBe(2);
    expect(result.filed).toBe(1);
    expect(result.belowThreshold).toBe(1);

    const filed = getWorkItem(confident.id)!;
    expect(filed.projectId).toBe(project.id);
    expect(filed.autoFiledBy).toBe(AUTO_FILED_BY_CUE);
    expect(filed.autoFileConfidence).toBe(0.92);

    const left = getWorkItem(unsure.id)!;
    expect(left.projectId).toBeNull();
    expect(left.autoFiledBy).toBeNull();
  });

  test("filing does NOT grant run permission — a parked item stays parked", async () => {
    const project = createProject({ title: "Ops" });
    const parked = makeItem("File my receipts", {
      autoRunEligibility: "parked",
    });

    const result = await sweepUnfiledWorkItems(async () => [
      { id: parked.id, projectId: project.id, confidence: 0.99 },
    ]);
    expect(result.filed).toBe(1);

    const after = getWorkItem(parked.id)!;
    expect(after.projectId).toBe(project.id);
    // The invariant this feature must never break.
    expect(after.autoRunEligibility).toBe("parked");
    expect(after.status).toBe("queued");
  });

  test("never considers user-filed or user-unfiled items", async () => {
    const project = createProject({ title: "Ops" });
    const other = createProject({ title: "Growth" });
    const userFiled = makeItem("Already filed", { projectId: other.id });
    const userUnfiled = makeItem("Deliberately unfiled");
    updateWorkItem(userUnfiled.id, { autoFiledBy: AUTO_FILE_USER_UNFILED });

    const seen: string[] = [];
    const result = await sweepUnfiledWorkItems(async (items) => {
      seen.push(...items.map((i) => i.id));
      return items.map((i) => ({
        id: i.id,
        projectId: project.id,
        confidence: 1,
      }));
    });

    // Neither candidate was even offered to the scorer; nothing changed.
    expect(seen).toHaveLength(0);
    expect(result.scanned).toBe(0);
    expect(getWorkItem(userFiled.id)!.projectId).toBe(other.id);
    expect(getWorkItem(userUnfiled.id)!.projectId).toBeNull();
  });

  test("skips entirely when there are no projects (no LLM call)", async () => {
    makeItem("Lonely task");
    let called = 0;
    const result = await sweepUnfiledWorkItems(async () => {
      called++;
      return [];
    });
    expect(called).toBe(0);
    expect(result.scanned).toBe(0);
  });

  test("caps a huge unfiled backlog at MAX_ITEMS_PER_SWEEP", async () => {
    createProject({ title: "Ops" });
    for (let i = 0; i < MAX_ITEMS_PER_SWEEP + 5; i++) {
      makeItem(`Task ${i}`);
    }
    let offered = 0;
    await sweepUnfiledWorkItems(async (items) => {
      offered = items.length;
      return [];
    });
    expect(offered).toBe(MAX_ITEMS_PER_SWEEP);
  });

  test("a mid-flight user filing wins over the sweep's stale assignment", async () => {
    const project = createProject({ title: "Ops" });
    const userPick = createProject({ title: "Personal" });
    const item = makeItem("Race me");

    const result = await sweepUnfiledWorkItems(async (items) => {
      // Simulate the user filing the item while the LLM call is in flight.
      updateWorkItem(items[0].id, { projectId: userPick.id });
      return [{ id: item.id, projectId: project.id, confidence: 0.95 }];
    });

    expect(result.filed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(getWorkItem(item.id)!.projectId).toBe(userPick.id);
    expect(getWorkItem(item.id)!.autoFiledBy).toBeNull();
  });

  test("a null scorer result (LLM failure) leaves everything unfiled", async () => {
    createProject({ title: "Ops" });
    const item = makeItem("Unscorable");
    const result = await sweepUnfiledWorkItems(async () => null);
    expect(result.filed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(getWorkItem(item.id)!.projectId).toBeNull();
  });
});
