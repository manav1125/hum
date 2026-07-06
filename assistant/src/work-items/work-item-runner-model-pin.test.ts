/**
 * Guardrails per-agent model pin: the agents.model column persists through
 * the store, and the work-item runner threads the pinned model into the run
 * conversation as `modelOverride` (the existing explicit-model mechanism that
 * wins over profile/call-site resolution in the provider layer).
 *
 * Hermetic: the task runner and the conversation store are mocked (bun
 * mock.module is process-global — run this file on its own).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the task runner so the background run invokes the message callback
// (which is where the runner creates the run conversation) and resolves
// immediately, with no real agent turn. Registered before the runner import.
mock.module("../tasks/task-runner.js", () => ({
  runTask: async (
    _opts: unknown,
    onMessage: (
      conversationId: string,
      message: string,
      taskRunId: string,
    ) => Promise<void>,
  ) => {
    await onMessage("conv-model-pin", "run it", "test-run");
    return {
      status: "completed",
      taskRunId: "test-run",
      conversationId: "conv-model-pin",
    };
  },
}));

// Capture what the runner passes to getOrCreateConversation and hand back a
// minimal fake conversation (no provider setup, no LLM).
const createCalls: Array<{
  conversationId: string;
  options: { modelOverride?: string } | undefined;
}> = [];
mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (
    conversationId: string,
    options?: { modelOverride?: string },
  ) => {
    createCalls.push({ conversationId, options });
    return {
      taskRunId: null as string | null,
      headlessLock: false,
      setTrustContext: () => {},
      processMessage: async () => "msg-id",
    };
  },
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  createAgent,
  getAgent,
  getAgentByAssignee,
  updateAgent,
} from "./agent-store.js";
import { runWorkItemInBackground } from "./work-item-runner.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
} from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM work_outputs");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM agents");
  createCalls.length = 0;
});

async function waitForTerminalStatus(workItemId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const status = getWorkItem(workItemId)?.status;
    if (status && status !== "queued" && status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("work item never reached a terminal status");
}

describe("agents.model persistence", () => {
  test("create, read, update, and clear the pin", () => {
    const agent = createAgent({
      name: "Growth",
      model: "anthropic/claude-haiku-4.5",
    });
    expect(getAgent(agent.id)?.model).toBe("anthropic/claude-haiku-4.5");

    updateAgent(agent.id, { model: "anthropic/claude-sonnet-4.5" });
    expect(getAgent(agent.id)?.model).toBe("anthropic/claude-sonnet-4.5");

    updateAgent(agent.id, { model: null });
    expect(getAgent(agent.id)?.model).toBeNull();
  });

  test("getAgentByAssignee matches case-insensitively; null assignee is the house agent", () => {
    createAgent({ name: "Growth", model: "anthropic/claude-haiku-4.5" });
    expect(getAgentByAssignee("growth")?.name).toBe("Growth");
    expect(getAgentByAssignee("GROWTH")?.name).toBe("Growth");
    expect(getAgentByAssignee("  Growth  ")?.name).toBe("Growth");
    expect(getAgentByAssignee(null)).toBeUndefined();
    expect(getAgentByAssignee("")).toBeUndefined();
    expect(getAgentByAssignee("Nobody")).toBeUndefined();
  });
});

describe("runner threads the pin into the run conversation", () => {
  test("a pinned assignee's run passes modelOverride", async () => {
    createAgent({ name: "Growth", model: "anthropic/claude-haiku-4.5" });
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "campaign" });
    updateWorkItem(item.id, { assignee: "growth" }); // case-insensitive match

    const result = runWorkItemInBackground(item.id);
    expect(result.success).toBe(true);
    await waitForTerminalStatus(item.id);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].conversationId).toBe("conv-model-pin");
    expect(createCalls[0].options).toEqual({
      modelOverride: "anthropic/claude-haiku-4.5",
    });
  });

  test("an unpinned assignee's run passes no override", async () => {
    createAgent({ name: "Ops" }); // no model pin
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "ops chore" });
    updateWorkItem(item.id, { assignee: "Ops" });

    runWorkItemInBackground(item.id);
    await waitForTerminalStatus(item.id);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].options).toBeUndefined();
  });

  test("an unassigned item (house agent 'cue') passes no override", async () => {
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "loose end" });

    runWorkItemInBackground(item.id);
    await waitForTerminalStatus(item.id);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].options).toBeUndefined();
  });
});
