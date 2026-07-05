/**
 * Tests for the action-item → work-item bridge's filing resolution.
 *
 * The bridge routes every minted item through triage (which files it onto its
 * best-matching project, and thus a mission via project.missionId) and folds the
 * resolved filing back into the returned refs so a caller — the voice-intake
 * response — can show the real ⟡ project/mission tag. These tests drive the
 * bridge against the real project/mission/work-item stores and stub only the
 * triage pass, so we can assert:
 *   - triage files onto a mission-linked project → ref carries projectId +
 *     projectTitle + missionId + missionTitle;
 *   - triage files onto an unlinked project → mission fields are null;
 *   - triage files nothing → every filing field is null (the neutral state).
 *
 * The event-hub broadcast is stubbed (no client to notify in a unit test).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the broadcast — there is no client hub in a unit test.
mock.module("../../assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

// Stub triage so each test deterministically controls the filing (or lack of
// it) that gets stamped onto the freshly-minted work item, standing in for the
// real flash-LLM project match. The bridge awaits this before reading the row
// back, so a synchronous stamp is observed by the filing resolution.
let fileOntoProjectId: string | null = null;
mock.module("../../../work-items/work-item-triage.js", () => ({
  triageAndMaybeAutoRunWorkItem: async (workItemId: string) => {
    if (fileOntoProjectId) {
      const { updateWorkItem } =
        await import("../../../work-items/work-item-store.js");
      updateWorkItem(
        workItemId,
        { projectId: fileOntoProjectId },
        { actor: "triage" },
      );
    }
    return { autoRunStarted: false, reason: "policy_ask" as const };
  },
}));

import { eq } from "drizzle-orm";

import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { missions } from "../../../memory/schema/index.js";
import { createMission } from "../../../missions/mission-store.js";
import {
  createProject,
  updateProject,
} from "../../../work-items/project-store.js";
import { actionItemsToWorkItems } from "../action-item-work-items.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM missions");
  fileOntoProjectId = null;
});

const CONV = "conv-voice-1";

describe("actionItemsToWorkItems — filing resolution", () => {
  test("files onto a mission-linked project → ref carries project + mission", async () => {
    const mission = createMission({
      title: "Grow ARR to $10M",
      outcome: "ARR $10M",
    });
    const project = createProject({ title: "Q4 pricing launch" });
    updateProject(project.id, { missionId: mission.id });
    fileOntoProjectId = project.id;

    const refs = await actionItemsToWorkItems(
      [{ text: "Draft the new pricing page", owner: null, done: false }],
      "voice",
      CONV,
    );

    expect(refs).toHaveLength(1);
    expect(refs[0]?.created).toBe(true);
    expect(refs[0]?.projectId).toBe(project.id);
    expect(refs[0]?.projectTitle).toBe("Q4 pricing launch");
    expect(refs[0]?.missionId).toBe(mission.id);
    expect(refs[0]?.missionTitle).toBe("Grow ARR to $10M");
  });

  test("files onto a project with no mission → mission fields null", async () => {
    const project = createProject({ title: "Personal errands" });
    fileOntoProjectId = project.id;

    const refs = await actionItemsToWorkItems(
      [{ text: "Book a dentist appointment", owner: null, done: false }],
      "voice",
      CONV,
    );

    expect(refs).toHaveLength(1);
    expect(refs[0]?.projectId).toBe(project.id);
    expect(refs[0]?.projectTitle).toBe("Personal errands");
    expect(refs[0]?.missionId).toBeNull();
    expect(refs[0]?.missionTitle).toBeNull();
  });

  test("no project match → every filing field is null (neutral state)", async () => {
    fileOntoProjectId = null; // triage isn't confident; files onto nothing

    const refs = await actionItemsToWorkItems(
      [{ text: "Think about the offsite theme", owner: null, done: false }],
      "voice",
      CONV,
    );

    expect(refs).toHaveLength(1);
    expect(refs[0]?.projectId).toBeNull();
    expect(refs[0]?.projectTitle).toBeNull();
    expect(refs[0]?.missionId).toBeNull();
    expect(refs[0]?.missionTitle).toBeNull();
  });

  test("mission fields null when the linked mission row is gone", async () => {
    const mission = createMission({ title: "Stale mission", outcome: "x" });
    const project = createProject({ title: "Orphaned project" });
    updateProject(project.id, { missionId: mission.id });
    // Delete the mission ROW directly (leaving project.missionId dangling) so we
    // exercise the guard where getMission returns undefined for a still-set link.
    getDb().delete(missions).where(eq(missions.id, mission.id)).run();
    fileOntoProjectId = project.id;

    const refs = await actionItemsToWorkItems(
      [{ text: "Do the orphaned thing", owner: null, done: false }],
      "voice",
      CONV,
    );

    expect(refs[0]?.projectId).toBe(project.id);
    expect(refs[0]?.projectTitle).toBe("Orphaned project");
    expect(refs[0]?.missionId).toBeNull();
    expect(refs[0]?.missionTitle).toBeNull();
  });
});
