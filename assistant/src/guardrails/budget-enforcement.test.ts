/**
 * WS1 budget-enforcement tests: agent + task scope classification
 * (ok/warn/hard_stop), the advisory-vs-hard-stop knob, uncapped = ok, and the
 * combined run-start gate. Asserts the ZERO-behavior-change defaults hold.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createAgent } from "../work-items/agent-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import {
  checkAgentBudget,
  checkRunStartBudget,
  checkTaskBudget,
} from "./budget-enforcement.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM agents");
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM llm_usage_events");
});

/** Insert one non-reversed agent_act with a cost, attributed to a work item. */
function seedAct(workItemId: string, costCents: number, reversed = 0): void {
  getSqliteFrom(getDb())
    .prepare(
      /*sql*/ `INSERT INTO agent_acts
        (id, agent, work_item_id, kind, reversed, cost_cents, created_at)
       VALUES (?, 'cue', ?, 'run_completed', ?, ?, ?)`,
    )
    .run(
      `a-${Math.random().toString(36).slice(2)}`,
      workItemId,
      reversed,
      costCents,
      Date.now(),
    );
}

/** Seed weekly LLM spend attributed (via last_run_conversation_id) to an agent. */
function seedAgentSpend(assignee: string, usd: number): void {
  const task = createTask({ title: "t", template: "do" });
  const item = createWorkItem({ taskId: task.id, title: "w", assignee });
  const conv = `conv-${Math.random().toString(36).slice(2)}`;
  updateWorkItem(item.id, { lastRunConversationId: conv });
  getSqliteFrom(getDb())
    .prepare(
      /*sql*/ `INSERT INTO llm_usage_events
        (id, created_at, conversation_id, actor, provider, model,
         input_tokens, output_tokens, estimated_cost_usd, pricing_status)
       VALUES (?, ?, ?, 'main_agent', 'openrouter', 'x', 10, 5, ?, 'priced')`,
    )
    .run(`u-${Math.random().toString(36).slice(2)}`, Date.now(), conv, usd);
}

function newTaskItem(taskBudgetCents: number | null): string {
  const task = createTask({ title: "t", template: "do" });
  return createWorkItem({ taskId: task.id, title: "w", taskBudgetCents }).id;
}

describe("checkTaskBudget", () => {
  test("no budget (null) → ok, uncapped", () => {
    const id = newTaskItem(null);
    seedAct(id, 9999);
    const r = checkTaskBudget(id);
    expect(r.state).toBe("ok");
    expect(r.capCents).toBeNull();
  });

  test("under warn threshold → ok", () => {
    const id = newTaskItem(1000);
    seedAct(id, 500); // 50% < 80%
    expect(checkTaskBudget(id).state).toBe("ok");
  });

  test("at/over warn but under cap → warn", () => {
    const id = newTaskItem(1000);
    seedAct(id, 850); // 85% ≥ 80%
    const r = checkTaskBudget(id);
    expect(r.state).toBe("warn");
    expect(r.pct).toBe(85);
  });

  test("at/over cap → hard_stop (a set task budget is a hard cap)", () => {
    const id = newTaskItem(1000);
    seedAct(id, 700);
    seedAct(id, 400); // 1100 ≥ 1000
    const r = checkTaskBudget(id);
    expect(r.state).toBe("hard_stop");
    expect(r.spentCents).toBe(1100);
  });

  test("reversed acts don't count toward spend", () => {
    const id = newTaskItem(1000);
    seedAct(id, 900);
    seedAct(id, 900, 1); // reversed → excluded
    expect(checkTaskBudget(id).state).toBe("warn"); // only 900 counts
  });
});

describe("checkAgentBudget", () => {
  test("no agent row (house 'cue') → ok", () => {
    expect(checkAgentBudget("cue").state).toBe("ok");
  });

  test("capped agent, hard-stop OFF (default), over cap → warn (advisory, not hard_stop)", () => {
    createAgent({ name: "Ops", capCents: 1000 }); // hardStopEnabled defaults 0
    seedAgentSpend("Ops", 15); // $15 = 1500¢ > 1000
    const r = checkAgentBudget("Ops");
    expect(r.state).toBe("warn");
    expect(r.hardStopEnabled).toBe(false);
  });

  test("capped agent, hard-stop ON, over cap → hard_stop", () => {
    createAgent({ name: "Ops", capCents: 1000, hardStopEnabled: true });
    seedAgentSpend("Ops", 15);
    const r = checkAgentBudget("Ops");
    expect(r.state).toBe("hard_stop");
    expect(r.hardStopEnabled).toBe(true);
  });

  test("capped agent, hard-stop ON, under warn → ok", () => {
    createAgent({ name: "Ops", capCents: 10000, hardStopEnabled: true });
    seedAgentSpend("Ops", 15); // 1500 of 10000 = 15% < 80%
    expect(checkAgentBudget("Ops").state).toBe("ok");
  });

  test("no cap → ok even with spend", () => {
    createAgent({ name: "Ops", hardStopEnabled: true }); // capCents null
    seedAgentSpend("Ops", 99);
    expect(checkAgentBudget("Ops").state).toBe("ok");
  });
});

describe("checkRunStartBudget", () => {
  test("returns the most severe of agent + task", () => {
    createAgent({ name: "Ops", capCents: 10000, hardStopEnabled: true });
    seedAgentSpend("Ops", 1); // agent ok
    const id = newTaskItem(1000);
    seedAct(id, 1200); // task hard_stop
    const r = checkRunStartBudget("Ops", id);
    expect(r.state).toBe("hard_stop");
    expect(r.scope).toBe("task");
  });

  test("both clear → ok", () => {
    const id = newTaskItem(null);
    expect(checkRunStartBudget("cue", id).state).toBe("ok");
  });
});
