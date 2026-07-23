/**
 * Invariants for the Create-studio template catalog's elicitation data.
 *
 * The user's report: a template ("build a SaaS financial model") generated an
 * .xlsx immediately without asking anything — twice. The fix carries the real
 * inputs on the template as `elicit`, and the CLIENT now renders those as a
 * question card BEFORE any model turn (see create-elicit.ts /
 * create-elicit-form.tsx). This file pins the catalog data those depend on;
 * the compose + entry-mapping logic is tested in create-elicit.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { CREATE_MODES } from "./create-templates";

describe("CREATE_MODES elicit catalog", () => {
  const all = CREATE_MODES.flatMap((m) => m.templates);

  test("the reported SaaS financial model carries the real inputs as elicit", () => {
    const model = all.find((t) => t.id === "financial-model");
    expect(model?.elicit && model.elicit.length).toBeGreaterThanOrEqual(2);
    // The inputs generation actually depends on — the user's honesty point.
    // (MRR lives in the option labels; churn is a question.)
    const text = (model?.elicit ?? [])
      .flatMap((f) => [f.question, ...f.options.map((o) => o.label)])
      .join(" ")
      .toLowerCase();
    expect(text).toContain("mrr");
    expect(text).toContain("churn");
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

  test("simple templates omit elicit so they stay instant", () => {
    // At least some templates must be no-elicit (they fire immediately).
    const instant = all.filter((t) => !t.elicit || t.elicit.length === 0);
    expect(instant.length).toBeGreaterThan(0);
  });
});
