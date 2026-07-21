/**
 * Tests for the assessment kit's read guards and the list-level signal.
 *
 * The guards are what keep an empty shell off a surface: a verdict whose
 * payload is missing the one thing it exists to say reads as "not assessed",
 * so the row renders exactly as it did before assessment existed. The signal
 * is deliberately quiet — only the two verdicts that wait on a person get a
 * badge, so a list never turns into a wall of them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import {
  AssessmentSignal,
  blockedFixKind,
  holdReason,
  holdsForYou,
  readAssessment,
} from "./assessment-kit";

afterEach(cleanup);

describe("readAssessment", () => {
  test("reads a complete verdict", () => {
    const assessment = readAssessment({
      assessmentVerdict: "execute",
      assessmentUnderstanding: "Draft the board update.",
      assessmentPlan: "Read the deck, then write it.",
      assessmentConfidence: 0.9,
      assessmentAt: 1_760_000_000_000,
    });
    expect(assessment?.verdict).toBe("execute");
    expect(assessment?.plan).toBe("Read the deck, then write it.");
  });

  test("treats a missing or unknown verdict as unassessed", () => {
    expect(readAssessment(null)).toBeNull();
    expect(readAssessment({})).toBeNull();
    expect(readAssessment({ assessmentVerdict: null })).toBeNull();
    // A newer daemon's verdict this build doesn't speak.
    expect(readAssessment({ assessmentVerdict: "deferred" })).toBeNull();
  });

  test("refuses a verdict that lost the one thing it exists to say", () => {
    // clarify with no question, blocked with nothing named, execute with
    // neither an understanding nor a plan: nothing to show, so show nothing.
    expect(readAssessment({ assessmentVerdict: "clarify" })).toBeNull();
    expect(readAssessment({ assessmentVerdict: "blocked" })).toBeNull();
    expect(readAssessment({ assessmentVerdict: "execute" })).toBeNull();
  });
});

describe("list-level signal", () => {
  test("flags only the verdicts that wait on a person", () => {
    expect(
      holdsForYou({
        assessmentVerdict: "clarify",
        assessmentQuestion: "Which list?",
      }),
    ).toBe("clarify");
    expect(
      holdsForYou({
        assessmentVerdict: "blocked",
        assessmentMissing: "Gmail is not linked.",
      }),
    ).toBe("blocked");
    expect(
      holdsForYou({
        assessmentVerdict: "execute",
        assessmentPlan: "Write it.",
      }),
    ).toBeNull();
    expect(
      holdsForYou({
        assessmentVerdict: "not_ai_task",
        assessmentUnderstanding: "Sign it in person.",
      }),
    ).toBeNull();
    expect(holdsForYou(null)).toBeNull();
  });

  test("names the hold in the assessor's own words", () => {
    expect(
      holdReason({
        assessmentVerdict: "clarify",
        assessmentQuestion: "Which list?",
      }),
    ).toBe("Which list?");
    expect(
      holdReason({ assessmentVerdict: "execute", assessmentPlan: "Write it." }),
    ).toBeNull();
  });

  test("renders the work-loop badge for a held item and nothing otherwise", () => {
    const { rerender } = render(
      <AssessmentSignal
        item={{
          assessmentVerdict: "clarify",
          assessmentQuestion: "Which list?",
        }}
      />,
    );
    expect(screen.getByText("Question")).toBeDefined();

    rerender(
      <AssessmentSignal
        item={{ assessmentVerdict: "execute", assessmentPlan: "Write it." }}
      />,
    );
    expect(screen.queryByText("Question")).toBeNull();
    expect(screen.queryByText("Blocked")).toBeNull();
  });
});

describe("blockedFixKind", () => {
  test("matches only clear signals", () => {
    expect(blockedFixKind("Gmail is not connected.")).toBe("connect");
    expect(blockedFixKind("No account is linked for Slack.")).toBe("connect");
    expect(blockedFixKind("The Q2 deck was never attached.")).toBe("attach");
    expect(blockedFixKind("The decision on which vendor won.")).toBeNull();
    expect(blockedFixKind(null)).toBeNull();
  });
});
