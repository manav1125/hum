/**
 * Unit tests for `dedupeTerminalWorkItemsForDisplay` — the read-path dedup that
 * keeps the Activity "Recently done" lane from showing the same finished task
 * twice. Pure function over an in-memory list; no DB needed.
 */
import { describe, expect, test } from "bun:test";

import {
  dedupeTerminalWorkItemsForDisplay,
  type WorkItem,
  type WorkItemStatus,
} from "./work-item-store.js";

function wi(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    taskId: "task-" + overrides.id,
    title: "Untitled",
    notes: null,
    status: "done" as WorkItemStatus,
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
    projectId: null,
    dueAt: null,
    labels: null,
    assignee: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("dedupeTerminalWorkItemsForDisplay", () => {
  test("collapses same title + same source channel, keeping the most recent", () => {
    const older = wi({
      id: "a",
      title: "Reply on WordPress guidance",
      sourceType: "slack",
      sourceId: "action-board:2026-06-27:0",
      updatedAt: 1_000,
    });
    const newer = wi({
      id: "b",
      title: "Reply on WordPress guidance",
      sourceType: "slack",
      sourceId: "action-board:2026-06-27:3", // per-build sourceId differs
      updatedAt: 2_000,
    });

    const result = dedupeTerminalWorkItemsForDisplay([older, newer]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b"); // most recent kept
  });

  test("title match is case/whitespace-insensitive", () => {
    const a = wi({
      id: "a",
      title: "Reply On WordPress Guidance",
      sourceType: "slack",
      updatedAt: 1_000,
    });
    const b = wi({
      id: "b",
      title: "  reply on wordpress guidance  ",
      sourceType: "slack",
      updatedAt: 2_000,
    });

    expect(dedupeTerminalWorkItemsForDisplay([a, b])).toHaveLength(1);
  });

  test("does NOT collapse same title on different channels", () => {
    const a = wi({ id: "a", title: "Reply", sourceType: "slack" });
    const b = wi({ id: "b", title: "Reply", sourceType: "telegram" });

    expect(dedupeTerminalWorkItemsForDisplay([a, b])).toHaveLength(2);
  });

  test("does NOT collapse genuinely distinct titles on the same channel", () => {
    const a = wi({ id: "a", title: "Reply to Aileen", sourceType: "slack" });
    const b = wi({ id: "b", title: "Send OTP to Bob", sourceType: "slack" });

    expect(dedupeTerminalWorkItemsForDisplay([a, b])).toHaveLength(2);
  });

  test("source-less items collapse on title only", () => {
    const a = wi({ id: "a", title: "Local task", updatedAt: 1_000 });
    const b = wi({ id: "b", title: "Local task", updatedAt: 5_000 });

    const result = dedupeTerminalWorkItemsForDisplay([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  test("a source-less item never collapses with a channel-tagged one", () => {
    const a = wi({ id: "a", title: "Reply", sourceType: null });
    const b = wi({ id: "b", title: "Reply", sourceType: "slack" });

    expect(dedupeTerminalWorkItemsForDisplay([a, b])).toHaveLength(2);
  });

  test("non-terminal items pass through untouched (never collapsed)", () => {
    const queuedA = wi({
      id: "a",
      title: "Reply",
      sourceType: "slack",
      status: "queued",
    });
    const queuedB = wi({
      id: "b",
      title: "Reply",
      sourceType: "slack",
      status: "running",
    });

    // Two active items with identical title+channel are NOT this helper's
    // concern — they pass through so the other lanes still see them.
    const result = dedupeTerminalWorkItemsForDisplay([queuedA, queuedB]);
    expect(result.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("mixed list: collapses terminal dupes, keeps active dupes", () => {
    const items = [
      wi({ id: "done1", title: "Reply", sourceType: "slack", status: "done" }),
      wi({
        id: "done2",
        title: "Reply",
        sourceType: "slack",
        status: "failed",
      }),
      wi({
        id: "active1",
        title: "Reply",
        sourceType: "slack",
        status: "queued",
      }),
    ];

    const result = dedupeTerminalWorkItemsForDisplay(items);
    const ids = result.map((r) => r.id).sort();
    // One of the two terminal dupes collapses; the queued one survives.
    expect(result).toHaveLength(2);
    expect(ids).toContain("active1");
  });

  test("treats done/failed/cancelled/archived all as terminal for dedup", () => {
    const items = [
      wi({ id: "a", title: "X", sourceType: "slack", status: "cancelled" }),
      wi({ id: "b", title: "X", sourceType: "slack", status: "archived" }),
    ];
    expect(dedupeTerminalWorkItemsForDisplay(items)).toHaveLength(1);
  });
});
