import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createMission } from "../../missions/mission-store.js";
import { createTask } from "../../tasks/task-store.js";
import { createWorkItemWithPermissions } from "../../work-items/work-item-store.js";
import { buildLiveBriefing } from "../build-live-briefing.js";

initializeDb();

function resetTables() {
  const db = getDb();
  for (const table of ["work_items", "tasks", "missions", "projects"]) {
    db.run(`DELETE FROM ${table}`);
  }
}

function addOpenTask(title: string) {
  const task = createTask({ title, template: title });
  return createWorkItemWithPermissions({ taskId: task.id, title });
}

describe("buildLiveBriefing", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns an empty string on a fresh workspace (never throws)", () => {
    expect(buildLiveBriefing()).toBe("");
  });

  test("includes the CONTEXT header and open tasks when work exists", () => {
    addOpenTask("Call the dentist");
    addOpenTask("Review the Q3 deck");

    const briefing = buildLiveBriefing();

    expect(briefing).toContain("CONTEXT");
    expect(briefing).toContain("On their plate right now");
    expect(briefing).toContain("Call the dentist");
    expect(briefing).toContain("Review the Q3 deck");
    // A new work item is "queued", which counts as open.
    expect(briefing).toContain("(queued)");
  });

  test("includes active missions with their outcome", () => {
    createMission({
      title: "Ship Cue Live",
      outcome: "1,000 weekly voice sessions",
    });

    const briefing = buildLiveBriefing();

    expect(briefing).toContain("Active missions");
    expect(briefing).toContain("Ship Cue Live");
    expect(briefing).toContain("1,000 weekly voice sessions");
  });

  test("respects the maxChars cap", () => {
    for (let i = 0; i < 50; i++)
      addOpenTask(`Task number ${i} with some padding`);

    const briefing = buildLiveBriefing({ maxChars: 400 });

    // Header + capped body; the body slice is bounded, so the whole thing stays
    // comfortably under a small multiple of the cap.
    expect(briefing.length).toBeLessThan(900);
    expect(briefing).toContain("CONTEXT");
  });
});
