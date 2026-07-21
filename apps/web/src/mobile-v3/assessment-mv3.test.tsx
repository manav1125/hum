/**
 * The mv3 list mark — deliberately quiet.
 *
 * mv3 lists (Today's came-in strip, Came in, Review index, All work, project
 * detail) must badge ONLY the rows that wait on a person. Everything else —
 * an item Cue can simply do, an item it says belongs to a human, an item never
 * assessed, a verdict that lost the one thing it exists to say — renders
 * nothing, so a list never turns into a wall of badges.
 *
 * The verdict rules themselves are the shared kit's (`assessment-kit.test.tsx`
 * covers them); this checks the mv3 rendering that consumes them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { opensInsteadOfRunning } from "@/pages/hq/assessment-kit";

import { Mv3AssessmentMark } from "./assessment-mv3";

afterEach(cleanup);

describe("Mv3AssessmentMark", () => {
  test("marks the two verdicts that wait on a person", () => {
    const { rerender } = render(
      <Mv3AssessmentMark
        item={{
          assessmentVerdict: "clarify",
          assessmentQuestion: "Which list?",
        }}
      />,
    );
    expect(screen.getByText("Question")).toBeDefined();

    rerender(
      <Mv3AssessmentMark
        item={{
          assessmentVerdict: "blocked",
          assessmentMissing: "Gmail is not connected.",
        }}
      />,
    );
    expect(screen.getByText("Blocked")).toBeDefined();
  });

  test("stays silent for everything else", () => {
    const quiet = [
      { assessmentVerdict: "execute", assessmentPlan: "Write it." },
      {
        assessmentVerdict: "not_ai_task",
        assessmentUnderstanding: "Sign it in person.",
      },
      // Never assessed.
      {},
      // A verdict that lost its payload — reads as unassessed, not an empty
      // badge.
      { assessmentVerdict: "clarify" },
      { assessmentVerdict: "blocked" },
    ];
    for (const item of quiet) {
      const { unmount } = render(<Mv3AssessmentMark item={item} />);
      expect(screen.queryByText("Question")).toBeNull();
      expect(screen.queryByText("Blocked")).toBeNull();
      unmount();
    }
    const { container } = render(<Mv3AssessmentMark item={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("opensInsteadOfRunning — the inline ▶ on a list row", () => {
  // A row's ▶ has nowhere to show a question or a refusal, so anything Cue
  // did not clear for execution must open rather than fire.
  test("opens for every verdict that is not execute", () => {
    for (const verdict of ["clarify", "blocked", "not_ai_task"] as const) {
      expect(
        opensInsteadOfRunning({
          assessmentVerdict: verdict,
          assessmentQuestion: verdict === "clarify" ? "Which deck?" : null,
          assessmentMissing: verdict === "blocked" ? "the quotes" : null,
          assessmentUnderstanding: "Something.",
        }),
      ).toBe(true);
    }
  });

  test("runs straight away when Cue cleared it, or never assessed it", () => {
    expect(
      opensInsteadOfRunning({
        assessmentVerdict: "execute",
        assessmentUnderstanding: "Draft the update.",
        assessmentPlan: "Read the deck, write the draft.",
      }),
    ).toBe(false);
    expect(opensInsteadOfRunning({ assessmentVerdict: null })).toBe(false);
    expect(opensInsteadOfRunning(null)).toBe(false);
  });
});
