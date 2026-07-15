import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  approvalTimeoutNote,
  buildSkippedStepsNote,
  clearApprovalTimeouts,
  consumeApprovalTimeouts,
  recordApprovalTimeoutForConversation,
} from "./work-item-approval-timeouts.js";
import { listWorkItemEvents } from "./work-item-events.js";
import {
  createWorkItem,
  findRunningWorkItemByRunConversationId,
  getWorkItem,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

let taskId = "";

/** A work item mid-headless-run: status running + a bound run conversation. */
function makeRunningItem(conversationId: string, title = "Send it"): WorkItem {
  const item = createWorkItem({ taskId, title });
  updateWorkItem(item.id, {
    status: "running",
    lastRunConversationId: conversationId,
  });
  return getWorkItem(item.id)!;
}

describe("work-item approval timeouts (DB-backed)", () => {
  initializeDb();

  beforeEach(() => {
    getDb().run("DELETE FROM work_item_events");
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    taskId = createTask({ title: "Timeout task", template: "do it" }).id;
  });

  // Don't leak rows to a later test file sharing this `bun test` process.
  afterAll(() => {
    getDb().run("DELETE FROM work_item_events");
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
  });

  test("a timed-out approval in a headless run stamps the skipped-step note on the work item", () => {
    const item = makeRunningItem("conv-run-1");
    const matched = recordApprovalTimeoutForConversation(
      "conv-run-1",
      "send_email",
    );
    expect(matched).toBe(item.id);

    const fresh = getWorkItem(item.id)!;
    expect(fresh.lastProgressNote).toBe(approvalTimeoutNote("send_email"));
    expect(fresh.lastProgressNote).toContain("⏸ Step skipped");
    expect(fresh.lastProgressNote).toContain("send_email");
    // Deny outcome is untouched: the item is still running its (now
    // step-skipped) run — no status change from this path.
    expect(fresh.status).toBe("running");

    // Durable audit record for review surfaces (the expired pending
    // interaction itself is consumed by the prompter, so this is what
    // survives).
    const events = listWorkItemEvents(item.id);
    expect(events.some((e) => e.kind === "approval_timeout")).toBe(true);
  });

  test("interactive prompts are a no-op: a conversation not bound to a running item matches nothing", () => {
    const item = makeRunningItem("conv-run-2");
    expect(
      recordApprovalTimeoutForConversation("some-chat-conversation", "bash"),
    ).toBeNull();
    expect(recordApprovalTimeoutForConversation(undefined, "bash")).toBeNull();
    // A FINISHED run's conversation no longer matches either — only live runs.
    updateWorkItem(item.id, { status: "awaiting_review" });
    expect(
      recordApprovalTimeoutForConversation("conv-run-2", "bash"),
    ).toBeNull();
    expect(getWorkItem(item.id)!.lastProgressNote).toBeNull();
  });

  test("findRunningWorkItemByRunConversationId only matches running items with that run conversation", () => {
    const running = makeRunningItem("conv-a");
    expect(findRunningWorkItemByRunConversationId("conv-a")?.id).toBe(
      running.id,
    );
    expect(findRunningWorkItemByRunConversationId("conv-b")).toBeUndefined();
    updateWorkItem(running.id, { status: "failed" });
    expect(findRunningWorkItemByRunConversationId("conv-a")).toBeUndefined();
  });

  test("consume drains the registry so the runner can persist a terminal note exactly once", () => {
    const item = makeRunningItem("conv-run-3");
    recordApprovalTimeoutForConversation("conv-run-3", "send_email");
    recordApprovalTimeoutForConversation("conv-run-3", "mcp__slack__post");

    const records = consumeApprovalTimeouts(item.id);
    expect(records.map((r) => r.toolName)).toEqual([
      "send_email",
      "mcp__slack__post",
    ]);
    // Drained: a second consume is empty (idempotent terminal handling).
    expect(consumeApprovalTimeouts(item.id)).toEqual([]);
  });

  test("clearApprovalTimeouts discards stale records at run start", () => {
    const item = makeRunningItem("conv-run-4");
    recordApprovalTimeoutForConversation("conv-run-4", "send_email");
    clearApprovalTimeouts(item.id);
    expect(consumeApprovalTimeouts(item.id)).toEqual([]);
  });

  test("buildSkippedStepsNote names the skipped tools, deduplicated", () => {
    const single = buildSkippedStepsNote([{ toolName: "send_email", at: 1 }]);
    expect(single).toContain("⏸ Finished with skipped steps");
    expect(single).toContain('approval for "send_email" timed out');

    const multi = buildSkippedStepsNote([
      { toolName: "send_email", at: 1 },
      { toolName: "send_email", at: 2 },
      { toolName: "publish_post", at: 3 },
    ]);
    expect(multi).toContain('approvals for "send_email", "publish_post"');
    expect(multi).toContain("approve and re-run to complete");
  });
});
