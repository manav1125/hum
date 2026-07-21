/**
 * The pre-run assessment gate, exercised through the REAL runner.
 *
 * Hermetic: the task runner is stubbed (no agent turn) and the flash side-chain
 * is stubbed (no LLM), but everything in between — prompt assembly, parsing,
 * the precision guards, persistence, the park/run decision — is the real code
 * path a production run takes.
 *
 * What this file protects:
 *   - a task Cue understands runs, and the plan is visible before it does;
 *   - a task it does NOT understand parks with ONE question instead of
 *     producing plausible garbage;
 *   - a parked item still cannot auto-run (the standing invariant);
 *   - the assessment never becomes a reason a task doesn't run (fail-open);
 *   - Cue asks once — an explicit re-run of an unchanged item goes ahead.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- Stubs, installed before the runner is imported ------------------------

let runTaskCalls = 0;
mock.module("../tasks/task-runner.js", () => ({
  runTask: async () => {
    runTaskCalls += 1;
    return { status: "completed", taskRunId: "test-run", conversationId: null };
  },
}));

// A provider must merely exist; the side-chain below is what answers.
mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => ({ name: "stub" }),
}));

/** The assessor's canned reply for the next assessment (null = no answer). */
let assessorReply: unknown = null;
let assessorThrows = false;
let assessorCalls = 0;
mock.module("../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: async () => {
    assessorCalls += 1;
    if (assessorThrows) throw new Error("side-chain exploded");
    return { text: JSON.stringify(assessorReply), hadTextDeltas: false };
  },
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { listWorkItemEvents } from "./work-item-events.js";
import { runWorkItemInBackground } from "./work-item-runner.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";
import { maybeAutoRunWorkItem } from "./work-item-triage.js";

initializeDb();

let taskId = "";
beforeEach(() => {
  runTaskCalls = 0;
  assessorCalls = 0;
  assessorThrows = false;
  assessorReply = null;
  getDb().run("DELETE FROM work_item_events");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  taskId = createTask({ title: "t", template: "do it" }).id;
});

/** Wait until the item leaves `running` (the run and the gate are async). */
async function settle(workItemId: string): Promise<WorkItem> {
  for (let i = 0; i < 200; i++) {
    const item = getWorkItem(workItemId)!;
    if (item.status !== "running") return item;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("work item never settled");
}

describe("verdict: execute", () => {
  test("runs, and the plain-words plan is stamped before the turn", async () => {
    assessorReply = {
      verdict: "execute",
      understanding: "Summarise the Q2 costs.",
      plan: "I'll read the Q2 deck in project knowledge and pull the three cost lines.",
      confidence: 0.9,
    };
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });

    expect(runWorkItemInBackground(item.id).success).toBe(true);
    const settled = await settle(item.id);

    expect(runTaskCalls).toBe(1);
    expect(settled.status).toBe("awaiting_review");
    expect(settled.assessmentVerdict).toBe("execute");
    expect(settled.assessmentPlan).toContain("Q2 deck");

    const trail = listWorkItemEvents(item.id);
    const assessed = trail.find((e) => e.kind === "assessed");
    expect(assessed?.detail).toContain("Q2 deck");
    // The plan is on the trail BEFORE the run finished — this is the line the
    // run view shows as the work starts.
    expect(trail.findIndex((e) => e.kind === "assessed")).toBeLessThan(
      trail.findIndex((e) => e.kind === "run_finished"),
    );
  });
});

describe("verdict: clarify", () => {
  test("does not run; parks with ONE question surfaced", async () => {
    assessorReply = {
      verdict: "clarify",
      understanding: "Send an update to the investor.",
      question: "Which investor should this go to?",
      confidence: 0.9,
    };
    const item = createWorkItem({ taskId, title: "Send the investor update" });

    expect(runWorkItemInBackground(item.id).success).toBe(true);
    const settled = await settle(item.id);

    // The whole point: no agent turn was spent producing plausible garbage.
    expect(runTaskCalls).toBe(0);
    expect(settled.status).toBe("queued");
    expect(settled.autoRunEligibility).toBe("parked");
    expect(settled.assessmentVerdict).toBe("clarify");
    expect(settled.assessmentQuestion).toBe(
      "Which investor should this go to?",
    );
    expect(settled.lastProgressNote).toBe(
      "Cue needs you: Which investor should this go to?",
    );
  });

  test("a parked item still cannot auto-run", async () => {
    assessorReply = {
      verdict: "clarify",
      question: "Which investor should this go to?",
      confidence: 0.9,
    };
    const item = createWorkItem({ taskId, title: "Send the investor update" });
    runWorkItemInBackground(item.id);
    await settle(item.id);

    const decision = await maybeAutoRunWorkItem(item.id);
    expect(decision.started).toBe(false);
    expect(decision.reason).toBe("user_parked");
    expect(runTaskCalls).toBe(0);
  });

  test("asks once: an explicit re-run of the unchanged item goes ahead", async () => {
    assessorReply = {
      verdict: "clarify",
      question: "Which investor should this go to?",
      confidence: 0.9,
    };
    const item = createWorkItem({ taskId, title: "Send the investor update" });
    runWorkItemInBackground(item.id);
    await settle(item.id);
    expect(runTaskCalls).toBe(0);

    // The user saw the question and pressed Run anyway. Cue does not re-ask,
    // and does not pay for a second assessment either — the verdict is cached.
    runWorkItemInBackground(item.id);
    const settled = await settle(item.id);

    expect(runTaskCalls).toBe(1);
    expect(assessorCalls).toBe(1);
    expect(settled.status).toBe("awaiting_review");
    // The verdict stays stamped so surfaces can still show the caveat.
    expect(settled.assessmentVerdict).toBe("clarify");
  });

  test("answering the question re-opens assessment", async () => {
    assessorReply = {
      verdict: "clarify",
      question: "Which investor should this go to?",
      confidence: 0.9,
    };
    const item = createWorkItem({ taskId, title: "Send the investor update" });
    runWorkItemInBackground(item.id);
    await settle(item.id);

    // The user answers as task context — which changes what the run will see.
    updateWorkItem(item.id, { context: "Send it to Aileen at Northwind." });
    assessorReply = {
      verdict: "execute",
      plan: "I'll draft the update for Aileen at Northwind.",
      confidence: 0.9,
    };
    runWorkItemInBackground(item.id);
    const settled = await settle(item.id);

    expect(assessorCalls).toBe(2);
    expect(settled.assessmentVerdict).toBe("execute");
    expect(runTaskCalls).toBe(1);
  });
});

describe("verdict: not_ai_task", () => {
  test("marks the item honestly instead of running it", async () => {
    assessorReply = {
      verdict: "not_ai_task",
      understanding: "Sign the lease in person at the letting office.",
      confidence: 0.95,
    };
    const item = createWorkItem({ taskId, title: "Sign the lease in person" });
    runWorkItemInBackground(item.id);
    const settled = await settle(item.id);

    expect(runTaskCalls).toBe(0);
    expect(settled.assessmentVerdict).toBe("not_ai_task");
    expect(settled.autoRunEligibility).toBe("parked");
    expect(settled.lastProgressNote).toContain("yours to do");
  });

  test("an unsure not_ai_task never stands — it becomes a question", async () => {
    assessorReply = {
      verdict: "not_ai_task",
      understanding: "Call the vet about the follow-up.",
      question: "Do you want me to call the vet, or will you?",
      confidence: 0.35,
    };
    const item = createWorkItem({ taskId, title: "Call the vet" });
    runWorkItemInBackground(item.id);
    const settled = await settle(item.id);

    // Cue CAN place calls, so refusing outright would be the worse error.
    expect(settled.assessmentVerdict).toBe("clarify");
    expect(settled.assessmentQuestion).toBe(
      "Do you want me to call the vet, or will you?",
    );
  });
});

describe("verdict: blocked", () => {
  test("names the missing thing so the UI can offer the fix", async () => {
    assessorReply = {
      verdict: "blocked",
      understanding: "File the receipts in Xero.",
      missing: "Xero is not connected.",
      confidence: 0.9,
    };
    const item = createWorkItem({ taskId, title: "File the receipts in Xero" });
    runWorkItemInBackground(item.id);
    const settled = await settle(item.id);

    expect(runTaskCalls).toBe(0);
    expect(settled.assessmentVerdict).toBe("blocked");
    expect(settled.assessmentMissing).toBe("Xero is not connected.");
    expect(settled.lastProgressNote).toBe("Blocked — Xero is not connected.");
  });
});

describe("fail-open", () => {
  test("an assessor that throws never stops the run", async () => {
    assessorThrows = true;
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    runWorkItemInBackground(item.id);
    const settled = await settle(item.id);

    expect(runTaskCalls).toBe(1);
    expect(settled.status).toBe("awaiting_review");
    expect(settled.assessmentVerdict).toBeNull();
  });

  test("an unparseable verdict never stops the run", async () => {
    assessorReply = "I'm not sure, maybe ask them?";
    const item = createWorkItem({ taskId, title: "Summarise Q2 costs" });
    runWorkItemInBackground(item.id);
    const settled = await settle(item.id);

    expect(runTaskCalls).toBe(1);
    expect(settled.status).toBe("awaiting_review");
    expect(settled.assessmentVerdict).toBeNull();
  });
});

describe("run-boundary invariants still hold", () => {
  test("an already-running item is still rejected before any assessment", () => {
    const item = createWorkItem({ taskId, title: "Busy" });
    updateWorkItem(item.id, { status: "running" });
    const result = runWorkItemInBackground(item.id);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("already_running");
    expect(assessorCalls).toBe(0);
  });

  test("a missing item is still rejected before any assessment", () => {
    const result = runWorkItemInBackground("nope");
    expect(result.errorCode).toBe("not_found");
    expect(assessorCalls).toBe(0);
  });
});
