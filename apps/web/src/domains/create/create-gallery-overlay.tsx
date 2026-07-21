/**
 * Create Studio — the Gallery Overlay ("Pick a look").
 *
 * A per-mode picker that opens over the Create surface. The user browses REAL
 * templates / styles / formats (backed by studio-specs.ts), optionally toggles
 * "In your brand", and confirms — the selection rides back to the composer as a
 * `GallerySelection`, which the Create view compiles into a `CreateIntent` and
 * prepends to the seeded prompt via `applyCreateIntent()`.
 *
 * Per-mode variants (all share the same shell — header, escape hatch, brand
 * toggle, primary "Use …" button):
 *   - slides  → "Choose a template"      (category tabs + search + fidelity badge)
 *   - images  → "Choose a style"         (15 image styles)
 *   - video   → "Choose a style"         (6 video styles)
 *   - data    → "Output & chart types"   (1 format + multi-select charts)
 *   - docs    → "Choose a document"      (4 doc types w/ structural preview)
 *   - canvas  → "Choose an action"       (4 canvas actions)
 *
 * Desktop = centered modal grid. Mobile (`useIsMobile()`) = full-screen sheet,
 * 2 cols, sticky header + drag handle. Built to the approved mocks
 * (Cue-Create-Studio.html · SET 1) on the shared `--mv1-*` / `C.*` token system.
 */

import { Check, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  CANVAS_ACTION_SPECS,
  CHART_TYPE_SPECS,
  DATA_FORMAT_SPECS,
  DOC_TYPE_SPECS,
  IMAGE_STYLE_SPECS,
  TEMPLATE_SPECS,
  VIDEO_STYLE_SPECS,
  type CanvasActionGlyph,
  type StyleSpec,
  type TemplateFidelity,
  type TemplateSpec,
  type VideoStyleKind,
} from "@/domains/create/studio-specs";
import { publicAsset } from "@/utils/public-asset";

// -- Shared tokens (mirror create-view.tsx) ---------------------------------
const C = {
  ink: "var(--mv1-t1)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  line: "var(--mv1-line)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

const microLabel: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: C.t3,
};

// -- The selection returned to the composer ---------------------------------

/** The structured choice a user confirms in the gallery. */
export interface GallerySelection {
  /** Create mode this selection was made in. */
  mode: string;
  /** Resolves a TemplateSpec / DocTypeSpec (slides / docs). */
  templateId?: string;
  /** Resolves a StyleSpec (image / video). */
  styleId?: string;
  /** Data output format id (dashboard / report / sheet / slides). */
  formatId?: string;
  /** Data chart-type ids (multi-select). */
  chartTypes?: string[];
  /** Canvas action id. */
  actionId?: string;
  /** Human-facing label of the primary pick (for the composer chip). */
  label: string;
  /** Apply the active brand kit to the output. */
  inBrand: boolean;
}

/** Which gallery variant a mode renders. */
type GalleryKind = "slides" | "style" | "data" | "docs" | "canvas";

function galleryKind(mode: string): GalleryKind {
  switch (mode) {
    case "slides":
      return "slides";
    case "images":
    case "video":
      return "style";
    case "data":
      return "data";
    case "docs":
      return "docs";
    case "canvas":
      return "canvas";
    default:
      return "slides";
  }
}

/** Mode → gallery copy. */
const GALLERY_COPY: Record<
  GalleryKind,
  { title: string; subtitle: (mode: string) => string }
> = {
  slides: {
    title: "Choose a template",
    subtitle: () => "Your content, rendered in this design. 18 templates.",
  },
  style: {
    title: "Choose a style",
    subtitle: (mode) =>
      mode === "video" ? "Video · 6 styles" : "Image · 15 styles",
  },
  data: {
    title: "Output & chart types",
    subtitle: () => "Data · pick a format, then charts",
  },
  docs: {
    title: "Choose a document",
    subtitle: () => "Docs · structural preview",
  },
  canvas: {
    title: "Choose an action",
    subtitle: () => "Canvas · start a new surface",
  },
};

/** Slides category tabs, in the design's order. */
const SLIDE_CATEGORIES: {
  id: TemplateSpec["category"] | "all";
  label: string;
}[] = [
  { id: "all", label: `All ${TEMPLATE_SPECS.length}` },
  { id: "startup", label: "Pitch" },
  { id: "minimal", label: "Minimal" },
  { id: "editorial", label: "Editorial" },
  { id: "bold", label: "Bold" },
];

/** Video style tabs (SET-4 mock): All 6 / Live-action / Animated. */
const VIDEO_TABS: { id: VideoStyleKind | "all"; label: string }[] = [
  { id: "all", label: `All ${VIDEO_STYLE_SPECS.length}` },
  { id: "live", label: "Live-action" },
  { id: "animated", label: "Animated" },
];

// -- Small shared bits ------------------------------------------------------

/** Selected ✓ badge, top-right of a card. */
function SelectedBadge() {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 22,
        height: 22,
        borderRadius: 999,
        display: "grid",
        placeItems: "center",
        background: C.blue,
        color: "#fff",
        boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
      }}
    >
      <Check size={13} strokeWidth={3} />
    </span>
  );
}

/**
 * Round-4 frame 59 (mobile): EXACT / INSPIRED rides as a CORNER chip on the
 * thumbnail, never inline with the name. Fix rule applied: every chip gets an
 * opaque / blurred-glass background so it stays legible over any thumbnail
 * content (the mock's translucent INSPIRED chip vanished into title bars).
 */
const cornerChipBase: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 8.5,
  letterSpacing: "0.06em",
  borderRadius: 5,
  padding: "3px 7px",
  lineHeight: 1.3,
};

const cornerChipTones: Record<"exact" | "inspired", React.CSSProperties> = {
  exact: { background: "#F4F4F6", color: "#050508" },
  inspired: {
    background: "rgba(24,28,40,.88)",
    color: "#E7E7EE",
    border: "1px solid rgba(255,255,255,.16)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  },
};

function CornerFidelityBadge({
  fidelity,
  mode,
  onChange,
}: {
  fidelity: TemplateFidelity;
  mode: "exact" | "inspired";
  onChange: (m: "exact" | "inspired") => void;
}) {
  if (fidelity === "both") {
    // ONE corner chip (the frame's rule — never a wide toggle over the
    // thumbnail): it shows the active mode; tapping it flips exact/inspired
    // for the pick.
    const next = mode === "exact" ? "inspired" : "exact";
    return (
      <button
        type="button"
        aria-label={`Fidelity: ${mode}. Tap to switch to ${next}.`}
        onClick={(e) => {
          e.stopPropagation();
          onChange(next);
        }}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          ...cornerChipBase,
          ...cornerChipTones[mode],
          cursor: "pointer",
        }}
      >
        {mode === "exact" ? "EXACT" : "INSPIRED"}
      </button>
    );
  }
  return (
    <span
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        ...cornerChipBase,
        ...cornerChipTones[fidelity === "exact" ? "exact" : "inspired"],
      }}
    >
      {fidelity === "exact" ? "EXACT" : "INSPIRED"}
    </span>
  );
}

/** EXACT / INSPIRED fidelity badge. `both` renders an Exact | Inspired toggle. */
function FidelityBadge({
  fidelity,
  mode,
  onChange,
}: {
  fidelity: TemplateFidelity;
  mode: "exact" | "inspired";
  onChange: (m: "exact" | "inspired") => void;
}) {
  if (fidelity === "both") {
    return (
      <span
        style={{
          display: "inline-flex",
          borderRadius: 6,
          overflow: "hidden",
          border: `1px solid ${C.line}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {(["exact", "inspired"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            style={{
              ...microLabel,
              color: mode === m ? "#fff" : C.t3,
              background: mode === m ? C.blue : "transparent",
              border: "none",
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            {m === "exact" ? "EXACT" : "INSPIRED"}
          </button>
        ))}
      </span>
    );
  }
  return (
    <span style={{ ...microLabel, color: C.t3 }}>
      {fidelity === "exact" ? "EXACT" : "INSPIRED"}
    </span>
  );
}

// -- The overlay ------------------------------------------------------------

export interface CreateGalleryOverlayProps {
  /** The active Create mode (drives the variant). */
  mode: string;
  /** Whether an active Brand Kit exists (enables the "In your brand" toggle). */
  hasBrand: boolean;
  /**
   * The active brand's display name — labels the in-gallery live preview
   * ("previewing your content"). Optional; falls back to a neutral sample.
   */
  brandName?: string | null;
  /** Initial brand-toggle state. */
  initialInBrand?: boolean;
  /** Confirm — the picked selection rides back to the composer. */
  onConfirm: (selection: GallerySelection) => void;
  /** Escape hatch — "Take AI direction" (skip the gallery, let Cue choose). */
  onTakeAiDirection: () => void;
  /** Dismiss without picking. */
  onClose: () => void;
}

export function CreateGalleryOverlay({
  mode,
  hasBrand,
  brandName,
  initialInBrand = true,
  onConfirm,
  onTakeAiDirection,
  onClose,
}: CreateGalleryOverlayProps) {
  const isMobile = useIsMobile();
  const kind = galleryKind(mode);
  const copy = GALLERY_COPY[kind];

  const [inBrand, setInBrand] = useState(hasBrand && initialInBrand);

  // Escape dismisses the overlay — a modal dialog must be keyboard-closable,
  // not only via the backdrop / ✕ pointer targets.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // slides / style / docs / canvas — a single selected id.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // slides — per-template fidelity choice (for `both` templates).
  const [fidelityMode, setFidelityMode] = useState<"exact" | "inspired">(
    "exact",
  );
  // slides — category + search.
  const [category, setCategory] =
    useState<(typeof SLIDE_CATEGORIES)[number]["id"]>("all");
  const [search, setSearch] = useState("");
  // video — style sub-tab (All / Live-action / Animated).
  const [videoTab, setVideoTab] =
    useState<(typeof VIDEO_TABS)[number]["id"]>("all");
  // data — output format + multi-select charts.
  const [formatId, setFormatId] = useState<string>(DATA_FORMAT_SPECS[0].id);
  const [chartIds, setChartIds] = useState<string[]>(["bar", "line"]);

  const primaryLabel = usePrimaryLabel(kind, {
    selectedId,
    formatId,
    chartIds,
  });

  const canConfirm =
    kind === "data" ? true : selectedId !== null;

  function confirm() {
    if (!canConfirm) return;
    const base = { mode, inBrand, label: primaryLabel };
    if (kind === "slides") {
      onConfirm({ ...base, templateId: selectedId ?? undefined });
    } else if (kind === "style") {
      onConfirm({ ...base, styleId: selectedId ?? undefined });
    } else if (kind === "docs") {
      onConfirm({ ...base, templateId: selectedId ?? undefined });
    } else if (kind === "canvas") {
      onConfirm({ ...base, actionId: selectedId ?? undefined });
    } else {
      onConfirm({ ...base, formatId, chartTypes: chartIds });
    }
  }

  // -- Panel chrome ---------------------------------------------------------
  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        inset: 0,
        background: C.surface,
        display: "flex",
        flexDirection: "column",
        zIndex: 60,
      }
    : {
        width: "min(760px, 94vw)",
        maxHeight: "88vh",
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        boxShadow: "0 40px 120px -40px rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 24,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(2px)",
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}
    >
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* Mobile drag handle — the panel is full-screen (fixed inset:0), so
            it must clear the iOS status bar itself or the "Choose a template"
            header renders under the clock. */}
        {isMobile ? (
          <div
            style={{
              display: "grid",
              placeItems: "center",
              paddingTop:
                "calc(8px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
            }}
          >
            <span
              style={{
                width: 36,
                height: 4,
                borderRadius: 999,
                background: C.line,
              }}
            />
          </div>
        ) : null}

        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: isMobile ? "12px 16px 10px" : "18px 20px 14px",
            position: isMobile ? "sticky" : "static",
            top: 0,
            background: C.surface,
            borderBottom: isMobile ? `1px solid ${C.line}` : "none",
            zIndex: 2,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
              color: C.blueS,
              background: `color-mix(in srgb, ${C.blue} 14%, transparent)`,
            }}
          >
            ▤
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                fontFamily: serif,
                fontSize: 21,
                lineHeight: 1.1,
                color: C.t1,
              }}
            >
              {copy.title}
            </h2>
            <p style={{ marginTop: 2, fontSize: 12.5, color: C.t2 }}>
              {copy.subtitle(mode)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0,
              width: 30,
              height: 30,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              color: C.t2,
              background: "transparent",
              border: `1px solid ${C.line}`,
              cursor: "pointer",
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Slides: category tabs + search */}
        {kind === "slides" ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              padding: isMobile ? "10px 16px" : "0 20px 12px",
            }}
          >
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
              {SLIDE_CATEGORIES.map((cat) => {
                const active = cat.id === category;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setCategory(cat.id)}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      borderRadius: 999,
                      padding: "5px 12px",
                      cursor: "pointer",
                      border: `1px solid ${active ? "transparent" : C.line}`,
                      background: active ? C.t1 : "transparent",
                      color: active ? C.surface : C.t2,
                    }}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
            {!isMobile ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: 8,
                  border: `1px solid ${C.line}`,
                  padding: "6px 10px",
                  color: C.t3,
                  minWidth: 180,
                }}
              >
                <Search size={13} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search templates"
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: C.t1,
                    fontSize: 13,
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Video: style sub-tabs (All 6 / Live-action / Animated) */}
        {kind === "style" && mode === "video" ? (
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              padding: isMobile ? "10px 16px" : "0 20px 12px",
            }}
          >
            {VIDEO_TABS.map((tab) => {
              const active = tab.id === videoTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setVideoTab(tab.id)}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    borderRadius: 999,
                    padding: "5px 12px",
                    cursor: "pointer",
                    border: `1px solid ${active ? "transparent" : C.line}`,
                    background: active ? C.t1 : "transparent",
                    color: active ? C.surface : C.t2,
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Body (scroll region). Mobile reserves room for the pinned footer
            so the last row scrolls clear of the gradient fade. */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: isMobile
              ? "6px 16px calc(120px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))"
              : "4px 20px 18px",
          }}
        >
          {kind === "slides" ? (
            <SlidesGrid
              isMobile={isMobile}
              category={category}
              search={search}
              selectedId={selectedId}
              fidelityMode={fidelityMode}
              previewInBrand={inBrand}
              brandName={brandName ?? null}
              onSelect={setSelectedId}
              onFidelity={setFidelityMode}
            />
          ) : null}

          {kind === "style" ? (
            <StyleGrid
              isMobile={isMobile}
              styles={
                mode === "video"
                  ? VIDEO_STYLE_SPECS.filter(
                      (s) => videoTab === "all" || s.videoKind === videoTab,
                    )
                  : IMAGE_STYLE_SPECS
              }
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}

          {kind === "data" ? (
            <DataPicker
              formatId={formatId}
              chartIds={chartIds}
              onFormat={setFormatId}
              onToggleChart={(id) =>
                setChartIds((prev) =>
                  prev.includes(id)
                    ? prev.filter((c) => c !== id)
                    : [...prev, id],
                )
              }
            />
          ) : null}

          {kind === "docs" ? (
            <DocsGrid
              isMobile={isMobile}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}

          {kind === "canvas" ? (
            <CanvasGrid
              isMobile={isMobile}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}
        </div>

        {/* Footer — escape hatch · brand toggle · primary. MOBILE (frame 59):
            pinned over a gradient fade instead of a hairline, so the grid
            visibly scrolls beneath the always-legible "Use ‹name› →" CTA. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: isMobile
              ? "34px 16px calc(12px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))"
              : "14px 20px",
            ...(isMobile
              ? {
                  position: "absolute" as const,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  border: "none",
                  background: `linear-gradient(transparent, ${C.surface} 40%)`,
                  pointerEvents: "none" as const,
                }
              : {
                  borderTop: `1px solid ${C.line}`,
                  background: C.surface,
                }),
          }}
        >
          {/* pointer-events re-enable per control — the mobile footer shell
              is pointer-transparent so the fade never blocks grid taps. */}
          <button
            type="button"
            onClick={onTakeAiDirection}
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: C.blueS,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              whiteSpace: "nowrap",
              pointerEvents: "auto",
            }}
          >
            + Take AI direction →
          </button>
          {/* Desktop pushes the CTA right; on mobile the CTA itself flexes
              to fill the footer, so no spacer. */}
          {!isMobile ? <span style={{ flex: 1 }} /> : null}
          {hasBrand ? (
            <span style={{ pointerEvents: "auto", display: "inline-flex" }}>
              <BrandToggle
                on={inBrand}
                onChange={setInBrand}
                compact={isMobile}
              />
            </span>
          ) : null}
          <button
            type="button"
            onClick={confirm}
            disabled={!canConfirm}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              fontWeight: 600,
              color: "#fff",
              background: canConfirm ? C.blue : C.line,
              border: "none",
              borderRadius: 10,
              padding: "9px 15px",
              cursor: canConfirm ? "pointer" : "not-allowed",
              opacity: canConfirm ? 1 : 0.7,
              whiteSpace: "nowrap",
              // Long template names ellipsize INSIDE the label span below —
              // "Use" and "→" themselves never truncate. On mobile the CTA
              // takes all remaining footer width so ordinary names render in
              // full; only absurdly long ones ellipsize (frame 59).
              minWidth: 0,
              ...(isMobile ? { flex: 1, justifyContent: "center" } : { maxWidth: 320 }),
              pointerEvents: "auto",
            }}
          >
            <span style={{ flexShrink: 0 }}>Use</span>
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {primaryLabel}
            </span>
            <span style={{ flexShrink: 0 }}>→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "Use X →" label depends on the variant + current selection. */
function usePrimaryLabel(
  kind: GalleryKind,
  state: {
    selectedId: string | null;
    formatId: string;
    chartIds: string[];
  },
): string {
  return useMemo(() => {
    if (kind === "data") {
      const fmt = DATA_FORMAT_SPECS.find((f) => f.id === state.formatId);
      const n = state.chartIds.length;
      return `${fmt?.label ?? "Output"} · ${n} chart${n === 1 ? "" : "s"}`;
    }
    // Nothing picked yet → the kind noun ("Use template →"), never a bare
    // "Use … →" (UAT: the CTA read as truncated).
    if (!state.selectedId) {
      return kind === "slides"
        ? "template"
        : kind === "style"
          ? "style"
          : kind === "docs"
            ? "document"
            : "action";
    }
    if (kind === "slides") {
      return `"${TEMPLATE_SPECS.find((t) => t.id === state.selectedId)?.name ?? ""}"`;
    }
    if (kind === "style") {
      const s = [...IMAGE_STYLE_SPECS, ...VIDEO_STYLE_SPECS].find(
        (x) => x.id === state.selectedId,
      );
      return `"${s?.label ?? ""}"`;
    }
    if (kind === "docs") {
      return `"${DOC_TYPE_SPECS.find((d) => d.id === state.selectedId)?.name ?? ""}"`;
    }
    return `"${CANVAS_ACTION_SPECS.find((a) => a.id === state.selectedId)?.label ?? ""}"`;
  }, [kind, state.selectedId, state.formatId, state.chartIds]);
}

// -- Brand toggle -----------------------------------------------------------

function BrandToggle({
  on,
  onChange,
  compact,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12.5,
        color: on ? C.t1 : C.t3,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {!compact ? <span>In your brand</span> : null}
      <span
        aria-hidden
        style={{
          position: "relative",
          width: 34,
          height: 18,
          borderRadius: 999,
          background: on ? C.blue : C.line,
          transition: "background 120ms",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: 999,
            background: "#fff",
            transition: "left 120ms",
          }}
        />
      </span>
      {on ? <Check size={13} color={C.blueS} strokeWidth={3} /> : null}
    </button>
  );
}

// -- Grids ------------------------------------------------------------------

const gridStyle = (isMobile: boolean): React.CSSProperties => ({
  display: "grid",
  gridTemplateColumns: isMobile
    ? "repeat(2, 1fr)"
    : "repeat(3, minmax(0, 1fr))",
  gap: 12,
});

/** A card frame with selected state. */
function cardFrame(selected: boolean): React.CSSProperties {
  return {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    textAlign: "left",
    borderRadius: 12,
    overflow: "hidden",
    cursor: "pointer",
    background: C.sunken,
    border: `1.5px solid ${selected ? C.blue : C.line}`,
    boxShadow: selected
      ? `0 10px 30px -18px color-mix(in srgb, ${C.blue} 70%, transparent)`
      : "none",
    transition: "border-color 120ms, transform 120ms",
    padding: 0,
  };
}

function SlidesGrid({
  isMobile,
  category,
  search,
  selectedId,
  fidelityMode,
  previewInBrand,
  brandName,
  onSelect,
  onFidelity,
}: {
  isMobile: boolean;
  category: (typeof SLIDE_CATEGORIES)[number]["id"];
  search: string;
  selectedId: string | null;
  fidelityMode: "exact" | "inspired";
  previewInBrand: boolean;
  brandName: string | null;
  onSelect: (id: string) => void;
  onFidelity: (m: "exact" | "inspired") => void;
}) {
  const q = search.trim().toLowerCase();
  const items = TEMPLATE_SPECS.filter((t) => {
    const catOk = category === "all" || t.category === category;
    const searchOk =
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.bestFor.toLowerCase().includes(q);
    return catOk && searchOk;
  });

  if (items.length === 0) return <EmptyState />;

  return (
    <div style={gridStyle(isMobile)}>
      {items.map((t) => (
        <SlideCard
          key={t.id}
          template={t}
          isMobile={isMobile}
          selected={t.id === selectedId}
          fidelityMode={fidelityMode}
          previewInBrand={previewInBrand}
          brandName={brandName}
          onSelect={() => onSelect(t.id)}
          onFidelity={onFidelity}
        />
      ))}
    </div>
  );
}

/**
 * A single slides template card with the SET-4 live-preview interaction:
 * hover (desktop) / long-press (mobile) swaps the demo thumbnail for a
 * "your content in this template" preview — a representative in-brand slide
 * with a "previewing your content" pill — then swaps back on leave/release.
 * The swap is a cross-fade over a fixed-aspect frame, so there's no layout
 * shift and no per-user render is required.
 */
function SlideCard({
  template: t,
  isMobile,
  selected,
  fidelityMode,
  previewInBrand,
  brandName,
  onSelect,
  onFidelity,
}: {
  template: TemplateSpec;
  isMobile: boolean;
  selected: boolean;
  fidelityMode: "exact" | "inspired";
  previewInBrand: boolean;
  brandName: string | null;
  onSelect: () => void;
  onFidelity: (m: "exact" | "inspired") => void;
}) {
  const [preview, setPreview] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  // Mobile: a ~350ms press arms the preview; releasing/scrolling clears it.
  const onTouchStart = () => {
    clearPress();
    pressTimer.current = setTimeout(() => setPreview(true), 350);
  };
  const onTouchEnd = () => {
    clearPress();
    setPreview(false);
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={isMobile ? undefined : () => setPreview(true)}
      onMouseLeave={isMobile ? undefined : () => setPreview(false)}
      onTouchStart={isMobile ? onTouchStart : undefined}
      onTouchEnd={isMobile ? onTouchEnd : undefined}
      onTouchCancel={isMobile ? onTouchEnd : undefined}
      style={cardFrame(selected)}
    >
      {/* MOBILE (round-4 frame 59): selection reads as the blue border +
          glow + the footer CTA naming the pick; the check circle would
          collide with the corner fidelity chip. Desktop keeps it. */}
      {selected && !isMobile ? <SelectedBadge /> : null}
      {/* Media frame: demo thumb + preview cross-fade layered. Mobile is the
          frame-59 96px thumbnail; desktop keeps the 4:3 aspect frame. */}
      <span
        style={{
          position: "relative",
          display: "block",
          width: "100%",
          ...(isMobile ? { height: 96 } : { aspectRatio: "4 / 3" }),
          overflow: "hidden",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            // Anchor the crop TOP-LEFT: slide titles live there, so the crop
            // may only eat the right/bottom edges (frame 59 rule; the earlier
            // UAT fix anchored left, the 96px frame also needs top).
            background: `left top / cover no-repeat url("${publicAsset(t.thumbnail)}")`,
            opacity: preview ? 0 : 1,
            transition: "opacity 160ms ease",
          }}
        />
        <SlidePreview
          template={t}
          brandName={brandName}
          inBrand={previewInBrand}
          visible={preview}
        />
        {/* Corner mono badge (mobile) — opaque chip over any thumbnail. */}
        {isMobile ? (
          <CornerFidelityBadge
            fidelity={t.fidelity}
            mode={fidelityMode}
            onChange={onFidelity}
          />
        ) : null}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          padding: isMobile ? "9px 11px" : "8px 10px",
          // Desktop keeps the inline badge and lets it wrap under the name;
          // on mobile the name owns the full row (badge moved to the corner).
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: C.t1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t.name}
        </span>
        {!isMobile ? (
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            <FidelityBadge
              fidelity={t.fidelity}
              mode={fidelityMode}
              onChange={onFidelity}
            />
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The live-preview overlay — a lightweight "your content in this template"
 * mock rendered from the template's own palette/fonts (a representative
 * in-brand slide, not a real per-user render), with the "previewing your
 * content" pill. Cross-fades in over the demo thumbnail.
 */
function SlidePreview({
  template: t,
  brandName,
  inBrand,
  visible,
}: {
  template: TemplateSpec;
  brandName: string | null;
  inBrand: boolean;
  visible: boolean;
}) {
  const p = t.palette;
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        padding: 12,
        background: p.bg,
        color: p.text,
        fontFamily: t.fonts.heading,
        opacity: visible ? 1 : 0,
        transition: "opacity 160ms ease",
        pointerEvents: "none",
      }}
    >
      {/* "previewing your content" pill, top-left. */}
      <span
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontFamily: mono,
          fontSize: 8.5,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "#fff",
          background: "rgba(0,0,0,0.62)",
          borderRadius: 5,
          padding: "3px 6px",
        }}
      >
        ● Previewing your content
      </span>
      {/* Accent bar + a representative headline in the template's type. */}
      <span
        style={{
          display: "block",
          width: 26,
          height: 4,
          borderRadius: 999,
          background: p.accent,
          marginBottom: 8,
        }}
      />
      <span style={{ fontSize: 15, lineHeight: 1.1 }}>
        {inBrand && brandName ? `${brandName}: ` : ""}
        Raising our{" "}
        <span style={{ fontStyle: "italic", color: p.primary }}>Series A</span>
      </span>
    </span>
  );
}

function StyleGrid({
  isMobile,
  styles,
  selectedId,
  onSelect,
}: {
  isMobile: boolean;
  styles: StyleSpec[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={gridStyle(isMobile)}>
      {styles.map((s) => {
        const selected = s.id === selectedId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            style={cardFrame(selected)}
          >
            {selected ? <SelectedBadge /> : null}
            <span
              style={{
                display: "block",
                width: "100%",
                aspectRatio: "1 / 1",
                background: `center / cover no-repeat url("${publicAsset(s.thumbnail)}")`,
              }}
            />
            <span
              style={{
                display: "block",
                padding: "8px 10px",
                fontSize: 12.5,
                fontWeight: 600,
                color: C.t1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DocsGrid({
  isMobile,
  selectedId,
  onSelect,
}: {
  isMobile: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
        gap: 12,
      }}
    >
      {DOC_TYPE_SPECS.map((d) => {
        const selected = d.id === selectedId;
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => onSelect(d.id)}
            style={{ ...cardFrame(selected), flexDirection: "row", gap: 12, padding: 12 }}
          >
            {selected ? <SelectedBadge /> : null}
            {/* Structural preview — skeleton of the outline */}
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: 46,
                height: 58,
                borderRadius: 6,
                background: C.surface,
                border: `1px solid ${C.line}`,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: 7,
              }}
            >
              {d.outline.slice(0, 4).map((_, i) => (
                <span
                  key={i}
                  style={{
                    height: 4,
                    borderRadius: 2,
                    width: i === 0 ? "70%" : `${100 - i * 12}%`,
                    background: i === 0 ? C.blue : C.line,
                  }}
                />
              ))}
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.t1,
                }}
              >
                {d.name}
              </span>
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  fontSize: 11.5,
                  color: C.t2,
                  lineHeight: 1.35,
                }}
              >
                {d.outline.join(" · ")}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Small illustration for a canvas action tile (matches the SET-4 mock). */
function CanvasGlyph({ glyph }: { glyph: CanvasActionGlyph }) {
  const chip = (extra: React.CSSProperties) => ({
    display: "block",
    borderRadius: 5,
    ...extra,
  });
  if (glyph === "plus") {
    return (
      <span style={{ fontSize: 22, lineHeight: 1, color: C.blueS }} aria-hidden>
        +
      </span>
    );
  }
  if (glyph === "edit") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} aria-hidden>
        <span
          style={chip({
            width: 18,
            height: 14,
            border: `1.5px dashed ${C.t3}`,
            background: "transparent",
          })}
        />
        <span style={chip({ width: 18, height: 14, background: C.blue })} />
      </span>
    );
  }
  if (glyph === "upscale") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} aria-hidden>
        <span style={chip({ width: 12, height: 10, background: C.line })} />
        <span
          style={{ fontSize: 12, color: C.t3, fontFamily: mono }}
        >
          →
        </span>
        <span style={chip({ width: 20, height: 16, background: C.blue })} />
      </span>
    );
  }
  // cutout — subject onto transparency (checkerboard hint + orange subject)
  return (
    <span
      style={{
        display: "block",
        width: 30,
        height: 20,
        borderRadius: 5,
        position: "relative",
        background:
          "repeating-conic-gradient(color-mix(in srgb, currentColor 12%, transparent) 0% 25%, transparent 0% 50%) 0 / 8px 8px",
        color: C.t3,
      }}
      aria-hidden
    >
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 12,
          height: 12,
          borderRadius: 999,
          background: "#e08a3c",
        }}
      />
    </span>
  );
}

function CanvasGrid({
  isMobile,
  selectedId,
  onSelect,
}: {
  isMobile: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [first, ...rest] = CANVAS_ACTION_SPECS;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
        gap: 12,
      }}
    >
      {/* "Create new" — featured tile: centered glyph, primary path. */}
      <button
        key={first.id}
        type="button"
        onClick={() => onSelect(first.id)}
        style={{
          ...cardFrame(first.id === selectedId),
          padding: 16,
          minHeight: isMobile ? 120 : 172,
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          gap: 6,
          background:
            first.id === selectedId
              ? `color-mix(in srgb, ${C.blue} 8%, ${C.sunken})`
              : C.sunken,
        }}
      >
        {first.id === selectedId ? <SelectedBadge /> : null}
        <CanvasGlyph glyph={first.glyph} />
        <span style={{ fontSize: 14, fontWeight: 600, color: C.t1, marginTop: 6 }}>
          {first.label}
        </span>
        <span
          style={{
            fontSize: 12,
            color: C.t2,
            lineHeight: 1.4,
            maxWidth: 180,
          }}
        >
          {first.description}
        </span>
      </button>

      {/* The three secondary actions, stacked in the right column. */}
      <div style={{ display: "grid", gap: 12, gridTemplateRows: "repeat(3, 1fr)" }}>
        {rest.map((a) => {
          const selected = a.id === selectedId;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              style={{
                ...cardFrame(selected),
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                padding: 12,
              }}
            >
              {selected ? <SelectedBadge /> : null}
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 46,
                  height: 40,
                  borderRadius: 8,
                  background: C.surface,
                  border: `1px solid ${C.line}`,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <CanvasGlyph glyph={a.glyph} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: C.t1,
                  }}
                >
                  {a.label}
                </span>
                <span
                  style={{
                    display: "block",
                    marginTop: 2,
                    fontSize: 11.5,
                    color: C.t2,
                    lineHeight: 1.35,
                  }}
                >
                  {a.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DataPicker({
  formatId,
  chartIds,
  onFormat,
  onToggleChart,
}: {
  formatId: string;
  chartIds: string[];
  onFormat: (id: string) => void;
  onToggleChart: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={{ ...microLabel, marginBottom: 8 }}>Output format</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
          }}
        >
          {DATA_FORMAT_SPECS.map((f) => {
            const active = f.id === formatId;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onFormat(f.id)}
                title={f.description}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 9,
                  padding: "10px 8px",
                  cursor: "pointer",
                  color: active ? "#fff" : C.t2,
                  background: active ? C.blue : "transparent",
                  border: `1.5px solid ${active ? "transparent" : C.line}`,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div style={{ ...microLabel, marginBottom: 8 }}>
          Chart types · multi-select
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 8,
          }}
        >
          {CHART_TYPE_SPECS.map((c) => {
            const on = chartIds.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onToggleChart(c.id)}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  minHeight: 64,
                  borderRadius: 10,
                  cursor: "pointer",
                  color: on ? C.t1 : C.t2,
                  background: on
                    ? `color-mix(in srgb, ${C.blue} 12%, transparent)`
                    : C.sunken,
                  border: `1.5px solid ${on ? C.blue : C.line}`,
                }}
              >
                {c.label}
                {on ? (
                  <Check size={13} color={C.blueS} strokeWidth={3} />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        padding: "48px 0",
        color: C.t3,
        fontSize: 13,
        textAlign: "center",
      }}
    >
      No match · clear the filter
    </div>
  );
}
