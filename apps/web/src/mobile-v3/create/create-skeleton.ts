/**
 * Mobile v3 Create — the template skeleton.
 *
 * The build surface (J4) wants to show something structural while the run works,
 * and the gallery wants a preview. There are three things it could show:
 *
 *   a) a real generation — impossible mid-build: the pipeline emits no partial
 *      artefact, so there is nothing to render until the run completes;
 *   b) the template's real skeleton — available, honest;
 *   c) invented thumbnails that fill in on a timer — a fabricated generation.
 *
 * This module does (b), and any component that uses it must LABEL it as a
 * skeleton.
 *
 * **v29 note.** The building card no longer renders this. N2 removed the tile
 * strip outright — *"no fake thumbnails… nothing to look at until then"* —
 * because an artefact-shaped row invites you to sit and watch it fill even when
 * its caption is honest. The module stays because the value is real and a
 * template preview is still a legitimate place for it; it simply has no place
 * on a surface whose whole message is that there is nothing to see yet.
 *
 * That labelling requirement is not decoration: this codebase previously shipped a brand
 * extraction that returned a hardcoded palette and invented font names as though
 * they had been extracted, and the fix (assistant/src/brand/brand-extract-job.ts)
 * established the rule — a thing that could not be derived is shown as absent or
 * as what it actually is, never as a plausible result.
 *
 * Every value here is read from the real registries:
 *   - Slides / dashboards → `TemplateSpec.layoutRhythm`, the observed slide-to-
 *     slide sequence captured from the real source deck.
 *   - Docs → `DocTypeSpec.outline`, the document's real section list.
 * When neither resolves, `skeletonFor` returns `null` and the UI shows nothing
 * rather than a generic five-box placeholder.
 */

import {
  getDocTypeSpec,
  getTemplateSpec,
  type TemplatePalette,
} from "@/domains/create/studio-specs";

/** What a skeleton describes. */
export type SkeletonKind = "slides" | "sections";

export interface Skeleton {
  kind: SkeletonKind;
  /**
   * The ordered step names — real layout rhythm or real section outline. These
   * are shown as labels, so the user can see this is structure, not content.
   */
  steps: string[];
  /** The template's real palette, when it declares one. Used for the tiles. */
  palette?: TemplatePalette;
  /**
   * The sentence the UI must render alongside it. Non-optional on purpose: a
   * skeleton without its disclaimer reads as a preview of the user's artefact.
   */
  disclaimer: string;
}

const SLIDES_DISCLAIMER =
  "Template structure — your slides replace these as they render.";
const SECTIONS_DISCLAIMER =
  "Template structure — your sections replace these as they're written.";

/**
 * Resolve the skeleton for a template.
 *
 * Returns `null` when the template declares no structure. Callers must handle
 * null by rendering nothing — not by substituting a generic shape.
 */
export function skeletonFor(templateId: string | undefined): Skeleton | null {
  if (!templateId) return null;

  const deck = getTemplateSpec(templateId);
  if (deck) {
    return {
      kind: "slides",
      steps: deck.layoutRhythm,
      palette: deck.palette,
      disclaimer: SLIDES_DISCLAIMER,
    };
  }

  const doc = getDocTypeSpec(templateId);
  if (doc) {
    return {
      kind: "sections",
      steps: doc.outline,
      disclaimer: SECTIONS_DISCLAIMER,
    };
  }

  return null;
}

/**
 * Turn a layout-rhythm token ("oversized-uppercase-cover") into something
 * readable ("Oversized uppercase cover"). Pure formatting of a real value — it
 * adds no meaning that wasn't there.
 */
export function humanizeStep(step: string): string {
  const words = step.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * How many tiles to draw. Bounded so a long rhythm doesn't overflow the card,
 * and never padded upward — five tiles for a three-step rhythm would imply a
 * five-part artefact that the template does not describe.
 */
export function skeletonTileCount(skeleton: Skeleton, max = 5): number {
  return Math.min(skeleton.steps.length, max);
}
