/**
 * Activity row — the shared row chrome for every Activity section.
 *
 * Layout: an optional status dot, a title + subtitle column carrying the
 * provenance chip (▸ what triggered this), a status pill, and a right-aligned
 * cluster of action buttons. Provenance is the signature feature of this
 * surface — it is always derived from real payload data by the caller and
 * passed in here; this component never fabricates a trigger.
 */

import type { ReactNode } from "react";

import { C, mono } from "./theme";

export type PillTone = "neutral" | "blue" | "green" | "amber" | "danger" | "violet";

const PILL: Record<PillTone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: C.t2, bg: C.sunken, border: C.line2 },
  blue: { fg: C.blueS, bg: C.blueW, border: "#C3D3F6" },
  green: { fg: C.green, bg: "#E4F2E8", border: "#BFE0CA" },
  amber: { fg: "#8C7225", bg: "#FCF3DD", border: "#ECD9A6" },
  danger: { fg: C.danger, bg: "#FDE7E2", border: "#F3C5BA" },
  violet: { fg: C.violetS, bg: "#EEEDFB", border: "#D6D2F4" },
};

export function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: PillTone;
}) {
  const c = PILL[tone];
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        padding: "2px 7px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Provenance chip — "▸ triggered by …". Rendered only when the caller can
 * honestly derive a trigger from the payload; callers omit it otherwise.
 */
export function ProvenanceChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        color: C.t3,
        whiteSpace: "nowrap",
      }}
      title={`Triggered by ${label}`}
    >
      <span style={{ color: C.violet }}>▸</span>
      {label}
    </span>
  );
}

export type RowButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function RowButton({
  label,
  variant = "secondary",
  disabled = false,
  onClick,
}: {
  label: string;
  variant?: RowButtonVariant;
  disabled?: boolean;
  onClick: () => void;
}) {
  const style =
    variant === "primary"
      ? { border: `1px solid ${C.blue}`, background: C.blue, color: "#fff" }
      : variant === "danger"
        ? { border: `1px solid ${C.line2}`, background: C.surface, color: C.danger }
        : variant === "ghost"
          ? { border: "1px solid transparent", background: "transparent", color: C.t2 }
          : { border: `1px solid ${C.line2}`, background: C.surface, color: C.t1 };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 12,
        fontWeight: 500,
        borderRadius: 8,
        padding: "5px 10px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...style,
      }}
    >
      {label}
    </button>
  );
}

export function ActivityRow({
  dotColor,
  title,
  subtitle,
  provenance,
  meta,
  statusLabel,
  statusTone = "neutral",
  actions,
  last = false,
}: {
  dotColor?: string;
  title: string;
  subtitle?: string | null;
  /** Honest trigger label, e.g. "Gmail event", "schedule", "manual". */
  provenance?: string | null;
  /** Small right-of-provenance note, e.g. "next in 2h", "12m ago". */
  meta?: string | null;
  statusLabel?: string;
  statusTone?: PillTone;
  actions?: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
      }}
    >
      {dotColor ? (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            background: dotColor,
            flexShrink: 0,
          }}
        />
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: C.t1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: 12,
              color: C.t2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginTop: 1,
            }}
          >
            {subtitle}
          </div>
        ) : null}
        {provenance || meta ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 4,
            }}
          >
            {provenance ? <ProvenanceChip label={provenance} /> : null}
            {meta ? (
              <span style={{ fontSize: 11, color: C.t3, fontFamily: mono }}>
                {meta}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {statusLabel ? <StatusPill label={statusLabel} tone={statusTone} /> : null}
      {actions ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
