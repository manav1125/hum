/**
 * Create sheet — the mobile v3 "+" surface (spec frame 7): a SheetShell lifted
 * over the CURRENT screen instead of a navigation. Prompt first, mode chips
 * (Slides / Doc / Image / Data), a template strip reusing the existing
 * template data, "Create it →" submitting through the EXISTING create/run
 * flow (draft conversation seeded with `?prompt=`, design contract compiled
 * by `applyCreateIntent`, provenance stamped) — then dismiss + a success tick.
 *
 * The full /assistant/create page keeps working for desktop and as fallback;
 * this sheet is only mounted by the mobile tab bar's "+".
 *
 * Brand: "In your brand ✓" renders ONLY when a real active Brand Kit exists
 * (useActiveBrand); the brand-matched template pick (nearest palette primary)
 * is then pre-selected. No brand → no chip, no fake pre-selection.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { SheetShell } from "@/mobile-v3";
import { useConversationStore } from "@/stores/conversation-store";
import { useCreateProvenanceStore } from "@/stores/create-provenance-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { publicAsset } from "@/utils/public-asset";
import { routes } from "@/utils/routes";

import { applyCreateIntent, type CreateIntent } from "./create-intent";
import {
  DATA_FORMAT_SPECS,
  DOC_TYPE_SPECS,
  IMAGE_STYLE_SPECS,
  TEMPLATE_SPECS,
} from "./studio-specs";
import { useActiveBrand } from "./use-active-brand";

/* ------------------------------------------------------------------------- */
/* Mode chips — the sheet's four (spec frame 7), mapped to existing modes.   */
/* ------------------------------------------------------------------------- */

type SheetModeId = "slides" | "docs" | "images" | "data";

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
  ];

/* ------------------------------------------------------------------------- */
/* Template strip data — reuses the existing spec catalogs per mode.         */
/* ------------------------------------------------------------------------- */

interface StripPick {
  id: string;
  label: string;
  /** Thumbnail image (publicAsset path) when the catalog carries one. */
  thumbnail?: string;
  /** Fallback swatch when there is no image (docs / data). */
  swatch?: { from: string; to: string };
}

function stripForMode(mode: SheetModeId): StripPick[] {
  switch (mode) {
    case "slides":
      return TEMPLATE_SPECS.map((t) => ({
        id: t.id,
        label: t.name,
        thumbnail: t.thumbnail,
        swatch: { from: t.palette.primary, to: t.palette.bg },
      }));
    case "docs":
      return DOC_TYPE_SPECS.map((d) => ({
        id: d.id,
        label: d.name,
        swatch: { from: "#232C3D", to: "#141B27" },
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
      }));
  }
}

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
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<SheetModeId>("slides");
  const [pickId, setPickId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const brandPick = useMemo(
    () => (mode === "slides" ? brandMatchedTemplateId(brand?.palette?.primary) : null),
    [mode, brand],
  );
  // Brand-matched pick leads the strip (frame 7 shows the pre-selected pick
  // first); the rest keep catalog order.
  const strip = useMemo(() => {
    const picks = stripForMode(mode);
    if (!brandPick) return picks;
    return [
      ...picks.filter((p) => p.id === brandPick),
      ...picks.filter((p) => p.id !== brandPick),
    ];
  }, [mode, brandPick]);

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
    }
  }, [open]);

  const inBrand = Boolean(brand) && mode === "slides" && pickId === brandPick;

  const submit = () => {
    const text = prompt.trim();
    if (!text) {
      inputRef.current?.focus();
      return;
    }
    // Same seeding path as CreatePage.handleRunPrompt — draft conversation,
    // provenance stamp, navigate with ?prompt= (auto-sent by the chat route).
    const intent: CreateIntent = {
      mode,
      ...(mode === "slides" || mode === "docs"
        ? { templateId: pickId ?? undefined }
        : {}),
      ...(mode === "images" ? { styleId: pickId ?? undefined } : {}),
      ...(mode === "data" ? { formatId: pickId ?? undefined } : {}),
      brandKitId: inBrand ? (brand?.id ?? null) : null,
    };
    const finalPrompt = applyCreateIntent(text, intent, inBrand ? brand : null);
    useViewerStore.getState().setMainView("chat");
    const id = newDraftConversationId();
    useConversationStore.getState().setActiveConversationId(id);
    useCreateProvenanceStore.getState().stampIntent(id, intent);
    haptic.success();
    onClose();
    void navigate(
      `${routes.conversation(id)}?prompt=${encodeURIComponent(finalPrompt)}`,
    );
  };

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
            placeholder="Deck for the renewal call…"
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

        {/* Mode chips. */}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {MODES.map((m) => {
            const active = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                className="cue-pressable"
                aria-pressed={active}
                onClick={() => {
                  haptic.light();
                  setMode(m.id);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  flex: 1,
                  padding: "12px 0",
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
                  }}
                >
                  {m.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Template strip — horizontal scroll of the mode's real catalog. */}
        <div
          style={{
            display: "flex",
            gap: 9,
            marginTop: 14,
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
            margin: "14px -2px 0",
            padding: "0 2px",
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
                    height: 66,
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
            Create it →
          </button>
        </div>
      </div>
    </SheetShell>
  );
}
