/**
 * Create Studio — 4e · "Make variations · the result".
 *
 * A 4-up grid of alternates generated from one asset. Each is selectable; the
 * bottom bar offers **Merge selected** (combine picks) and **Pick this →**
 * (promote the single selected variation to the canonical asset). Desktop is a
 * 2×2 grid panel; mobile is a bottom sheet (per the 4e mock).
 *
 * Wiring: the parent fires N seeded generations (buildVariationPrompts) and
 * feeds their results in as `variations`. Selecting + Pick/Merge re-seeds the
 * conversation via the host callbacks. Rendering each variation's real artifact
 * requires the same iframe/app host the deck viewer uses — that lives outside
 * this domain, so a variation MAY carry a `thumbnail` node the host injects;
 * absent that, we render a labelled placeholder tile (clearly the design's
 * demo-content treatment, not a fake result).
 */

import { useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";

import { useIsMobile } from "@/hooks/use-is-mobile";

const C = {
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

/** One generated variation shown in the grid. */
export interface VariationResult {
  /** 1-based index (→ "Variation N"). */
  index: number;
  /** Short axis descriptor, e.g. "centered", "dark". */
  variant: string;
  /**
   * A rendered preview node for this variation (the host injects the real
   * artifact thumbnail — an iframe or image). When omitted, a placeholder tile
   * renders in its place.
   */
  preview?: React.ReactNode;
}

export interface VariationsResultProps {
  /** Asset name for the header ("Series A cover · Startup template"). */
  title: string;
  /** Sub-line under the title (context: template · brand). */
  subtitle?: string;
  /** The generated variations (typically 4). */
  variations: VariationResult[];
  /** Re-fire all variations. */
  onRegenerateAll: () => void;
  /**
   * Promote the single selected variation to the canonical asset. Receives the
   * chosen variation's index.
   */
  onPick: (index: number) => void;
  /**
   * Merge the selected variations into one refined asset. Receives all selected
   * indexes (≥ 2). No dedicated merge endpoint exists yet — the host re-seeds a
   * "merge variation N and M" instruction (buildMergePrompt); see create-remix.
   */
  onMerge: (indexes: number[]) => void;
}

/** Placeholder artifact tile — the design's "demo content" treatment. */
function PlaceholderTile({ variant }: { variant: string }) {
  return (
    <div
      style={{
        aspectRatio: "16 / 10",
        borderRadius: 8,
        background: `linear-gradient(135deg, color-mix(in srgb, ${C.blue} 14%, ${C.sunken}), ${C.sunken})`,
        display: "grid",
        placeItems: "center",
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: C.t3,
        }}
      >
        {variant}
      </span>
    </div>
  );
}

/** A single selectable variation card. */
function VariationCard({
  v,
  selected,
  onToggle,
}: {
  v: VariationResult;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 0,
        padding: 0,
        borderRadius: 12,
        overflow: "hidden",
        border: `1.5px solid ${selected ? C.blue : C.line}`,
        background: C.surface,
        cursor: "pointer",
        textAlign: "left",
        boxShadow: selected
          ? `0 14px 34px -22px color-mix(in srgb, ${C.blue} 60%, transparent)`
          : "none",
      }}
    >
      {/* selection dot */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          width: 20,
          height: 20,
          borderRadius: 999,
          display: "grid",
          placeItems: "center",
          background: selected ? C.blue : "rgba(0,0,0,0.28)",
          border: selected ? "none" : `1px solid ${C.line}`,
          color: "#fff",
          zIndex: 2,
        }}
      >
        {selected ? <Check size={13} /> : null}
      </span>
      <div style={{ padding: 12 }}>
        {v.preview ?? <PlaceholderTile variant={v.variant} />}
      </div>
      <div
        style={{
          padding: "8px 12px",
          borderTop: `1px solid ${C.line}`,
          fontSize: 12,
          color: selected ? C.blueS : C.t3,
          fontWeight: selected ? 600 : 500,
        }}
      >
        Variation {v.index} · {selected ? "selected" : v.variant}
      </div>
    </button>
  );
}

/** Bottom action bar: N selected · Merge selected · Pick this →. */
function ActionBar({
  selectedCount,
  canMerge,
  onMerge,
  onPick,
  compact,
}: {
  selectedCount: number;
  canMerge: boolean;
  onMerge: () => void;
  onPick: () => void;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: compact ? "12px 16px 4px" : "14px 22px",
        borderTop: `1px solid ${C.line}`,
      }}
    >
      {!compact ? (
        <span style={{ fontSize: 12, color: C.t3 }}>
          {selectedCount} selected
        </span>
      ) : null}
      <button
        type="button"
        onClick={onMerge}
        disabled={!canMerge}
        style={{
          marginLeft: compact ? 0 : "auto",
          flex: compact ? 1 : undefined,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          fontSize: 13,
          fontWeight: 600,
          color: canMerge ? C.t1 : C.t3,
          background: C.sunken,
          border: `1px solid ${C.line}`,
          borderRadius: 10,
          padding: "9px 14px",
          cursor: canMerge ? "pointer" : "not-allowed",
          opacity: canMerge ? 1 : 0.65,
        }}
      >
        <Copy size={14} />
        {compact ? "Merge" : "Merge selected"}
      </button>
      <button
        type="button"
        onClick={onPick}
        disabled={selectedCount === 0}
        style={{
          flex: compact ? 1 : undefined,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          color: "#fff",
          background: selectedCount === 0 ? C.line : C.blue,
          border: "none",
          borderRadius: 10,
          padding: "9px 16px",
          cursor: selectedCount === 0 ? "not-allowed" : "pointer",
          opacity: selectedCount === 0 ? 0.7 : 1,
        }}
      >
        Pick this →
      </button>
    </div>
  );
}

/**
 * The 4e Make-variations result. Multi-select the alternates, then Merge or
 * Pick. "Pick this" promotes the last-selected variation; "Merge" needs ≥ 2.
 */
export function VariationsResult({
  title,
  subtitle,
  variations,
  onRegenerateAll,
  onPick,
  onMerge,
}: VariationsResultProps) {
  const isMobile = useIsMobile();
  // Selection is ordered so "Pick this" can resolve a single primary choice.
  const [selected, setSelected] = useState<number[]>(
    variations.length ? [variations[0].index] : [],
  );

  const toggle = (index: number) =>
    setSelected((prev) =>
      prev.includes(index)
        ? prev.filter((i) => i !== index)
        : [...prev, index],
    );

  const doPick = () => {
    const pick = selected.at(-1);
    if (pick != null) onPick(pick);
  };
  const doMerge = () => {
    if (selected.length >= 2) onMerge([...selected].sort((a, b) => a - b));
  };

  const header = (
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
        <Copy size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>{title}</div>
        {subtitle ? (
          <div
            style={{
              fontSize: 11,
              color: C.t3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRegenerateAll}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: C.t2,
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        <RefreshCw size={13} />
        {isMobile ? "" : "Regenerate all"}
      </button>
    </div>
  );

  const grid = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: isMobile ? 12 : 16,
        padding: isMobile ? "12px 16px" : 22,
      }}
    >
      {variations.map((v) => (
        <VariationCard
          key={v.index}
          v={v}
          selected={selected.includes(v.index)}
          onToggle={() => toggle(v.index)}
        />
      ))}
    </div>
  );

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: isMobile ? "18px 18px 0 0" : 18,
        overflow: "hidden",
      }}
    >
      {header}
      {grid}
      <ActionBar
        selectedCount={selected.length}
        canMerge={selected.length >= 2}
        onMerge={doMerge}
        onPick={doPick}
        compact={isMobile}
      />
    </div>
  );
}
