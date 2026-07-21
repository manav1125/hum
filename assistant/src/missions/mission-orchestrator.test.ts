/**
 * Mission orchestrator cycle tests (mocked LLM planner):
 *   - plan → items enqueued into linked projects, with audit events;
 *   - exact-once: a re-run producing the same plan hash enqueues nothing;
 *   - observe mode assesses + reports but never enqueues;
 *   - budget hard-stop pauses the mission (and the pre-check refuses to
 *     spend more);
 *   - the continuation summary is regenerated each cycle and stays bounded;
 *   - the kill switch skips scheduled cycles but not forced ones.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createProject } from "../work-items/project-store.js";
import { listWorkItems } from "../work-items/work-item-store.js";
import {
  isMissionCycleDue,
  MissionOrchestrator,
  type MissionPlannerResult,
  parseMissionPlan,
} from "./mission-orchestrator.js";
import {
  CONTINUATION_SUMMARY_MAX_CHARS,
  createMission,
  getMission,
  listMissionEvents,
  type Mission,
  updateCompanyProfile,
  updateMission,
} from "./mission-store.js";

initializeDb();

// Keep cycles hermetic: even in autonomous mode the enqueued items must not
// spawn real background runs from a unit test. The orchestrator defers to
// the normal triage/auto-run path, and this is that path's own kill switch.
beforeAll(() => {
  process.env.CUE_DISABLE_WORKITEM_AUTORUN = "1";
});
afterAll(() => {
  delete process.env.CUE_DISABLE_WORKITEM_AUTORUN;
  delete process.env.CUE_DISABLE_MISSION_ORCHESTRATOR;
});

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM missions");
  getDb().run("DELETE FROM mission_events");
  getDb().run("DELETE FROM mission_plan_fingerprints");
  getDb().run("DELETE FROM company_profile");
  delete process.env.CUE_DISABLE_MISSION_ORCHESTRATOR;
});

function makeMissionWithProject(opts?: {
  mode?: "observe" | "assist" | "autonomous";
  budgetCents?: number;
}): { mission: Mission; projectId: string } {
  const mission = createMission({
    title: "First 20 customers",
    outcome: "20 paying customers",
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.budgetCents != null ? { budgetCents: opts.budgetCents } : {}),
  });
  const project = createProject({ title: "Outbound" });
  getDb().run(
    `UPDATE projects SET mission_id = '${mission.id}' WHERE id = '${project.id}'`,
  );
  return { mission, projectId: project.id };
}

function plannerReturning(
  plan: unknown,
  costCents = 0,
): (prompt: string) => Promise<MissionPlannerResult> {
  return () => Promise.resolve({ text: JSON.stringify(plan), costCents });
}

const TWO_ITEM_PLAN = {
  assessment: "No customers yet; outbound has not started.",
  items: [
    {
      projectId: null,
      title: "Draft the outreach email",
      notes: "50 words max",
    },
    { projectId: null, title: "Build a 20-lead list", notes: "ICP: founders" },
  ],
  report: "Kicked off outbound: drafting outreach and building the lead list.",
};

describe("parseMissionPlan", () => {
  test("parses JSON with surrounding prose and drops junk items", () => {
    const text = `Here you go:\n${JSON.stringify({
      assessment: "ok",
      items: [
        { title: "Real", projectId: "p1", notes: "n" },
        { title: "   " },
        "garbage",
      ],
      report: "r",
    })}\nthanks`;
    const plan = parseMissionPlan(text)!;
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.title).toBe("Real");
    expect(plan.report).toBe("r");
  });

  test("returns null for non-JSON", () => {
    expect(parseMissionPlan("no json here")).toBeNull();
  });

  test("parses a per-item assignee, defaulting to null when absent", () => {
    const text = JSON.stringify({
      assessment: "ok",
      items: [
        { title: "Ops work", assignee: "Ops" },
        { title: "Unowned work" },
      ],
      report: "r",
    });
    const plan = parseMissionPlan(text)!;
    expect(plan.items[0]!.assignee).toBe("Ops");
    expect(plan.items[1]!.assignee).toBeNull();
  });
});

describe("cycle execution", () => {
  test("plan → items enqueued into the linked project with audit events", async () => {
    const { mission, projectId } = makeMissionWithProject({ mode: "assist" });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning(TWO_ITEM_PLAN, 1),
    });

    const result = await orchestrator.runCycle(mission.id);
    expect(result.ran).toBe(true);
    expect(result.reason).toBe("completed");
    expect(result.enqueued).toBe(2);

    const items = listWorkItems({ projectId });
    expect(items).toHaveLength(2);
    // assist mode = draft-only: items wait for a human, they never start.
    expect(items.every((i) => i.status === "queued")).toBe(true);
    expect(items.every((i) => i.sourceType === "mission")).toBe(true);
    expect(items.every((i) => i.sourceId === mission.id)).toBe(true);

    const kinds = listMissionEvents(mission.id).map((e) => e.kind);
    expect(kinds).toContain("cycle_started");
    expect(kinds).toContain("planned");
    expect(kinds.filter((k) => k === "item_enqueued")).toHaveLength(2);
    expect(kinds).toContain("reported");

    const fresh = getMission(mission.id)!;
    expect(fresh.lastCycleAt).not.toBeNull();
    expect(fresh.spentCents).toBe(1);
  });

  test("plan items get the conservative requiredTools stamp; side-effect items stay empty", async () => {
    const { mission, projectId } = makeMissionWithProject({ mode: "assist" });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning({
        assessment: "a",
        items: [
          {
            projectId: null,
            title: "Research competitor pricing",
            notes: "Compare the top 5 and summarize",
          },
          {
            projectId: null,
            title: "Email the beta invite to the waitlist",
            notes: null,
          },
        ],
        report: "r",
      }),
    });

    const result = await orchestrator.runCycle(mission.id);
    expect(result.enqueued).toBe(2);

    const items = listWorkItems({ projectId });
    const research = items.find((i) => i.title.startsWith("Research"))!;
    // Read-only research tools — classifies to "research" (not the
    // fail-closed "other"), so autonomous-mode items can pass the auto-run
    // policy gate instead of parking forever.
    expect(JSON.parse(research.requiredTools!)).toEqual([
      "web_fetch",
      "web_search",
    ]);
    // "Email X" implies a side-effect deliverable — deliberately no snapshot,
    // so the item parks for human review.
    const email = items.find((i) => i.title.startsWith("Email"))!;
    expect(email.requiredTools).toBeNull();
  });

  test("exact-once: a re-run producing the same plan enqueues nothing", async () => {
    const { mission, projectId } = makeMissionWithProject({ mode: "assist" });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning(TWO_ITEM_PLAN),
    });

    const first = await orchestrator.runCycle(mission.id);
    expect(first.enqueued).toBe(2);

    // Same plan hash (e.g. a crashed cycle re-running) → fingerprint already
    // claimed → zero duplicates.
    const second = await orchestrator.runCycle(mission.id);
    expect(second.ran).toBe(true);
    expect(second.enqueued).toBe(0);
    expect(second.duplicatePlan).toBe(true);
    expect(listWorkItems({ projectId })).toHaveLength(2);

    // A genuinely different plan is a fresh fingerprint.
    const orchestrator2 = new MissionOrchestrator({
      planner: plannerReturning({
        ...TWO_ITEM_PLAN,
        items: [
          { projectId: null, title: "Follow up with warm leads", notes: null },
        ],
      }),
    });
    const third = await orchestrator2.runCycle(mission.id);
    expect(third.enqueued).toBe(1);
    expect(listWorkItems({ projectId })).toHaveLength(3);
  });

  test("observe mode assesses and reports but never enqueues", async () => {
    const { mission, projectId } = makeMissionWithProject({ mode: "observe" });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning(TWO_ITEM_PLAN),
    });

    const result = await orchestrator.runCycle(mission.id);
    expect(result.ran).toBe(true);
    expect(result.enqueued).toBe(0);
    expect(listWorkItems({ projectId })).toHaveLength(0);

    const kinds = listMissionEvents(mission.id).map((e) => e.kind);
    expect(kinds).toContain("planned");
    expect(kinds).toContain("reported");
    expect(kinds).not.toContain("item_enqueued");
  });

  test("workspace mode is the fallback when the mission has no override", async () => {
    updateCompanyProfile({ workspaceMode: "observe" });
    const { mission, projectId } = makeMissionWithProject(); // mode = null
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning(TWO_ITEM_PLAN),
    });
    const result = await orchestrator.runCycle(mission.id);
    expect(result.enqueued).toBe(0);
    expect(listWorkItems({ projectId })).toHaveLength(0);
  });

  test("never-lines from the company profile land in the planning prompt", async () => {
    updateCompanyProfile({
      neverLines: ["Never contact journalists", "Never spend money"],
    });
    const { mission } = makeMissionWithProject({ mode: "assist" });
    let seenPrompt = "";
    const orchestrator = new MissionOrchestrator({
      planner: (prompt) => {
        seenPrompt = prompt;
        return Promise.resolve({
          text: JSON.stringify({ assessment: "a", items: [], report: "r" }),
          costCents: 0,
        });
      },
    });
    await orchestrator.runCycle(mission.id);
    expect(seenPrompt).toContain("Never contact journalists");
    expect(seenPrompt).toContain("Never spend money");
    expect(seenPrompt).toContain("hard-constraints");
  });

  test("budget hard-stop: cycle cost reaching the cap pauses the mission", async () => {
    const { mission } = makeMissionWithProject({
      mode: "assist",
      budgetCents: 3,
    });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning(TWO_ITEM_PLAN, 5),
    });

    const result = await orchestrator.runCycle(mission.id);
    expect(result.ran).toBe(true);

    const fresh = getMission(mission.id)!;
    expect(fresh.spentCents).toBe(5);
    expect(fresh.status).toBe("paused");
    expect(listMissionEvents(mission.id).map((e) => e.kind)).toContain(
      "budget_stop",
    );

    // Paused missions never cycle again — not even forced.
    const after = await orchestrator.runCycle(mission.id, { force: true });
    expect(after.ran).toBe(false);
    expect(after.reason).toBe("not_active");
  });

  test("budget pre-check refuses to spend when the cap is already burned", async () => {
    const { mission } = makeMissionWithProject({ budgetCents: 10 });
    updateMission(mission.id, { spentCents: 10 });
    let plannerCalls = 0;
    const orchestrator = new MissionOrchestrator({
      planner: () => {
        plannerCalls++;
        return Promise.resolve({ text: "{}", costCents: 0 });
      },
    });

    const result = await orchestrator.runCycle(mission.id);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("budget_exhausted");
    expect(plannerCalls).toBe(0);
    expect(getMission(mission.id)!.status).toBe("paused");
  });

  test("continuation summary is regenerated each cycle and stays bounded", async () => {
    const { mission } = makeMissionWithProject({ mode: "assist" });
    const hugeReport = "Do the thing. ".repeat(2_000); // ~28k chars
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning({ ...TWO_ITEM_PLAN, report: hugeReport }),
    });

    const first = await orchestrator.runCycle(mission.id);
    const summary1 = getMission(mission.id)!.continuationSummary!;
    expect(summary1.length).toBeLessThanOrEqual(CONTINUATION_SUMMARY_MAX_CHARS);
    expect(summary1).toContain("# Mission Continuation Summary");
    expect(summary1).toContain(first.cycleId!);
    expect(summary1).toContain("Enqueued 2 work item(s)");

    const orchestrator2 = new MissionOrchestrator({
      planner: plannerReturning({
        assessment: "moving",
        items: [],
        report: "Waiting on drafts.",
      }),
    });
    const second = await orchestrator2.runCycle(mission.id);
    const summary2 = getMission(mission.id)!.continuationSummary!;
    // Regenerated, not appended: the new cycle replaces the old doc.
    expect(summary2).toContain(second.cycleId!);
    expect(summary2).not.toContain(first.cycleId!);
    expect(summary2.length).toBeLessThanOrEqual(CONTINUATION_SUMMARY_MAX_CHARS);
    expect(summary2).toContain("Waiting on drafts.");
  });

  test("a plan that fails to parse records an error event and still stamps the cycle", async () => {
    const { mission } = makeMissionWithProject({ mode: "assist" });
    const orchestrator = new MissionOrchestrator({
      planner: () => Promise.resolve({ text: "not json at all", costCents: 2 }),
    });
    const result = await orchestrator.runCycle(mission.id);
    expect(result.ran).toBe(true);
    expect(result.reason).toBe("plan_failed");
    const fresh = getMission(mission.id)!;
    expect(fresh.lastCycleAt).not.toBeNull();
    expect(fresh.spentCents).toBe(2);
    expect(listMissionEvents(mission.id).map((e) => e.kind)).toContain("error");
  });

  test("plan items pointing at unknown projects fall back to a linked project", async () => {
    const { mission, projectId } = makeMissionWithProject({ mode: "assist" });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning({
        assessment: "a",
        items: [{ projectId: "made-up-id", title: "Task", notes: null }],
        report: "r",
      }),
    });
    await orchestrator.runCycle(mission.id);
    const items = listWorkItems({ projectId });
    expect(items).toHaveLength(1);
  });

  test("a mission with no linked projects plans but enqueues nothing", async () => {
    const mission = createMission({
      title: "Unlinked",
      outcome: "x",
      mode: "assist",
    });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning(TWO_ITEM_PLAN),
    });
    const result = await orchestrator.runCycle(mission.id);
    expect(result.ran).toBe(true);
    expect(result.enqueued).toBe(0);
    const kinds = listMissionEvents(mission.id).map((e) => e.kind);
    expect(kinds).toContain("checkpoint");
    expect(kinds).not.toContain("item_enqueued");
  });
});

describe("guards", () => {
  test("kill switch skips scheduled cycles but not forced ones", async () => {
    const { mission } = makeMissionWithProject({ mode: "assist" });
    process.env.CUE_DISABLE_MISSION_ORCHESTRATOR = "1";
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning({ assessment: "a", items: [], report: "r" }),
    });

    const scheduled = await orchestrator.runCycle(mission.id);
    expect(scheduled.ran).toBe(false);
    expect(scheduled.reason).toBe("disabled");

    const forced = await orchestrator.runCycle(mission.id, { force: true });
    expect(forced.ran).toBe(true);
  });

  test("non-active missions never cycle", async () => {
    const { mission } = makeMissionWithProject();
    updateMission(mission.id, { status: "achieved" });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning(TWO_ITEM_PLAN),
    });
    const result = await orchestrator.runCycle(mission.id, { force: true });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("not_active");
  });

  test("the sweep emits a drift nudge after three idle cycles", async () => {
    // A planner that plans nothing every cycle: cycles run, but no item is ever
    // enqueued — the exact "idling with nothing to run" shape §6 nudges.
    const { mission } = makeMissionWithProject({ mode: "assist" });
    const orchestrator = new MissionOrchestrator({
      planner: plannerReturning({
        assessment: "stuck",
        items: [],
        report: "r",
      }),
    });
    // Force cadence to hourly-ish is unnecessary — run cycles directly, then
    // sweep once to run the drift pass over the (now idle) trail.
    await orchestrator.runCycle(mission.id, { force: true });
    await orchestrator.runCycle(mission.id, { force: true });
    await orchestrator.runCycle(mission.id, { force: true });

    await orchestrator.sweepOnce();

    const driftEvents = listMissionEvents(mission.id).filter((e) => {
      if (e.kind !== "checkpoint" || !e.payload) return false;
      return (JSON.parse(e.payload) as { drift?: boolean }).drift === true;
    });
    expect(driftEvents).toHaveLength(1);
  });

  test("isMissionCycleDue respects cadence and status", () => {
    const now = Date.now();
    const base = createMission({ title: "M", outcome: "x" });
    expect(isMissionCycleDue(base, now)).toBe(true); // never ran

    // Clear the default sweep clock — these assertions cover the legacy
    // rolling-interval path, which must stay time-of-day independent. The
    // clock path has its own suite (mission-sweep-clock.test.ts).
    const ranRecently = updateMission(base.id, {
      sweepAt: null,
      lastCycleAt: now - 60 * 60 * 1000, // 1h ago, daily cadence
    })!;
    expect(isMissionCycleDue(ranRecently, now)).toBe(false);

    const hourly = updateMission(base.id, { cadence: "hourly" })!;
    expect(isMissionCycleDue(hourly, now)).toBe(true);

    const paused = updateMission(base.id, { status: "paused" })!;
    expect(isMissionCycleDue(paused, now)).toBe(false);
  });

  test("new missions default to a 08:00 sweep clock; PATCHing it to null reverts to rolling", () => {
    const mission = createMission({ title: "M2", outcome: "x" });
    expect(mission.sweepAt).toBe("08:00");
    const cleared = updateMission(mission.id, { sweepAt: null })!;
    expect(cleared.sweepAt).toBeNull();
    const retimed = updateMission(mission.id, { sweepAt: "06:30" })!;
    expect(retimed.sweepAt).toBe("06:30");
  });
});
