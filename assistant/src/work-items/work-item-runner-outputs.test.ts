/**
 * Regression test for the sprint-outputs capture choke point: a work-item
 * run that completes with tool-produced attachments registers work_outputs
 * rows from the runner's completion path.
 *
 * Hermetic: the task runner is mocked (no LLM turn) to resolve with a run
 * conversation seeded with a real assistant-message attachment, mirroring
 * what the agent loop's attachmentIds side channel persists during a run.
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
import { runWorkItemInBackground } from "./work-item-runner.js";
import { createWorkItem, getWorkItem } from "./work-item-store.js";
import { listWorkItemOutputs } from "./work-output-store.js";

initializeDb();

beforeEach(() => {
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

describe("runner completion registers sprint outputs", () => {
  test("a completed run's attachments become work_outputs rows", async () => {
    // Seed the "run conversation" the mocked runTask will report, with one
    // tool-produced attachment linked to an assistant message.
    const conversation = createConversation("run conversation");
    mockRunConversationId = conversation.id;
    const msg = await addMessage(
      conversation.id,
      "assistant",
      "Deck attached.",
      { skipIndexing: true },
    );
    const stored = attachInlineAttachmentToMessage(
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

    const result = runWorkItemInBackground(workItem.id);
    expect(result.success).toBe(true);
    const status = await waitForTerminalStatus(workItem.id);
    expect(status).toBe("awaiting_review");

    const outputs = listWorkItemOutputs(workItem.id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].attachmentId).toBe(stored.id);
    expect(outputs[0].kind).toBe("pdf");
    expect(outputs[0].title).toBe("Pitch deck v3.pdf");
    expect(outputs[0].why).toContain("Build the pitch deck");
    expect(outputs[0].reviewState).toBe("pending");
  });

  test("a run with no attachments registers nothing", async () => {
    const conversation = createConversation("empty run");
    mockRunConversationId = conversation.id;
    await addMessage(conversation.id, "assistant", "All done, no files.", {
      skipIndexing: true,
    });

    const task = createTask({ title: "No-op", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "No-op item" });

    runWorkItemInBackground(workItem.id);
    await waitForTerminalStatus(workItem.id);

    expect(listWorkItemOutputs(workItem.id)).toHaveLength(0);
  });
});
