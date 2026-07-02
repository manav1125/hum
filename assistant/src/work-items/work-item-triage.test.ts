import { describe, expect, test } from "bun:test";

import type { WorkItem } from "./work-item-store.js";
import {
  classifyWorkItemAutonomy,
  parseTriageResponse,
} from "./work-item-triage.js";

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

describe("parseTriageResponse", () => {
  const ids = new Set(["proj-1", "proj-2"]);

  test("accepts a valid project id and drops hallucinated ones", () => {
    const ok = parseTriageResponse(
      '{"urgency": 70, "tier": 1, "projectId": "proj-1", "dueAt": null}',
      ids,
    );
    expect(ok?.projectId).toBe("proj-1");
    const bad = parseTriageResponse(
      '{"urgency": 70, "tier": 1, "projectId": "made-up", "dueAt": null}',
      ids,
    );
    expect(bad?.projectId).toBeNull();
  });

  test("parses a local-ISO dueAt to epoch ms and rejects garbage + stale dates", () => {
    const now = Date.parse("2026-07-02T12:00");
    const future = parseTriageResponse(
      '{"urgency": 80, "tier": 0, "projectId": null, "dueAt": "2026-07-03T17:00"}',
      ids,
      now,
    );
    expect(future?.dueAt).toBe(Date.parse("2026-07-03T17:00"));
    const garbage = parseTriageResponse(
      '{"urgency": 80, "tier": 0, "projectId": null, "dueAt": "next friday-ish"}',
      ids,
      now,
    );
    expect(garbage?.dueAt).toBeNull();
    const stale = parseTriageResponse(
      '{"urgency": 80, "tier": 0, "projectId": null, "dueAt": "2026-06-20T17:00"}',
      ids,
      now,
    );
    expect(stale?.dueAt).toBeNull();
  });

  test("still parses plain urgency/tier responses (fields absent)", () => {
    const r = parseTriageResponse('{"urgency": 55, "tier": 1}', ids);
    expect(r).toEqual({ urgency: 55, tier: 1, projectId: null, dueAt: null });
  });

  test("clamps out-of-range values and rejects non-JSON", () => {
    const r = parseTriageResponse('{"urgency": 300, "tier": 9}', ids);
    expect(r).toEqual({ urgency: 100, tier: 2, projectId: null, dueAt: null });
    expect(parseTriageResponse("no json here", ids)).toBeNull();
  });
});
