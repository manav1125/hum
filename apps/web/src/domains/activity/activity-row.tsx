/**
 * Activity row — the shared row chrome for every Activity section.
 *
 * Layout: an optional status dot, a title + subtitle column carrying the
 * provenance chip (▸ what triggered this), a status pill, and a right-aligned
 * cluster of action buttons. Provenance is the signature feature of this
 * surface — it is always derived from real payload data by the caller and
 * passed in here; this component never fabricates a trigger.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { C, mono } from "./theme";

export type PillTone =
  "neutral" | "blue" | "green" | "amber" | "danger" | "violet";

// Washes derive from the theme accents via color-mix so the pills read
// correctly on both the light canvas and the dark ink.
const wash = (accent: string, pct: number) =>
  `color-mix(in srgb, ${accent} ${pct}%, transparent)`;

const PILL: Record<PillTone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: C.t2, bg: C.sunken, border: C.line2 },
  blue: { fg: C.blueS, bg: C.blueW, border: wash(C.blue, 32) },
  green: { fg: C.green, bg: wash(C.green, 14), border: wash(C.green, 32) },
  amber: { fg: C.amber, bg: wash(C.amber, 14), border: wash(C.amber, 34) },
  danger: { fg: C.danger, bg: wash(C.danger, 12), border: wash(C.danger, 30) },
  violet: { fg: C.violetS, bg: wash(C.violet, 14), border: wash(C.violet, 32) },
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
        ? {
            border: `1px solid ${C.line2}`,
            background: C.surface,
            color: C.danger,
          }
        : variant === "ghost"
          ? {
              border: "1px solid transparent",
              background: "transparent",
              color: C.t2,
            }
          : {
              border: `1px solid ${C.line2}`,
              background: C.surface,
              color: C.t1,
            };
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
  provenanceNode,
  meta,
  statusLabel,
  statusTone = "neutral",
  actions,
  children,
  last = false,
  highlight = false,
}: {
  dotColor?: string;
  title: string;
  subtitle?: string | null;
  /** Honest trigger label, e.g. "Gmail event", "schedule", "manual". */
  provenance?: string | null;
  /**
   * Provenance as a NODE, rendered instead of the plain chip — the
   * `<ProvenanceTrace/>` pill, which opens the full "why is this here" panel.
   * Takes precedence over `provenance` so a row never carries two competing
   * accounts of where the item came from.
   */
  provenanceNode?: ReactNode;
  /** Small right-of-provenance note, e.g. "next in 2h", "12m ago". */
  meta?: string | null;
  statusLabel?: string;
  statusTone?: PillTone;
  actions?: ReactNode;
  /**
   * Optional expanded content rendered below the title/provenance line within
   * the text column — e.g. the Done lane's inline result highlights. The row
   * switches from center- to top-alignment when present so the block flows
   * naturally beneath the single-line header.
   */
  children?: ReactNode;
  last?: boolean;
  /**
   * Deep-link focus: when this row is the target of Home's `?focus=` link, it
   * scrolls itself into view on mount and wears a blue wash + left accent so the
   * run the user just kicked off is unmistakable.
   */
  highlight?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: "center" });
  }, [highlight]);

  return (
    <div
      ref={ref}
      data-slot="activity-row"
      style={{
        display: "flex",
        // Top-align when an expanded child block is present so it flows below
        // the header; otherwise keep the compact center-aligned single-line row.
        alignItems: children ? "flex-start" : "center",
        // Wrap the status pill + action cluster beneath the title when the row
        // is squeezed (e.g. a narrow Mission Control lane). A no-op on the wide
        // Activity page, where everything fits on one line.
        flexWrap: "wrap",
        columnGap: 12,
        rowGap: 8,
        padding: "12px 14px",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        background: highlight ? C.blueW : undefined,
        boxShadow: highlight ? `inset 3px 0 0 ${C.blue}` : undefined,
        transition: "background 200ms",
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
      <div style={{ flex: "1 1 110px", minWidth: 110 }}>
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
        {provenanceNode || provenance || meta ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 4,
              // Wrap the meta beneath the provenance chip in a narrow lane
              // rather than spilling past the column edge.
              flexWrap: "wrap",
              rowGap: 2,
            }}
          >
            {provenanceNode ??
              (provenance ? <ProvenanceChip label={provenance} /> : null)}
            {meta ? (
              <span style={{ fontSize: 11, color: C.t3, fontFamily: mono }}>
                {meta}
              </span>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
      {statusLabel ? (
        <StatusPill label={statusLabel} tone={statusTone} />
      ) : null}
      {actions ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexShrink: 0,
            // Stack the buttons when the cluster is wider than a narrow lane
            // (e.g. Scheduled's Run/Pause/Cancel) instead of overflowing it.
            flexWrap: "wrap",
            rowGap: 6,
            maxWidth: "100%",
          }}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
