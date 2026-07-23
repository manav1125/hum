/**
 * Deterministic, CLIENT-SIDE elicitation for Create-studio templates.
 *
 * A template with `elicit` fields asks its questions BEFORE any model turn:
 * the client renders the batched question card (the same one chat uses), the
 * user picks answers, and this module composes those answers into the final
 * prompt — which is what gets sent. The model receives concrete inputs and
 * just builds; it is never relied on to ask first.
 *
 * This replaces the old `<elicit_first>` directive (model-mediated, and only
 * added on one specific button path), which is exactly why the SaaS model
 * generated an .xlsx with no questions in the real app. Nothing here depends
 * on the model's cooperation.
 *
 * The id scheme (`q{n}` per field, `q{n}-o{m}` per option) is generated here
 * and mirrored on the compose side so a response's `optionId` maps back to the
 * originating field option without a separate lookup table.
 */

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import type { QuestionEntry } from "@/types/interaction-ui-types";

import type {
  CreateTemplate,
  TemplateElicitField,
  TemplateElicitOption,
} from "./create-templates";

/** Stable question id for the field at `index` (matches the compose side). */
function entryIdFor(index: number): string {
  return `q${index + 1}`;
}

/** Stable option id for option `oIndex` of field `qIndex`. */
function optionIdFor(qIndex: number, oIndex: number): string {
  return `q${qIndex + 1}-o${oIndex}`;
}

/** The recommended default for a field — the flagged option, else the first. */
function defaultOption(field: TemplateElicitField): TemplateElicitOption {
  return field.options.find((o) => o.isDefault) ?? field.options[0];
}

/** True when a template must collect inputs before it can generate. */
export function templateNeedsElicitation(template: CreateTemplate): boolean {
  return Boolean(template.elicit && template.elicit.length > 0);
}

/**
 * Convert a template's `elicit` fields into the batched `QuestionEntry[]` the
 * shared question card renders. The recommended option carries a visible
 * "(default)" suffix so the user can click through in seconds or accept the
 * whole set at once.
 */
export function elicitFieldsToEntries(
  fields: TemplateElicitField[],
): QuestionEntry[] {
  return fields.map((field, i) => ({
    id: entryIdFor(i),
    question: field.question,
    description: field.description,
    options: field.options.map((option, j) => ({
      id: optionIdFor(i, j),
      label: option.isDefault ? `${option.label} (default)` : option.label,
    })),
    freeTextPlaceholder: field.freeTextPlaceholder,
  }));
}

/** Resolve one field's answer from its response (skip/omitted → default). */
function resolveFieldAnswer(
  field: TemplateElicitField,
  response: QuestionResponseEntry | undefined,
): string {
  const fallback = defaultOption(field).label;
  if (!response || response.kind === "skip") return fallback;
  if (response.kind === "free_text") {
    const text = response.text.trim();
    return text.length > 0 ? text : fallback;
  }
  const match = /-o(\d+)$/.exec(response.optionId);
  const idx = match ? Number(match[1]) : -1;
  return (field.options[idx] ?? defaultOption(field)).label;
}

/**
 * Compose the answers into the template's prompt deterministically. Appends a
 * clear parameters block that names each question and the chosen value, and
 * tells the model these are the user's answers so it builds rather than asks.
 *
 * Passing an empty `responses` array yields the all-defaults prompt — the
 * "Use defaults / Generate" one-tap path.
 */
export function composeElicitedPrompt(
  template: CreateTemplate,
  responses: QuestionResponseEntry[],
): string {
  const fields = template.elicit ?? [];
  if (fields.length === 0) return template.prompt;

  const byId = new Map(responses.map((r) => [r.questionId, r]));
  const lines = fields.map((field, i) => {
    const label = field.question.replace(/[?:]\s*$/, "").trim();
    const answer = resolveFieldAnswer(field, byId.get(entryIdFor(i)));
    return `- ${label}: ${answer}`;
  });

  return [
    template.prompt,
    "",
    "Use these inputs — they are my answers, so build with them and don't ask again:",
    ...lines,
  ].join("\n");
}
