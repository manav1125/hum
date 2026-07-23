/**
 * Tests for the deterministic, client-side elicitation logic.
 *
 * The load-bearing guarantees:
 *   1. A template WITH `elicit` maps to batched question entries whose default
 *      option is visibly flagged "(default)".
 *   2. Answers (option / free-text / skip / omitted) compose into the prompt
 *      deterministically — the model receives concrete values, so it builds
 *      instead of asking.
 *   3. A template WITHOUT `elicit` composes to its prompt unchanged (stays
 *      instant — never blocked behind a form).
 */
import { describe, expect, test } from "bun:test";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";

import {
  composeElicitedPrompt,
  elicitFieldsToEntries,
  templateNeedsElicitation,
} from "./create-elicit";
import { CREATE_MODES, type CreateTemplate } from "./create-templates";

const TEMPLATE: CreateTemplate = {
  id: "t1",
  title: "SaaS model",
  description: "d",
  prompt: "Build me a SaaS financial model.",
  elicit: [
    {
      question: "What stage are you modelling from?",
      options: [
        { label: "Seed — ~$50k starting MRR", isDefault: true },
        { label: "Series A — ~$250k starting MRR" },
      ],
    },
    {
      question: "Monthly churn rate?",
      options: [
        { label: "2% / month", isDefault: true },
        { label: "5% / month" },
      ],
      freeTextPlaceholder: "e.g. 3% / month",
    },
  ],
};

describe("templateNeedsElicitation", () => {
  test("true only when there are elicit fields", () => {
    expect(templateNeedsElicitation(TEMPLATE)).toBe(true);
    expect(
      templateNeedsElicitation({ ...TEMPLATE, elicit: [] }),
    ).toBe(false);
    expect(
      templateNeedsElicitation({ ...TEMPLATE, elicit: undefined }),
    ).toBe(false);
  });
});

describe("elicitFieldsToEntries", () => {
  test("maps to batched entries with stable ids and a flagged default", () => {
    const entries = elicitFieldsToEntries(TEMPLATE.elicit ?? []);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("q1");
    expect(entries[1].id).toBe("q2");
    // The default option is surfaced so the user can one-click accept it.
    expect(entries[0].options[0].label).toBe("Seed — ~$50k starting MRR (default)");
    expect(entries[0].options[1].label).toBe("Series A — ~$250k starting MRR");
    // Free-text placeholder rides through for the card's inline slot.
    expect(entries[1].freeTextPlaceholder).toBe("e.g. 3% / month");
  });
});

describe("composeElicitedPrompt", () => {
  test("no-elicit template composes to its prompt unchanged", () => {
    const simple: CreateTemplate = {
      id: "t2",
      title: "T2",
      description: "d",
      prompt: "Just build it.",
    };
    expect(composeElicitedPrompt(simple, [])).toBe("Just build it.");
  });

  test("empty responses fall back to every field's default", () => {
    const out = composeElicitedPrompt(TEMPLATE, []);
    expect(out.startsWith("Build me a SaaS financial model.")).toBe(true);
    expect(out).toContain("- What stage are you modelling from: Seed — ~$50k starting MRR");
    expect(out).toContain("- Monthly churn rate: 2% / month");
    // Tells the model these are answers, so it builds rather than re-asks.
    expect(out.toLowerCase()).toContain("ask again");
  });

  test("picked options compose into the prompt (non-default values)", () => {
    const responses: QuestionResponseEntry[] = [
      { questionId: "q1", kind: "option", optionId: "q1-o1" },
      { questionId: "q2", kind: "option", optionId: "q2-o1" },
    ];
    const out = composeElicitedPrompt(TEMPLATE, responses);
    expect(out).toContain(
      "- What stage are you modelling from: Series A — ~$250k starting MRR",
    );
    expect(out).toContain("- Monthly churn rate: 5% / month");
  });

  test("free-text answer is used verbatim; a skip resolves to the default", () => {
    const responses: QuestionResponseEntry[] = [
      { questionId: "q1", kind: "free_text", text: "$12k starting MRR" },
      { questionId: "q2", kind: "skip" },
    ];
    const out = composeElicitedPrompt(TEMPLATE, responses);
    expect(out).toContain("- What stage are you modelling from: $12k starting MRR");
    expect(out).toContain("- Monthly churn rate: 2% / month");
  });

  test("the real financial-model template composes concrete inputs", () => {
    const model = CREATE_MODES.flatMap((m) => m.templates).find(
      (t) => t.id === "financial-model",
    );
    const out = composeElicitedPrompt(model!, []).toLowerCase();
    expect(out).toContain("mrr");
    expect(out).toContain("churn");
    // No leftover directive scaffolding.
    expect(out).not.toContain("<elicit_first>");
  });
});
