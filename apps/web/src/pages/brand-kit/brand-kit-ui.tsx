/**
 * Shared visual kit for the Brand Kit surfaces.
 *
 * Reuses the app's theme-aware `C` / `mono` / `serif` tokens (the same
 * `--mv1-*` system HQ + onboarding ride) so every screen follows light/dark
 * with no bespoke palette, and matches the approved Create-Studio mocks:
 *   · BRAND KIT microlabel + Instrument-Serif display headline
 *   · three entry cards (Upload / From your website / Guided)
 *   · palette swatches, type specimens, logo-on-light/dark, voice do/don't
 *   · a "same deck in your brand" live preview
 */

import type { CSSProperties, ReactNode } from "react";

import { C, mono, serif } from "@/domains/activity/theme";

export { C, mono, serif };

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

export function MicroLabel({
  children,
  color = C.t3,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Display({
  children,
  size = 34,
  style,
}: {
  children: ReactNode;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <h1
      style={{
        fontFamily: serif,
        fontSize: size,
        fontWeight: 400,
        lineHeight: 1.06,
        color: C.t1,
        margin: 0,
        ...style,
      }}
    >
      {children}
    </h1>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export function PrimaryButton({
  children,
  onClick,
  disabled,
  full,
  style,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  full?: boolean;
  style?: CSSProperties;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        width: full ? "100%" : undefined,
        background: C.blue,
        color: "#fff",
        border: "none",
        borderRadius: 12,
        padding: "12px 22px",
        fontSize: 14,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "opacity .12s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: C.surface,
        color: C.t1,
        border: `1px solid ${C.line2}`,
        borderRadius: 12,
        padding: "11px 18px",
        fontSize: 13.5,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** The small "Edit" / "Change" / "Replace" text link at a card's top-right. */
export function CardAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        color: C.blue,
        fontSize: 12.5,
        fontWeight: 500,
        cursor: "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A bordered content card — the surface every section lives inside. */
export function Panel({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        padding: 22,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Section header row: microlabel on the left, optional action on the right. */
export function SectionHead({
  label,
  badge,
  action,
}: {
  label: string;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <MicroLabel>{label}</MicroLabel>
        {badge}
      </div>
      {action}
    </div>
  );
}

/** The small green "SAME DECK · IN YOUR BRAND" style pill. */
export function Tag({
  children,
  tone = "green",
}: {
  children: ReactNode;
  tone?: "green" | "blue" | "neutral";
}) {
  const color =
    tone === "green" ? C.green : tone === "blue" ? C.blue : C.t2;
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        borderRadius: 6,
        padding: "3px 7px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Palette swatches
// ---------------------------------------------------------------------------

export const PALETTE_SLOTS: Array<{
  key: "primary" | "accent" | "bg" | "surface" | "text";
  label: string;
}> = [
  { key: "primary", label: "Primary" },
  { key: "accent", label: "Accent" },
  { key: "bg", label: "Bg" },
  { key: "surface", label: "Surface" },
  { key: "text", label: "Text" },
];

/** A single labelled swatch. When `onChange` is set it doubles as a picker. */
export function Swatch({
  color,
  label,
  size = 56,
  onChange,
}: {
  color: string | undefined;
  label?: string;
  size?: number;
  onChange?: (hex: string) => void;
}) {
  const swatch = (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
        borderRadius: 12,
        background: color || C.sunken,
        border: `1px solid ${C.line2}`,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
        overflow: "hidden",
      }}
    >
      {onChange ? (
        <input
          type="color"
          value={normalizeHex(color)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            cursor: "pointer",
            border: "none",
            padding: 0,
          }}
        />
      ) : null}
    </span>
  );
  if (!label) return swatch;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}>
      {swatch}
      <MicroLabel style={{ fontSize: 9, letterSpacing: "0.08em" }}>
        {label}
      </MicroLabel>
    </span>
  );
}

function normalizeHex(value: string | undefined): string {
  if (!value) return "#000000";
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return "#000000";
}

// ---------------------------------------------------------------------------
// Live "same deck in your brand" preview — a mini slide skinned by the profile.
// ---------------------------------------------------------------------------

export function BrandPreviewSlide({
  palette,
  fonts,
  name,
  compact,
}: {
  palette: BrandLikePalette;
  fonts: { heading?: string; body?: string };
  name: string;
  compact?: boolean;
}) {
  const bg = palette.surface || "#F4F1EA";
  const ink = palette.text || "#12161C";
  const accent = palette.accent || palette.primary || C.blue;
  const primary = palette.primary || C.blue;
  return (
    <div
      style={{
        position: "relative",
        borderRadius: 12,
        background: bg,
        border: `1px solid ${C.line2}`,
        padding: compact ? "18px 16px" : "26px 22px",
        minHeight: compact ? 120 : 180,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        overflow: "hidden",
      }}
    >
      {/* logo mark chip on the cover */}
      <span
        style={{
          position: "absolute",
          top: 14,
          left: 16,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: 4,
            background: primary,
            display: "inline-block",
          }}
        />
        <span
          style={{
            fontFamily: fonts.body || "inherit",
            fontSize: 11,
            fontWeight: 600,
            color: ink,
          }}
        >
          {name}
        </span>
      </span>
      <span
        style={{
          width: 34,
          height: 3,
          borderRadius: 2,
          background: accent,
          marginBottom: 10,
        }}
      />
      <div
        style={{
          fontFamily: fonts.heading || serif,
          fontSize: compact ? 20 : 26,
          lineHeight: 1.1,
          color: ink,
        }}
      >
        Raising our{" "}
        <span style={{ color: accent, fontStyle: "italic" }}>Series A</span>
      </div>
      <div
        style={{
          fontFamily: fonts.body || "inherit",
          fontSize: compact ? 11 : 12.5,
          color: `color-mix(in srgb, ${ink} 65%, transparent)`,
          marginTop: 6,
        }}
      >
        Confident, plain-spoken — your voice.
      </div>
    </div>
  );
}

interface BrandLikePalette {
  primary?: string;
  accent?: string;
  bg?: string;
  surface?: string;
  text?: string;
}

interface BrandLogo {
  light?: string;
  dark?: string;
  mark?: string;
}
export type { BrandLogo, BrandLikePalette };
