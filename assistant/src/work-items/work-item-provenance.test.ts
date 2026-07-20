/**
 * Unit tests for the read-time run-provenance derivation.
 *
 * Provenance is the honest trust signal the HQ Done cards read: did Cue run an
 * item autonomously ("auto"), or was a person in the loop ("you_approved")? The
 * load-bearing invariant is that an approval by a person always wins over
 * "auto" — a run a human approved must NEVER be labeled autonomous.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { createCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  createTask,
  createTaskRun,
  updateTaskRun,
} from "../tasks/task-store.js";
import {
  deriveRanProvenance,
  withRanProvenance,
} from "./work-item-provenance.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
} from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM canonical_guardian_requests");
  getDb().run("DELETE FROM task_runs");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
});

const OWNER_PRINCIPAL = "local:owner";

/** Create a work item and return its current row (post-updates). */
function seedItem(
  updates: Parameters<typeof updateWorkItem>[1],
): ReturnType<typeof getWorkItem> {
  const task = createTask({ title: "T", template: "do it" });
  const item = createWorkItem({ taskId: task.id, title: "Item" });
  updateWorkItem(item.id, updates);
  return getWorkItem(item.id);
}

/** Seed an approved guardian gate tied to a run conversation. */
function seedApprovedGuardianRequest(conversationId: string): void {
  createCanonicalGuardianRequest({
    kind: "tool_approval",
    sourceType: "desktop",
    conversationId,
    guardianPrincipalId: OWNER_PRINCIPAL,
    toolName: "web_publish",
    status: "approved",
  });
}

describe("deriveRanProvenance", () => {
  test('a completed autonomous run with no approval is "auto"', () => {
    const item = seedItem({
      status: "awaiting_review",
      lastRunConversationId: "conv-auto",
      lastRunStatus: "completed",
    })!;
    expect(deriveRanProvenance(item)).toBe("auto");
  });

  test('an approved guardian gate during the run is "you_approved"', () => {
    seedApprovedGuardianRequest("conv-approved");
    const item = seedItem({
      status: "awaiting_review",
      lastRunConversationId: "conv-approved",
      lastRunStatus: "completed",
    })!;
    expect(deriveRanProvenance(item)).toBe("you_approved");
  });

  test('pre-approved tool permissions is "you_approved"', () => {
    const item = seedItem({
      status: "awaiting_review",
      lastRunConversationId: "conv-preapproved",
      lastRunStatus: "completed",
      approvalStatus: "approved",
    })!;
    expect(deriveRanProvenance(item)).toBe("you_approved");
  });

  test("HONESTY: a DONE run a human approved is never labeled auto", () => {
    seedApprovedGuardianRequest("conv-done-approved");
    const item = seedItem({
      status: "done",
      lastRunConversationId: "conv-done-approved",
      lastRunStatus: "completed",
    })!;
    expect(deriveRanProvenance(item)).toBe("you_approved");
  });

  test('a pending/denied guardian gate does NOT count as approved (stays "auto")', () => {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "desktop",
      conversationId: "conv-denied",
      guardianPrincipalId: OWNER_PRINCIPAL,
      toolName: "web_publish",
      status: "denied",
    });
    const item = seedItem({
      status: "awaiting_review",
      lastRunConversationId: "conv-denied",
      lastRunStatus: "completed",
    })!;
    expect(deriveRanProvenance(item)).toBe("auto");
  });

  test('a DONE item that never ran is "manual"', () => {
    const item = seedItem({ status: "done" })!;
    expect(deriveRanProvenance(item)).toBe("manual");
  });

  test('completedElsewhere is always "manual", even with a completed run', () => {
    // The owner said the work happened outside Cue — that wins over the run
    // conversation the item still carries. Never "Cue finished this".
    const item = seedItem({
      status: "done",
      lastRunConversationId: "conv-elsewhere",
      lastRunStatus: "completed",
      completedElsewhere: 1,
    })!;
    expect(deriveRanProvenance(item)).toBe("manual");
  });

  test('completedElsewhere wins over an approved guardian gate ("manual", not "you_approved")', () => {
    seedApprovedGuardianRequest("conv-elsewhere-approved");
    const item = seedItem({
      status: "done",
      lastRunConversationId: "conv-elsewhere-approved",
      lastRunStatus: "completed",
      completedElsewhere: 1,
    })!;
    expect(deriveRanProvenance(item)).toBe("manual");
  });

  test("a queued item that never ran is null", () => {
    const item = seedItem({ status: "queued" })!;
    expect(deriveRanProvenance(item)).toBeNull();
  });

  test("a failed run is null (it completed nothing autonomously)", () => {
    const item = seedItem({
      status: "failed",
      lastRunConversationId: "conv-failed",
      lastRunStatus: "failed",
    })!;
    expect(deriveRanProvenance(item)).toBeNull();
  });

  test("resolves the run conversation via lastRunId → task run", () => {
    const task = createTask({ title: "T", template: "do it" });
    const run = createTaskRun(task.id);
    updateTaskRun(run.id, {
      conversationId: "conv-via-run",
      status: "completed",
    });
    seedApprovedGuardianRequest("conv-via-run");

    const item = createWorkItem({ taskId: task.id, title: "Item" });
    updateWorkItem(item.id, {
      status: "awaiting_review",
      lastRunId: run.id,
      lastRunStatus: "completed",
    });
    expect(deriveRanProvenance(getWorkItem(item.id)!)).toBe("you_approved");
  });
});

describe("withRanProvenance (batch)", () => {
  test("labels each item independently in a single pass", () => {
    seedApprovedGuardianRequest("conv-x");

    const approved = seedItem({
      status: "awaiting_review",
      lastRunConversationId: "conv-x",
      lastRunStatus: "completed",
    })!;
    const auto = seedItem({
      status: "awaiting_review",
      lastRunConversationId: "conv-y",
      lastRunStatus: "completed",
    })!;
    const manual = seedItem({ status: "done" })!;

    const annotated = withRanProvenance([approved, auto, manual]);
    const byId = new Map(annotated.map((i) => [i.id, i.ranProvenance]));

    expect(byId.get(approved.id)).toBe("you_approved");
    expect(byId.get(auto.id)).toBe("auto");
    expect(byId.get(manual.id)).toBe("manual");
  });
});
