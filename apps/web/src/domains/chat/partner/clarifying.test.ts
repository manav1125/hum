/**
 * One clarifying question is partnership; three is a form.
 */

import { describe, expect, test } from "bun:test";

import {
  capClarifyingQuestions,
  skipsForDroppedQuestions,
  withDroppedSkips,
} from "@/domains/chat/partner/clarifying";
import type { QuestionEntry } from "@/types/interaction-ui-types";

const batch: QuestionEntry[] = [
  { id: "q1", question: "Dana's thread or Rachel's?" },
  { id: "q2", question: "Which pricing model?" },
  { id: "q3", question: "Send today or Monday?" },
] as QuestionEntry[];

describe("capClarifyingQuestions", () => {
  test("asks once", () => {
    expect(capClarifyingQuestions(batch).map((e) => e.id)).toEqual(["q1"]);
  });

  test("a single question is left alone", () => {
    expect(capClarifyingQuestions(batch.slice(0, 1))).toHaveLength(1);
  });
});

describe("withDroppedSkips", () => {
  test("the questions we never asked are skipped, not swallowed", () => {
    // The daemon is waiting on the whole batch; leaving entries out would hang
    // the run. Cue makes its own call on the rest instead — which is the
    // behaviour we wanted anyway.
    expect(skipsForDroppedQuestions(batch)).toEqual([
      { questionId: "q2", kind: "skip" },
      { questionId: "q3", kind: "skip" },
    ]);
  });

  test("responses come back in the daemon's own order", () => {
    const merged = withDroppedSkips(batch, [
      { questionId: "q1", kind: "option", optionId: "dana" },
    ]);
    expect(merged.map((r) => r.questionId)).toEqual(["q1", "q2", "q3"]);
    expect(merged[0]).toEqual({
      questionId: "q1",
      kind: "option",
      optionId: "dana",
    });
  });

  test("an answered question is never overwritten with a skip", () => {
    const merged = withDroppedSkips(batch, [
      { questionId: "q1", kind: "free_text", text: "Dana" },
      { questionId: "q2", kind: "free_text", text: "the 24-month one" },
    ]);
    expect(
      merged.filter((r) => r.kind === "skip").map((r) => r.questionId),
    ).toEqual(["q3"]);
  });

  test("nothing to drop changes nothing", () => {
    const single = batch.slice(0, 1);
    const responses = [{ questionId: "q1", kind: "skip" as const }];
    expect(withDroppedSkips(single, responses)).toEqual(responses);
  });
});
