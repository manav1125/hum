/**
 * `task_list_add` origin link: a task enqueued from a conversation must record
 * WHICH conversation, even when it has no channel.
 *
 * The regression this locks down: `deriveWorkItemSource` returns `{}` for local
 * / desktop / voice tasks by design (they have no channel, and dedup +
 * categorisation depend on that staying honest). The conversation id was going
 * out with it, so the thread that captured a commitment could not find the work
 * it started — and the thread agent, blind to it, re-ran finished research
 * inline. Channel provenance and the originating conversation are now separate
 * concerns and only the first is allowed to be absent.
 *
 * Triage is mocked with the same install/restore pattern as
 * `work-item-enqueue-honesty.test.ts` — `mock.module` mutates a process-global
 * registry, so a top-level mock would leak into other files in the same run.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import * as workItemTriage from "../../work-items/work-item-triage.js";

const realTriageAndMaybeAutoRunWorkItem =
  workItemTriage.triageAndMaybeAutoRunWorkItem;

beforeAll(() => {
  mock.module("../../work-items/work-item-triage.js", () => ({
    ...workItemTriage,
    triageAndMaybeAutoRunWorkItem: async () => ({
      autoRunStarted: false,
      reason: "policy_ask",
    }),
  }));
});

afterAll(() => {
  mock.module("../../work-items/work-item-triage.js", () => ({
    ...workItemTriage,
    triageAndMaybeAutoRunWorkItem: realTriageAndMaybeAutoRunWorkItem,
  }));
});

import { resetDbForTesting } from "../../__tests__/db-test-helpers.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { getTask } from "../../tasks/task-store.js";
import {
  listWorkItems,
  listWorkItemsByOriginConversation,
} from "../../work-items/work-item-store.js";
import type { ToolContext } from "../types.js";
import { executeTaskListAdd } from "./work-item-enqueue.js";

resetDbForTesting();
initializeDb();

const CONVERSATION_ID = "conv-origin-1";

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
});

afterAll(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
});

describe("task_list_add originating-conversation link", () => {
  test("a LOCAL task keeps its conversation link even with no channel source", async () => {
    const ctx: ToolContext = {
      workingDir: "/tmp",
      conversationId: CONVERSATION_ID,
      trustClass: "guardian",
      // The desktop/voice surface: explicitly a non-channel execution channel.
      executionChannel: "vellum",
    };

    const result = await executeTaskListAdd(
      { title: "Find highly-rated cafes near Just Dance" },
      ctx,
    );
    expect(result.isError).toBe(false);

    const [item] = listWorkItems();
    expect(item).toBeDefined();
    // Channel provenance stays absent — that is correct for a local task.
    expect(item.sourceType).toBeNull();
    expect(item.sourceId).toBeNull();
    // …but the conversation link is recorded.
    expect(item.originConversationId).toBe(CONVERSATION_ID);

    // And it is readable from the conversation's side.
    const spawned = listWorkItemsByOriginConversation(CONVERSATION_ID);
    expect(spawned.map((i) => i.id)).toEqual([item.id]);
  });

  test("the backing task template also records the source conversation", async () => {
    const ctx: ToolContext = {
      workingDir: "/tmp",
      conversationId: CONVERSATION_ID,
      trustClass: "guardian",
    };
    await executeTaskListAdd({ title: "Draft the vendor email" }, ctx);

    const [item] = listWorkItems();
    expect(getTask(item.taskId)?.createdFromConversationId).toBe(
      CONVERSATION_ID,
    );
  });

  test("a CHANNEL task records both the channel and the conversation", async () => {
    const ctx: ToolContext = {
      workingDir: "/tmp",
      conversationId: CONVERSATION_ID,
      trustClass: "guardian",
      executionChannel: "slack",
      requesterChatId: "C123",
    };

    await executeTaskListAdd({ title: "Reply to Jane in #eng" }, ctx);

    const [item] = listWorkItems();
    expect(item.sourceType).toBe("slack");
    expect(item.sourceId).toBe("C123");
    expect(item.originConversationId).toBe(CONVERSATION_ID);
  });

  test("a conversation that spawned nothing reads back empty", () => {
    expect(listWorkItemsByOriginConversation("conv-with-nothing")).toEqual([]);
  });

  test("an item enqueued outside any conversation has no origin link", async () => {
    // `conversationId` is required on ToolContext, so "no conversation" is
    // expressed as a blank one — which is exactly what
    // `deriveOriginConversationId` trims away (a CLI-filed chore has no thread
    // to link back to).
    const ctx: ToolContext = {
      workingDir: "/tmp",
      trustClass: "guardian",
      conversationId: "",
    };
    await executeTaskListAdd({ title: "CLI-filed chore" }, ctx);

    const [item] = listWorkItems();
    expect(item.originConversationId).toBeNull();
  });
});
