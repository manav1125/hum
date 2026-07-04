/**
 * `task_list_add` result honesty: the tool result must reflect what the
 * capture → triage → auto-run pipeline ACTUALLY did with the item.
 *
 * The historical bug: the reply was composed from the pre-triage snapshot, so
 * when the auto-runner started the item the chat still said "queued — it'll
 * wait until you tell me to run it". The tool now awaits the (bounded)
 * triage + auto-run decision and reports it.
 *
 * The triage module is mocked with the same targeted install/restore pattern
 * as `work-item-triage.test.ts` — `mock.module` mutates the process-global
 * registry, so a top-level mock would leak into other files in the same
 * `bun test` process.
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

let mockOutcome: { autoRunStarted: boolean; reason: string } = {
  autoRunStarted: false,
  reason: "policy_ask",
};
const triageCalls: string[] = [];

beforeAll(() => {
  mock.module("../../work-items/work-item-triage.js", () => ({
    ...workItemTriage,
    triageAndMaybeAutoRunWorkItem: async (id: string) => {
      triageCalls.push(id);
      return mockOutcome;
    },
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
import type { ToolContext } from "../types.js";
import { executeTaskListAdd } from "./work-item-enqueue.js";

// Heal a singleton an earlier test file may have opened inside its own
// (since-deleted) per-test workspace override, then (re)initialize against
// the preload workspace.
resetDbForTesting();
initializeDb();

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  triageCalls.length = 0;
  mockOutcome = { autoRunStarted: false, reason: "policy_ask" };
});

afterAll(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
});

describe("task_list_add result honesty (auto-run awareness)", () => {
  test("reports 'running (auto-started)' when the auto-runner started the item", async () => {
    mockOutcome = { autoRunStarted: true, reason: "started" };

    const result = await executeTaskListAdd(
      { title: "Summarize the news" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(triageCalls).toHaveLength(1);
    expect(result.content).toContain("Status: running (auto-started)");
    expect(result.content).toContain("ALREADY RUNNING");
    // The stale phrasing must be gone entirely.
    expect(result.content).not.toContain("Status: queued");
  });

  test("reports queued + waiting when the policy deferred the run", async () => {
    mockOutcome = { autoRunStarted: false, reason: "policy_ask" };

    const result = await executeTaskListAdd({ title: "Draft the memo" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Status: queued");
    expect(result.content).toContain("will wait for the user");
    expect(result.content).not.toContain("auto-started");
  });

  test("template-based enqueue also reflects the auto-run decision", async () => {
    mockOutcome = { autoRunStarted: true, reason: "started" };
    const { createTask } = await import("../../tasks/task-store.js");
    const task = createTask({ title: "Weekly digest", template: "digest it" });

    const result = await executeTaskListAdd({ task_id: task.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Status: running (auto-started)");
    expect(result.content).toContain("ALREADY RUNNING");
  });
});
