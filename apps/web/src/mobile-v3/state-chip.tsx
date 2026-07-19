/**
 * StateChip — the mv3 state taxonomy (README, non-negotiable):
 *
 *   ↴ picked up (blue) · pulse = running (blue, animated dot) ·
 *   ‖ needs you (amber) · ◱ review (violet) · ✓ done (green)
 *
 * Typography read off the spec's microlabels: mono stack, 10px (9.5px in
 * dense rows), +0.10em tracking, uppercase, colored per state (e.g.
 * "‖ NEEDS YOU · PITCH REVIEW" in #E0A64B). The `pill` variant is the
 * badge treatment the frames use for AUTO/ASK/DUE chips: state color at
 * 12–15% alpha fill, 3px/8px padding, radius 6.
 */
import type React from "react";

import { microLabel } from "./mv3-kit";

export type Mv3State =
  | "picked_up"
  | "running"
  | "needs_you"
  | "review"
  | "done";

const STATE_META: Record<Mv3State, { glyph: string; color: string }> = {
  picked_up: { glyph: "↴", color: "var(--mv3-micro)" },
  running: { glyph: "", color: "var(--mv3-micro)" }, // pulse dot instead
  needs_you: { glyph: "‖", color: "var(--mv3-amber)" },
  review: { glyph: "◱", color: "var(--mv3-violet)" },
  done: { glyph: "✓", color: "var(--mv3-green)" },
};

/** The running state's animated pulse dot (transform/opacity only). */
function PulseDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: color,
          animation: "mv3Ping 1.8s ease-out infinite",
        }}
      />
    </span>
  );
}

export function StateChip({
  state,
  label,
  size = "md",
  pill = false,
  style,
}: {
  state: Mv3State;
  /** Uppercased microlabel copy, e.g. "NEEDS YOU · PITCH REVIEW". */
  label: string;
  /** md = 10px (card eyebrows) · sm = 9.5px/+0.08em (dense rows). */
  size?: "md" | "sm";
  /** Badge variant: tinted fill + radius 6 (the AUTO/ASK/DUE treatment). */
  pill?: boolean;
  style?: React.CSSProperties;
}) {
  const meta = STATE_META[state];
  return (
    <span
      data-mv3
      style={{
        ...microLabel,
        ...(size === "sm" ? { fontSize: 9.5, letterSpacing: "0.08em" } : {}),
        color: meta.color,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        whiteSpace: "nowrap",
        ...(pill
          ? {
              background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
              padding: "3px 8px",
              borderRadius: 6,
            }
          : {}),
        ...style,
      }}
    >
      {state === "running" ? (
        <PulseDot color={meta.color} />
      ) : (
        <span aria-hidden>{meta.glyph}</span>
      )}
      {label}
    </span>
  );
}
