/**
 * The planner's reply must survive the way an open-weight model actually
 * writes.
 *
 * Production recorded 12 of 80 mission cycles ending in "planner produced no
 * parseable plan". A discarded cycle is not free: it costs a real planning
 * pass and leaves the mission looking idle for the day. This is the same
 * failure class as a strict sentinel match — the fix is to read the shape
 * rather than the exact bytes.
 *
 * The specific breakage was the old "first `{` to last `}`" slice. That span
 * is not the object as soon as the reply contains two: a reasoning model
 * thinks before it answers, and any brace in that prose starts the slice
 * while the real plan supplies its end, so the span covers both and parses
 * as nothing.
 */

import { describe, expect, test } from "bun:test";

import { parseMissionPlan } from "./mission-orchestrator.js";

const PLAN = `{"assessment":"Behind schedule.","items":[{"title":"Email the fund","projectId":null}],"report":"One task queued."}`;

describe("parseMissionPlan", () => {
  test("a bare plan object parses", () => {
    const plan = parseMissionPlan(PLAN);
    expect(plan?.assessment).toBe("Behind schedule.");
    expect(plan?.items).toHaveLength(1);
    expect(plan?.items[0]!.title).toBe("Email the fund");
  });

  test("a brace in the reasoning before the answer no longer eats the plan", () => {
    // The regression. The old slice ran from the `{` inside the thinking to
    // the plan's closing brace and parsed as nothing.
    const reply = `Let me think. The shape I want is roughly { title, notes }
    and I should check the deadline first.

    ${PLAN}`;
    const plan = parseMissionPlan(reply);
    expect(plan?.items).toHaveLength(1);
    expect(plan?.assessment).toBe("Behind schedule.");
  });

  test("a fenced json block parses", () => {
    const plan = parseMissionPlan(
      "Here is the plan:\n```json\n" + PLAN + "\n```",
    );
    expect(plan?.items).toHaveLength(1);
  });

  test("when the model drafts then revises, the LAST plan wins", () => {
    // A draft quoted mid-thought is not the conclusion. The answer comes last.
    const draft = `{"assessment":"draft","items":[],"report":"draft"}`;
    const plan = parseMissionPlan(
      `First pass: ${draft}\n\nOn reflection:\n${PLAN}`,
    );
    expect(plan?.assessment).toBe("Behind schedule.");
    expect(plan?.items).toHaveLength(1);
  });

  test("a brace inside a string value does not split the span", () => {
    const withBrace = `{"assessment":"use the {placeholder} form","items":[],"report":"ok"}`;
    expect(parseMissionPlan(withBrace)?.assessment).toBe(
      "use the {placeholder} form",
    );
  });

  test("an escaped quote inside a string does not end it early", () => {
    const tricky = `{"assessment":"they said \\"go\\" today","items":[],"report":"ok"}`;
    expect(parseMissionPlan(tricky)?.assessment).toBe('they said "go" today');
  });

  test("a plan with no items is still a plan", () => {
    // The blocked case: the planner correctly concludes there is nothing it
    // can do yet. That must parse, or the reason never reaches anyone.
    const blocked = `{"assessment":"No project is linked to this mission.","items":[],"report":"Blocked."}`;
    const plan = parseMissionPlan(blocked);
    expect(plan).not.toBeNull();
    expect(plan?.items).toHaveLength(0);
    expect(plan?.assessment).toContain("No project is linked");
  });

  test("prose with no JSON at all still returns null", () => {
    // Tolerance must not become credulity: a refusal is not a plan.
    expect(parseMissionPlan("I cannot plan this right now.")).toBeNull();
    expect(parseMissionPlan("")).toBeNull();
  });

  test("a non-plan object is not mistaken for a plan", () => {
    expect(parseMissionPlan(`{"foo":1,"bar":[2,3]}`)).toBeNull();
  });
});
