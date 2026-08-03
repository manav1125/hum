/**
 * Mobile v3 Create — what the card offers after delivery.
 *
 * Two of design's rules live here, and they pull in opposite directions on
 * purpose:
 *
 * - **Rule 5 — remix chips are type-specific.** Slides get shorter / different
 *   look / add a slide; docs get tone / length / restructure; images get restyle
 *   / variations / upscale. A generic "regenerate" chip on every type is the
 *   failure this rule exists to prevent.
 * - **Rule 4 — exactly one adjacent offer, only from what it touched.** *"Two is
 *   nagging; unrelated is creepy."*
 *
 * Both produce REAL instructions. Every chip resolves to a prompt that re-seeds
 * the conversation the asset came from, reusing the pure builders in
 * `domains/create/create-remix.ts` where they fit, so a chip is never a button
 * that does nothing.
 *
 * The adjacent offer is derived from the artefact itself — the fan-out registry
 * maps the delivered format to the other formats that can be produced *from the
 * same brief*. That is what makes it provably "from what it touched" rather than
 * a guess about the user's week. Design's own example ("Sarah at a16z asked
 * about the data room twice") needs inbox and contact knowledge the Create run
 * genuinely does not have, so it is not reproduced; see the report.
 */

import {
  assetNoun,
  buildVariationPrompt,
  DEFAULT_VARIATIONS,
  FANOUT_FORMATS,
  type FanoutFormat,
  type RemixAsset,
} from "@/domains/create/create-remix";
import type { BrandProfileLike } from "@/domains/create/create-intent";

/* ----------------------------------------------------------------------- */
/* Remix chips                                                              */
/* ----------------------------------------------------------------------- */

/** What tapping a chip does. */
export type RemixAction =
  /** Re-seed the conversation with `prompt`. */
  | { kind: "reseed"; prompt: string }
  /**
   * Needs a target template first — the scoped gallery opens, and the choice
   * becomes a restyle. Modelled explicitly so the UI can't fire a restyle with
   * no target and call it a success.
   */
  | { kind: "pick_template"; typeId: string };

export interface RemixChip {
  id: string;
  label: string;
  action: RemixAction;
}

/** Re-seed instruction shared by the "less of it" chips. */
function shorten(asset: RemixAsset): string {
  const noun = assetNoun(asset);
  return (
    `Make this ${noun} shorter. Keep every point that carries weight and cut the rest — ` +
    `tighten the copy rather than deleting whole sections, and keep the same order.`
  );
}

/**
 * The chips for a type.
 *
 * Types beyond the three design named get a set derived from what their skill
 * can actually do, rather than an empty row: every Create type reaches a real
 * generator, so every type has at least one honest way to iterate.
 */
export function remixChipsFor(
  typeId: string,
  asset: RemixAsset,
  brand: BrandProfileLike | null = null,
): RemixChip[] {
  const noun = assetNoun(asset);

  switch (typeId) {
    case "slides":
      return [
        { id: "shorter", label: "Make it shorter", action: { kind: "reseed", prompt: shorten(asset) } },
        { id: "look", label: "Different look", action: { kind: "pick_template", typeId: "slides" } },
        {
          id: "add_slide",
          label: "Add a slide",
          action: {
            kind: "reseed",
            prompt:
              "Add one more slide to this deck. Tell me what it covers before you write it, " +
              "then place it where it belongs in the flow rather than at the end.",
          },
        },
      ];

    case "docs":
      return [
        {
          id: "tone",
          label: "Change the tone",
          action: {
            kind: "reseed",
            prompt:
              `Rewrite this ${noun} in a different tone. Keep every fact and the structure exactly as they are — ` +
              "only the voice changes. Ask me which tone you should take if it isn't obvious from the content.",
          },
        },
        { id: "length", label: "Make it shorter", action: { kind: "reseed", prompt: shorten(asset) } },
        {
          id: "restructure",
          label: "Restructure it",
          action: {
            kind: "reseed",
            prompt:
              `Restructure this ${noun}. Keep all the content, but reorder and re-section it so the ` +
              "most important thing leads. Show me the new outline first.",
          },
        },
      ];

    case "images":
    case "canvas":
      return [
        { id: "restyle", label: "Restyle it", action: { kind: "pick_template", typeId: "images" } },
        {
          id: "variations",
          label: "Make variations",
          action: {
            kind: "reseed",
            prompt: buildVariationPrompt(asset, DEFAULT_VARIATIONS[1], brand),
          },
        },
        {
          id: "upscale",
          label: "Upscale it",
          action: {
            kind: "reseed",
            prompt:
              "Upscale this image — raise the resolution and sharpen the detail without " +
              "introducing artefacts or changing the composition.",
          },
        },
      ];

    case "data":
    case "sheets":
      return [
        {
          id: "add_metric",
          label: "Add a metric",
          action: {
            kind: "reseed",
            prompt:
              `Add another metric to this ${noun}. Ask me which one if you can't tell from the data already in it.`,
          },
        },
        {
          id: "chart",
          label: "Change the charts",
          action: {
            kind: "reseed",
            prompt: `Change how this ${noun} charts its data — pick the chart types that actually suit each series, and say why you chose each.`,
          },
        },
        { id: "shorter", label: "Simplify it", action: { kind: "reseed", prompt: shorten(asset) } },
      ];

    case "research":
      return [
        {
          id: "deeper",
          label: "Go deeper",
          action: {
            kind: "reseed",
            prompt:
              "Go deeper on this — find primary sources for the claims that currently rest on secondary ones, " +
              "and say plainly which points you could not verify.",
          },
        },
        {
          id: "sources",
          label: "Show sources",
          action: {
            kind: "reseed",
            prompt: "List every source behind this brief, with what each one actually supported.",
          },
        },
        { id: "shorter", label: "Make it shorter", action: { kind: "reseed", prompt: shorten(asset) } },
      ];

    case "video":
    case "audio":
      return [
        {
          id: "shorter",
          label: "Make it shorter",
          action: { kind: "reseed", prompt: shorten(asset) },
        },
        {
          id: "restyle",
          label: "Different style",
          action: { kind: "pick_template", typeId } as RemixAction,
        },
        {
          id: "variations",
          label: "Another take",
          action: { kind: "reseed", prompt: buildVariationPrompt(asset, DEFAULT_VARIATIONS[0], brand) },
        },
      ];

    default:
      return [
        { id: "shorter", label: "Make it shorter", action: { kind: "reseed", prompt: shorten(asset) } },
        {
          id: "redo",
          label: "Try it differently",
          action: { kind: "reseed", prompt: buildVariationPrompt(asset, DEFAULT_VARIATIONS[0], brand) },
        },
      ];
  }
}

/* ----------------------------------------------------------------------- */
/* The one adjacent offer                                                   */
/* ----------------------------------------------------------------------- */

/** Which fan-out format a delivered type corresponds to (so we don't re-offer it). */
const SOURCE_FORMAT: Record<string, string> = {
  slides: "slides",
  docs: "one_pager",
  images: "social",
  canvas: "landing",
};

/**
 * The adjacent format offered after each type.
 *
 * Chosen deliberately, not by index: a deck's natural next artefact is the
 * one-pager that summarises it; a document's is the deck that presents it.
 * Types whose output has no honest downstream format get no offer at all —
 * returning nothing is a correct outcome, and the card renders no offer block.
 */
const ADJACENT: Record<string, string> = {
  slides: "one_pager",
  docs: "slides",
  data: "one_pager",
  sheets: "one_pager",
  research: "one_pager",
  images: "landing",
  canvas: "social",
};

export interface AdjacentOffer {
  format: FanoutFormat;
  /** The question shown on the card. */
  question: string;
  /** The prompt fired if the user accepts. */
  prompt: string;
}

/**
 * Exactly one adjacent offer, or none.
 *
 * Never returns a list: the return type is a single value precisely so a second
 * offer cannot be added without changing the signature. Both the offer and its
 * prompt are anchored on the delivered artefact's own brief, which is what keeps
 * it from being "unrelated, and creepy".
 */
export function adjacentOfferFor(
  typeId: string,
  asset: RemixAsset,
): AdjacentOffer | null {
  const targetId = ADJACENT[typeId];
  if (!targetId || targetId === SOURCE_FORMAT[typeId]) return null;

  const format = FANOUT_FORMATS.find((f) => f.id === targetId);
  if (!format) return null;

  const noun = assetNoun(asset);
  return {
    format,
    question: `Want ${format.produce} from the same brief, to go with the ${noun}?`,
    prompt:
      `From the same brief behind "${asset.name}", also make ${format.produce}. ` +
      `Keep it in the same brand and on-message with the ${noun} so the two read as one set.`,
  };
}
