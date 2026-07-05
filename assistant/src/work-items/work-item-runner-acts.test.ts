/**
 * Regression test for the act/reversal ledger's runner choke points: a
 * completed background run records one run_completed act, and re-running an
 * already-reviewed item (the redo path) marks the prior act reversed.
 *
 * Hermetic: the task runner is mocked (no LLM turn) to resolve with a run
 * conversation seeded with a real assistant-message attachment, mirroring
 * work-item-runner-outputs.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the task runner so the background run resolves immediately with a
// completed status pointed at the conversation each test seeds (no real
// agent turn). Must be registered before the runner module is imported.
let mockRunConversationId = "unset";
mock.module("../tasks/task-runner.js", () => ({
  runTask: async () => ({
    status: "completed",
    taskRunId: "test-run",
    conversationId: mockRunConversationId,
  }),
}));

import { attachInlineAttachmentToMessage } from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { getActsSummary, listRecentActs } from "./agent-act-store.js";
import { runWorkItemInBackground } from "./work-item-runner.js";
import { createWorkItem, getWorkItem } from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM work_outputs");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
});

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function waitForTerminalStatus(workItemId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const status = getWorkItem(workItemId)?.status;
    if (status && status !== "queued" && status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("work item never reached a terminal status");
}

describe("runner records an act on a completed run", () => {
  test("a run producing a deliverable records a run_completed act", async () => {
    const conversation = createConversation("run conversation");
    mockRunConversationId = conversation.id;
    const msg = await addMessage(
      conversation.id,
      "assistant",
      "Deck attached.",
      { skipIndexing: true },
    );
    attachInlineAttachmentToMessage(
      msg.id,
      0,
      "Pitch deck v3.pdf",
      "application/pdf",
      TINY_PNG_B64,
    );

    const task = createTask({ title: "Build deck", template: "Do it" });
    const workItem = createWorkItem({
      taskId: task.id,
      title: "Build the pitch deck",
    });

    runWorkItemInBackground(workItem.id);
    expect(await waitForTerminalStatus(workItem.id)).toBe("awaiting_review");

    const acts = listRecentActs();
    expect(acts).toHaveLength(1);
    expect(acts[0].kind).toBe("run_completed");
    expect(acts[0].workItemId).toBe(workItem.id);
    expect(acts[0].reversed).toBe(0);
    // The run produced one deliverable, so the estimate carries the
    // deliverables bonus above the flat base.
    expect(acts[0].estMinutesSaved).not.toBeNull();
    expect(acts[0].estMinutesSaved!).toBeGreaterThan(5);

    const summary = getActsSummary();
    expect(summary.acts).toBe(1);
    expect(summary.reversed).toBe(0);
  });
});

describe("redo marks the prior act reversed", () => {
  test("re-running an awaiting_review item reverses its completed act", async () => {
    const conversation = createConversation("run conversation");
    mockRunConversationId = conversation.id;
    await addMessage(conversation.id, "assistant", "Done.", {
      skipIndexing: true,
    });

    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Redo me" });

    // First run: reaches awaiting_review and records one live act.
    runWorkItemInBackground(workItem.id);
    expect(await waitForTerminalStatus(workItem.id)).toBe("awaiting_review");
    expect(getActsSummary().acts).toBe(1);
    expect(getActsSummary().reversed).toBe(0);

    // Redo: re-running an awaiting_review item reverses the earlier act, then
    // the second completion records a fresh live act.
    runWorkItemInBackground(workItem.id);
    expect(await waitForTerminalStatus(workItem.id)).toBe("awaiting_review");

    const summary = getActsSummary();
    expect(summary.acts).toBe(2);
    expect(summary.reversed).toBe(1);
  });

  test("output rejection reverses the run's act", async () => {
    // Seed a completed run with a deliverable so an output exists to reject.
    const conversation = createConversation("run conversation");
    mockRunConversationId = conversation.id;
    const msg = await addMessage(conversation.id, "assistant", "File.", {
      skipIndexing: true,
    });
    attachInlineAttachmentToMessage(
      msg.id,
      0,
      "report.pdf",
      "application/pdf",
      TINY_PNG_B64,
    );
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Reject me" });

    runWorkItemInBackground(workItem.id);
    await waitForTerminalStatus(workItem.id);
    expect(getActsSummary().reversed).toBe(0);

    // Approve then reject the produced output — the rejection (approved →
    // pending) reverses the run's act via the work-output store hook.
    const { listWorkItemOutputs, setWorkOutputReviewState } =
      await import("./work-output-store.js");
    const [output] = listWorkItemOutputs(workItem.id);
    expect(output).toBeDefined();
    setWorkOutputReviewState(output.id, "approved");
    setWorkOutputReviewState(output.id, "pending");

    expect(getActsSummary().reversed).toBe(1);
  });
});
