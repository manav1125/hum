/**
 * Backward-compatibility contract for the versioned setup-progress store.
 *
 * The v1 → v2 schema change added the optional "think" step between name and
 * connect. These tests pin the two guarantees the upgrade must keep:
 *
 *  1. A user who FINISHED onboarding on the v1 step list (`completedAt` set,
 *     no `version` field, no "think" entry) is never re-gated — the meter
 *     stays hidden even though the tracked list grew.
 *  2. A user MID-onboarding on a v1 value keeps their progress: old step
 *     outcomes parse unchanged, resume lands on the first not-done step, and
 *     the next write stamps the value to v2 without dropping anything.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import {
  LEGACY_SETUP_STEP_IDS,
  markStep,
  meterProgress,
  readSetupState,
  resetSetupStateCache,
  SETUP_STEP_IDS,
} from "./setup-state";

const KEY = "cue:hq-setup-progress";

/** The exact shape the v1 code wrote to localStorage (no `version`). */
function seedV1(value: Record<string, unknown>): void {
  localStorage.setItem(KEY, JSON.stringify(value));
  resetSetupStateCache(); // emulate a fresh page load
}

function freshState() {
  return readSetupState();
}

beforeEach(() => {
  localStorage.clear();
  resetSetupStateCache();
});

describe("setup-state v1 → v2 backward compatibility", () => {
  it("keeps a v1-completed user complete — no re-gating from the new step", () => {
    seedV1({
      started: true,
      steps: {
        mode: "done",
        name: "done",
        connect: "done",
        direction: "done",
        mission: "done",
      },
      fork: { me: false, work: false, company: true },
      meterDismissed: false,
      completedAt: 1750000000000,
    });

    const state = freshState();
    expect(state.version).toBe(1);

    // With the grown v2 list, the meter must still read complete: "think"
    // (added post-completion) drops out of the tracked list.
    const progress = meterProgress(state, SETUP_STEP_IDS);
    expect(progress.next).toBeNull();
    expect(progress.doneCount).toBe(progress.total);
  });

  it("keeps a v1-completed-but-skipped user on legacy semantics only", () => {
    seedV1({
      started: true,
      steps: {
        mode: "done",
        name: "done",
        connect: "skipped",
        direction: "done",
        mission: "done",
      },
      fork: null,
      meterDismissed: false,
      completedAt: 1750000000000,
    });

    const progress = meterProgress(freshState(), SETUP_STEP_IDS);
    // The legacy skipped step still shows (original gentle-meter behavior)…
    expect(progress.next).toBe("connect");
    // …but the NEW step never enters the count for a completed user.
    expect(progress.total).toBe(LEGACY_SETUP_STEP_IDS.length);
  });

  it("resumes a v1 mid-onboarding user without losing progress", () => {
    seedV1({
      started: true,
      steps: { mode: "done", name: "done" },
      fork: { me: true, work: false, company: false },
      meterDismissed: false,
      completedAt: null,
    });

    const state = freshState();
    expect(state.steps.name).toBe("done");
    // Not completed → the new optional step is simply the next open one.
    const progress = meterProgress(state, SETUP_STEP_IDS);
    expect(progress.next).toBe("think");
    expect(progress.total).toBe(SETUP_STEP_IDS.length);

    // A write migrates the value to v2 in place, keeping every old field.
    markStep("think", "skipped");
    const migrated = JSON.parse(localStorage.getItem(KEY)!) as {
      version: number;
      steps: Record<string, string>;
      completedAt: number | null;
    };
    expect(migrated.version).toBe(2);
    expect(migrated.steps.mode).toBe("done");
    expect(migrated.steps.name).toBe("done");
    expect(migrated.steps.think).toBe("skipped");
  });

  it("treats a malformed stored value as a fresh start", () => {
    localStorage.setItem(KEY, "{not json");
    resetSetupStateCache();
    const state = freshState();
    expect(state.started).toBe(false);
    expect(meterProgress(state, SETUP_STEP_IDS).doneCount).toBe(0);
  });
});
