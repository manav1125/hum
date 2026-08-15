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

  const hasElicit = (id: string) => {
    const t = all.find((x) => x.id === id);
    if (!t) throw new Error(`no template "${id}"`);
    return Boolean(t.elicit && t.elicit.length > 0);
  };

  test("every input-dependent template carries elicit (decks/docs/dashboards/sheets/leads)", () => {
    // These produce a materially different asset depending on the inputs, so
    // the client must collect the output-determining choices BEFORE the model
    // turn — the same bar as the SaaS financial model.
    const mustElicit = [
      // Slides
      "investor-pitch",
      "qbr",
      "product-launch",
      "team-offsite",
      // Dashboards
      "kpi-dashboard",
      "budget-tracker",
      "habit-tracker",
      "roi-calculator",
      // Docs
      "prd",
      "meeting-notes",
      "blog-post",
      "one-pager",
      // Sheets
      "financial-model",
      "budget-sheet",
      "sales-tracker",
      // Leads
      "find-leads-quick",
      "company-list",
      // Research (structured comparison deliverable)
      "competitor-scan",
    ];
    for (const id of mustElicit) {
      expect(hasElicit(id)).toBe(true);
    }
  });

  test("no elicit field is a style picker — the gallery shows the look", () => {
    // Design v29: "the gallery *shows* the look; a chip only names it."
    // Two "Visual direction?" chips (investor-pitch, product-launch) were
    // deleted on that ruling. This pins the absence so neither returns, and
    // catches a new one written under any wording.
    const styleQuestion = /visual direction|what look|which look|visual style|what style|which style|aesthetic/i;
    const offenders = all
      .flatMap((t) => (t.elicit ?? []).map((f) => ({ t, q: f.question })))
      .filter(({ q }) => styleQuestion.test(q));
    expect(offenders.map((o) => `${o.t.id}: ${o.q}`)).toEqual([]);
  });

  test("the two deleted style pickers left their content questions intact", () => {
    // The deletion must remove one chip, not gut the template: both still ask
    // the questions the gallery genuinely cannot answer.
    const pitch = all.find((t) => t.id === "investor-pitch");
    expect(pitch?.elicit?.map((f) => f.question)).toEqual([
      "Which round are you raising?",
      "What sector?",
    ]);
    const launch = all.find((t) => t.id === "product-launch");
    expect(launch?.elicit?.map((f) => f.question)).toEqual([
      "What are you launching?",
      "Who's the primary audience?",
      "When does it launch?",
    ]);
  });

  test("genuinely open-ended / creative templates stay instant (no forced form)", () => {
    // Free-form subject with no meaningful default, or a raw creative prompt,
    // or a paste/attach flow — forcing a form here would degrade the surface.
    const mustStayInstant = [
      // Research "research anything" (subject is the free-form input)
      "market-brief",
      "person-brief",
      "topic-deep-dive",
      // Images — creative; style handled by the gallery/reference system
      "hero-image",
      "logo-concepts",
      "social-graphic",
      "illustration",
      // Canvas edit recipes (need an attached image)
      "restyle",
      "retouch",
      "replace-object",
      // Video — creative + analyze-a-file interactive flows
      "cinematic-clip",
      "summarize-video",
      "extract-clip",
      // Audio — creative generation
      "background-music",
      "voiceover",
      // Leads — needs pasted URLs, no meaningful defaults
      "scrape-site-contacts",
    ];
    for (const id of mustStayInstant) {
      expect(hasElicit(id)).toBe(false);
    }
  });
});
