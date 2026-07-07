/**
 * Shared chrome for the HQ first-run setup steps — the white step card,
 * headline block, Continue/Skip footer, and the row/input styles every step
 * shares. Extracted from `setup-page.tsx` so the onboarding-v2 step modules
 * (`think-step.tsx`, `connect-tools-step.tsx`) reuse the exact same visual
 * language without a circular import back into the page.
 */

import type { CSSProperties, ReactNode } from "react";

import { C, mono, serif } from "@/domains/activity/theme";
import { MicroLabel } from "@/pages/hq/hq-kit";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The white first-run card every step lives inside. */
export function StepCard({ children }: { children: ReactNode }) {
  return (
    <div style={cardStyle} data-slot="hq-setup-card">
      {children}
    </div>
  );
}

export function StepHead({
  label,
  title,
  blurb,
}: {
  label: string;
  title: string;
  blurb: string;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <MicroLabel color={C.blue} style={{ marginBottom: 12 }}>
        {label}
      </MicroLabel>
      <h1
        style={{
          fontFamily: serif,
          fontSize: 30,
          lineHeight: 1.08,
          color: C.t1,
          fontWeight: 400,
          margin: "0 0 8px",
        }}
      >
        {title}
      </h1>
      <p style={{ fontSize: 13.5, color: C.t2, lineHeight: 1.5, margin: 0 }}>
        {blurb}
      </p>
    </div>
  );
}

/** Dark "Continue ›" pill. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...primaryBtnStyle,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function SkipLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={skipLinkStyle}>
      {children}
    </button>
  );
}

/** Continue + Skip row — the footer every skippable step shares. */
export function StepFooter({
  continueLabel,
  onContinue,
  continueDisabled,
  onSkip,
  skipLabel = "Skip for now",
  caption,
}: {
  continueLabel: string;
  onContinue: () => void;
  continueDisabled?: boolean;
  onSkip: () => void;
  skipLabel?: string;
  caption?: string;
}) {
  return (
    <div style={{ marginTop: 22 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
        }}
      >
        <PrimaryButton onClick={onContinue} disabled={continueDisabled}>
          {continueLabel}
        </PrimaryButton>
        <SkipLink onClick={onSkip}>{skipLabel}</SkipLink>
      </div>
      {caption ? (
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: C.t3,
            marginTop: 12,
            letterSpacing: "0.02em",
          }}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles — all ride theme-aware `C` tokens.
// ---------------------------------------------------------------------------

export const cardStyle: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 22,
  padding: 28,
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

export const selectRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  padding: "13px 14px",
  background: C.surface,
  cursor: "pointer",
  textAlign: "left",
  font: "inherit",
  transition: "border-color .12s, background .12s",
};

export const rowIconStyle: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 11,
  background: C.sunken,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 18,
  flexShrink: 0,
};

export const checkDotStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: `1.5px solid ${C.line2}`,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  flexShrink: 0,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${C.line2}`,
  borderRadius: 12,
  padding: "12px 14px",
  fontSize: 15,
  color: C.t1,
  background: C.bg,
  outline: "none",
  boxSizing: "border-box",
};

export const connectPillStyle: CSSProperties = {
  border: `1px solid ${C.line2}`,
  background: C.bg,
  color: C.t1,
  borderRadius: 9,
  padding: "7px 14px",
  fontSize: 12.5,
  cursor: "pointer",
  flexShrink: 0,
};

const primaryBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: C.t1,
  color: C.bg,
  border: "none",
  borderRadius: 12,
  padding: "12px 22px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const skipLinkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: C.t3,
  fontSize: 13,
  cursor: "pointer",
  padding: "6px 4px",
};
