/**
 * Tests for the next-move "chief of staff" endpoint: deterministic candidate
 * ranking, the templated fallback (LLM never invoked on the GET path), the
 * empty "all caught up" state, and the stale-while-revalidate cache keyed on
 * the top item id.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// No provider → narration falls back to deterministic, so background
// revalidation is a safe no-op in tests (never hits a real LLM).
mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => null,
}));

import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItem,
  listWorkItems,
  removeWorkItemFromQueue,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { __resetNextMoveCacheForTest } from "../next-move.js";
import {
  clear as clearInteractions,
  register,
} from "../pending-interactions.js";
import { ROUTES } from "./next-move-routes.js";

initializeDb();

const route = ROUTES.find(
  (r) => r.endpoint === "next-move" && r.method === "GET",
)!;

interface NextMoveResponse {
  hasMove: boolean;
  itemId: string | null;
  kind: "approval" | "work_item" | "feed" | null;
  headline: string;
  reasoning: string;
  actions: Array<{ id: string; kind: string }>;
}

function callNextMove(): NextMoveResponse {
  return route.handler({ headers: {} }) as NextMoveResponse;
}

function clearWorkItems(): void {
  for (const i of listWorkItems()) removeWorkItemFromQueue(i.id);
}

afterEach(() => {
  clearWorkItems();
  clearInteractions();
  __resetNextMoveCacheForTest();
});

describe("next-move endpoint", () => {
  test("returns 'all caught up' when nothing is pending", () => {
    const res = callNextMove();
    expect(res.hasMove).toBe(false);
    expect(res.itemId).toBeNull();
    expect(res.kind).toBeNull();
    expect(res.headline).toBe("You're all caught up.");
    expect(res.reasoning).toBe("");
    expect(res.actions).toEqual([]);
  });

  test("a queued work item surfaces a 'Run' move with run action", () => {
    const task = createTask({ title: "Reply to Aileen", template: "..." });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Reply to Aileen",
      notes: "Aileen asked about the OTP",
    });

    const res = callNextMove();
    expect(res.hasMove).toBe(true);
    expect(res.itemId).toBe(`wi:${wi.id}`);
    expect(res.kind).toBe("work_item");
    // Deterministic fallback (no provider): "Run: <title>" + notes.
    expect(res.headline).toBe("Run: Reply to Aileen");
    expect(res.reasoning).toBe("Aileen asked about the OTP");
    expect(res.actions.some((a) => a.kind === "run")).toBe(true);
  });

  test("a pending approval outranks a queued work item", () => {
    const task = createTask({ title: "Queued task", template: "..." });
    createWorkItem({ taskId: task.id, title: "Queued task" });

    register("req-1", {
      conversationId: "conv-1",
      kind: "confirmation",
      confirmationDetails: {
        toolName: "send_email",
        input: {},
        riskLevel: "high",
        allowlistOptions: [],
        scopeOptions: [],
      },
    });

    const res = callNextMove();
    expect(res.kind).toBe("approval");
    expect(res.itemId).toBe("int:req-1");
    expect(res.headline).toBe("Approve: send_email");
    expect(res.actions.map((a) => a.kind).sort()).toEqual([
      "approve",
      "decline",
    ]);
  });

  test("awaiting_review outranks queued; oldest-within-tier wins", () => {
    const task = createTask({ title: "t", template: "..." });
    const queued = createWorkItem({ taskId: task.id, title: "Queued one" });
    const review = createWorkItem({ taskId: task.id, title: "Review me" });
    updateWorkItem(review.id, { status: "awaiting_review" });

    const res = callNextMove();
    expect(res.itemId).toBe(`wi:${review.id}`);
    expect(res.itemId).not.toBe(`wi:${queued.id}`);
  });

  test("caches by top item id and serves the same itemId on repeat calls", () => {
    const task = createTask({ title: "Cached task", template: "..." });
    const wi = createWorkItem({ taskId: task.id, title: "Cached task" });

    const a = callNextMove();
    const b = callNextMove();
    expect(a.itemId).toBe(`wi:${wi.id}`);
    expect(b.itemId).toBe(`wi:${wi.id}`);
  });
});
