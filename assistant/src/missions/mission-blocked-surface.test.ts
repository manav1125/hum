/**
 * A blocked mission has to reach the owner.
 *
 * Production ran 80 mission cycles, wrote 68 plans, and enqueued four work
 * items. The assessments were not vague — they named the obstacle and the fix
 * ("create a 'Seed Fundraising' project and link it"). All of it went into an
 * events table and a live client event, so the mission knew why it was stuck,
 * said so daily, was charged for the thinking, and the owner never saw it.
 *
 * The risk in fixing that is overcorrecting into a flood: the planner rewords
 * the same obstacle every cycle, so anything keyed on the wording would mint a
 * row a day. These pin the dedupe as hard as the surfacing.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../memory/db-init.js";
import {
  listWorkItems,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import {
  blockedItemKey,
  MISSION_BLOCKED_SOURCE_TYPE,
  surfaceBlockedMission,
} from "./mission-blocked-surface.js";

initializeDb();

const MISSION = { missionId: "m-1", missionTitle: "Raise a $500K seed" };

/**
 * Open surfaced items only. Status matters here: `beforeEach` closes out the
 * previous test's rows, and counting those would make every assertion about
 * "how many rows exist" accumulate across the file.
 */
function surfaced() {
  return listWorkItems({ includeUnComprehended: true }).filter(
    (i) =>
      i.sourceType === MISSION_BLOCKED_SOURCE_TYPE &&
      (i.status === "queued" || i.status === "awaiting_review"),
  );
}

beforeEach(() => {
  // Close out anything a previous test surfaced, so each case starts with an
  // empty lane. Cancelled is not an open status, so it drops out of dedupe.
  for (const item of surfaced()) {
    updateWorkItem(item.id, { status: "cancelled" }, { actor: "test" });
  }
});

describe("surfaceBlockedMission", () => {
  test("a blocked mission becomes a work item carrying the planner's own words", () => {
    const reason =
      "No project is linked to the mission, so no concrete fundraising tasks can be planned. Create a 'Seed Fundraising' project and link it.";
    const id = surfaceBlockedMission({
      ...MISSION,
      kind: "no_linked_project",
      reason,
    });

    expect(id).not.toBeNull();
    const items = surfaced();
    expect(items).toHaveLength(1);
    // Verbatim: the specificity is the value. A synthesized summary would
    // lose "create a 'Seed Fundraising' project and link it".
    expect(items[0]!.notes).toBe(reason);
    expect(items[0]!.title).toContain("Raise a $500K seed");
  });

  test("it is parked — something to read and decide, not to run", () => {
    // An agent cannot link a project or review a partnership draft for you.
    surfaceBlockedMission({
      ...MISSION,
      kind: "awaiting_owner",
      reason: "Two items need your review.",
    });
    expect(surfaced()[0]!.autoRunEligibility).toBe("parked");
  });

  test("it lands at the top of the lane", () => {
    // A blocked mission is why nothing else is moving.
    surfaceBlockedMission({
      ...MISSION,
      kind: "awaiting_owner",
      reason: "Blocked on you.",
    });
    expect(surfaced()[0]!.priorityTier).toBe(0);
  });

  test("a REWORDED repeat updates the one row instead of adding another", () => {
    // The flood risk, and the reason the key ignores the wording. The planner
    // says the same thing differently every cycle.
    surfaceBlockedMission({
      ...MISSION,
      kind: "awaiting_owner",
      reason: "Progress is stalled; two items require your review.",
    });
    surfaceBlockedMission({
      ...MISSION,
      kind: "awaiting_owner",
      reason:
        "The mission remains blocked because a pair of items are still awaiting your review.",
    });
    surfaceBlockedMission({
      ...MISSION,
      kind: "awaiting_owner",
      reason: "Still waiting on your review of two outstanding items.",
    });

    const items = surfaced();
    expect(items).toHaveLength(1);
    // The row carries the LATEST wording, so it is not stale.
    expect(items[0]!.notes).toContain("Still waiting on your review");
    expect(items[0]!.lastProgressNote).toContain("Still blocked");
  });

  test("a genuinely different KIND of block gets its own row", () => {
    surfaceBlockedMission({
      ...MISSION,
      kind: "awaiting_owner",
      reason: "Needs your review.",
    });
    surfaceBlockedMission({
      ...MISSION,
      kind: "planner_failing",
      reason: "The planner could not produce a usable plan.",
    });
    expect(surfaced()).toHaveLength(2);
  });

  test("two missions blocked the same way do not collide", () => {
    surfaceBlockedMission({
      ...MISSION,
      kind: "awaiting_owner",
      reason: "Needs your review.",
    });
    surfaceBlockedMission({
      missionId: "m-2",
      missionTitle: "Raise 100M Funds",
      kind: "awaiting_owner",
      reason: "Needs your review.",
    });
    expect(surfaced()).toHaveLength(2);
  });

  test("an empty reason surfaces nothing", () => {
    // A title with no way to act on it is worse than silence.
    expect(
      surfaceBlockedMission({
        ...MISSION,
        kind: "awaiting_owner",
        reason: "  ",
      }),
    ).toBeNull();
    expect(surfaced()).toHaveLength(0);
  });

  test("the key ignores wording but separates mission and kind", () => {
    expect(blockedItemKey("m-1", "awaiting_owner")).toBe(
      blockedItemKey("m-1", "awaiting_owner"),
    );
    expect(blockedItemKey("m-1", "awaiting_owner")).not.toBe(
      blockedItemKey("m-1", "planner_failing"),
    );
    expect(blockedItemKey("m-1", "awaiting_owner")).not.toBe(
      blockedItemKey("m-2", "awaiting_owner"),
    );
  });
});
