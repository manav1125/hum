/**
 * FailureCard — the mv3 failure exemplar (spec frame 29): the ONLY place red
 * appears. Always carries a named reason and a way forward.
 *
 * Spec values (dark, read off frame 29):
 *   card: bg rgba(44,26,28,.75) · border 1px rgba(229,103,91,.45) ·
 *         border-left 3px #E5675B · radius 20 · padding 15px 16px · blur(20px)
 *   header: ✕ chip 22×22 r7 bg rgba(229,103,91,.18) #E5675B · microlabel
 *           "COULDN'T FINISH" mono 9.5px +0.08em #E5675B · time 11px muted
 *   title 15/600 · agent row 12px muted ("Ops · stopped after 2 tries")
 *   why box: bg rgba(229,103,91,.1) r11 p10/12 · 12.5px #E7A9AD ·
 *            "Why:" bolded in text color
 *   actions: primary #E5675B on #211619 r12 p11 13.5/600 · secondary quiet
 *
 * Light legs are extrapolated mechanically per the README dark↔light rules
 * (analogous to amber #E0A64B → #B4770F): red #E5675B → #B3453B on a red-cream
 * card (#FDF0EE, the #FBF4E4 analog). Frame 29 itself is dark-only.
 *
 * Rendering honesty: the agent line, tries count, and reason render ONLY when
 * the caller has real values — nothing is fabricated.
 *
 * NOT exported from ../index.ts (parallel builds own that file) — import
 * directly: `import { FailureCard } from "@/mobile-v3/failure-card"`.
 */
import type React from "react";

import { microLabel } from "./mv3-kit";

/** Scoped theme legs. Injected per-card; duplicate <style> tags are inert. */
const FAILURE_CARD_CSS = `
.mv3-failure-card {
  --mv3f-red: #b3453b;
  --mv3f-card-bg: #fdf0ee;
  --mv3f-card-border: rgba(179, 69, 59, 0.35);
  --mv3f-chip-bg: rgba(179, 69, 59, 0.14);
  --mv3f-why-bg: rgba(179, 69, 59, 0.08);
  --mv3f-why-text: #8a3a32;
  --mv3f-btn-text: #ffffff;
  --mv3f-shadow: 0 16px 36px -22px rgba(179, 69, 59, 0.35);
}
[data-theme="dark"] .mv3-failure-card,
[data-theme="velvet"] .mv3-failure-card {
  --mv3f-red: #e5675b;
  --mv3f-card-bg: rgba(44, 26, 28, 0.75);
  --mv3f-card-border: rgba(229, 103, 91, 0.45);
  --mv3f-chip-bg: rgba(229, 103, 91, 0.18);
  --mv3f-why-bg: rgba(229, 103, 91, 0.1);
  --mv3f-why-text: #e7a9ad;
  --mv3f-btn-text: #211619;
  --mv3f-shadow: 0 20px 44px -22px rgba(0, 0, 0, 0.7);
}
`;

export interface FailureCardProps {
  /** What couldn't finish, e.g. "Pull Q2 numbers from QuickBooks". */
  title: string;
  /** Right-aligned timestamp label, e.g. "11:42". */
  timeLabel?: string;
  /** Named agent that ran it (chip + label), e.g. "Ops". */
  agentName?: string;
  /** Agent chip hue (spec shows #4FC7C7 for Ops). Defaults to the teal slot. */
  agentColor?: string;
  /** Honest retry-count line, e.g. "stopped after 2 tries". Omit if unknown. */
  triesLabel?: string;
  /** The named reason ("Why: …"). Omit when no real reason is known. */
  reason?: string;
  /** Primary recovery label, e.g. "Reconnect & retry" / "Retry". */
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  /** Secondary action label. Spec copy: "Tell Cue". */
  secondaryLabel?: string;
  onSecondary?: () => void;
  style?: React.CSSProperties;
}

export function FailureCard({
  title,
  timeLabel,
  agentName,
  agentColor = "var(--mv3-teal)",
  triesLabel,
  reason,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  secondaryLabel = "Tell Cue",
  onSecondary,
  style,
}: FailureCardProps) {
  const agentLine = [agentName, triesLabel].filter(Boolean).join(" · ");
  return (
    <div
      data-mv3
      className="mv3-failure-card"
      style={{
        background: "var(--mv3f-card-bg)",
        border: "1px solid var(--mv3f-card-border)",
        borderLeft: "3px solid var(--mv3f-red)",
        borderRadius: 20,
        padding: "15px 16px",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: "var(--mv3f-shadow)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
        ...style,
      }}
    >
      <style>{FAILURE_CARD_CSS}</style>

      {/* ✕ COULDN'T FINISH · time */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            background: "var(--mv3f-chip-bg)",
            color: "var(--mv3f-red)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          ✕
        </span>
        <span
          style={{
            ...microLabel,
            fontSize: 9.5,
            letterSpacing: "0.08em",
            color: "var(--mv3f-red)",
          }}
        >
          Couldn&rsquo;t finish
        </span>
        {timeLabel ? (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11,
              color: "var(--mv3-muted)",
            }}
          >
            {timeLabel}
          </span>
        ) : null}
      </div>

      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          marginTop: 8,
          letterSpacing: "-0.2px",
        }}
      >
        {title}
      </div>

      {agentLine ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            marginTop: 5,
          }}
        >
          {agentName ? (
            <span
              aria-hidden
              style={{
                width: 15,
                height: 15,
                borderRadius: 5,
                background: agentColor,
                color: "#08211f",
                fontSize: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              ◆
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: "var(--mv3-muted)" }}>
            {agentLine}
          </span>
        </div>
      ) : null}

      {reason ? (
        <div
          style={{
            background: "var(--mv3f-why-bg)",
            borderRadius: 11,
            padding: "10px 12px",
            marginTop: 11,
            fontSize: 12.5,
            color: "var(--mv3f-why-text)",
            lineHeight: 1.5,
          }}
        >
          <b style={{ color: "var(--mv3-text)", fontWeight: 600 }}>Why:</b>{" "}
          {reason}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="cue-pressable"
          disabled={primaryDisabled}
          onClick={onPrimary}
          style={{
            flex: 1,
            background: "var(--mv3f-red)",
            color: "var(--mv3f-btn-text)",
            border: "none",
            borderRadius: 12,
            padding: 11,
            minHeight: 44,
            fontSize: 13.5,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: primaryDisabled ? "default" : "pointer",
            opacity: primaryDisabled ? 0.6 : 1,
          }}
        >
          {primaryLabel}
        </button>
        {onSecondary ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={onSecondary}
            style={{
              background: "var(--mv3-btn2-bg)",
              color: "var(--mv3-text)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 12,
              padding: "11px 14px",
              minHeight: 44,
              fontSize: 13,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
