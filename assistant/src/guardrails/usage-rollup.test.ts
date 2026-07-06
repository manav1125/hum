/**
 * Tests for the per-mission $ attribution slice of the Guardrails ledger:
 * the usage → run conversation → work item → project → mission join, the
 * trailing window, and the omit-zero-cost-missions contract.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createMission } from "../missions/mission-store.js";
import { createTask } from "../tasks/task-store.js";
import { createProject } from "../work-items/project-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import { getMissionSpend } from "./usage-rollup.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM llm_usage_events");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM missions");
});

function seedUsage(
  conversationId: string,
  usd: number,
  createdAt = Date.now(),
): void {
  getSqliteFrom(getDb())
    .prepare(
      /*sql*/ `INSERT INTO llm_usage_events
        (id, created_at, conversation_id, actor, provider, model,
         input_tokens, output_tokens, estimated_cost_usd, pricing_status)
       VALUES (?, ?, ?, 'main_agent', 'openrouter', 'm', 100, 50, ?, 'priced')`,
    )
    .run(
      `u-${Math.random().toString(36).slice(2)}`,
      createdAt,
      conversationId,
      usd,
    );
}

/** Mission → project → work item bound to a run conversation. */
function seedMissionChain(
  missionTitle: string,
  conversationId: string,
): string {
  const mission = createMission({ title: missionTitle, outcome: "o" });
  const project = createProject({ title: `${missionTitle} project` });
  getDb().run(
    `UPDATE projects SET mission_id = '${mission.id}' WHERE id = '${project.id}'`,
  );
  const task = createTask({ title: "t", template: "do" });
  const item = createWorkItem({
    taskId: task.id,
    title: "work",
    projectId: project.id,
  });
  updateWorkItem(item.id, { lastRunConversationId: conversationId });
  return mission.id;
}

describe("getMissionSpend", () => {
  test("attributes cost through the full chain, highest-cost first", () => {
    const bigId = seedMissionChain("Big", "conv-big");
    const smallId = seedMissionChain("Small", "conv-small");
    seedUsage("conv-big", 1.25);
    seedUsage("conv-big", 0.75); // same run conversation → 1 run, summed
    seedUsage("conv-small", 0.1);
    seedUsage("conv-chat", 99); // unattributed chat usage — excluded

    const spend = getMissionSpend();
    expect(spend).toEqual([
      { missionId: bigId, missionTitle: "Big", costCents: 200, runs: 1 },
      { missionId: smallId, missionTitle: "Small", costCents: 10, runs: 1 },
    ]);
  });

  test("omits missions with no attributable cost", () => {
    seedMissionChain("Idle", "conv-idle"); // chain exists, zero usage
    const zeroId = seedMissionChain("Zero", "conv-zero");
    seedUsage("conv-zero", 0); // rows exist but cost rounds to 0¢
    expect(zeroId).toBeTruthy();

    expect(getMissionSpend()).toEqual([]);
  });

  test("honours the trailing-days window", () => {
    const id = seedMissionChain("Windowed", "conv-w");
    seedUsage("conv-w", 0.5); // now — inside any window
    seedUsage("conv-w", 3.0, Date.now() - 10 * 24 * 60 * 60 * 1000); // 10d ago

    const week = getMissionSpend({ days: 7 });
    expect(week).toEqual([
      { missionId: id, missionTitle: "Windowed", costCents: 50, runs: 1 },
    ]);

    const month = getMissionSpend({ days: 30 });
    expect(month[0].costCents).toBe(350);
  });

  test("empty workspace returns an empty list", () => {
    expect(getMissionSpend()).toEqual([]);
  });
});
