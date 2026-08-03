/**
 * One of the composer's mode affordances (v25 · G1: ＋ attach · ✎ Create ·
 * ▦ Library · mic).
 *
 * Deliberately uniform and deliberately quiet: these are ways of SAYING
 * something, not places to go, so none of them gets a destination's weight.
 * The mic is the only one drawn as primary, because talking is the fastest
 * input on a phone.
 *
 * 44px hit target around a 30px pill — the touch target is the button, not the
 * thing you can see.
 */

import type { ReactNode } from "react";

import { haptic } from "@/utils/haptics";

export interface ComposerAffordanceProps {
  /** Accessible name. Says what it does, not what it is called. */
  label: string;
  /** Optional visible word beside the glyph (only ✎ Create carries one). */
  text?: string;
  /** Passed through to aria-expanded when the affordance opens a sheet. */
  expanded?: boolean;
  onPress: () => void;
  children: ReactNode;
}

export function ComposerAffordance({
  label,
  text,
  expanded,
  onPress,
  children,
}: ComposerAffordanceProps) {
  return (
    <button
      type="button"
      className="cue-pressable"
      aria-label={label}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-expanded={expanded}
      onClick={() => {
        // `.light` — this is a selection, not a commit (build rule).
        haptic.light();
        onPress();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        minHeight: 44,
        padding: text ? "0 10px" : "0 8px",
        border: "none",
        background: "transparent",
        color: "var(--mv3-muted)",
        fontFamily: "inherit",
        fontSize: 12,
        cursor: "pointer",
        flexShrink: 0,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          height: 30,
          padding: text ? "0 10px" : "0 7px",
          borderRadius: 10,
          background: "var(--mv3-btn2-bg)",
          border: "1px solid var(--mv3-btn2-border)",
        }}
      >
        {children}
        {text ? <span>{text}</span> : null}
      </span>
    </button>
  );
}
