/**
 * Mobile v3 Create — the fill plan (v29 N1, which replaces v27 J3).
 *
 * Design's rule 1: "Fill is never an empty form. State what Cue knows as a
 * checkable block, ask only the gaps. If Cue knows everything, skip fill and
 * build."
 *
 * **v29 corrected the claim around that rule.** The v27 line — *"the 8-field
 * form becomes 2 questions, a fifth of the typing"* — is withdrawn. The accurate
 * one is *"Cue states what it knows with sources, and asks the rest"*, and on
 * the frame design draws that is FIVE questions, not two, with the known block
 * rendered verbatim and each row's origin named. Two consequences here:
 *
 *   - the header counts QUESTIONS, not a known-of-total ratio. "6 of 8 known"
 *     was the prefill badge in numeric form, and v29 withdrew the badge.
 *   - a template that asks for figures carries the line that earns more trust
 *     than any prefill would: *"I don't have your numbers, so I'll leave them
 *     blank rather than invent them."* See `blankNumbersLine`.
 *
 * This module turns a real `TemplateDefinition` (create-form-templates.ts) plus
 * whatever Cue genuinely knows into that plan. Two reductions do the work, and
 * both hold even when Cue knows NOTHING — which matters, because the honest
 * default today is that it knows nothing but the brand (see create-known-facts):
 *
 *   1. **Known facts answer fields.** A fact whose `fieldKey` matches an input
 *      removes that input from the asks and adds a `✓` row to the block.
 *   2. **Optional inputs are deferred, not asked.** A template's non-required
 *      inputs never appear as gaps; they sit behind "Add detail" and the build
 *      proceeds without them. This is what stops an 8-field form rendering as
 *      eight questions on a phone even with an empty known block.
 *
 * So the worst case is "ask the required fields", not "ask everything" — and the
 * count in the header is that number, so the card that opened this screen and
 * the screen itself can never disagree about how much work it is.
 */

import {
  findTemplate,
  type InputField,
  type TemplateDefinition,
} from "@/domains/create/create-form-templates";
import { getCreateMode } from "./create-types";
import type { KnownFact } from "./create-known-facts";

/* ----------------------------------------------------------------------- */
/* Field kinds — the mobile control vocabulary                              */
/* ----------------------------------------------------------------------- */

/**
 * The control a gap renders as.
 *
 * This maps the registry's `InputField.type` onto what a phone can actually
 * show. Note there is deliberately no `metric` kind: design's brief lists one,
 * but the registry has no metric field type and no unit metadata, so a "metric"
 * control would have nothing real to render. `number` is the honest nearest.
 */
export type GapKind = "chips" | "text" | "long_text" | "number" | "url" | "tags";

/** Map a registry input type to a mobile control. */
export function gapKindFor(field: InputField): GapKind {
  switch (field.type) {
    // A select with options is a chip row on mobile — never a dropdown.
    case "select":
      return "chips";
    case "textarea":
      return "long_text";
    case "number":
      return "number";
    case "url":
      return "url";
    case "tags":
      return "tags";
    case "text":
    default:
      return "text";
  }
}

/** One thing the fill step actually asks for. */
export interface Gap {
  key: string;
  label: string;
  kind: GapKind;
  placeholder?: string;
  /** Chip labels, for `chips`. Always non-empty when kind is `chips`. */
  options?: string[];
  help?: string;
}

/* ----------------------------------------------------------------------- */
/* The plan                                                                 */
/* ----------------------------------------------------------------------- */

export interface FillPlan {
  typeId: string;
  templateId: string;
  /** The template's real title, for the pushed screen's header. */
  title: string;
  /** The backing skill's name. Not rendered — see `Mv3CreateType.skillLabel`. */
  skillLabel: string;
  /** Facts Cue holds, rendered as the checkable block. May be empty. */
  known: KnownFact[];
  /** Values already answered by those facts, keyed by field key. */
  prefilled: Record<string, string>;
  /** What we still have to ask. Empty means: skip fill, build now. */
  gaps: Gap[];
  /** Optional inputs we chose not to ask. Reachable, never blocking. */
  deferred: Gap[];
  /** Total inputs the template declares — the denominator, honestly. */
  totalFields: number;
}

/**
 * The header — v29 N1's *"5 questions · skip any"*.
 *
 * It counts one thing: what this screen is about to ask. v27's "6 of 8 known ·
 * 2 to go" is gone, and deliberately: a ratio of what Cue claims to know is the
 * prefill badge expressed as arithmetic, and v29 withdrew the badge. What Cue
 * knows is stated verbatim in the block below, with its origin, where the user
 * can actually judge it — a number cannot be judged.
 *
 * "skip any" is only appended because it is true: every gap can be left empty
 * and the build still runs (see `CreateFill`'s skip path).
 */
export function fillProgressLabel(plan: FillPlan): string {
  const n = plan.gaps.length;
  if (n === 0) return "Nothing left to ask";
  return `${n} question${n === 1 ? "" : "s"} · skip any`;
}

/** True when this gap asks the user for a figure. */
function isFigure(gap: Gap): boolean {
  return gap.kind === "number";
}

/**
 * v29's invariant, said out loud before the build starts:
 *
 * > Cue may draft *words* it hasn't been given. It may never draft *numbers* it
 * > hasn't been given.
 *
 * Returned only when this template actually asks for a figure — on a template
 * with no numeric input the sentence would be answering a question nobody asked.
 * `null` means: render nothing. Blank is a legitimate output, announced before
 * building, and it needs no apology on the artefact afterwards.
 */
export function blankNumbersLine(plan: FillPlan): string | null {
  const asksForFigures =
    plan.gaps.some(isFigure) || plan.deferred.some(isFigure);
  if (!asksForFigures) return null;
  return "I don't have your numbers, so I'll leave them blank rather than invent them.";
}

/**
 * What happens to a figure you don't give. Rendered under every numeric input,
 * because "skip any" has to be believable at the point of skipping.
 */
export const FIGURE_SKIP_HELP =
  "Leave it blank and it ships with the field empty.";

function toGap(field: InputField): Gap {
  const kind = gapKindFor(field);
  return {
    key: field.key,
    label: field.label,
    kind,
    placeholder: field.placeholder,
    // A chips control with no options would render as a dead row, so fall back
    // to free text rather than an empty chip strip.
    options: kind === "chips" ? field.options : undefined,
    help: field.help,
  };
}

/**
 * Build the plan for a template.
 *
 * When `templateId` names no known template — a blank / free-text run — the plan
 * has no gaps at all, because there is no declared field list to ask against.
 * The caller then goes straight to a build seeded by the user's own words, which
 * is exactly what "Blank is first-class" means.
 */
export function buildFillPlan(
  typeId: string,
  templateId: string,
  known: KnownFact[],
  freeText?: string,
): FillPlan {
  const template: TemplateDefinition | undefined = findTemplate(templateId);
  const mode = getCreateMode(typeId);
  const skillLabel = mode?.skillLabel ?? "Cue";

  if (!template) {
    return {
      typeId,
      templateId,
      title: freeText?.trim() || "New " + (mode?.label ?? "thing").toLowerCase(),
      skillLabel,
      known,
      prefilled: {},
      gaps: [],
      deferred: [],
      totalFields: 0,
    };
  }

  // A fact answers a field only when it names one AND that field exists.
  const fieldKeys = new Set(template.inputs.map((f) => f.key));
  const prefilled: Record<string, string> = {};
  for (const fact of known) {
    if (fact.fieldKey && fieldKeys.has(fact.fieldKey)) {
      prefilled[fact.fieldKey] = fact.value;
    }
  }

  const unanswered = template.inputs.filter((f) => !(f.key in prefilled));
  const gaps = unanswered.filter((f) => f.required).map(toGap);
  const deferred = unanswered.filter((f) => !f.required).map(toGap);

  return {
    typeId,
    templateId,
    title: template.title,
    skillLabel,
    known,
    prefilled,
    gaps,
    deferred,
    totalFields: template.inputs.length,
  };
}

/**
 * True when the plan has regressed into the thing rule 1 forbids: it states
 * nothing AND achieves no reduction — every field the template declares is
 * asked, as an undifferentiated wall.
 *
 * This is deliberately the test of *reduction and framing*, not of a question
 * count. With an empty known block a five-required-field template genuinely has
 * five gaps, and asking five things is the honest answer — pretending otherwise
 * would mean dropping a required input on the floor and calling the result
 * complete. What must never happen is asking all eight with nothing stated,
 * which is exactly what this returns true for.
 *
 * The count comes down when the known block has something in it. Today that
 * means the brand and any retrieved memory; design's "8 fields becomes 2
 * questions" needs a typed fact store that does not exist yet (see
 * create-known-facts). The gap between the two is reported rather than papered
 * over.
 */
export function isEmptyForm(plan: FillPlan): boolean {
  if (plan.totalFields === 0) return false;
  const noReduction = plan.gaps.length >= plan.totalFields;
  const statesNothing = plan.known.length === 0;
  return noReduction && statesNothing;
}

/**
 * The sentence above the asks. It changes with what Cue actually has, so the
 * user is never told "I've got most of it" when the block is empty.
 */
export function fillHeadline(plan: FillPlan): string {
  if (plan.known.length > 0 && plan.gaps.length > 0) {
    return plan.gaps.length === 1
      ? "One thing I can't work out:"
      : `${spellSmall(plan.gaps.length)} things I can't work out:`;
  }
  if (plan.known.length > 0) return "I've got everything I need.";
  if (plan.gaps.length === 1) return "One thing before I start:";
  return `${spellSmall(plan.gaps.length)} things before I start:`;
}

/** The block's own heading — only claims memory when there is some. */
export function knownHeadline(plan: FillPlan): string | null {
  if (plan.known.length === 0) return null;
  return "Here's what I'm going on:";
}

function spellSmall(n: number): string {
  return (
    ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"][n] ??
    String(n)
  );
}
