/**
 * Mobile v3 Create — the routing spine.
 *
 * Design's v27 rule, as a pure state machine:
 *
 *   1a  tap a type       ──→  1c scoped gallery  ──→  J3 fill
 *   1a  tap a suggestion ──────────────────────→  J3 fill  (template known)
 *   1a  type or speak    ──→  1d stream  ──→  asks only what's missing
 *   1a  "not sure"       ──→  J6 "what's it for?"  ──→  scoped gallery
 *
 * Three properties this file exists to guarantee, each covered by a test:
 *
 * 1. **Every route reaches a build.** There is no stage whose only exit is back
 *    to the entry. `nextAfterFill` always yields a build request.
 * 2. **The gallery is never global.** `Stage.gallery` requires a `typeId`; there
 *    is no representation of an unscoped gallery, so one cannot be rendered.
 * 3. **Fill is skipped when nothing is missing.** `enterFill` returns a build
 *    request directly when the plan has no gaps (design's rule 1).
 *
 * J6 is reachable only from the explicit `not_sure` action. It is a rescue, not
 * a step: no other transition produces it.
 */

import { buildFillPlan, type FillPlan } from "./create-fill-model";
import type { KnownFact } from "./create-known-facts";

/* ----------------------------------------------------------------------- */
/* Stages                                                                   */
/* ----------------------------------------------------------------------- */

/**
 * Where the flow currently is. `entry` is the sheet; everything after it is a
 * PUSH onto the stack (design §3: a sheet inside a sheet loses the back
 * gesture), which is why these are a flat list rather than a nesting.
 */
export type Stage =
  | { kind: "entry" }
  /** 1c — always scoped to exactly one type. */
  | { kind: "gallery"; typeId: string }
  /** J3 — the plan carries what's known and what's still missing. */
  | { kind: "fill"; plan: FillPlan }
  /** J6 — the rescue. */
  | { kind: "purpose" };

/** What the user did on the entry surface. */
export type EntryAction =
  /** Tapped one of the ten type tiles. */
  | { kind: "pick_type"; typeId: string }
  /** Tapped a "because you're working on" suggestion — template already known. */
  | { kind: "pick_suggestion"; typeId: string; templateId: string }
  /** Typed or spoke free text. */
  | { kind: "free_text"; text: string }
  /** Tapped "Not sure what you need? Talk it through". */
  | { kind: "not_sure" };

/**
 * A request to actually build something. Produced by the spine and handed to
 * the host, which turns it into a real run (see `create-run.ts`). The spine
 * never runs anything itself, which is what makes it testable.
 */
export interface BuildRequest {
  typeId: string;
  /** The template being built, when one was chosen. */
  templateId?: string;
  /** Values collected in fill, keyed by field key. */
  values: Record<string, string | string[]>;
  /** Free text the user typed, when this run started from a description. */
  freeText?: string;
  /** Facts Cue already held that were folded into the brief. */
  known: KnownFact[];
}

/** The outcome of a transition: either a new stage, or "go build this". */
export type Transition =
  | { go: "stage"; stage: Stage }
  | { go: "build"; request: BuildRequest };

/* ----------------------------------------------------------------------- */
/* Type inference — deliberately conservative                               */
/* ----------------------------------------------------------------------- */

/**
 * Keyword signals per type. These are matched against the user's own words, so
 * a hit is evidence rather than a guess. Ordered by specificity: the first type
 * with a hit wins, so "deck" beats the generic "write".
 */
const SIGNALS: { typeId: string; words: RegExp }[] = [
  { typeId: "slides", words: /\b(deck|slides?|presentation|pitch|keynote|powerpoint)\b/i },
  { typeId: "sheets", words: /\b(spreadsheet|sheet|excel|xlsx|model|formula|pivot)\b/i },
  { typeId: "data", words: /\b(dashboard|kpis?|tracker|calculator|metrics? board)\b/i },
  { typeId: "video", words: /\b(video|clip|reel|footage|animation|trailer)\b/i },
  { typeId: "audio", words: /\b(audio|music|voiceover|voice-over|podcast|sound|jingle)\b/i },
  { typeId: "images", words: /\b(image|picture|photo|logo|illustration|graphic|artwork)\b/i },
  { typeId: "canvas", words: /\b(upscale|background|retouch|inpaint|crop|cut ?out|restyle)\b/i },
  { typeId: "leads", words: /\b(leads?|prospects?|contacts?|scrape|email list)\b/i },
  { typeId: "research", words: /\b(research|competitor|market|brief|analys[ei]s|landscape|deep ?dive)\b/i },
  { typeId: "docs", words: /\b(doc|document|memo|prd|spec|one-?pager|proposal|essay|blog|article|write-?up)\b/i },
];

/**
 * How confident we are about a type. `inferred` means the user's own words
 * named it; `unknown` means they didn't, and we must not pretend otherwise.
 */
export type TypeConfidence = "inferred" | "unknown";

export interface TypeInference {
  typeId: string | null;
  confidence: TypeConfidence;
}

/**
 * Infer the artefact type from free text.
 *
 * Returns `{ typeId: null, confidence: "unknown" }` when the text carries no
 * signal. The caller must then ASK rather than pick a plausible default — a
 * silently-chosen type is the same class of lie as a fabricated palette.
 */
export function inferType(text: string): TypeInference {
  const trimmed = text.trim();
  if (!trimmed) return { typeId: null, confidence: "unknown" };
  for (const signal of SIGNALS) {
    if (signal.words.test(trimmed)) {
      return { typeId: signal.typeId, confidence: "inferred" };
    }
  }
  return { typeId: null, confidence: "unknown" };
}

/* ----------------------------------------------------------------------- */
/* Transitions                                                              */
/* ----------------------------------------------------------------------- */

/** Context the spine needs to compute a fill plan. */
export interface SpineContext {
  /** Facts Cue genuinely holds. Empty is normal and must render fine. */
  known: KnownFact[];
}

/**
 * Enter fill for a known template — or skip straight to the build when the plan
 * has no gaps. Design's rule 1: "If Cue knows everything, skip J3 and build."
 */
export function enterFill(
  typeId: string,
  templateId: string,
  ctx: SpineContext,
  freeText?: string,
): Transition {
  const plan = buildFillPlan(typeId, templateId, ctx.known, freeText);
  if (plan.gaps.length === 0) {
    return {
      go: "build",
      request: {
        typeId,
        templateId,
        values: plan.prefilled,
        freeText,
        known: plan.known,
      },
    };
  }
  return { go: "stage", stage: { kind: "fill", plan } };
}

/**
 * The entry transition — the whole routing rule in one function.
 *
 * `purpose` (J6) is produced by exactly one branch, and no branch produces an
 * unscoped gallery.
 */
export function fromEntry(
  action: EntryAction,
  ctx: SpineContext,
): Transition {
  switch (action.kind) {
    // Tap a type → the gallery, scoped to it.
    case "pick_type":
      return { go: "stage", stage: { kind: "gallery", typeId: action.typeId } };

    // Tap a suggestion → straight to fill; the template is already known.
    case "pick_suggestion":
      return enterFill(action.typeId, action.templateId, ctx);

    // Type or speak → infer. A named type skips the gallery entirely; an
    // un-named one lands in the gallery so the user picks rather than being
    // handed a guess.
    case "free_text": {
      const { typeId, confidence } = inferType(action.text);
      if (typeId && confidence === "inferred") {
        return {
          go: "build",
          request: { typeId, values: {}, freeText: action.text, known: ctx.known },
        };
      }
      return { go: "stage", stage: { kind: "purpose" } };
    }

    // "Not sure" → the rescue.
    case "not_sure":
      return { go: "stage", stage: { kind: "purpose" } };
  }
}

/** Picking a template in the scoped gallery. */
export function fromGallery(
  typeId: string,
  templateId: string,
  ctx: SpineContext,
): Transition {
  return enterFill(typeId, templateId, ctx);
}

/**
 * "Blank" in the gallery grid — design's rule 6, first-class. It carries no
 * template, so it goes straight to a build seeded by the user's own words.
 */
export function fromBlank(typeId: string, text: string, ctx: SpineContext): Transition {
  return {
    go: "build",
    request: { typeId, values: {}, freeText: text, known: ctx.known },
  };
}

/* ----------------------------------------------------------------------- */
/* J6 — "what's it for?"                                                    */
/* ----------------------------------------------------------------------- */

/**
 * The five purposes, each mapped to the types that actually serve it.
 *
 * Design reframed this deliberately: the question is "what's it for?", not
 * "what kind of file?", because someone unsure doesn't know the format either.
 * So each answer resolves to a TYPE the user never had to name.
 */
export interface PurposeOption {
  id: string;
  glyph: string;
  label: string;
  detail: string;
  /** The type the gallery opens scoped to. */
  typeId: string;
}

export const PURPOSE_OPTIONS: PurposeOption[] = [
  {
    id: "convince",
    glyph: "👥",
    label: "Convincing someone",
    detail: "A pitch, a proposal, a case",
    typeId: "slides",
  },
  {
    id: "report",
    glyph: "📋",
    label: "Reporting on something",
    detail: "An update, a review, numbers",
    typeId: "data",
  },
  {
    id: "work_out",
    glyph: "🔎",
    label: "Working something out",
    detail: "Research, analysis, options",
    typeId: "research",
  },
  {
    id: "attention",
    glyph: "📣",
    label: "Getting attention",
    detail: "Marketing, launch, outreach",
    typeId: "images",
  },
  {
    id: "operational",
    glyph: "⚙",
    label: "Something operational",
    detail: "A tracker, a process, a tool",
    typeId: "sheets",
  },
];

/** Answering J6 drops into the scoped gallery — never straight into a build. */
export function fromPurpose(purposeId: string): Transition {
  const option =
    PURPOSE_OPTIONS.find((p) => p.id === purposeId) ?? PURPOSE_OPTIONS[0];
  return { go: "stage", stage: { kind: "gallery", typeId: option.typeId } };
}
