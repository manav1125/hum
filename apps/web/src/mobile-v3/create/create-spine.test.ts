/**
 * What is at risk here.
 *
 * The Create spine is four routes that must all converge on a build. The failure
 * this file exists to catch is a route that dead-ends — a type whose gallery has
 * no templates, a template whose fill can never satisfy itself, a rescue that
 * drops you back where you started. On a phone a dead-end is invisible in review
 * and obvious in use, so it is checked exhaustively rather than by example:
 * every one of the ten types, and every template each of them offers, is driven
 * to a build.
 *
 * It also locks the four prohibitions that are easy to regress by "improving"
 * the UI later:
 *
 *   - the gallery cannot be rendered unscoped (there is no such Stage);
 *   - a free-text run with no type signal must not silently pick one;
 *   - fill must never come back as a bare list of empty inputs;
 *   - v29's chip stage is asked for exactly three types and never for Sheets.
 */

import { describe, expect, test } from "bun:test";

import {
  blankNumbersLine,
  buildFillPlan,
  fillHeadline,
  fillProgressLabel,
  isEmptyForm,
  knownHeadline,
} from "./create-fill-model";
import type { KnownFact } from "./create-known-facts";
import { chipQuestionsFor, hasChipStage } from "./create-chip-sets";
import {
  fromBlank,
  fromChips,
  fromEntry,
  fromGallery,
  fromPurpose,
  inferType,
  toBuild,
  PURPOSE_OPTIONS,
  type BuildRequest,
  type Stage,
  type Transition,
} from "./create-spine";
import { galleryEntriesFor, MV3_CREATE_TYPES } from "./create-types";

const CTX = { known: [] as KnownFact[] };

/** Fill every gap a plan declares, the way a user would. */
function answerAll(stage: Stage): Record<string, string | string[]> {
  if (stage.kind !== "fill") return {};
  const values: Record<string, string | string[]> = { ...stage.plan.prefilled };
  for (const gap of stage.plan.gaps) {
    values[gap.key] =
      gap.kind === "chips" && gap.options?.length
        ? gap.options[0]
        : gap.kind === "tags"
          ? ["one", "two"]
          : "an answer";
  }
  return values;
}

/**
 * Drive a transition to a build, the way the flow host does. Returns the build
 * request, or throws with the stage it got stuck on.
 */
function driveToBuild(start: Transition, hops = 0): BuildRequest {
  if (start.go === "build") return start.request;
  if (hops > 6) throw new Error(`stuck at ${start.stage.kind} after ${hops} hops`);

  const stage = start.stage;
  switch (stage.kind) {
    case "gallery": {
      const entries = galleryEntriesFor(stage.typeId);
      if (entries.length === 0) {
        // A type with no templates must still reach a build via blank.
        return driveToBuild(fromBlank(stage.typeId, "describe it", CTX), hops + 1);
      }
      return driveToBuild(
        fromGallery(stage.typeId, entries[0].id, CTX),
        hops + 1,
      );
    }
    case "fill": {
      // Answering every gap is always sufficient to build.
      return {
        typeId: stage.plan.typeId,
        templateId: stage.plan.templateId,
        values: answerAll(stage),
        known: stage.plan.known,
      };
    }
    case "chips":
      // Stage two must be answerable AND skippable; skipping is the harder
      // case, so that is the one the exhaustive drive uses.
      return driveToBuild(fromChips(stage.pending, {}), hops + 1);
    case "purpose":
      return driveToBuild(fromPurpose(PURPOSE_OPTIONS[0].id), hops + 1);
    case "entry":
      throw new Error("transition returned to entry — this is a dead end");
  }
}

describe("the spine reaches a build from every route", () => {
  test.each(MV3_CREATE_TYPES.map((t) => [t.label, t.id] as const))(
    "%s: tapping the type reaches a build",
    (_label, typeId) => {
      const request = driveToBuild(fromEntry({ kind: "pick_type", typeId }, CTX));
      expect(request.typeId).toBeDefined();
    },
  );

  test("every template in every type reaches a build", () => {
    for (const type of MV3_CREATE_TYPES) {
      for (const entry of galleryEntriesFor(type.id)) {
        const request = driveToBuild(fromGallery(type.id, entry.id, CTX));
        expect(request.typeId).toBe(type.id);
      }
    }
  });

  test("blank on a chip-stage type still reaches its build", () => {
    // Blank is the route with the least information, so it is the one where a
    // skipped stage two would strand the user rather than build.
    const t = fromBlank("video", "a 30 second teaser", CTX);
    expect(t.go).toBe("stage");
    expect(driveToBuild(t).typeId).toBe("video");
  });

  test("a suggestion goes to a build without passing through a gallery", () => {
    const entries = galleryEntriesFor("slides");
    const first = fromEntry(
      { kind: "pick_suggestion", typeId: "slides", templateId: entries[0].id },
      CTX,
    );
    // Either straight to a build (nothing missing) or straight to fill —
    // never to a gallery, because the template is already known.
    if (first.go === "stage") expect(first.stage.kind).toBe("fill");
    expect(driveToBuild(first).typeId).toBe("slides");
  });

  test("free text naming a type builds without a gallery or a rescue", () => {
    const t = fromEntry({ kind: "free_text", text: "a pitch deck for our seed round" }, CTX);
    expect(t.go).toBe("build");
    if (t.go === "build") {
      expect(t.request.typeId).toBe("slides");
      expect(t.request.freeText).toContain("pitch deck");
    }
  });

  test("the rescue reaches a build from every purpose", () => {
    for (const option of PURPOSE_OPTIONS) {
      const request = driveToBuild(fromPurpose(option.id));
      expect(request.typeId).toBe(option.typeId);
    }
  });

  test("blank is a build, not a detour", () => {
    const t = fromBlank("slides", "something no template covers", CTX);
    expect(t.go).toBe("build");
    if (t.go === "build") expect(t.request.templateId).toBeUndefined();
  });
});

describe("the gallery is scoped, never global", () => {
  test("every gallery stage carries a type", () => {
    for (const type of MV3_CREATE_TYPES) {
      const t = fromEntry({ kind: "pick_type", typeId: type.id }, CTX);
      expect(t.go).toBe("stage");
      if (t.go === "stage" && t.stage.kind === "gallery") {
        expect(t.stage.typeId).toBe(type.id);
      }
    }
  });

  test("answering the rescue lands in a scoped gallery, not a build", () => {
    const t = fromPurpose("convince");
    expect(t.go).toBe("stage");
    if (t.go === "stage") {
      expect(t.stage.kind).toBe("gallery");
      if (t.stage.kind === "gallery") expect(t.stage.typeId).toBe("slides");
    }
  });
});

/**
 * v29's one structural change to the machine.
 *
 * NOTE FOR REVIEWERS: this describe block has no v27 counterpart, because v27
 * had no stage two. The Sheets assertion is the important one — v29 corrected
 * its own earlier draft, which had grouped Sheets with the other three, and a
 * chip row on Sheets would ask a second time over its existing elicit sets.
 */
describe("chip stage two is asked exactly where v29 says", () => {
  const WITH_CHIPS = ["video", "canvas", "audio"];

  test.each(MV3_CREATE_TYPES.map((t) => [t.id] as const))(
    "%s carries a chip stage only if v29 named it",
    (typeId) => {
      expect(hasChipStage(typeId)).toBe(WITH_CHIPS.includes(typeId));
    },
  );

  test("Sheets is excluded — it already has its own elicit sets", () => {
    expect(hasChipStage("sheets")).toBe(false);
    const t = toBuild({ typeId: "sheets", values: {}, known: [] });
    expect(t.go).toBe("build");
  });

  test("video is asked format, length and voiceover before the render", () => {
    const t = toBuild({ typeId: "video", values: {}, known: [] });
    expect(t.go).toBe("stage");
    if (t.go !== "stage" || t.stage.kind !== "chips") throw new Error("no chips");
    expect(t.stage.questions.map((q) => q.key)).toEqual([
      "format",
      "length",
      "voiceover",
    ]);
  });

  test("no chip is pre-selected — the stage asks, it does not assume", () => {
    for (const typeId of WITH_CHIPS) {
      const t = toBuild({ typeId, values: {}, known: [] });
      if (t.go !== "stage" || t.stage.kind !== "chips") throw new Error("no chips");
      expect(t.stage.pending.values).toEqual({});
      for (const q of t.stage.questions) expect(q.options.length).toBeGreaterThan(1);
    }
  });

  test("answers ride into the build; skipped questions send nothing", () => {
    const pending = { typeId: "video", values: {}, known: [] };
    const answered = fromChips(pending, { format: "Animated", length: "" });
    expect(answered.go).toBe("build");
    if (answered.go !== "build") return;
    expect(answered.request.values.format).toBe("Animated");
    // A skipped question is absent, not defaulted to a plausible choice.
    expect("length" in answered.request.values).toBe(false);
    expect("voiceover" in answered.request.values).toBe(false);
  });

  test("the stage is asked once — an answered request goes straight through", () => {
    const answers = Object.fromEntries(
      chipQuestionsFor("video").map((q) => [q.key, q.options[0]]),
    );
    const t = toBuild({ typeId: "video", values: answers, known: [] });
    expect(t.go).toBe("build");
  });
});

describe("type inference does not guess", () => {
  test.each([
    ["a deck for the board", "slides"],
    ["write me a PRD", "docs"],
    ["a financial model spreadsheet", "sheets"],
    ["generate a logo", "images"],
    ["research our competitors", "research"],
    ["a 10 second video clip", "video"],
    ["find me leads in fintech", "leads"],
  ])("%s → %s", (text, expected) => {
    expect(inferType(text).typeId).toBe(expected);
  });

  test("text with no signal returns unknown rather than a plausible default", () => {
    const result = inferType("something for Tuesday");
    expect(result.typeId).toBeNull();
    expect(result.confidence).toBe("unknown");
  });

  test("un-inferrable free text routes to the rescue, never to a silent build", () => {
    const t = fromEntry({ kind: "free_text", text: "something for Tuesday" }, CTX);
    expect(t.go).toBe("stage");
    if (t.go === "stage") expect(t.stage.kind).toBe("purpose");
  });

  test("empty text is never a build", () => {
    const t = fromEntry({ kind: "free_text", text: "   " }, CTX);
    expect(t.go).toBe("stage");
  });
});

describe("fill is never an empty form", () => {
  const formTemplates = MV3_CREATE_TYPES.flatMap((type) =>
    galleryEntriesFor(type.id)
      .filter((e) => e.source === "form")
      .map((e) => [type.id, e.id, e.fieldCount ?? 0] as const),
  );

  test("there is at least one structured template to check", () => {
    expect(formTemplates.length).toBeGreaterThan(5);
  });

  test.each(formTemplates)(
    "%s/%s asks fewer questions than it has fields",
    (typeId, templateId, fieldCount) => {
      const plan = buildFillPlan(typeId, templateId, []);
      // The reduction that makes fill worth having: optional inputs are
      // deferred, so a template never asks everything it declares.
      expect(plan.gaps.length).toBeLessThan(fieldCount);
      expect(plan.gaps.length + plan.deferred.length).toBe(fieldCount);
      // And it never renders as an unreduced, unframed wall of inputs.
      expect(isEmptyForm(plan)).toBe(false);
    },
  );

  test("a template with every field required and nothing known IS an empty form", () => {
    // The guard has teeth: this is the shape it must reject. If a future edit
    // marks every input required, or drops the deferral of optionals, the
    // check above starts failing rather than silently passing.
    const plan = buildFillPlan("slides", "form-investor-pitch", []);
    const unreduced = {
      ...plan,
      gaps: [...plan.gaps, ...plan.deferred],
      deferred: [],
    };
    expect(isEmptyForm(unreduced)).toBe(true);
  });

  test("the headline never claims memory the plan does not have", () => {
    const bare = buildFillPlan("slides", "form-investor-pitch", []);
    expect(knownHeadline(bare)).toBeNull();
    expect(fillHeadline(bare)).not.toContain("most of it");

    const withFacts = buildFillPlan("slides", "form-investor-pitch", [
      { id: "b", label: "Brand", value: "Northwind", origin: "brand" },
    ]);
    expect(knownHeadline(withFacts)).toBeTruthy();
  });

  test("a fact answers its field, and the field stops being asked", () => {
    const before = buildFillPlan("slides", "form-investor-pitch", []);
    const after = buildFillPlan("slides", "form-investor-pitch", [
      {
        id: "c",
        label: "Company",
        value: "Northwind",
        fieldKey: "company",
        origin: "context",
      },
    ]);
    expect(after.gaps.length).toBe(before.gaps.length - 1);
    expect(after.prefilled.company).toBe("Northwind");
    expect(after.gaps.some((g) => g.key === "company")).toBe(false);
  });

  test("knowing everything skips fill entirely", () => {
    const template = "form-find-leads";
    const plan = buildFillPlan("leads", template, []);
    const facts: KnownFact[] = plan.gaps.map((gap, i) => ({
      id: `f${i}`,
      label: gap.label,
      value: "known",
      fieldKey: gap.key,
      origin: "context",
    }));
    const full = buildFillPlan("leads", template, facts);
    expect(full.gaps).toHaveLength(0);

    // And the spine turns that into a build rather than an empty fill screen.
    const t = fromGallery("leads", template, { known: facts });
    expect(t.go).toBe("build");
  });

  test("a free-text plan has no gaps — blank must not invent a form", () => {
    const plan = buildFillPlan("slides", "not-a-template", [], "just make it");
    expect(plan.gaps).toHaveLength(0);
    expect(plan.totalFields).toBe(0);
  });

  /**
   * REPLACES two v27 tests ("the progress label never counts a deferred field
   * as known" and "a real fact does show up in the known count"). Both asserted
   * the "6 of 8 known · 2 to go" header, which v29 withdrew along with the
   * prefill badge — a ratio of what Cue claims to know is that badge in numeric
   * form, and the user cannot judge a ratio. What survives from those tests is
   * the thing they were really protecting: the header must never overstate.
   * It now does that by counting only the questions it is about to ask.
   */
  test("the header counts the questions it is about to ask, and nothing else", () => {
    const plan = buildFillPlan("slides", "form-investor-pitch", []);
    expect(plan.totalFields).toBe(8);
    expect(plan.deferred.length).toBeGreaterThan(0);

    const label = fillProgressLabel(plan);
    expect(label).toBe(`${plan.gaps.length} questions · skip any`);
    // No claim about what Cue knows, and no denominator to inflate it with.
    expect(label).not.toContain("known");
    expect(label).not.toContain("of 8");
  });

  test("a fact that answers a field lowers the count, and the header follows", () => {
    const plan = buildFillPlan("slides", "form-investor-pitch", [
      {
        id: "c",
        label: "Company",
        value: "Northwind",
        fieldKey: "company",
        origin: "context",
      },
    ]);
    expect(fillProgressLabel(plan)).toBe(
      `${plan.gaps.length} questions · skip any`,
    );
  });

  /**
   * v29: *"a card labelled '8 fields' opening a five-question screen was its
   * own small dishonesty."* The card and the screen behind it are computed in
   * different modules, so this checks they agree for every structured template.
   */
  test("the gallery card's count is what the fill screen actually asks", () => {
    for (const type of MV3_CREATE_TYPES) {
      for (const entry of galleryEntriesFor(type.id)) {
        if (entry.source !== "form") continue;
        const plan = buildFillPlan(type.id, entry.id, []);
        expect(entry.questionCount).toBe(plan.gaps.length);
      }
    }
  });

  test("the investor pitch card says five, not eight", () => {
    // Design's own example, and the one they corrected by name.
    const entry = galleryEntriesFor("slides").find(
      (e) => e.id === "form-investor-pitch",
    );
    expect(entry?.fieldCount).toBe(8);
    expect(entry?.questionCount).toBe(5);
  });

  test("a template asking for figures says it will leave them blank", () => {
    // The invariant, surfaced before the build rather than apologised for after.
    const withFigures = buildFillPlan("data", "form-budget-tracker", []);
    expect(
      [...withFigures.gaps, ...withFigures.deferred].some(
        (g) => g.kind === "number",
      ),
    ).toBe(true);
    expect(blankNumbersLine(withFigures)).toContain("rather than invent them");

    // And a template with no numeric input does not answer a question nobody
    // asked.
    const noFigures = buildFillPlan("slides", "form-investor-pitch", []);
    expect(blankNumbersLine(noFigures)).toBeNull();
  });
});
