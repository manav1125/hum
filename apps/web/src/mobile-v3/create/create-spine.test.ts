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
 * It also locks the three prohibitions that are easy to regress by "improving"
 * the UI later:
 *
 *   - the gallery cannot be rendered unscoped (there is no such Stage);
 *   - a free-text run with no type signal must not silently pick one;
 *   - fill must never come back as a bare list of empty inputs.
 */

import { describe, expect, test } from "bun:test";

import {
  buildFillPlan,
  fillHeadline,
  fillProgressLabel,
  isEmptyForm,
  knownHeadline,
} from "./create-fill-model";
import type { KnownFact } from "./create-known-facts";
import {
  fromBlank,
  fromEntry,
  fromGallery,
  fromPurpose,
  inferType,
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

  test("the progress label never counts a deferred field as known", () => {
    const plan = buildFillPlan("slides", "form-investor-pitch", []);
    expect(plan.totalFields).toBe(8);
    expect(plan.deferred.length).toBeGreaterThan(0);
    // Nothing is known, so the label must not claim a "known" count at all —
    // `totalFields - gaps` would have reported the three optional fields.
    const label = fillProgressLabel(plan);
    expect(label).not.toContain("known");
    expect(label).toContain(`${plan.gaps.length} to go`);
    expect(label).toContain(`${plan.deferred.length} optional`);
  });

  test("a real fact does show up in the known count", () => {
    const plan = buildFillPlan("slides", "form-investor-pitch", [
      {
        id: "c",
        label: "Company",
        value: "Northwind",
        fieldKey: "company",
        origin: "context",
      },
    ]);
    expect(fillProgressLabel(plan)).toContain("1 of 8 known");
  });
});
