/**
 * The planner's "do NOT re-plan these" list must not lie by omission.
 *
 * Production: a mission with 35 open work items, a prompt that listed 20, and
 * a re-plan of "Review Ghita's shared folders" three weeks after the first one
 * had already run and been sitting in awaiting_review. The instruction was
 * correct; the list it pointed at was silently incomplete, so the planner
 * duplicated finished work in good faith and charged for it.
 *
 * awaiting_review items are the dangerous ones to omit: they carry no visible
 * result, so a planner that cannot see them concludes the work was never done.
 */

import { describe, expect, test } from "bun:test";

import { initializeDb } from "../memory/db-init.js";
import { buildMissionPlanPrompt } from "./mission-orchestrator.js";

// The prompt builder reads the roster, so it needs a real (temp) DB.
initializeDb();
import type { WorkItem } from "../work-items/work-item-store.js";
import type { Mission } from "./mission-store.js";

const mission = {
  id: "m-1",
  title: "Raise 100M Funds",
  outcome: "Raise 2-3 funds totalling $100m",
  metric: null,
  horizon: null,
  brief: null,
  continuationSummary: null,
  budgetCents: null,
  spentCents: 0,
} as unknown as Mission;

const item = (id: number, status: string): WorkItem =>
  ({ id: `wi-${id}`, title: `Task number ${id}`, status }) as WorkItem;

/** Minimal AssessedState — only the fields the prompt reads. */
function state(openItems: WorkItem[]) {
  return {
    mission,
    profile: { identity: null, direction: null, neverLines: [] },
    mode: "autonomous" as const,
    linkedProjects: [{ id: "p-1", title: "AEF Fund", status: "active" }],
    openItems,
    finishedItems: [],
    inboundItems: [],
  };
}

const prompt = (openItems: WorkItem[]) =>
  buildMissionPlanPrompt(state(openItems) as never);

describe("planner prompt: the open-items denylist", () => {
  test("a list that fits is not annotated as partial", () => {
    const p = prompt([item(1, "queued"), item(2, "queued")]);
    expect(p).toContain("do NOT re-plan these");
    expect(p).not.toContain("not listed");
  });

  test("an over-cap list says how many it omitted", () => {
    // Silence here is what let the planner treat an absent title as evidence
    // the work had never been done.
    const many = Array.from({ length: 35 }, (_, i) => item(i, "queued"));
    const p = prompt(many);

    expect(p).toContain("and 15 more open item(s) not listed");
    expect(p).toContain("This list is PARTIAL");
    expect(p).toContain("plan nothing rather than risk duplicating");
  });

  test("awaiting_review items are shown even when far down the list", () => {
    // The regression. With 34 queued items ahead of it, the one item already
    // done and awaiting review fell outside the window — so the planner
    // re-planned it. It must now always make the cut.
    const many = Array.from({ length: 34 }, (_, i) => item(i, "queued"));
    const buried = {
      id: "wi-ghita",
      title: "Review Ghita's shared folders",
      status: "awaiting_review",
    } as WorkItem;
    const p = prompt([...many, buried]);

    expect(p).toContain("Review Ghita's shared folders");
    expect(p).toContain("[awaiting_review]");
  });

  test("every awaiting_review item sorts ahead of queued ones", () => {
    const items = [
      item(1, "queued"),
      { ...item(2, "awaiting_review") },
      item(3, "queued"),
      { ...item(4, "awaiting_review") },
    ];
    const p = prompt(items);

    const firstQueued = p.indexOf("[queued]");
    const lastReview = p.lastIndexOf("[awaiting_review]");
    expect(lastReview).toBeLessThan(firstQueued);
  });
});
