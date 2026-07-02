import { describe, expect, test } from "bun:test";

import type { WorkItem } from "./work-item-store.js";
import { classifyWorkItemAutonomy } from "./work-item-triage.js";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    taskId: "task-1",
    title: "Test item",
    notes: null,
    status: "queued",
    priorityTier: 1,
    sortIndex: null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    sourceType: null,
    sourceId: null,
    requiredTools: null,
    approvedTools: null,
    approvalStatus: "none",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as WorkItem;
}

describe("classifyWorkItemAutonomy", () => {
  test("empty tool snapshot classifies as other", () => {
    expect(classifyWorkItemAutonomy(makeItem())).toEqual(["other"]);
    expect(classifyWorkItemAutonomy(makeItem({ requiredTools: "[]" }))).toEqual(
      ["other"],
    );
  });

  test("malformed snapshot degrades to other rather than throwing", () => {
    expect(
      classifyWorkItemAutonomy(makeItem({ requiredTools: "not json" })),
    ).toEqual(["other"]);
  });

  test("research-only tools classify as research", () => {
    const item = makeItem({
      requiredTools: JSON.stringify(["web_search", "read"]),
    });
    expect(classifyWorkItemAutonomy(item)).toEqual(["research"]);
  });

  test("a money tool surfaces the money class alongside others", () => {
    const item = makeItem({
      requiredTools: JSON.stringify(["web_search", "stripe_create_payment"]),
    });
    const classes = classifyWorkItemAutonomy(item);
    expect(classes).toContain("money");
    expect(classes).toContain("research");
  });

  test("non-string entries in the snapshot are ignored", () => {
    const item = makeItem({
      requiredTools: JSON.stringify(["read", 42, null]),
    });
    expect(classifyWorkItemAutonomy(item)).toEqual(["research"]);
  });
});
