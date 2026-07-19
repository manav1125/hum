/**
 * Shared scaffolding for the YOU cluster of mobile-v3 screens (spec frames
 * 9/10/11/18/19/20/30/31/32 — docs/design/mobile-v3/cue-mobile-v3.html).
 *
 * Every screen in the cluster is the same physical shell read off the frames:
 * a full-height mv3 surface over the aurora, an optional `‹ You` back chevron
 * row (16px, micro color), a 30px/700/−0.8px large title with a 13px muted
 * subtitle, then a scrolling card stack with 16px gutters. The pieces here
 * are new files only — the mv3 foundation (`GlassCard`, `SheetShell`, tokens)
 * is consumed, never edited.
 */
import { useNavigate } from "react-router";

import { haptic } from "@/utils/haptics";

import { microLabel } from "../mv3-kit";
import { AuroraBackdrop } from "../aurora-backdrop";

/** Aurora tints per frame (frame 9 violet-ish / 10 blue / 11 teal / 18 violet). */
export const AURORA_TINTS = {
  blue: "rgba(61,110,232,.2)",
  violet: "rgba(167,159,240,.18)",
  lavender: "rgba(127,119,221,.22)",
  teal: "rgba(79,199,199,.16)",
} as const;

export type AuroraTint = keyof typeof AURORA_TINTS;

/**
 * Full-height screen shell: aurora + optional back row + large title block +
 * the scrolling stack. Screens that need custom headers (You's avatar row)
 * pass `header` instead of `title`.
 */
export function YouScreen({
  tint = "blue",
  back,
  backLabel = "You",
  trailing,
  title,
  sub,
  header,
  children,
  testId,
}: {
  tint?: AuroraTint;
  /** Back destination; omit for the root You tab. */
  back?: string | (() => void);
  backLabel?: string;
  /** Right-aligned ornament on the back row (e.g. "+ Rule" / "Add brand"). */
  trailing?: React.ReactNode;
  title?: string;
  sub?: React.ReactNode;
  /** Replaces the title block wholesale (frame 9's avatar header). */
  header?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const navigate = useNavigate();
  return (
    <div
      data-mv3
      data-slot={testId}
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop
        style={{
          background: `radial-gradient(44% 30% at 50% 4%, ${AURORA_TINTS[tint]}, transparent 68%)`,
        }}
      />

      {(back || trailing) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "6px 20px 0",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          {back ? (
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                if (typeof back === "function") back();
                else navigate(back);
              }}
              style={{
                fontSize: 16,
                color: "var(--mv3-micro)",
                background: "none",
                border: "none",
                padding: "6px 0",
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ‹ {backLabel}
            </button>
          ) : (
            <span />
          )}
          {trailing ? (
            <span style={{ marginLeft: "auto" }}>{trailing}</span>
          ) : null}
        </div>
      )}

      {header ??
        (title ? (
          <div
            style={{
              padding: "6px 22px 12px",
              flexShrink: 0,
              position: "relative",
              zIndex: 2,
            }}
          >
            <div
              style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.8px" }}
            >
              {title}
            </div>
            {sub ? (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--mv3-muted)",
                  marginTop: 5,
                }}
              >
                {sub}
              </div>
            ) : null}
          </div>
        ) : null)}

      {/* The scrolling card stack — the only scrolling region. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding:
            "2px 16px calc(24px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Mono card eyebrow (frame 9 "HOW MUCH CUE DOES ALONE" grammar). */
export function Eyebrow({
  children,
  trailing,
}: {
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ ...microLabel, color: "var(--mv3-muted)" }}>
        {children}
      </span>
      {trailing ? (
        <span style={{ marginLeft: "auto" }}>{trailing}</span>
      ) : null}
    </div>
  );
}

/** Quiet inline link ("Rules ›" / "Change ›") — 11.5px micro color. */
export function QuietLink({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{
        fontSize: 11.5,
        color: "var(--mv3-micro)",
        background: "none",
        border: "none",
        padding: "4px 0",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}

/**
 * Native grouped row (frame 9's Memory/Connections/Skills/Brand rows):
 * 30px icon tile, 14.5px label, optional right meta, `›` chevron.
 */
export function NavRow({
  icon,
  iconBg,
  label,
  meta,
  metaColor,
  isLast,
  onPress,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  meta?: string;
  metaColor?: string;
  isLast?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="cue-pressable"
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 16px",
        minHeight: 48,
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: isLast ? "none" : "1px solid var(--mv3-line)",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "var(--mv3-text)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ fontSize: 14.5, flex: 1, minWidth: 0 }}>{label}</span>
      {meta ? (
        <span
          style={{
            fontSize: 12,
            color: metaColor ?? "var(--mv3-muted)",
            flexShrink: 0,
          }}
        >
          {meta}
        </span>
      ) : null}
      <span style={{ color: "var(--mv3-faint)", marginLeft: 4 }} aria-hidden>
        ›
      </span>
    </button>
  );
}

/** Segment pill rail (frame 10 People/Preferences · frame 18 Explore/Installed). */
export function SegRail<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: "flex",
        gap: 7,
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
      }}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            className="cue-pressable"
            aria-pressed={active}
            onClick={() => {
              haptic.light();
              onChange(item.value);
            }}
            style={{
              flexShrink: 0,
              fontSize: 12.5,
              fontWeight: active ? 600 : 400,
              fontFamily: "inherit",
              color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
              background: active
                ? "var(--mv3-text)"
                : "var(--mv3-btn2-bg)",
              border: active
                ? "1px solid transparent"
                : "1px solid var(--mv3-btn2-border)",
              borderRadius: 99,
              padding: "7px 15px",
              minHeight: 32,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Big-number stat tile (frame 9 TRACK RECORD · frame 30 runs/spend). */
export function StatTile({
  value,
  label,
  onPress,
}: {
  value: string;
  label: string;
  onPress?: () => void;
}) {
  const body = (
    <>
      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--mv3-text)" }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--mv3-muted)", marginTop: 2 }}>
        {label}
      </div>
    </>
  );
  if (!onPress) return <div>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {body}
    </button>
  );
}

/** The green-shield trust footer line (frames 10/18). */
export function TrustFootnote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        justifyContent: "center",
        padding: "4px 0",
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--mv3-green)"
        strokeWidth="2"
        aria-hidden
      >
        <path d="M12 2l7 4v6c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6z" />
      </svg>
      <span style={{ fontSize: 11.5, color: "var(--mv3-faint)" }}>
        {children}
      </span>
    </div>
  );
}

/** Epoch → "9:41" local time. */
export function clockLabel(epoch: number): string {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Epoch → "Jun 12" short date. */
export function shortDate(epoch: number): string {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
