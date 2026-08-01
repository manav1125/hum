/**
 * THE item card — the one-card language from the Cue-HQ-Build Round 5 · B3
 * anatomy sheet, shared by the project board rows and the task-drawer header
 * (and, later, the HQ needs-you / came-in / mission-step rows).
 *
 * One anatomy, five slots, in this order and never reordered:
 *   ① source badge · ② title · ③ mission/project tag · ④ status/due chip ·
 *   ⑤ primary action
 * Empty slots collapse — nothing shifts. Emphasis variants (per the sheet):
 *   next    → 1.5px accent border + accent shadow, never a new layout
 *   blocked → amber border + amber chip
 *   done    → sunken bg + strikethrough title
 * Dark theme remaps tokens only (everything rides the `--mv1-*` vars).
 */

import type { CSSProperties, ReactNode } from "react";

import { C, mono } from "@/domains/activity/theme";
import { LiveBars, sourceBadge } from "@/pages/hq/hq-kit";

export type ItemEmphasis = "none" | "next" | "blocked" | "done";

/** Mono status/due chip in ring-tone hues (slot ④). */
export interface ItemChip {
  label: string;
  color: string;
  /** Optional wash behind the chip; defaults to the sunken token. */
  bg?: string;
}

/**
 * Slot-④ chip for a work-item status, in the same ring-tone hues the HQ deck
 * uses (blue running / amber queued+review / green done / danger failed).
 */
export function statusChip(status: string): ItemChip | null {
  switch (status) {
    case "running":
      return { label: "RUNNING", color: C.blueS };
    case "queued":
    case "pending":
      return { label: "QUEUED", color: C.amber };
    case "awaiting_review":
      return {
        label: "REVIEW",
        color: C.amber,
        bg: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
      };
    case "done":
      return {
        label: "DONE",
        color: C.green,
        bg: `color-mix(in srgb, ${C.green} 12%, transparent)`,
      };
    case "failed":
    case "cancelled":
      return {
        label: status.toUpperCase(),
        color: C.danger,
        bg: `color-mix(in srgb, ${C.danger} 10%, transparent)`,
      };
    default:
      return null;
  }
}

/** Slot-① source badge tile (16px board size / 34px hero size). */
export function SourceBadge({
  sourceType,
  size = 16,
}: {
  sourceType: string | null;
  size?: number;
}) {
  const { glyph, tint } = sourceBadge(sourceType);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size >= 28 ? 9 : 4,
        background: tint,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size >= 28 ? 14 : 8,
        flexShrink: 0,
      }}
    >
      {glyph}
    </span>
  );
}

/** Slot-③ mission/project tag: ⟡ = linked (blue wash); Standalone = sunken. */
export function MissionTag({
  label,
  linked = true,
  onClick,
  style,
}: {
  label: string;
  linked?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const inner = (
    <>
      {linked ? <span aria-hidden>⟡</span> : null}
      {label}
    </>
  );
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    color: linked ? C.blueS : C.t3,
    background: linked
      ? `color-mix(in srgb, ${C.blue} 13%, transparent)`
      : C.sunken,
    borderRadius: 7,
    padding: "4px 9px",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    ...style,
  };
  if (!onClick) return <span style={base}>{inner}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ ...base, border: "none", cursor: "pointer" }}
    >
      {inner}
    </button>
  );
}

/**
 * Slot-③ goal tag — the linked mission's outcome ("Close the $500K seed"),
 * rendered as a green wash to read as the destination the project drives
 * toward (distinct from the blue ⟡ mission-name tag). Shown only when the
 * mission actually declares an outcome; absent → the card falls back to the
 * mission-name / Standalone tag alone. No fabrication.
 */
export function GoalTag({
  label,
  onClick,
  style,
}: {
  label: string;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const inner = (
    <>
      <span aria-hidden>◎</span>
      {label}
    </>
  );
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    color: C.green,
    background: `color-mix(in srgb, ${C.green} 14%, transparent)`,
    borderRadius: 7,
    padding: "4px 9px",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    ...style,
  };
  if (!onClick) return <span style={base}>{inner}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ ...base, border: "none", cursor: "pointer" }}
    >
      {inner}
    </button>
  );
}

/**
 * The card. Board rows pass `onOpen`; the drawer header renders it inert
 * (`flat`) as its identity block.
 */
export function ItemCard({
  sourceType,
  title,
  tag,
  chip,
  chipNode,
  provenance,
  action,
  note,
  live = false,
  emphasis = "none",
  flat = false,
  titleSize = 12.5,
  onOpen,
}: {
  /** Slot ① — collapses when null/undefined. */
  sourceType?: string | null;
  /** Slot ② — verb-first, plain. */
  title: string;
  /** Slot ③ — a <MissionTag/> (or anything); collapses when absent. */
  tag?: ReactNode;
  /** Slot ④ — mono ring-tone chip; collapses when absent. */
  chip?: ItemChip | null;
  /**
   * Slot ④, state variant — a work-loop <StateBadge/> rendered INSTEAD of the
   * mono chip (never beside it, so the anatomy keeps its five slots). Used
   * when the row's most honest status is a loop state, e.g. a task the pre-run
   * assessment parked because it needs a person.
   */
  chipNode?: ReactNode;
  /**
   * Slot ③b — the `<ProvenanceTrace/>` pill ("why is this here"), beside the
   * mission tag. Collapses when the item has no provenance to state, which is
   * the common case for anything the user typed in without a source.
   */
  provenance?: ReactNode;
  /** Slot ⑤ — ONE primary action; collapses when absent. */
  action?: ReactNode;
  /** Progress/evidence line under the title row (live notes, "Ops wrote it"). */
  note?: { text: string; color?: string } | null;
  /** Equalizer bars beside the title while an agent is working. */
  live?: boolean;
  emphasis?: ItemEmphasis;
  /** Render without card chrome (bg/border) — the drawer-header variant. */
  flat?: boolean;
  /** Title size override (the drawer header runs larger); default 12.5. */
  titleSize?: number;
  onOpen?: () => void;
}) {
  const done = emphasis === "done";
  const border =
    emphasis === "next"
      ? `1.5px solid ${C.blue}`
      : emphasis === "blocked"
        ? `1px solid color-mix(in srgb, ${C.amber} 45%, ${C.line})`
        : `1px solid ${C.line}`;

  const chrome: CSSProperties = flat
    ? { padding: 0 }
    : {
        background: done ? C.sunken : C.surface,
        border,
        borderRadius: 12,
        padding: done ? "10px 13px" : "11px 13px",
        boxShadow:
          emphasis === "next"
            ? `0 10px 26px -18px color-mix(in srgb, ${C.blue} 50%, transparent)`
            : "none",
        opacity: done ? 0.8 : 1,
        cursor: onOpen ? "pointer" : "default",
      };

  const interactive = onOpen
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        },
      }
    : {};

  return (
    <div {...interactive} style={chrome}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {done ? (
          <span aria-hidden style={{ fontSize: 11, color: C.green }}>
            ✓
          </span>
        ) : sourceType !== undefined && sourceType !== null ? (
          <SourceBadge sourceType={sourceType} />
        ) : null}
        <span
          style={{
            fontSize: titleSize,
            fontWeight: done ? 400 : emphasis === "none" ? 500 : 600,
            color: done ? C.t2 : C.t1,
            textDecoration: done ? "line-through" : "none",
            flex: 1,
            minWidth: 0,
            lineHeight: 1.3,
          }}
        >
          {title}
        </span>
        {live ? <LiveBars color={C.blue} /> : null}
        {chipNode ? (
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            {chipNode}
          </span>
        ) : chip ? (
          <span
            style={{
              fontFamily: mono,
              fontSize: 8.5,
              letterSpacing: "0.06em",
              color: chip.color,
              background: chip.bg ?? C.sunken,
              borderRadius: 5,
              padding: "2px 6px",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {chip.label}
          </span>
        ) : null}
      </div>
      {tag || provenance ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 7,
          }}
        >
          {tag}
          {provenance}
        </div>
      ) : null}
      {note ? (
        <div
          style={{
            fontSize: 11,
            color: note.color ?? C.t3,
            marginTop: 6,
            lineHeight: 1.4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {note.text}
        </div>
      ) : null}
      {action ? (
        <div style={{ display: "flex", gap: 6, marginTop: 9 }}>{action}</div>
      ) : null}
    </div>
  );
}
