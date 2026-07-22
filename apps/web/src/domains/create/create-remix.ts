/**
 * Create Studio — the OUTPUT side (remix).
 *
 * Round 1 compiled a gallery selection into a design contract on the way IN
 * (create-intent.ts / applyCreateIntent). This module is the mirror on the way
 * OUT: once an asset has been generated, the user can *remix* it — restyle it
 * to another template, rebrand it to another Brand Kit, or fan a few variations
 * out to compare — without retyping the brief.
 *
 * Each remix is a **re-seed**: we build a short natural-language instruction
 * ("re-render this deck in the Minimal template, keep all content") and, where
 * a design selection is involved, prepend the same compiled design contract the
 * gallery would have produced (compileCreateIntent). The instruction seeds the
 * SAME conversation the asset came from, so the backing skill re-renders in
 * context rather than starting cold.
 *
 * This module is pure + UI-agnostic (no React, no stores). The surfaces call
 * these builders and hand the resulting prompt to the host's re-seed callback.
 */

import {
  compileCreateIntent,
  type BrandProfileLike,
  type CreateIntent,
} from "./create-intent";
import { getTemplateSpec } from "./studio-specs";

/** Identifies the generated asset a remix acts on (for the instruction copy). */
export interface RemixAsset {
  /** Human-facing asset name, e.g. "Northwind — Series A". */
  name: string;
  /** The Create mode the asset was generated in (slides | image | docs | …). */
  mode: string;
  /** The template the asset currently uses, if known (drives "keep / swap"). */
  templateId?: string;
  /** The style the asset currently uses, if known (image / video modes). */
  styleId?: string;
  /** The Brand Kit currently applied, if any. */
  brandKitId?: string | null;
  /**
   * A short noun for the asset in instruction copy ("deck", "one-pager",
   * "image"). Derived from `mode` when omitted.
   */
  noun?: string;
}

/** The noun used in instruction copy for a given mode. */
export function assetNoun(asset: Pick<RemixAsset, "mode" | "noun">): string {
  if (asset.noun) return asset.noun;
  switch (asset.mode) {
    case "slides":
      return "deck";
    case "image":
    case "images":
      return "image";
    case "video":
      return "video";
    case "docs":
      return "document";
    case "data":
      return "dashboard";
    default:
      return "asset";
  }
}

/**
 * Prepend a compiled design contract to a remix instruction. Mirrors
 * `applyCreateIntent` but is scoped to the remix instruction so the two stay
 * independent.
 */
function withContract(
  instruction: string,
  intent: CreateIntent | null,
  brand?: BrandProfileLike | null,
): string {
  if (!intent) return instruction;
  const contract = compileCreateIntent(intent, brand);
  if (!contract) return instruction;
  return `${contract}\n\n---\n\n${instruction}`;
}

/**
 * RESTYLE — swap the template, keep the content. Reopening the gallery to pick
 * the new template is the UI's job; this builds the re-seed prompt once the new
 * template id is chosen.
 */
export function buildRestylePrompt(
  asset: RemixAsset,
  newTemplateId: string,
  brand?: BrandProfileLike | null,
): string {
  const noun = assetNoun(asset);
  const target = getTemplateSpec(newTemplateId);
  const targetName = target ? target.name : newTemplateId;
  const intent: CreateIntent = {
    mode: asset.mode,
    templateId: newTemplateId,
    brandKitId: asset.brandKitId ?? null,
  };
  const instruction =
    `Restyle this ${noun} into the "${targetName}" template. ` +
    `Keep ALL the existing content, copy and structure exactly as they are — ` +
    `only change the visual template (layout, palette, type and cover treatment).`;
  return withContract(instruction, intent, asset.brandKitId ? brand : null);
}

/**
 * REBRAND — re-render in a different Brand Kit, same content. The chosen kit's
 * profile compiles into the brand contract so colors/fonts/voice all move.
 */
export function buildRebrandPrompt(
  asset: RemixAsset,
  newBrandKitId: string,
  newBrand: BrandProfileLike | null,
): string {
  const noun = assetNoun(asset);
  const brandName = newBrand?.name ?? "the selected brand";
  const intent: CreateIntent = {
    mode: asset.mode,
    templateId: asset.templateId,
    styleId: asset.styleId,
    brandKitId: newBrandKitId,
  };
  const instruction =
    `Rebrand this ${noun} into ${brandName}. ` +
    `Keep ALL the existing content and copy — re-render it in the new brand's ` +
    `colors, fonts, logo and voice so it reads as ${brandName}'s asset.`;
  return withContract(instruction, intent, newBrand);
}

/** A single make-variations directive (one seeded generation per variation). */
export interface VariationDirective {
  /** 1-based index, for the "Variation N" label. */
  index: number;
  /** Short descriptor of the axis this variation explores ("centered", "dark"). */
  variant: string;
  /**
   * What the treatment actually changes, in plain words. There is no way to
   * preview a variation before it is generated, so the chooser SAYS what each
   * direction is instead of showing an empty artwork tile — this is the copy
   * that makes the choice a real one. See create-variations-result.
   */
  description: string;
}

/**
 * The default four variation axes, matching the 4e mock (faithful · centered ·
 * split · dark). Kept small + tasteful — the point is to compare, not flood.
 */
export const DEFAULT_VARIATIONS: VariationDirective[] = [
  {
    index: 1,
    variant: "faithful",
    description:
      "The same layout and emphasis, re-cut — tighter copy and cleaner spacing, nothing moved.",
  },
  {
    index: 2,
    variant: "centered",
    description:
      "Everything centred on one axis: a symmetric hero, centred headline and stacked supporting copy.",
  },
  {
    index: 3,
    variant: "split-layout",
    description:
      "Two columns — copy on one side, the visual on the other, with an asymmetric grid.",
  },
  {
    index: 4,
    variant: "dark",
    description:
      "The palette inverted to a dark ground, with the accent colour carrying the emphasis.",
  },
];

/**
 * The instruction for ONE variation. `total` only affects the phrasing ("2 of
 * 4"); pass 1 when a single alternate is being made on its own so the copy
 * doesn't imply siblings that were never generated.
 */
export function buildVariationPrompt(
  asset: RemixAsset,
  variation: VariationDirective,
  brand?: BrandProfileLike | null,
  total = 1,
): string {
  const noun = assetNoun(asset);
  const intent: CreateIntent = {
    mode: asset.mode,
    templateId: asset.templateId,
    styleId: asset.styleId,
    brandKitId: asset.brandKitId ?? null,
  };
  const position =
    total > 1 ? ` (variation ${variation.index} of ${total})` : "";
  const instruction =
    `Make an ALTERNATE of this ${noun}${position} — keep the same content and ` +
    `brand, but explore a "${variation.variant}" treatment: ` +
    `${variation.description} Vary the composition, emphasis and layout so ` +
    `this reads as a distinct option.`;
  return withContract(instruction, intent, asset.brandKitId ? brand : null);
}

/**
 * MAKE VARIATIONS — one prompt per variation. Each seeded generation shares the
 * brief + template but nudges a different visual axis, so the result grid (4e)
 * is genuinely different alternates to pick between.
 */
export function buildVariationPrompts(
  asset: RemixAsset,
  variations: VariationDirective[] = DEFAULT_VARIATIONS,
  brand?: BrandProfileLike | null,
): string[] {
  return variations.map((v) =>
    buildVariationPrompt(asset, v, brand, variations.length),
  );
}

/**
 * MERGE — combine the picked variations into one refined asset. There's no
 * dedicated multi-asset merge endpoint yet, so this re-seeds a single
 * instruction naming the chosen variations; the skill reconciles them in
 * context. (See the 4e surface for the UI-side TODO.)
 */
export function buildMergePrompt(
  asset: RemixAsset,
  selectedIndexes: number[],
  brand?: BrandProfileLike | null,
): string {
  const noun = assetNoun(asset);
  const intent: CreateIntent = {
    mode: asset.mode,
    templateId: asset.templateId,
    styleId: asset.styleId,
    brandKitId: asset.brandKitId ?? null,
  };
  const list = selectedIndexes.map((i) => `variation ${i}`).join(" and ");
  const instruction =
    `Merge ${list} of this ${noun} into a single refined version — ` +
    `take the strongest elements from each and reconcile them into one ${noun}, ` +
    `keeping the content and brand intact.`;
  return withContract(instruction, intent, asset.brandKitId ? brand : null);
}

// ---------------------------------------------------------------------------
// 4g STRETCH — multi-format fan-out
// ---------------------------------------------------------------------------

/** A downstream format the fan-out can also produce from one brief. */
export interface FanoutFormat {
  id: string;
  /** Label shown in the "Also make…" chooser. */
  label: string;
  /** Glyph for the row (kept as unicode to match the design's icon set). */
  glyph: string;
  /** The Create mode the format maps to (for the re-seed intent). */
  mode: string;
  /** Instruction fragment naming what to produce. */
  produce: string;
}

/**
 * The fan-out format menu, matching the 4g mock. `slides` is the "source" —
 * the asset already exists — so the chooser marks it and the others fan out
 * from it.
 */
export const FANOUT_FORMATS: FanoutFormat[] = [
  {
    id: "slides",
    label: "Slides deck",
    glyph: "▭",
    mode: "slides",
    produce: "a slide deck",
  },
  {
    id: "one_pager",
    label: "One-pager",
    glyph: "▤",
    mode: "docs",
    produce: "a one-page summary document",
  },
  {
    id: "social",
    label: "3 social images",
    glyph: "▦",
    mode: "image",
    produce: "a set of 3 social images",
  },
  {
    id: "email",
    label: "Email announcement",
    glyph: "✉",
    mode: "docs",
    produce: "an email announcement",
  },
  {
    id: "landing",
    label: "Landing section",
    glyph: "▧",
    mode: "canvas",
    produce: "a landing-page section",
  },
];

/**
 * FAN-OUT — one seeded generation per selected format. Each carries the same
 * brand so the kit reads as coordinated. NOTE: firing N independent generations
 * gives coordinated-BY-brand assets; true single-pass multi-asset orchestration
 * (one skill run that emits the whole kit together, sharing a content spine)
 * needs a backend kit endpoint that does not exist yet — see the 4g surface
 * TODO. This re-seed path is the honest, shippable approximation.
 */
export function buildFanoutPrompts(
  asset: RemixAsset,
  formatIds: string[],
  brand?: BrandProfileLike | null,
): { format: FanoutFormat; prompt: string }[] {
  return formatIds.flatMap((id) => {
    const fmt = FANOUT_FORMATS.find((f) => f.id === id);
    if (!fmt || fmt.id === "slides") return []; // slides is the source asset.
    const intent: CreateIntent = {
      mode: fmt.mode,
      brandKitId: asset.brandKitId ?? null,
    };
    const instruction =
      `From the same brief behind "${asset.name}", also make ${fmt.produce}. ` +
      `Keep it in the same brand and on-message with the source ${assetNoun(asset)} ` +
      `so the whole set reads as one coordinated kit.`;
    return [
      {
        format: fmt,
        prompt: withContract(instruction, intent, asset.brandKitId ? brand : null),
      },
    ];
  });
}
