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
  shouldShowSetupMeter,
  type AccountUsageSignals,
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

/**
 * The meter's progress record lives only in this browser profile's
 * localStorage, and only `/assistant/hq/setup` ever writes it. So an account
 * that predates that flow reads a pristine "0 OF 6" no matter how long it has
 * been running missions — which is what nagged a weeks-old account to "choose
 * what Cue is for". These pin the honesty gate.
 */
describe("setup meter visibility", () => {
  const idle: AccountUsageSignals = {
    missionCount: 0,
    projectCount: 0,
    scheduleCount: 0,
    workItemCount: 0,
    hasIdentity: false,
  };

  function progressFor(state = freshState()) {
    return meterProgress(state, SETUP_STEP_IDS);
  }

  it("shows for a genuinely fresh account with nothing in it", () => {
    const state = freshState();
    expect(shouldShowSetupMeter(state, progressFor(state), idle)).toBe(true);
  });

  it("stays quiet on an established account that never ran the flow", () => {
    // GIVEN no local record at all (the pristine "0 OF 6" case)…
    const state = freshState();
    expect(state.started).toBe(false);
    // …but an account that plainly has real work in it
    const established = { ...idle, missionCount: 4, workItemCount: 37 };
    expect(shouldShowSetupMeter(state, progressFor(state), established)).toBe(
      false,
    );
  });

  it("counts any single real signal as established", () => {
    const state = freshState();
    const p = progressFor(state);
    for (const usage of [
      { ...idle, missionCount: 1 },
      { ...idle, projectCount: 1 },
      { ...idle, scheduleCount: 1 },
      { ...idle, workItemCount: 1 },
      { ...idle, hasIdentity: true },
    ]) {
      expect(shouldShowSetupMeter(state, p, usage)).toBe(false);
    }
  });

  it("keeps the meter for a user who DID start the flow and skipped steps", () => {
    seedV1({
      started: true,
      steps: { mode: "skipped" },
      fork: null,
      meterDismissed: false,
      completedAt: null,
    });
    const state = freshState();
    const established = { ...idle, missionCount: 9 };
    // Their own half-finished setup — theirs to finish or dismiss.
    expect(shouldShowSetupMeter(state, progressFor(state), established)).toBe(
      true,
    );
  });

  it("respects an explicit dismissal even on a fresh account", () => {
    seedV1({
      started: true,
      steps: {},
      fork: null,
      meterDismissed: true,
      completedAt: null,
    });
    const state = freshState();
    expect(shouldShowSetupMeter(state, progressFor(state), idle)).toBe(false);
  });
});
