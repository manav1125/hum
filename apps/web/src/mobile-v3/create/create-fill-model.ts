/**
 * Mobile v3 Create — the fill plan (J3).
 *
 * Design's rule 1: "Fill is never an empty form. State what Cue knows as a
 * checkable block, ask only the gaps. If Cue knows everything, skip fill and
 * build." The line they want is *"the 8-field form becomes 2 questions — same
 * completeness, a fifth of the typing."*
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
 * plan always reports honestly how it got there (`knownCount` / `askCount` /
 * `deferredCount`) so the header can say "6 of 8 known · 2 to go" using real
 * numbers rather than a decorative ratio.
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
  /** The backing skill's name — real provenance for the footer. */
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
 * The header's counts — "6 of 8 known · 2 to go".
 *
 * Each number counts one thing and says which. The tempting shortcut,
 * `totalFields - gaps`, silently reports deferred OPTIONAL fields as "known",
 * so a template with three optional inputs claims Cue knows three things about
 * you when it knows nothing. Known means a fact answered the field; optional
 * means we chose not to ask. They are counted separately because they are
 * different claims.
 */
export function fillProgressLabel(plan: FillPlan): string {
  const knownCount = Object.keys(plan.prefilled).length;
  const parts: string[] = [];
  if (knownCount > 0) parts.push(`${knownCount} of ${plan.totalFields} known`);
  if (plan.gaps.length > 0) parts.push(`${plan.gaps.length} to go`);
  if (plan.deferred.length > 0) parts.push(`${plan.deferred.length} optional`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing left to ask";
}

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
  return "Here's what I already have —";
}

function spellSmall(n: number): string {
  return (
    ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"][n] ??
    String(n)
  );
}
