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
import type { KnownFact } from "./create-known-facts";
import { getCreateMode } from "./create-types";

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
    (f) => `- ${f.label}: ${f.value} (from ${f.origin})`,
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
  const mode = getCreateMode(request.typeId);
  const template = request.templateId ? findTemplate(request.templateId) : undefined;

  // The body: the registry's own composer when we have a form template,
  // otherwise the user's own words plus whatever they filled in.
  let body: string;
  if (template) {
    body = template.composePrompt(request.values as TemplateValues);
  } else {
    const parts = [
      request.freeText?.trim() ||
        `Make me ${mode ? `a ${mode.label.toLowerCase().replace(/s$/, "")}` : "something"}.`,
      valuesBlock(request.values),
    ].filter(Boolean);
    body = parts.join("\n\n");
  }

  const known = knownBlock(request.known);
  const prompt = [body, known].filter(Boolean).join("\n\n");

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
