/**
 * Mobile v3 Create — composing a real run.
 *
 * The spine decides WHAT to build; this module turns that decision into the
 * exact prompt the daemon receives. It runs the same path the desktop Create
 * surface runs, so a mobile build is not a second-class one:
 *
 *   values → template.composePrompt()      (the registry's own composer)
 *          → + what Cue knows              (context, marked as such)
 *          → applyCreateIntent()           (design contract + brand)
 *          → seeded into a fresh thread    (the host navigates)
 *
 * Nothing here generates. `applyCreateIntent` prepends the compiled contract and
 * the host hands the string to the ordinary chat send path, which is what makes
 * the artefact land in a thread the user can leave and come back to.
 */

import {
  findTemplate,
  type TemplateValues,
} from "@/domains/create/create-form-templates";
import {
  applyCreateIntent,
  type BrandProfileLike,
  type CreateIntent,
} from "@/domains/create/create-intent";
import {
  getDocTypeSpec,
  getTemplateSpec,
} from "@/domains/create/studio-specs";

import type { BuildRequest } from "./create-spine";
import { originLabel, type KnownFact } from "./create-known-facts";
import { getCreateMode, getCreateType, withArticle } from "./create-types";

/**
 * v29's invariant, carried into every run this surface starts.
 *
 * > Cue may draft *words* it hasn't been given. It may never draft *numbers* it
 * > hasn't been given.
 *
 * Three of the structured templates already say this in their own composers
 * (see `create-form-templates.ts`, and the `no-fabricated-figures` guard beside
 * it). The routes that did not were the ones with no structured template at
 * all: blank, free text, and every quick-start template — which is most of what
 * a phone actually builds. `$38.4K, up 18% MoM` in a deck someone presents is
 * the failure; a bracketed placeholder or an empty cell is not.
 */
const FIGURES_RULE =
  "Figures: use only numbers I have given you. Where you have no number, leave " +
  "the field empty or write a bracketed placeholder I can spot — never a " +
  "stand-in figure, because an invented number reads exactly like a measured one.";

/**
 * The quick-start template behind an id, when the id names one.
 *
 * The registry has two catalogs and `findTemplate` only searches the structured
 * one, so a quick-start id resolved to nothing and its authored prompt was
 * silently dropped: picking "Cinematic clip" built from the words "Make me a
 * video." This looks the template up in the mode's own catalog instead.
 */
function quickPrompt(typeId: string, templateId?: string): string | undefined {
  if (!templateId) return undefined;
  const mode = getCreateMode(typeId);
  return mode?.templates.find((t) => t.id === templateId)?.prompt;
}

/**
 * Render the known block into the prompt.
 *
 * Facts are passed through verbatim and labelled by origin, so the model is told
 * both what is known and how solidly. Facts the user could still contradict are
 * not asserted as constraints — they are offered as context, which is the same
 * status they have on screen.
 */
function knownBlock(known: KnownFact[]): string {
  if (known.length === 0) return "";
  const lines = known.map(
    (f) => `- ${f.label}: ${f.value} (${originLabel(f)})`,
  );
  return [
    "What I already know — use it, and don't ask me for it again:",
    ...lines,
  ].join("\n");
}

/** Render collected field values for a run with no registry composer. */
function valuesBlock(values: TemplateValues): string {
  const lines = Object.entries(values)
    .map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join(", ") : String(value);
      return rendered.trim() ? `- ${key}: ${rendered.trim()}` : "";
    })
    .filter(Boolean);
  if (lines.length === 0) return "";
  return ["Use these inputs — they are my answers, so build with them:", ...lines].join("\n");
}

/**
 * Resolve the `CreateIntent.templateId`.
 *
 * The registry has two id spaces that must not be confused: structured FORM
 * template ids (`form-investor-pitch`) and studio TEMPLATE/DOC-TYPE spec ids
 * (`startup`, `prd`). `compileCreateIntent` only resolves the latter, so passing
 * a form id would silently compile to no design contract at all. Only ids that
 * actually resolve are set.
 */
function resolveSpecTemplateId(templateId?: string): string | undefined {
  if (!templateId) return undefined;
  if (getTemplateSpec(templateId) || getDocTypeSpec(templateId)) return templateId;
  return undefined;
}

export interface ComposedRun {
  /** The full prompt, contract included, ready to seed. */
  prompt: string;
  /**
   * The origin intent to stamp against the seeded conversation, or null when
   * the run carried no design selection worth remembering.
   */
  intent: CreateIntent | null;
}

/**
 * Compose the run.
 *
 * `brand` must be the REAL active Brand Kit or null — never a synthesised one.
 * When it is null the brand contract is simply omitted and the output is
 * un-branded, which is an honest outcome the user can see on the fill footer.
 */
export function composeRun(
  request: BuildRequest,
  brand: BrandProfileLike | null,
): ComposedRun {
  const type = getCreateType(request.typeId);
  const template = request.templateId ? findTemplate(request.templateId) : undefined;

  // The body: the registry's own composer when we have a form template, then
  // the quick-start template's authored prompt, and only then the user's own
  // words. A quick-start that fell through to the last branch lost everything
  // its author wrote about the artefact.
  let body: string;
  if (template) {
    body = template.composePrompt(request.values as TemplateValues);
  } else {
    const parts = [
      quickPrompt(request.typeId, request.templateId) ||
        request.freeText?.trim() ||
        `Make me ${type ? withArticle(type.noun) : "something"}.`,
      // Chip answers and any values collected ride along either way.
      valuesBlock(request.values),
    ].filter(Boolean);
    body = parts.join("\n\n");
  }

  const known = knownBlock(request.known);
  const prompt = [body, known, FIGURES_RULE].filter(Boolean).join("\n\n");

  const specTemplateId = resolveSpecTemplateId(request.templateId);
  const intent: CreateIntent | null =
    specTemplateId || brand
      ? {
          mode: request.typeId,
          templateId: specTemplateId,
          brandKitId: brand?.name ? (brand as { id?: string }).id ?? null : null,
        }
      : null;

  return {
    prompt: applyCreateIntent(prompt, intent, brand),
    intent,
  };
}
