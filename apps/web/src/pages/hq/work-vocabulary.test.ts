/**
 * Tests for the work vocabulary — the guard against schema leaking into voice.
 *
 * The bug these exist to prevent shipped for months: All work rendered
 * `AWAITING REVIEW`, `QUEUED` and `RUNNING` verbatim from the database.
 */

import { describe, expect, test } from "bun:test";

import {
  allWorkStates,
  describeWorkState,
  verbForKey,
  WORK_VERBS,
} from "@/pages/hq/work-vocabulary";

describe("describeWorkState — no raw enum reaches a user", () => {
  test("translates every stored state to human words", () => {
    expect(describeWorkState("awaiting_review").label).toBe("Needs you");
    expect(describeWorkState("running").label).toBe("Cue is doing");
    expect(describeWorkState("queued").label).toBe("Waiting");
    expect(describeWorkState("done").label).toBe("Done");
  });

  test("no label contains an underscore or shouted enum casing", () => {
    for (const { entry } of allWorkStates()) {
      expect(entry.label).not.toContain("_");
      expect(entry.label).not.toBe(entry.label.toUpperCase());
    }
  });

  test("an unmapped state is humanised, never rendered raw", () => {
    // An unmapped state is a bug — but shipping the enum is a worse one.
    const entry = describeWorkState("some_new_state");
    expect(entry.label).toBe("Some new state");
    expect(entry.label).not.toContain("_");
  });

  test("every state carries a glyph, so state is never colour alone", () => {
    for (const { entry } of allWorkStates()) {
      expect(entry.glyph.length).toBeGreaterThan(0);
    }
  });

  test("queued and parked are different promises, not synonyms", () => {
    // queued = Cue will start it. parked = dormant until you do.
    // Collapsing these either implies work is imminent when it isn't, or hides
    // work that is about to spend money.
    const queued = describeWorkState("queued");
    const parked = describeWorkState("parked");
    expect(queued.label).not.toBe(parked.label);
    expect(queued.hint).not.toBe(parked.hint);
  });
});

describe("the eight verbs", () => {
  test("there are exactly eight, with unique ids and keys", () => {
    expect(WORK_VERBS).toHaveLength(8);
    expect(new Set(WORK_VERBS.map((v) => v.id)).size).toBe(8);
    expect(new Set(WORK_VERBS.map((v) => v.key)).size).toBe(8);
  });

  test("archive never claims to delete or complete", () => {
    const archive = WORK_VERBS.find((v) => v.id === "archive");
    expect(archive?.hint.toLowerCase()).toContain("never deletes");
    expect(archive?.hint.toLowerCase()).not.toContain("complete");
  });

  test("done-elsewhere credits the user, never Cue", () => {
    const d = WORK_VERBS.find((v) => v.id === "done_elsewhere");
    expect(d?.hint.toLowerCase()).toContain("you");
    expect(d?.hint.toLowerCase()).toContain("not cue");
  });

  test("key lookup is case-insensitive and accepts the verb id", () => {
    expect(verbForKey("h")?.id).toBe("hand_off");
    expect(verbForKey("H")?.id).toBe("hand_off");
    expect(verbForKey("archive")?.id).toBe("archive");
    expect(verbForKey("⌘Z")?.id).toBe("undo");
    expect(verbForKey("Z")).toBeNull();
  });
});
