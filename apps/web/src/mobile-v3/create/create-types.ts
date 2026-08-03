/**
 * Mobile v3 Create — the ten types, as the mobile surface sees them.
 *
 * This is a thin, presentation-shaped VIEW over the real registries in
 * `@/domains/create`. It invents nothing: every entry here resolves to a real
 * `CreateMode` (create-templates.ts) whose templates are backed by a real Cue
 * skill, and the template counts are computed from those registries rather than
 * typed in. If a mode disappears upstream, this file stops listing it instead of
 * advertising a door that opens onto nothing.
 *
 * Design draws ten type tiles (v27 J1/J2). There are exactly ten `CREATE_MODES`,
 * so the mapping is 1:1 — `slides · data · docs · sheets · research · images ·
 * canvas · video · audio · leads`.
 *
 * Ordering matters: J1's peek detent shows the first two as large tiles and
 * summarises the rest, so the two highest-frequency types lead.
 */

import {
  CREATE_MODES,
  type CreateMode,
  type CreateTemplate,
} from "@/domains/create/create-templates";
import {
  templatesForMode,
  type TemplateDefinition,
} from "@/domains/create/create-form-templates";

/** A Create type as the mobile entry + gallery render it. */
export interface Mv3CreateType {
  /** The real `CreateMode.id`. */
  id: string;
  /** Short label for the tile and the type chips. */
  label: string;
  /** The noun used in body copy ("Blank deck", "12 templates"). */
  blankLabel: string;
  /** Emoji used in the compressed "and 8 more" row at the peek detent. */
  glyph: string;
  /** The backing skill's human name — real provenance, shown on cards. */
  skillLabel: string;
  /** Total templates this type can offer (quick-start + structured form). */
  templateCount: number;
}

/**
 * Display metadata that has no home in the upstream registry. Keyed by the real
 * mode id so a typo can't silently create a phantom type — `buildTypes()` only
 * emits entries whose id exists in `CREATE_MODES`.
 */
const DISPLAY: Record<string, { blankLabel: string; glyph: string }> = {
  slides: { blankLabel: "Blank deck", glyph: "▤" },
  docs: { blankLabel: "Blank doc", glyph: "📄" },
  data: { blankLabel: "Blank dashboard", glyph: "📊" },
  sheets: { blankLabel: "Blank sheet", glyph: "▦" },
  research: { blankLabel: "Open question", glyph: "🔎" },
  images: { blankLabel: "Describe an image", glyph: "🎨" },
  canvas: { blankLabel: "Start from an image", glyph: "✂" },
  video: { blankLabel: "Describe a video", glyph: "🎬" },
  audio: { blankLabel: "Describe audio", glyph: "🎵" },
  leads: { blankLabel: "Blank search", glyph: "👥" },
};

/**
 * How many distinct templates a type actually offers.
 *
 * Counted from the same function the grid renders from, so the number on the
 * tile and the number of cards behind it can never disagree. Summing the two
 * catalogs directly would over-count by every template that appears in both.
 */
export function templateCountFor(mode: CreateMode): number {
  return galleryEntriesFor(mode.id).length;
}

/**
 * Display order, from the v27 entry: Slides and Docs lead as the two large
 * tiles, then "Sheets, Images, Video, Research +4". The registry's own order is
 * incidental (it groups by backing skill), and the first two tiles are the whole
 * point of the peek detent — so the order is stated here rather than inherited.
 *
 * Any mode missing from this list still appears, after the named ones: a new
 * Create type must never silently vanish from the phone.
 */
const ORDER = [
  "slides",
  "docs",
  "sheets",
  "images",
  "video",
  "research",
  "data",
  "canvas",
  "audio",
  "leads",
];

function buildTypes(): Mv3CreateType[] {
  const ranked = [...CREATE_MODES].sort((a, b) => {
    const ai = ORDER.indexOf(a.id);
    const bi = ORDER.indexOf(b.id);
    return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi);
  });
  return ranked.map((mode) => {
    const display = DISPLAY[mode.id];
    return {
      id: mode.id,
      label: mode.label,
      blankLabel: display?.blankLabel ?? `Blank ${mode.label.toLowerCase()}`,
      glyph: display?.glyph ?? "✎",
      skillLabel: mode.skillLabel,
      templateCount: templateCountFor(mode),
    };
  });
}

/** The ten Create types, derived from the real mode registry. */
export const MV3_CREATE_TYPES: Mv3CreateType[] = buildTypes();

/** Lookup a type by id. */
export function getCreateType(id: string): Mv3CreateType | undefined {
  return MV3_CREATE_TYPES.find((t) => t.id === id);
}

/** The real `CreateMode` behind a type id. */
export function getCreateMode(id: string): CreateMode | undefined {
  return CREATE_MODES.find((m) => m.id === id);
}

/**
 * Every template a type can offer, as one list the gallery can render.
 *
 * Structured form templates lead: they carry a typed field list, which is what
 * lets J3 state what's known and ask only the gaps. Quick-start templates follow
 * — they still reach a real build, they just elicit with chips instead of fields.
 */
export interface Mv3GalleryEntry {
  id: string;
  title: string;
  description: string;
  /** "form" carries typed inputs; "quick" carries chip elicitation. */
  source: "form" | "quick";
  /** Number of typed inputs, when this is a form template. */
  fieldCount?: number;
  /** Number of chip questions, when this is a quick-start template. */
  questionCount?: number;
  /**
   * A real provenance hint from the registry, when the template declares one.
   * `files` names a project the output would be filed onto; `source` names a
   * connected system the content is drawn from. Absent means "we don't know" —
   * the gallery then shows nothing rather than a plausible guess.
   */
  provenance?: TemplateDefinition["provenance"];
}

/** Titles differing only by case/punctuation are the same template to a user. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * All gallery entries for a type, form templates first and de-duplicated.
 *
 * The two catalogs overlap by intent: "Investor pitch deck" exists both as a
 * structured form template (8 typed inputs) and as a quick-start with chip
 * elicitation. Listing both puts the same name in the grid twice with different
 * subtitles, which reads as a bug. The structured one wins, because typed inputs
 * are what let the fill step state what's known and ask only the gaps — the
 * quick-start's chips can only ever ask.
 */
export function galleryEntriesFor(typeId: string): Mv3GalleryEntry[] {
  const mode = getCreateMode(typeId);
  if (!mode) return [];

  const forms: Mv3GalleryEntry[] = templatesForMode(typeId).map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    source: "form",
    fieldCount: t.inputs.length,
    provenance: t.provenance,
  }));

  const seen = new Set(forms.map((f) => titleKey(f.title)));

  const quicks: Mv3GalleryEntry[] = mode.templates
    .filter((t: CreateTemplate) => !seen.has(titleKey(t.title)))
    .map((t: CreateTemplate) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      source: "quick",
      questionCount: t.elicit?.length ?? 0,
    }));

  return [...forms, ...quicks];
}
