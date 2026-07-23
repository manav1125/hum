/**
 * Tests for template elicit-before-generate wiring.
 *
 * The user's report: a template ("build a SaaS financial model") generated an
 * .xlsx immediately without asking anything. The fix carries the real inputs on
 * the template as `elicit`, and `buildTemplateKickoff` appends a directive that
 * steers the agent to ask them (via the existing batched `ask_question` card)
 * BEFORE generating — with visible defaults so the user can click through fast.
 *
 * Two invariants are load-bearing and asserted here:
 *   1. a template WITH `elicit` produces a kickoff that asks first, and
 *   2. a template WITHOUT `elicit` is left exactly as-is (simple templates stay
 *      instant — never blocked behind a form).
 */
import { describe, expect, test } from "bun:test";

import {
  CREATE_MODES,
  buildElicitDirective,
  buildTemplateKickoff,
  type CreateTemplate,
  type TemplateElicitField,
} from "./create-templates";

const FIELDS: TemplateElicitField[] = [
  {
    question: "What stage?",
    options: [
      { label: "Pre-seed", isDefault: true },
      { label: "Series A" },
    ],
  },
  {
    question: "Growth rate?",
    options: [{ label: "10%", isDefault: true }, { label: "20%" }],
  },
];

describe("buildElicitDirective", () => {
  test("routes to a single batched ask_question call", () => {
    const d = buildElicitDirective(FIELDS);
    expect(d).toContain("<elicit_first>");
    expect(d).toContain("</elicit_first>");
    expect(d).toContain("ask_question");
    // One batched call, not one-at-a-time.
    expect(d).toContain("questions");
    expect(d.toLowerCase()).toContain("one batched");
  });

  test("lists every question and flags the default", () => {
    const d = buildElicitDirective(FIELDS);
    expect(d).toContain("What stage?");
    expect(d).toContain("Growth rate?");
    // The default is surfaced so the user can one-click accept it, and the
    // directive tells the agent to fall back to it on skip.
    expect(d).toContain("Pre-seed (default)");
    expect(d).toContain("(default) option");
  });

  test("tells the agent to generate after answers and honour skip→defaults", () => {
    const d = buildElicitDirective(FIELDS).toLowerCase();
    expect(d).toContain("skip");
    expect(d).toContain("default");
    expect(d).toContain("generate");
  });
});

describe("buildTemplateKickoff", () => {
  test("template WITH elicit → base prompt PLUS the directive (asks first)", () => {
    const template: CreateTemplate = {
      id: "t1",
      title: "T1",
      description: "d",
      prompt: "Build me a thing.",
      elicit: FIELDS,
    };
    const kickoff = buildTemplateKickoff(template);
    expect(kickoff.startsWith("Build me a thing.")).toBe(true);
    expect(kickoff).toContain("<elicit_first>");
    expect(kickoff).toContain("What stage?");
  });

  test("template WITHOUT elicit → base prompt unchanged (stays instant)", () => {
    const template: CreateTemplate = {
      id: "t2",
      title: "T2",
      description: "d",
      prompt: "Just build it.",
    };
    expect(buildTemplateKickoff(template)).toBe("Just build it.");
  });

  test("template with empty elicit array → base prompt unchanged", () => {
    const template: CreateTemplate = {
      id: "t3",
      title: "T3",
      description: "d",
      prompt: "No questions here.",
      elicit: [],
    };
    expect(buildTemplateKickoff(template)).toBe("No questions here.");
  });
});

describe("CREATE_MODES elicit catalog", () => {
  const all = CREATE_MODES.flatMap((m) => m.templates);

  test("the reported SaaS financial model now elicits real inputs first", () => {
    const model = all.find((t) => t.id === "financial-model");
    expect(model?.elicit && model.elicit.length).toBeGreaterThanOrEqual(2);
    const kickoff = buildTemplateKickoff(model!);
    // The inputs generation actually depends on — the user's honesty point.
    expect(kickoff.toLowerCase()).toContain("mrr");
    expect(kickoff.toLowerCase()).toContain("churn");
    expect(kickoff).toContain("<elicit_first>");
  });

  test("every elicit field has 2–4 options and exactly one default", () => {
    for (const t of all) {
      if (!t.elicit) continue;
      expect(t.elicit.length).toBeLessThanOrEqual(6);
      for (const field of t.elicit) {
        expect(field.options.length).toBeGreaterThanOrEqual(2);
        expect(field.options.length).toBeLessThanOrEqual(4);
        const defaults = field.options.filter((o) => o.isDefault);
        expect(defaults.length).toBe(1);
      }
    }
  });
});
