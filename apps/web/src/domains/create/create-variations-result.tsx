/**
 * Create Studio — 4e · "Make variations".
 *
 * The panel has TWO honest modes, decided by whether real previews exist:
 *
 *  - **Chooser** (no `preview` on any variation — the situation today). Nothing
 *    has been generated yet, so there is nothing to show. Each card therefore
 *    DESCRIBES its direction in words ("Two columns — copy on one side, the
 *    visual on the other") and the action makes that one. It must never render
 *    an empty artwork tile: a grey box where a picture should be reads as a
 *    preview that failed to load, and the user ends up choosing blind.
 *  - **Results** (the host injected `preview` nodes for generated alternates).
 *    The 2×2 comparison grid with **Merge selected** and **Pick this →**.
 *
 * Rendering a real variation thumbnail needs the same iframe/app host the deck
 * viewer uses, which lives outside this domain — so results mode activates only
 * when a host passes previews in. Until one does, the chooser is the truthful
 * surface, not a placeholder for a missing one.
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

/** One variation — a direction to make, or a generated alternate. */
export interface VariationResult {
  /** 1-based index (→ "Variation N"). */
  index: number;
  /** Short axis descriptor, e.g. "centered", "dark". */
  variant: string;
  /**
   * What this direction changes, in plain words. Shown in chooser mode in place
   * of artwork that does not exist yet.
   */
  description?: string;
  /**
   * A rendered preview node for this variation (the host injects the real
   * artifact thumbnail — an iframe or image). Its presence is what switches the
   * panel from chooser mode into results mode.
   */
  preview?: React.ReactNode;
}

export interface VariationsResultProps {
  /** Asset name for the header ("Series A cover · Startup template"). */
  title: string;
  /** Sub-line under the title (context: template · brand). */
  subtitle?: string;
  /** The variations (typically 4). */
  variations: VariationResult[];
  /** Re-fire all variations. Only offered in results mode. */
  onRegenerateAll: () => void;
  /**
   * Results mode: promote the selected variation to the canonical asset.
   * Chooser mode: generate that direction. Receives the variation's index.
   */
  onPick: (index: number) => void;
  /**
   * Merge the selected variations into one refined asset. Receives all selected
   * indexes (≥ 2). Results mode only — there is nothing to merge before the
   * alternates exist. No dedicated merge endpoint exists yet: the host re-seeds
   * a "merge variation N and M" instruction (buildMergePrompt).
   */
  onMerge: (indexes: number[]) => void;
}

/**
 * Chooser-mode tile: the direction, stated. Deliberately typographic — an
 * artwork-shaped box with nothing in it would read as a broken preview.
 */
function DirectionTile({
  variant,
  description,
}: {
  variant: string;
  description?: string;
}) {
  return (
    <div
      style={{
        borderRadius: 8,
        background: C.sunken,
        border: `1px solid ${C.line}`,
        padding: "14px 14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 118,
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: C.blueS,
        }}
      >
        {variant}
      </span>
      <span style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.45 }}>
        {description ??
          `A ${variant} treatment of the same content — generated when you pick it.`}
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
        {v.preview ?? (
          <DirectionTile variant={v.variant} description={v.description} />
        )}
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
        {v.preview
          ? `Variation ${v.index} · ${selected ? "selected" : v.variant}`
          : `Direction ${v.index} · ${selected ? "selected" : "not made yet"}`}
      </div>
    </button>
  );
}

/**
 * Bottom action bar. Results mode: N selected · Merge selected · Pick this →.
 * Chooser mode: the merge affordance is absent (there is nothing to merge) and
 * the primary action names what it will actually do — make the direction.
 */
function ActionBar({
  selectedCount,
  showMerge,
  canMerge,
  pickLabel,
  hint,
  onMerge,
  onPick,
  compact,
}: {
  selectedCount: number;
  showMerge: boolean;
  canMerge: boolean;
  pickLabel: string;
  hint: string;
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
        <span style={{ fontSize: 12, color: C.t3 }}>{hint}</span>
      ) : null}
      {showMerge ? (
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
      ) : null}
      <button
        type="button"
        onClick={onPick}
        disabled={selectedCount === 0}
        style={{
          marginLeft: showMerge || compact ? undefined : "auto",
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
        {pickLabel}
      </button>
    </div>
  );
}

/**
 * The 4e Make-variations panel. With previews it is the comparison grid (Merge
 * / Pick); without them it is the honest chooser — named directions, and the
 * primary action generates the selected one.
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
  // Results mode is earned: it needs at least one real rendered alternate.
  const hasPreviews = variations.some((v) => v.preview != null);
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
      {/* Nothing has been generated in chooser mode, so there is nothing to
          regenerate — offering it would imply results that don't exist. */}
      {hasPreviews ? (
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
      ) : null}
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
        showMerge={hasPreviews}
        canMerge={hasPreviews && selected.length >= 2}
        pickLabel={hasPreviews ? "Pick this →" : "Make this one →"}
        hint={
          hasPreviews
            ? `${selected.length} selected`
            : "Nothing is generated yet — pick a direction to make"
        }
        onMerge={doMerge}
        onPick={doPick}
        compact={isMobile}
      />
    </div>
  );
}
