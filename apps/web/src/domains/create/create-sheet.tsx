/**
 * Create sheet — the mobile v3 "+" surface (spec frame 7): a SheetShell lifted
 * over the CURRENT screen instead of a navigation. Prompt first, a horizontal
 * mode rail covering the full desktop Create breadth (Slides / Doc / Image /
 * Data / Research / Video / Canvas / Sheets / Audio / Leads), per-mode
 * quick-start prompt cards (the desktop `CREATE_MODES[].templates`), a
 * template strip reusing the existing template data (slides get the desktop
 * gallery's category tabs + search; video gets the 6 `VIDEO_STYLE_SPECS` with
 * a live/animated kind label; canvas gets the 4 self-seeding
 * `CANVAS_ACTION_SPECS`), and "Create it →" submitting through the EXISTING
 * create/run flow (draft conversation seeded with `?prompt=`, design contract
 * compiled by `applyCreateIntent`, provenance stamped) — then dismiss.
 *
 * The full /assistant/create page keeps working for desktop and as fallback;
 * this sheet is only mounted by the mobile tab bar's "+".
 *
 * Brand: "In your brand ✓" renders ONLY when a real active Brand Kit exists
 * (useActiveBrand); the brand-matched template pick (nearest palette primary)
 * is then pre-selected. No brand → no chip, no fake pre-selection.
 *
 * Create-studio wave (spec frames 33–36):
 *   33 — form templates (create-form-templates.ts) surface as a "Fill &
 *        build" strip; tapping one pushes CreateSheetForm inside the sheet.
 *   34 — Canvas mode swaps the old 4-action strip for CanvasComposer: an
 *        image source (photo library + real recent-outputs History) and the
 *        6 action tiles; with an image picked, submit stages the run into
 *        the chat composer so the image actually rides the message
 *        (create-composer-seed.ts). Marquee selection deferred — see
 *        create-sheet-canvas.tsx.
 *   35 — Live-action/Animated segmented sub-tabs re-filter the video style
 *        strip by videoKind (replacing the flat kind badges).
 *   36 — SheetReferencePicker: "make it look like this" reference riding
 *        exactly one generation via CreateIntent.reference.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { SheetShell } from "@/mobile-v3";
import { useConversationStore } from "@/stores/conversation-store";
import { useCreateProvenanceStore } from "@/stores/create-provenance-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { publicAsset } from "@/utils/public-asset";
import { routes } from "@/utils/routes";

import { stageComposerSeed } from "./create-composer-seed";
import {
  templatesForMode,
  type TemplateDefinition,
} from "./create-form-templates";
import {
  applyCreateIntent,
  type CreateIntent,
  type CreateReference,
} from "./create-intent";
import {
  CanvasComposer,
  canvasTileSeed,
  getCanvasTile,
  type CanvasImagePick,
  type CanvasTileId,
} from "./create-sheet-canvas";
import { CreateSheetForm } from "./create-sheet-form";
import { SheetReferencePicker } from "./create-sheet-reference";
import { CREATE_MODES, buildTemplateKickoff } from "./create-templates";
import {
  DATA_FORMAT_SPECS,
  DOC_TYPE_SPECS,
  IMAGE_STYLE_SPECS,
  TEMPLATE_SPECS,
  VIDEO_STYLE_SPECS,
  type TemplateSpec,
} from "./studio-specs";
import { useActiveBrand } from "./use-active-brand";

/* ------------------------------------------------------------------------- */
/* Mode chips — the full desktop Create breadth, mapped to existing modes.   */
/* ------------------------------------------------------------------------- */

type SheetModeId =
  | "slides"
  | "docs"
  | "images"
  | "data"
  | "research"
  | "video"
  | "canvas"
  | "sheets"
  | "audio"
  | "leads";

const GLYPH = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
} as const;

const MODES: Array<{ id: SheetModeId; label: string; glyph: React.ReactNode }> =
  [
    {
      id: "slides",
      label: "Slides",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <rect x="3" y="5" width="18" height="13" rx="2" />
          <path d="M8 21h8" />
        </svg>
      ),
    },
    {
      id: "docs",
      label: "Doc",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M9 11h7M9 15h5" />
        </svg>
      ),
    },
    {
      id: "images",
      label: "Image",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="9" cy="9" r="2" />
          <path d="M21 15l-5-5-9 9" />
        </svg>
      ),
    },
    {
      id: "data",
      label: "Data",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <path d="M4 20V10M10 20V4M16 20v-8M21 20H3" />
        </svg>
      ),
    },
    {
      id: "research",
      label: "Research",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M20.5 20.5L16 16" />
        </svg>
      ),
    },
    {
      id: "video",
      label: "Video",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M10.5 9.5l4.5 2.5-4.5 2.5z" />
        </svg>
      ),
    },
    {
      id: "canvas",
      label: "Canvas",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M8 16l6.5-6.5 2 2L10 18H8z" />
        </svg>
      ),
    },
    {
      id: "sheets",
      label: "Sheets",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M9 4v16" />
        </svg>
      ),
    },
    {
      id: "audio",
      label: "Audio",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <path d="M9 18V6l10-2v12" />
          <circle cx="7" cy="18" r="2" />
          <circle cx="17" cy="16" r="2" />
        </svg>
      ),
    },
    {
      id: "leads",
      label: "Leads",
      glyph: (
        <svg {...GLYPH} aria-hidden>
          <circle cx="9" cy="8.5" r="3.5" />
          <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
          <circle cx="17" cy="9.5" r="2.5" />
          <path d="M16.5 14.5c2.2.3 3.6 1.8 4 4" />
        </svg>
      ),
    },
  ];

/** Per-mode prompt placeholder (kept short — the field is single-line). */
const PLACEHOLDERS: Record<SheetModeId, string> = {
  slides: "Deck for the renewal call…",
  docs: "PRD for the new onboarding…",
  images: "Hero image for the launch page…",
  data: "Dashboard of Q3 signups…",
  research: "Scan our top 3 competitors…",
  video: "A 5-second product teaser…",
  canvas: "Or describe an edit…",
  sheets: "3-year SaaS model in Excel…",
  audio: "Upbeat 30s intro track…",
  leads: "50 heads of ops in fintech…",
};

/* ------------------------------------------------------------------------- */
/* Template strip data — reuses the existing spec catalogs per mode.         */
/* ------------------------------------------------------------------------- */

interface StripPick {
  id: string;
  label: string;
  /** Thumbnail image (publicAsset path) when the catalog carries one. */
  thumbnail?: string;
  /** Fallback swatch when there is no image (docs / data / canvas). */
  swatch?: { from: string; to: string };
  /** Slides only — the template's gallery category (for the tab rail). */
  category?: TemplateSpec["category"];
  /** Video only — live | animated (frame 35 sub-tab filtering). */
  videoKind?: "live" | "animated";
  /** Longer description surfaced as the tile's title attribute. */
  description?: string;
}

function stripForMode(mode: SheetModeId): StripPick[] {
  switch (mode) {
    case "slides":
      return TEMPLATE_SPECS.map((t) => ({
        id: t.id,
        label: t.name,
        thumbnail: t.thumbnail,
        swatch: { from: t.palette.primary, to: t.palette.bg },
        category: t.category,
      }));
    case "docs":
      return DOC_TYPE_SPECS.map((d) => ({
        id: d.id,
        label: d.name,
        swatch: { from: "#232C3D", to: "#141B27" },
        description: d.description,
      }));
    case "images":
      return IMAGE_STYLE_SPECS.map((s) => ({
        id: s.id,
        label: s.label,
        thumbnail: s.thumbnail,
      }));
    case "data":
      return DATA_FORMAT_SPECS.map((f) => ({
        id: f.id,
        label: f.label,
        swatch: { from: "#1A2230", to: "#3D6EE8" },
        description: f.description,
      }));
    case "video":
      // The 6 video styles; the sheet filters them through the frame-35
      // Live-action/Animated segmented sub-tabs (videoKind).
      return VIDEO_STYLE_SPECS.map((s) => ({
        id: s.id,
        label: s.label,
        thumbnail: s.thumbnail,
        videoKind: s.videoKind,
      }));
    // Canvas renders the frame-34 CanvasComposer (image source + action
    // tiles) instead of a template strip.
    case "canvas":
    // Research / Sheets / Audio / Leads have no visual catalog on desktop
    // either — their breadth is the quick-start prompts.
    case "research":
    case "sheets":
    case "audio":
    case "leads":
      return [];
  }
}

/** Per-mode micro-caption over the template strip. Video gets the frame-35
 * segmented sub-tabs instead; canvas gets the frame-34 composer block. */
const STRIP_CAPTIONS: Partial<Record<SheetModeId, string>> = {
  slides: "Templates",
  docs: "Document types",
  images: "Styles",
  data: "Output formats",
};

/** Frame 35 — the two video sub-tabs (segment order per the frame). */
const VIDEO_SUBTABS: Array<{ id: "live" | "animated"; label: string }> = [
  { id: "live", label: "Live-action" },
  { id: "animated", label: "Animated" },
];

/** Slides category tabs — mirrors the desktop gallery's rail exactly. */
const SLIDES_CATEGORIES: Array<{
  id: TemplateSpec["category"] | "all";
  label: string;
}> = [
  { id: "all", label: `All ${TEMPLATE_SPECS.length}` },
  { id: "startup", label: "Pitch" },
  { id: "minimal", label: "Minimal" },
  { id: "editorial", label: "Editorial" },
  { id: "bold", label: "Bold" },
];

/** Perceptual-ish distance between two hex colors (for brand matching). */
function colorDistance(a: string, b: string): number {
  const parse = (hex: string): [number, number, number] | null => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  return (
    (ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2 + (ca[2] - cb[2]) ** 2
  );
}

/** The brand-matched slides template: nearest palette primary to the brand's. */
function brandMatchedTemplateId(brandPrimary: string | undefined): string | null {
  if (!brandPrimary) return null;
  let best: { id: string; d: number } | null = null;
  for (const t of TEMPLATE_SPECS) {
    const d = colorDistance(brandPrimary, t.palette.primary);
    if (!best || d < best.d) best = { id: t.id, d };
  }
  return best?.id ?? null;
}

function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Shared style for a horizontally-scrolling strip (momentum, no scrollbar). */
const H_SCROLL: React.CSSProperties = {
  display: "flex",
  overflowX: "auto",
  WebkitOverflowScrolling: "touch",
  scrollbarWidth: "none",
  margin: "0 -2px",
  padding: "0 2px",
};

function StripCaption({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: "var(--mv3-muted)",
        marginTop: 15,
        marginBottom: 7,
        padding: "0 2px",
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Sheet                                                                     */
/* ------------------------------------------------------------------------- */

export function CreateSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { brand } = useActiveBrand();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<SheetModeId>("slides");
  const [pickId, setPickId] = useState<string | null>(null);
  const [slidesCategory, setSlidesCategory] =
    useState<(typeof SLIDES_CATEGORIES)[number]["id"]>("all");
  const [slidesSearch, setSlidesSearch] = useState("");
  // Frame 33 — the pushed fielded form (null = the main sheet).
  const [formTemplate, setFormTemplate] = useState<TemplateDefinition | null>(
    null,
  );
  // Frame 35 — video sub-tab.
  const [videoTab, setVideoTab] = useState<"live" | "animated">("live");
  // Frame 36 — per-generation reference (rides exactly ONE submit).
  const [reference, setReference] = useState<CreateReference | null>(null);
  // Frame 34 — canvas action tile + source image.
  const [canvasTile, setCanvasTile] = useState<CanvasTileId | null>(null);
  const [canvasImage, setCanvasImage] = useState<CanvasImagePick | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const brandPick = useMemo(
    () => (mode === "slides" ? brandMatchedTemplateId(brand?.palette?.primary) : null),
    [mode, brand],
  );
  // Brand-matched pick leads the strip (frame 7 shows the pre-selected pick
  // first); the rest keep catalog order. Slides also honor the gallery's
  // category tabs + search (same filter as the desktop overlay).
  const strip = useMemo(() => {
    let picks = stripForMode(mode);
    if (mode === "slides") {
      const q = slidesSearch.trim().toLowerCase();
      picks = picks.filter((p) => {
        const catOk =
          slidesCategory === "all" || p.category === slidesCategory;
        const qOk =
          !q ||
          p.label.toLowerCase().includes(q) ||
          (p.category ?? "").includes(q);
        return catOk && qOk;
      });
    }
    // Frame 35 — the video sub-tab re-filters the style strip by videoKind.
    if (mode === "video") {
      picks = picks.filter((p) => p.videoKind === videoTab);
    }
    if (!brandPick) return picks;
    return [
      ...picks.filter((p) => p.id === brandPick),
      ...picks.filter((p) => p.id !== brandPick),
    ];
  }, [mode, brandPick, slidesCategory, slidesSearch, videoTab]);

  // Frame 33 — the mode's form templates ("Fill & build" strip).
  const formPicks = useMemo(() => templatesForMode(mode), [mode]);

  // The active mode's quick-start prompt cards — the REAL desktop
  // `CREATE_MODES[].templates` (mode ids match 1:1).
  const quickStarts = useMemo(
    () => CREATE_MODES.find((m) => m.id === mode)?.templates ?? [],
    [mode],
  );

  // Pre-select the brand-matched pick (slides + real brand only) when the
  // sheet opens or the mode flips; otherwise nothing is pre-selected.
  useEffect(() => {
    if (!open) return;
    setPickId(brandPick);
  }, [open, mode, brandPick]);

  // Reset transient state each open.
  useEffect(() => {
    if (open) {
      setPrompt("");
      setMode("slides");
      setSlidesCategory("all");
      setSlidesSearch("");
      setFormTemplate(null);
      setVideoTab("live");
      setReference(null);
      setCanvasTile(null);
      setCanvasImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return null;
      });
    }
  }, [open]);

  const switchMode = (id: SheetModeId) => {
    haptic.light();
    setMode(id);
    setSlidesCategory("all");
    setSlidesSearch("");
    setVideoTab("live");
  };

  const setCanvasImagePick = (pick: CanvasImagePick | null) => {
    setCanvasImage((prev) => {
      if (prev && prev.previewUrl !== pick?.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      return pick;
    });
  };

  const inBrand = Boolean(brand) && mode === "slides" && pickId === brandPick;

  /**
   * Shared run seeding — draft conversation, provenance stamp, then either
   * the `?prompt=` auto-send path (no file) or the composer-staging path
   * (canvas image: prompt + attachment land in the chat composer, the user
   * taps send so the image actually rides the message).
   */
  const seedRun = (finalPrompt: string, intent: CreateIntent, file?: File) => {
    useViewerStore.getState().setMainView("chat");
    const id = newDraftConversationId();
    useConversationStore.getState().setActiveConversationId(id);
    useCreateProvenanceStore.getState().stampIntent(id, intent);
    haptic.success();
    // The reference rides exactly ONE generation.
    setReference(null);
    onClose();
    if (file && assistantId) {
      stageComposerSeed({
        conversationId: id,
        assistantId,
        prompt: finalPrompt,
        file,
      });
      void navigate(routes.conversation(id));
      return;
    }
    void navigate(
      `${routes.conversation(id)}?prompt=${encodeURIComponent(finalPrompt)}`,
    );
  };

  const submit = () => {
    const text = prompt.trim();
    // Canvas tiles are self-seeding (desktop parity): a picked tile carries
    // its action's promptSeed, so it submits even with an empty field.
    const tileSeed =
      mode === "canvas" && canvasTile ? canvasTileSeed(canvasTile) : undefined;
    if (!text && !tileSeed) {
      inputRef.current?.focus();
      return;
    }
    const intent: CreateIntent = {
      mode,
      ...(mode === "slides" || mode === "docs"
        ? { templateId: pickId ?? undefined }
        : {}),
      ...(mode === "images" || mode === "video"
        ? { styleId: pickId ?? undefined }
        : {}),
      ...(mode === "data" ? { formatId: pickId ?? undefined } : {}),
      brandKitId: inBrand ? (brand?.id ?? null) : null,
      // The reference picker is hidden on canvas (its image source owns that
      // affordance) — never let a reference set in another mode ride a
      // canvas submit invisibly.
      ...(mode !== "canvas" && reference ? { reference } : {}),
    };
    // If the composer still holds an untouched quick-start prompt that carries
    // elicitation questions, swap in the kickoff (base prompt + elicit
    // directive) so mobile templates ask-before-generating too. Done here, not
    // in the visible composer, so the raw directive never shows to the user;
    // only fires when the text is verbatim the template's prompt (unedited).
    const matchedQuickStart = quickStarts.find(
      (t) => t.elicit && t.elicit.length > 0 && t.prompt === text,
    );
    const baseText = matchedQuickStart
      ? buildTemplateKickoff(matchedQuickStart)
      : text;
    const content = tileSeed
      ? text
        ? `${tileSeed}\n\n${text}`
        : tileSeed
      : baseText;
    const finalPrompt = applyCreateIntent(content, intent, inBrand ? brand : null);
    seedRun(
      finalPrompt,
      intent,
      mode === "canvas" ? canvasImage?.file : undefined,
    );
  };

  /** Frame 33 — the fielded form's submit: desktop-composed prompt + brand. */
  const submitForm = (composed: string) => {
    if (!formTemplate) return;
    const intent: CreateIntent = {
      mode: formTemplate.mode,
      brandKitId: brand?.id ?? null,
    };
    seedRun(applyCreateIntent(composed, intent, brand), intent);
  };

  if (formTemplate) {
    // Frame 33 — the pushed "Fill & build" fielded form (same SheetShell).
    return (
      <SheetShell open={open} onClose={onClose} label="Create">
        <CreateSheetForm
          key={formTemplate.id}
          template={formTemplate}
          brandActive={Boolean(brand)}
          onBack={() => {
            setFormTemplate(null);
            // "Just describe it" escapes to the free prompt.
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          onSubmit={submitForm}
        />
      </SheetShell>
    );
  }

  return (
    <SheetShell open={open} onClose={onClose} label="Create">
      <div style={{ padding: "0 2px 4px" }}>
        <div
          style={{
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "-0.6px",
            color: "var(--mv3-text)",
          }}
        >
          What should I make?
        </div>

        {/* Prompt — ≥16px so iOS never zooms; accent focus ring per spec. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--mv3-btn2-bg)",
            border: "1.5px solid var(--mv3-accent)",
            borderRadius: 17,
            padding: "2px 16px",
            marginTop: 16,
            boxShadow:
              "0 0 0 4px color-mix(in srgb, var(--mv3-accent) 14%, transparent)",
          }}
        >
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={PLACEHOLDERS[mode]}
            aria-label="What should I make?"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 16,
              padding: "12px 0",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--mv3-text)",
              fontFamily: "inherit",
            }}
          />
        </div>

        {/* Mode rail — all 10 desktop modes, horizontal momentum scroll. */}
        <div
          role="tablist"
          aria-label="Create modes"
          style={{ ...H_SCROLL, gap: 8, marginTop: 14 }}
        >
          {MODES.map((m) => {
            const active = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={active}
                className="cue-pressable"
                onClick={() => switchMode(m.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                  minWidth: 74,
                  padding: "12px 10px",
                  minHeight: 44,
                  borderRadius: 16,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  background: active
                    ? "color-mix(in srgb, var(--mv3-accent) 18%, transparent)"
                    : "var(--mv3-btn2-bg)",
                  border: active
                    ? "1px solid color-mix(in srgb, var(--mv3-ring-active) 50%, transparent)"
                    : "1px solid var(--mv3-btn2-border)",
                  color: active ? "var(--mv3-micro)" : "var(--mv3-muted)",
                }}
              >
                {m.glyph}
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: active ? 600 : 400,
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Quick starts — the desktop mode's prefilled prompt cards. */}
        {quickStarts.length > 0 ? (
          <>
            <StripCaption>Quick starts</StripCaption>
            <div style={{ ...H_SCROLL, gap: 9 }}>
              {quickStarts.map((t) => {
                const selected = prompt === t.prompt;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className="cue-pressable"
                    aria-pressed={selected}
                    onClick={() => {
                      haptic.light();
                      setPrompt(t.prompt);
                    }}
                    style={{
                      flexShrink: 0,
                      width: 196,
                      minHeight: 62,
                      textAlign: "left",
                      borderRadius: 14,
                      padding: "10px 12px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      background: selected
                        ? "color-mix(in srgb, var(--mv3-accent) 12%, var(--mv3-card))"
                        : "var(--mv3-card)",
                      border: selected
                        ? "1.5px solid var(--mv3-accent)"
                        : "1px solid var(--mv3-card-border)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "var(--mv3-text)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {t.title}
                    </div>
                    <div
                      style={{
                        fontSize: 10.5,
                        lineHeight: 1.35,
                        marginTop: 3,
                        color: "var(--mv3-muted)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {t.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {/* Fill & build — form templates (frame 33): tap → fielded sheet. */}
        {formPicks.length > 0 ? (
          <>
            <StripCaption>Fill &amp; build</StripCaption>
            <div style={{ ...H_SCROLL, gap: 9 }}>
              {formPicks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="cue-pressable"
                  onClick={() => {
                    haptic.light();
                    setFormTemplate(t);
                  }}
                  style={{
                    flexShrink: 0,
                    width: 196,
                    minHeight: 62,
                    textAlign: "left",
                    borderRadius: 14,
                    padding: "10px 12px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    background: "var(--mv3-card)",
                    border: "1px solid var(--mv3-card-border)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "var(--mv3-text)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {t.title}
                    </span>
                    <span
                      aria-hidden
                      style={{ fontSize: 12, color: "var(--mv3-micro)" }}
                    >
                      ›
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      lineHeight: 1.35,
                      marginTop: 3,
                      color: "var(--mv3-muted)",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {/* Slides gallery controls — the desktop overlay's tabs + search. */}
        {mode === "slides" ? (
          <>
            <StripCaption>Templates</StripCaption>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "var(--mv3-btn2-bg)",
                border: "1px solid var(--mv3-btn2-border)",
                borderRadius: 13,
                padding: "0 12px",
              }}
            >
              <svg
                {...GLYPH}
                width={15}
                height={15}
                aria-hidden
                style={{ flexShrink: 0, color: "var(--mv3-muted)" }}
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20.5 20.5L16 16" />
              </svg>
              <input
                value={slidesSearch}
                onChange={(e) => setSlidesSearch(e.target.value)}
                placeholder="Search templates"
                aria-label="Search templates"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 16,
                  padding: "11px 0",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--mv3-text)",
                  fontFamily: "inherit",
                }}
              />
            </div>
            <div style={{ ...H_SCROLL, gap: 7, marginTop: 9 }}>
              {SLIDES_CATEGORIES.map((cat) => {
                const active = cat.id === slidesCategory;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    className="cue-pressable"
                    aria-pressed={active}
                    onClick={() => {
                      haptic.light();
                      setSlidesCategory(cat.id);
                    }}
                    style={{
                      flexShrink: 0,
                      minHeight: 40,
                      padding: "10px 15px",
                      borderRadius: 99,
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      whiteSpace: "nowrap",
                      background: active
                        ? "color-mix(in srgb, var(--mv3-accent) 18%, transparent)"
                        : "var(--mv3-btn2-bg)",
                      border: active
                        ? "1px solid color-mix(in srgb, var(--mv3-ring-active) 50%, transparent)"
                        : "1px solid var(--mv3-btn2-border)",
                      color: active ? "var(--mv3-micro)" : "var(--mv3-muted)",
                    }}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </>
        ) : mode === "video" ? (
          /* Frame 35 — Live-action / Animated segmented sub-tabs. */
          <div
            role="tablist"
            aria-label="Video style kind"
            style={{
              display: "flex",
              gap: 4,
              background: "var(--mv3-track)",
              borderRadius: 12,
              padding: 4,
              marginTop: 15,
            }}
          >
            {VIDEO_SUBTABS.map((seg) => {
              const active = seg.id === videoTab;
              return (
                <button
                  key={seg.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="cue-pressable"
                  onClick={() => {
                    haptic.light();
                    setVideoTab(seg.id);
                    // A pick hidden by the new tab no longer applies.
                    setPickId((prev) =>
                      prev &&
                      VIDEO_STYLE_SPECS.find((s) => s.id === prev)
                        ?.videoKind !== seg.id
                        ? null
                        : prev,
                    );
                  }}
                  style={{
                    flex: 1,
                    minHeight: 40,
                    textAlign: "center",
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 400,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    color: active ? "#ffffff" : "var(--mv3-muted)",
                    background: active
                      ? "linear-gradient(160deg, #4E7CEC, #3560CC)"
                      : "transparent",
                    border: "none",
                    borderRadius: 9,
                    padding: "8px 0",
                  }}
                >
                  {seg.label}
                </button>
              );
            })}
          </div>
        ) : STRIP_CAPTIONS[mode] ? (
          <StripCaption>{STRIP_CAPTIONS[mode]}</StripCaption>
        ) : null}

        {/* Template strip — horizontal scroll of the mode's real catalog. */}
        {strip.length > 0 ? (
          <div
            style={{
              ...H_SCROLL,
              gap: 9,
              marginTop: mode === "slides" ? 10 : mode === "video" ? 12 : 0,
            }}
          >
            {strip.map((pick) => {
              const selected = pick.id === pickId;
              return (
                <button
                  key={pick.id}
                  type="button"
                  className="cue-pressable"
                  aria-pressed={selected}
                  title={pick.description}
                  onClick={() => {
                    haptic.light();
                    setPickId((prev) => (prev === pick.id ? null : pick.id));
                  }}
                  style={{
                    flexShrink: 0,
                    width: 118,
                    borderRadius: 13,
                    overflow: "hidden",
                    padding: 0,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    background: "var(--mv3-card)",
                    border: selected
                      ? "1.5px solid var(--mv3-accent)"
                      : "1px solid var(--mv3-card-border)",
                    boxShadow: selected
                      ? "0 8px 20px -8px color-mix(in srgb, var(--mv3-accent) 50%, transparent)"
                      : "none",
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      position: "relative",
                      height: 66,
                      display: "grid",
                      placeItems: "center",
                      background: pick.thumbnail
                        ? `center / cover no-repeat url("${publicAsset(pick.thumbnail)}")`
                        : `linear-gradient(160deg, ${pick.swatch?.from ?? "#232C3D"}, ${pick.swatch?.to ?? "#141B27"})`,
                    }}
                  />
                  <div
                    style={{
                      fontSize: 10,
                      padding: "6px 9px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: selected ? "var(--mv3-micro)" : "var(--mv3-muted)",
                      background: selected
                        ? "color-mix(in srgb, var(--mv3-accent) 15%, transparent)"
                        : "transparent",
                    }}
                  >
                    {pick.label}
                    {selected ? " ✓" : ""}
                  </div>
                </button>
              );
            })}
          </div>
        ) : mode === "slides" ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--mv3-muted)",
              padding: "12px 2px 4px",
            }}
          >
            No templates match.
          </div>
        ) : null}

        {/* Canvas (frame 34) — image source + the 6 action tiles. */}
        {mode === "canvas" ? (
          <>
            <StripCaption>Image</StripCaption>
            <CanvasComposer
              image={canvasImage}
              tile={canvasTile}
              onImage={setCanvasImagePick}
              onClearImage={() => setCanvasImagePick(null)}
              onTile={setCanvasTile}
            />
          </>
        ) : null}

        {/* Reference (frame 36) — "make it look like this", one generation.
            Hidden on canvas, whose own image source owns that affordance. */}
        {mode !== "canvas" ? (
          <>
            <div
              style={{
                fontFamily: "var(--mv3-mono)",
                fontSize: 9.5,
                letterSpacing: "0.1em",
                color: "var(--mv3-muted)",
                marginTop: 16,
                marginBottom: 8,
                padding: "0 2px",
              }}
            >
              MAKE IT LOOK LIKE THIS
            </div>
            <SheetReferencePicker
              reference={reference}
              onReference={setReference}
              onClear={() => setReference(null)}
            />
          </>
        ) : null}

        {/* Brand chip + go. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 14,
            paddingBottom: 4,
          }}
        >
          {inBrand ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                flexShrink: 0,
                background:
                  "color-mix(in srgb, var(--mv3-green) 12%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--mv3-green) 35%, transparent)",
                borderRadius: 99,
                padding: "8px 13px",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 4,
                  background: `linear-gradient(135deg, ${brand?.palette?.primary ?? "#3D6EE8"}, ${brand?.palette?.accent ?? "#7F77DD"})`,
                }}
              />
              <span
                style={{
                  fontSize: 12,
                  color: "var(--mv3-green)",
                  fontWeight: 500,
                }}
              >
                In your brand ✓
              </span>
            </span>
          ) : null}
          <button
            type="button"
            className="cue-pressable"
            onClick={submit}
            style={{
              flex: 1,
              background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
              color: "#ffffff",
              border: "none",
              borderRadius: 15,
              padding: 14,
              minHeight: 48,
              fontSize: 15,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              boxShadow: "var(--mv3-primary-btn-shadow)",
            }}
          >
            {/* Selected canvas tile relabels the CTA (frame 34). */}
            {mode === "canvas" && canvasTile
              ? `${getCanvasTile(canvasTile).label} →`
              : "Create it →"}
            {reference && mode !== "canvas" ? (
              <span style={{ fontWeight: 400, opacity: 0.8 }}>
                {" "}
                1 reference riding
              </span>
            ) : null}
          </button>
        </div>
      </div>
    </SheetShell>
  );
}
