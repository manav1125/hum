/**
 * Mobile v3 shared style atoms — the exact values read off the rendered spec
 * (docs/design/mobile-v3/cue-mobile-v3.html, frames 1 + 12). Kept as plain
 * style objects so every mv3 component composes the same primitives instead
 * of re-deriving them.
 */
import type React from "react";

/** SF Pro system stack (spec: -apple-system … sans-serif). */
export const mv3Font = "var(--mv3-font)";

/** Mono microlabel stack (spec: ui-monospace, "SF Mono", Menlo, monospace). */
export const mv3Mono = "var(--mv3-mono)";

/**
 * Microlabel typography — the card eyebrows: mono, 10px, +0.10em tracking,
 * uppercase (spec: "NEXT MOVE" / "NEEDS YOUR OK · …" / "WORKING NOW · 2 AUTO").
 * Color is supplied by the caller (state color or `--mv3-micro`).
 */
export const microLabel: React.CSSProperties = {
  fontFamily: mv3Mono,
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
};

/** Primary blue CTA — spec "Send it": gradient fill, radius 13, glow. */
export const primaryBtn: React.CSSProperties = {
  flex: 1,
  background: "var(--mv3-accent-fill-gradient)",
  color: "#ffffff",
  border: "none",
  borderRadius: 13,
  padding: 10,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
  boxShadow: "var(--mv3-primary-btn-shadow)",
};

/** Secondary button — spec "Open"/"Deny": quiet fill + hairline border. */
export const secondaryBtn: React.CSSProperties = {
  background: "var(--mv3-btn2-bg)",
  color: "var(--mv3-text)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 13,
  padding: "10px 16px",
  fontSize: 13.5,
  fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
};

/** Card title — spec: 16px/600, −0.3px tracking. */
export const cardTitle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: "-0.3px",
  marginTop: 7,
  color: "var(--mv3-text)",
};

/** Card body line — spec: 13px muted, 1.4 line-height. */
export const cardBody: React.CSSProperties = {
  fontSize: 13,
  color: "var(--mv3-muted)",
  marginTop: 3,
  lineHeight: 1.4,
};

/**
 * Staggered card entrance — spec `v3Rise .7s cubic-bezier(.2,.8,.2,1) both`
 * with per-card delays (.1s/.25s/.4s/.55s). Frozen by the mv3 reduced-motion
 * rule (elements rest at opacity 1).
 */
export function rise(delaySeconds: number): React.CSSProperties {
  return {
    animation: `mv3Rise .7s cubic-bezier(.2,.8,.2,1) ${delaySeconds}s 1 normal both`,
  };
}
