/**
 * Create Studio — 4g STRETCH · "Multi-format fan-out".
 *
 * One brief → a coordinated asset kit. Two surfaces:
 *
 *   1. **AlsoMakeChooser** — a multi-select of downstream formats (Deck ·
 *      One-pager · Social set · Doc · Email · Landing). The source format is
 *      marked; picking others produces a "Kit: deck +N" intent. On confirm the
 *      host fires one seeded generation per picked format (buildFanoutPrompts).
 *   2. **KitResultView** — the produced kit shown together, per-asset
 *      "regenerate" + a "Download all", all in-brand.
 *
 * Badged as a LATER-PHASE capability: firing N independent generations yields
 * coordinated-BY-brand assets, but true single-pass kit orchestration (one run
 * emitting the whole set off a shared content spine) needs a backend kit
 * endpoint that does not exist yet. The UI is built; the deep orchestration is
 * a TODO (see create-remix.buildFanoutPrompts + the KitResultView note).
 */

import { useState } from "react";
import { Check, Download, RefreshCw, Sparkles } from "lucide-react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { FANOUT_FORMATS, type FanoutFormat } from "@/domains/create/create-remix";

const C = {
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  line: "var(--mv1-line)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  amber: "var(--mv1-amber, #E6A23C)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

/** "LATER PHASE" badge — flags the stretch capability. */
export function LaterPhaseBadge() {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "#0B0E13",
        background: C.amber,
        borderRadius: 6,
        padding: "3px 8px",
        fontWeight: 600,
      }}
    >
      Stretch · later phase
    </span>
  );
}

/** The chip a confirmed fan-out selection parks as ("Kit: deck +2"). */
export function fanoutChipLabel(formatIds: string[]): string {
  const extras = formatIds.filter((id) => id !== "slides").length;
  return extras > 0 ? `Kit: deck +${extras}` : "Kit: deck";
}

// ---------------------------------------------------------------------------
// 1 · Also-make chooser
// ---------------------------------------------------------------------------

export interface AlsoMakeChooserProps {
  /** The source format id already produced (marked, non-deselectable). */
  sourceFormatId?: string;
  /** Fire the fan-out for the selected (extra) formats. */
  onGenerate: (formatIds: string[]) => void;
}

/**
 * The "From this brief, also make" multi-select. The source format is preset +
 * locked; the rest toggle. "Generate N assets" fires the picked extras.
 */
export function AlsoMakeChooser({
  sourceFormatId = "slides",
  onGenerate,
}: AlsoMakeChooserProps) {
  const isMobile = useIsMobile();
  // Default-pick the first two non-source formats to match the mock (one-pager
  // + social), but the user drives it from there.
  const [picked, setPicked] = useState<Set<string>>(() => {
    const extras = FANOUT_FORMATS.filter((f) => f.id !== sourceFormatId).slice(
      0,
      2,
    );
    return new Set(extras.map((f) => f.id));
  });

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const count = picked.size;

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        overflow: "hidden",
        width: isMobile ? "100%" : 320,
      }}
    >
      <div style={{ padding: "18px 20px", borderBottom: `1px solid ${C.line}` }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.t3,
          }}
        >
          Also make…
        </div>
        <div
          style={{ fontFamily: serif, fontSize: 19, color: C.t1, marginTop: 6 }}
        >
          From this brief, also make
        </div>
        <div style={{ fontSize: 11.5, color: C.t3, marginTop: 2 }}>
          All in your brand, produced together.
        </div>
      </div>

      <div
        style={{
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        {FANOUT_FORMATS.map((fmt) => {
          const isSource = fmt.id === sourceFormatId;
          const on = isSource || picked.has(fmt.id);
          return (
            <FormatRow
              key={fmt.id}
              fmt={fmt}
              on={on}
              isSource={isSource}
              onToggle={() => (isSource ? undefined : toggle(fmt.id))}
            />
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 20px",
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span style={{ fontSize: 12, color: C.t3 }}>{count} selected</span>
        <button
          type="button"
          onClick={() => onGenerate([...picked])}
          disabled={count === 0}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: "#fff",
            background: count === 0 ? C.line : C.blue,
            border: "none",
            borderRadius: 10,
            padding: "9px 15px",
            cursor: count === 0 ? "not-allowed" : "pointer",
            opacity: count === 0 ? 0.7 : 1,
          }}
        >
          <Sparkles size={14} />
          Generate {count} asset{count === 1 ? "" : "s"} →
        </button>
      </div>
    </div>
  );
}

function FormatRow({
  fmt,
  on,
  isSource,
  onToggle,
}: {
  fmt: FanoutFormat;
  on: boolean;
  isSource: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isSource}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${on ? C.blue : C.line}`,
        background: on
          ? `color-mix(in srgb, ${C.blue} 8%, transparent)`
          : "transparent",
        cursor: isSource ? "default" : "pointer",
        textAlign: "left",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: 20,
          height: 20,
          borderRadius: 6,
          background: on ? C.blue : "transparent",
          border: on ? "none" : `1px solid ${C.line}`,
          color: "#fff",
          flexShrink: 0,
        }}
      >
        {on ? <Check size={13} /> : null}
      </span>
      <span aria-hidden style={{ color: on ? C.blueS : C.t3, fontSize: 14 }}>
        {fmt.glyph}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: on ? 600 : 500,
          color: on ? C.t1 : C.t2,
        }}
      >
        {fmt.label}
      </span>
      {isSource ? (
        <span style={{ fontSize: 11, color: C.t3 }}>source</span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 2 · Kit result view
// ---------------------------------------------------------------------------

/** One produced asset in the kit. */
export interface KitAsset {
  id: string;
  /** Display label ("Deck · 12 slides", "One-pager"). */
  label: string;
  /** Rendered preview node (host injects the real artifact), else placeholder. */
  preview?: React.ReactNode;
  /** Whether this asset is a set (renders a mini-row of tiles + "regenerate one"). */
  isSet?: boolean;
  /** Set size, when isSet (drives placeholder tile count). */
  setSize?: number;
}

export interface KitResultViewProps {
  /** Kit name ("Series A launch kit"). */
  title: string;
  /** The produced assets. */
  assets: KitAsset[];
  /** Regenerate a single asset without touching the rest. */
  onRegenerateAsset: (assetId: string) => void;
  /** Download the whole kit. */
  onDownloadAll: () => void;
}

function KitPlaceholder({ label }: { label: string }) {
  return (
    <div
      style={{
        aspectRatio: "16 / 10",
        borderRadius: 8,
        background: `linear-gradient(135deg, color-mix(in srgb, ${C.blue} 12%, ${C.sunken}), ${C.sunken})`,
        display: "grid",
        placeItems: "center",
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: C.t3,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function KitAssetCard({
  asset,
  onRegenerate,
}: {
  asset: KitAsset;
  onRegenerate: () => void;
}) {
  return (
    <div
      style={{
        borderRadius: 12,
        overflow: "hidden",
        border: `1px solid ${C.line}`,
        background: C.surface,
      }}
    >
      <div style={{ padding: 12 }}>
        {asset.isSet ? (
          <div style={{ display: "flex", gap: 8 }}>
            {Array.from({ length: asset.setSize ?? 3 }).map((_, i) => (
              <div key={i} style={{ flex: 1 }}>
                <KitPlaceholder label={`${i + 1}`} />
              </div>
            ))}
          </div>
        ) : (
          (asset.preview ?? <KitPlaceholder label={asset.label} />)
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 12px",
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: C.t1 }}>
          {asset.label}
        </span>
        <button
          type="button"
          onClick={onRegenerate}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12,
            color: C.t3,
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={12} />
          {asset.isSet ? "regenerate one" : "regenerate"}
        </button>
      </div>
    </div>
  );
}

/**
 * The produced kit, shown together. Per-asset regenerate keeps the rest intact.
 *
 * TODO(kit-orchestration): today each asset is an independent seeded generation
 * (coordinated only by shared brand). A real "launch kit" wants one backend run
 * that emits the whole set off a shared content spine so headline/messaging
 * stay consistent across formats, and "regenerate one" re-derives from that
 * spine. That endpoint does not exist yet — this view renders the honest
 * approximation and is the seam to upgrade when it lands.
 */
export function KitResultView({
  title,
  assets,
  onRegenerateAsset,
  onDownloadAll,
}: KitResultViewProps) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: isMobile ? "18px 18px 0 0" : 18,
        overflow: "hidden",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: isMobile ? "14px 16px" : "16px 22px",
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            borderRadius: 8,
            background: `color-mix(in srgb, ${C.blue} 12%, transparent)`,
            color: C.blueS,
            flexShrink: 0,
          }}
        >
          <Sparkles size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: C.t3 }}>
            {assets.length} assets · produced together · in your brand
          </div>
        </div>
        <span
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--mv1-green-strong, #17936B)",
            background: "color-mix(in srgb, var(--mv1-green, #17936B) 14%, transparent)",
            borderRadius: 6,
            padding: "3px 8px",
            whiteSpace: "nowrap",
          }}
        >
          In your brand ✓
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr",
          gap: 16,
          padding: isMobile ? 16 : 22,
        }}
      >
        {assets.map((asset) => (
          <div
            key={asset.id}
            style={{ gridColumn: asset.isSet && !isMobile ? "1 / -1" : "auto" }}
          >
            <KitAssetCard
              asset={asset}
              onRegenerate={() => onRegenerateAsset(asset.id)}
            />
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "12px 16px 16px" : "14px 22px",
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span style={{ fontSize: 12, color: C.t3 }}>
          Regenerate any one asset without touching the rest
        </span>
        <button
          type="button"
          onClick={onDownloadAll}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 600,
            color: "#fff",
            background: C.blue,
            border: "none",
            borderRadius: 10,
            padding: "9px 15px",
            cursor: "pointer",
          }}
        >
          <Download size={14} />
          Download all
        </button>
      </div>
    </div>
  );
}
