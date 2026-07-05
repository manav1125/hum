/**
 * Tests for the mission store (HQ Phase 1): mission CRUD + ordering,
 * rollups across linked projects, the single-row company profile, the
 * mission_events audit trail, and the exact-once plan-fingerprint claim.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createProject, updateProject } from "../work-items/project-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import {
  claimMissionPlanFingerprint,
  computeMissionDrift,
  CONTINUATION_SUMMARY_MAX_CHARS,
  createMission,
  deleteMission,
  getCompanyProfile,
  getMission,
  getMissionAchievedSummary,
  getMissionWithRollup,
  listMissionEvents,
  listMissions,
  listMissionsWithRollups,
  maybeEmitMissionDrift,
  recordMissionEvent,
  updateCompanyProfile,
  updateMission,
} from "./mission-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM missions");
  getDb().run("DELETE FROM mission_events");
  getDb().run("DELETE FROM mission_plan_fingerprints");
  getDb().run("DELETE FROM company_profile");
});

function linkProject(missionId: string, title: string): string {
  const project = createProject({ title });
  getDb().run(
    `UPDATE projects SET mission_id = '${missionId}' WHERE id = '${project.id}'`,
  );
  return project.id;
}

describe("mission CRUD", () => {
  test("round-trips all fields", () => {
    const m = createMission({
      title: "First 20 customers",
      outcome: "20 paying customers",
      metric: "MRR",
      horizon: 1893456000000,
      mode: "autonomous",
      brief: "Revenue proves the product.",
      cadence: "daily",
      budgetCents: 5000,
      pinned: true,
      sortIndex: 1,
    });
    const fetched = getMission(m.id)!;
    expect(fetched.title).toBe("First 20 customers");
    expect(fetched.outcome).toBe("20 paying customers");
    expect(fetched.metric).toBe("MRR");
    expect(fetched.mode).toBe("autonomous");
    expect(fetched.brief).toBe("Revenue proves the product.");
    expect(fetched.cadence).toBe("daily");
    expect(fetched.budgetCents).toBe(5000);
    expect(fetched.spentCents).toBe(0);
    expect(fetched.status).toBe("active");
    expect(fetched.pinned).toBe(1);
    expect(fetched.lastCycleAt).toBeNull();
  });

  test("update edits fields; list excludes abandoned by default", () => {
    const a = createMission({ title: "A", outcome: "a" });
    const b = createMission({ title: "B", outcome: "b" });
    updateMission(a.id, { status: "abandoned" });
    updateMission(b.id, { status: "paused", spentCents: 42 });

    const listed = listMissions();
    expect(listed.map((m) => m.id)).toEqual([b.id]);
    expect(listed[0]!.spentCents).toBe(42);
    expect(listMissions({ status: "abandoned" }).map((m) => m.id)).toEqual([
      a.id,
    ]);
  });

  test("list orders pinned-first, then sortIndex, then newest", () => {
    const plain = createMission({ title: "plain", outcome: "x" });
    const sorted = createMission({
      title: "sorted",
      outcome: "x",
      sortIndex: 0,
    });
    const pinned = createMission({
      title: "pinned",
      outcome: "x",
      pinned: true,
    });
    expect(listMissions().map((m) => m.id)).toEqual([
      pinned.id,
      sorted.id,
      plain.id,
    ]);
  });

  test("continuation summary is hard-bounded at the store choke point", () => {
    const m = createMission({ title: "M", outcome: "x" });
    updateMission(m.id, {
      continuationSummary: "x".repeat(CONTINUATION_SUMMARY_MAX_CHARS * 2),
    });
    const fetched = getMission(m.id)!;
    expect(fetched.continuationSummary!.length).toBeLessThanOrEqual(
      CONTINUATION_SUMMARY_MAX_CHARS,
    );
    expect(fetched.continuationSummary!.endsWith("[truncated]")).toBe(true);
  });

  test("delete nulls linked projects' mission_id and removes events/fingerprints", () => {
    const m = createMission({ title: "M", outcome: "x" });
    const projectId = linkProject(m.id, "Initiative");
    recordMissionEvent({ missionId: m.id, kind: "cycle_started" });
    claimMissionPlanFingerprint(m.id, "hash1");

    deleteMission(m.id);

    expect(getMission(m.id)).toBeUndefined();
    expect(listMissionEvents(m.id)).toEqual([]);
    const row = getDb()
      .all(`SELECT mission_id FROM projects WHERE id = '${projectId}'`)
      .at(0) as { mission_id: string | null };
    expect(row.mission_id).toBeNull();
    // The fingerprint namespace is freed with the mission.
    expect(claimMissionPlanFingerprint(m.id, "hash1")).toBe(true);
  });
});

describe("rollups", () => {
  test("aggregates linked projects and work-item counts by status", () => {
    const m = createMission({ title: "M", outcome: "x", budgetCents: 1000 });
    const p1 = linkProject(m.id, "Init 1");
    const p2 = linkProject(m.id, "Init 2");
    // A project NOT linked to the mission must not leak into the rollup.
    const other = createProject({ title: "Unrelated" });

    const task = createTask({ title: "t", template: "t" });
    createWorkItem({ taskId: task.id, title: "q1", projectId: p1 });
    createWorkItem({ taskId: task.id, title: "q2", projectId: p2 });
    const running = createWorkItem({
      taskId: task.id,
      title: "r",
      projectId: p1,
    });
    updateWorkItem(running.id, { status: "running" });
    const review = createWorkItem({
      taskId: task.id,
      title: "v",
      projectId: p2,
    });
    updateWorkItem(review.id, { status: "awaiting_review" });
    const done = createWorkItem({ taskId: task.id, title: "d", projectId: p1 });
    updateWorkItem(done.id, { status: "done" });
    createWorkItem({ taskId: task.id, title: "outside", projectId: other.id });

    updateMission(m.id, { spentCents: 123 });
    const rolled = getMissionWithRollup(m.id)!;
    expect(rolled.rollup.projects.map((p) => p.id).sort()).toEqual(
      [p1, p2].sort(),
    );
    expect(rolled.rollup.counts).toEqual({
      queued: 2,
      running: 1,
      awaiting_review: 1,
      done: 1,
      failed: 0,
      open: 4,
      total: 5,
    });
    expect(rolled.rollup.spentCents).toBe(123);
    expect(rolled.rollup.budgetCents).toBe(1000);
  });

  test("mission with no linked projects rolls up to zeros", () => {
    createMission({ title: "Empty", outcome: "x" });
    const [rolled] = listMissionsWithRollups();
    expect(rolled!.rollup.projects).toEqual([]);
    expect(rolled!.rollup.counts.total).toBe(0);
  });

  test("archived linked projects still appear in the rollup listing", () => {
    const m = createMission({ title: "M", outcome: "x" });
    const p = linkProject(m.id, "Init");
    updateProject(p, { status: "archived" });
    const rolled = getMissionWithRollup(m.id)!;
    expect(rolled.rollup.projects).toHaveLength(1);
    expect(rolled.rollup.projects[0]!.status).toBe("archived");
  });
});

describe("company profile", () => {
  test("missing row reads as defaults", () => {
    const profile = getCompanyProfile();
    expect(profile.identity).toBeNull();
    expect(profile.neverLines).toEqual([]);
    expect(profile.workspaceMode).toBe("assist");
  });

  test("partial upsert keeps omitted fields", () => {
    updateCompanyProfile({
      identity: "We build Cue.",
      neverLines: ["Never spend money without approval"],
    });
    const updated = updateCompanyProfile({ workspaceMode: "autonomous" });
    expect(updated.identity).toBe("We build Cue.");
    expect(updated.neverLines).toEqual(["Never spend money without approval"]);
    expect(updated.workspaceMode).toBe("autonomous");
  });
});

describe("mission events", () => {
  test("records and lists chronologically with payload JSON", () => {
    const m = createMission({ title: "M", outcome: "x" });
    recordMissionEvent({
      missionId: m.id,
      kind: "cycle_started",
      cycleId: "c1",
    });
    recordMissionEvent({
      missionId: m.id,
      kind: "planned",
      cycleId: "c1",
      payload: { items: [{ title: "do it" }] },
    });
    const events = listMissionEvents(m.id);
    expect(events.map((e) => e.kind)).toEqual(["cycle_started", "planned"]);
    expect(JSON.parse(events[1]!.payload!)).toEqual({
      items: [{ title: "do it" }],
    });
  });
});

describe("drift detection", () => {
  /** Record a full cycle window with the given kinds under one cycleId. */
  function cycle(missionId: string, cycleId: string, kinds: string[]): void {
    for (const kind of kinds) {
      recordMissionEvent({
        missionId,
        kind: kind as Parameters<typeof recordMissionEvent>[0]["kind"],
        cycleId,
      });
    }
  }

  test("three idle cycles → drifting; a progress cycle resets the streak", () => {
    const m = createMission({ title: "M", outcome: "x" });
    cycle(m.id, "c1", ["cycle_started", "planned", "reported"]);
    cycle(m.id, "c2", ["cycle_started", "planned", "reported"]);
    let drift = computeMissionDrift(m.id);
    expect(drift.idleCycles).toBe(2);
    expect(drift.drifting).toBe(false);

    cycle(m.id, "c3", ["cycle_started", "planned", "reported"]);
    drift = computeMissionDrift(m.id);
    expect(drift.cyclesObserved).toBe(3);
    expect(drift.idleCycles).toBe(3);
    expect(drift.drifting).toBe(true);
    expect(drift.latestCycleId).toBe("c3");

    // A cycle that enqueues work is real progress — streak resets to zero.
    cycle(m.id, "c4", [
      "cycle_started",
      "planned",
      "item_enqueued",
      "reported",
    ]);
    drift = computeMissionDrift(m.id);
    expect(drift.idleCycles).toBe(0);
    expect(drift.drifting).toBe(false);
  });

  test("output_ready also counts as progress", () => {
    const m = createMission({ title: "M", outcome: "x" });
    cycle(m.id, "c1", ["cycle_started", "output_ready"]);
    cycle(m.id, "c2", ["cycle_started", "reported"]);
    cycle(m.id, "c3", ["cycle_started", "reported"]);
    const drift = computeMissionDrift(m.id);
    // Only 2 trailing idle cycles — the output_ready cycle breaks the streak.
    expect(drift.idleCycles).toBe(2);
    expect(drift.drifting).toBe(false);
  });

  test("maybeEmitMissionDrift emits one checkpoint per window (idempotent)", () => {
    const m = createMission({ title: "M", outcome: "x" });
    cycle(m.id, "c1", ["cycle_started", "planned", "reported"]);
    cycle(m.id, "c2", ["cycle_started", "planned", "reported"]);
    cycle(m.id, "c3", ["cycle_started", "planned", "reported"]);

    expect(maybeEmitMissionDrift(m.id)).toBe(true);
    // Second call within the same cycle window is a no-op.
    expect(maybeEmitMissionDrift(m.id)).toBe(false);

    const driftEvents = listMissionEvents(m.id).filter((e) => {
      if (e.kind !== "checkpoint" || !e.payload) return false;
      return (JSON.parse(e.payload) as { drift?: boolean }).drift === true;
    });
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0]!.cycleId).toBe("c3");
  });

  test("a new idle cycle window re-arms the nudge", () => {
    const m = createMission({ title: "M", outcome: "x" });
    cycle(m.id, "c1", ["cycle_started", "reported"]);
    cycle(m.id, "c2", ["cycle_started", "reported"]);
    cycle(m.id, "c3", ["cycle_started", "reported"]);
    expect(maybeEmitMissionDrift(m.id)).toBe(true);
    // Another idle cycle later — new latestCycleId, so the nudge fires again.
    cycle(m.id, "c4", ["cycle_started", "reported"]);
    expect(maybeEmitMissionDrift(m.id)).toBe(true);
  });

  test("paused missions never drift-nudge", () => {
    const m = createMission({ title: "M", outcome: "x" });
    cycle(m.id, "c1", ["cycle_started", "reported"]);
    cycle(m.id, "c2", ["cycle_started", "reported"]);
    cycle(m.id, "c3", ["cycle_started", "reported"]);
    updateMission(m.id, { status: "paused" });
    expect(maybeEmitMissionDrift(m.id)).toBe(false);
  });

  test("fewer than three cycles never drifts", () => {
    const m = createMission({ title: "M", outcome: "x" });
    cycle(m.id, "c1", ["cycle_started", "reported"]);
    cycle(m.id, "c2", ["cycle_started", "reported"]);
    expect(computeMissionDrift(m.id).drifting).toBe(false);
    expect(maybeEmitMissionDrift(m.id)).toBe(false);
  });
});

describe("achieved summary", () => {
  test("rolls cycles, outputs, items, spend, and hours-back from the trail", () => {
    const m = createMission({ title: "M", outcome: "x" });
    updateMission(m.id, { spentCents: 1234 });
    recordMissionEvent({
      missionId: m.id,
      kind: "cycle_started",
      cycleId: "c1",
    });
    recordMissionEvent({
      missionId: m.id,
      kind: "item_enqueued",
      cycleId: "c1",
    });
    recordMissionEvent({
      missionId: m.id,
      kind: "output_ready",
      cycleId: "c1",
    });
    recordMissionEvent({
      missionId: m.id,
      kind: "output_ready",
      cycleId: "c1",
    });
    recordMissionEvent({
      missionId: m.id,
      kind: "cycle_started",
      cycleId: "c2",
    });
    recordMissionEvent({ missionId: m.id, kind: "reported", cycleId: "c2" });

    const summary = getMissionAchievedSummary(m.id)!;
    expect(summary.cycles).toBe(2);
    expect(summary.outputs).toBe(2);
    expect(summary.itemsEnqueued).toBe(1);
    expect(summary.spentCents).toBe(1234);
    // 2 outputs × 30 min = 60 min → 1 hour back.
    expect(summary.hoursSaved).toBe(1);
  });

  test("missing mission returns undefined", () => {
    expect(getMissionAchievedSummary("nope")).toBeUndefined();
  });
});

describe("exact-once plan fingerprints", () => {
  test("first claim wins; repeat claim of the same plan loses", () => {
    const m = createMission({ title: "M", outcome: "x" });
    expect(claimMissionPlanFingerprint(m.id, "hash-a")).toBe(true);
    expect(claimMissionPlanFingerprint(m.id, "hash-a")).toBe(false);
    // A different plan (or a different mission) is a fresh claim.
    expect(claimMissionPlanFingerprint(m.id, "hash-b")).toBe(true);
    const m2 = createMission({ title: "M2", outcome: "y" });
    expect(claimMissionPlanFingerprint(m2.id, "hash-a")).toBe(true);
  });
});
