/**
 * Shared card chrome for dashboard widgets.
 *
 * Title row (eyebrow + optional action slot) over a body that switches between
 * loading / error / empty / content states. Matches the v0.3 card styling
 * (surface fill, hairline border, rounded corners, DM Mono eyebrow).
 */

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { C, mono } from "../theme";

export interface WidgetFrameProps {
  title: string;
  /** Optional small note rendered to the right of the title (e.g. provenance). */
  badge?: ReactNode;
  /** Optional action control rendered at the far right of the header. */
  action?: ReactNode;
  /** Make the card span the full grid width (e.g. the query bar). */
  span?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  error?: boolean;
  errorLabel?: string;
  /** When true (and not loading/error), render the empty slot. */
  empty?: boolean;
  emptyLabel?: string;
  children?: ReactNode;
}

export function WidgetFrame({
  title,
  badge,
  action,
  span,
  loading,
  loadingLabel = "Loading…",
  error,
  errorLabel = "Couldn’t load this just now.",
  empty,
  emptyLabel = "Nothing here yet.",
  children,
}: WidgetFrameProps) {
  return (
    <section
      style={{
        gridColumn: span ? "1 / -1" : undefined,
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          {title}
        </span>
        {badge ? <span style={{ minWidth: 0 }}>{badge}</span> : null}
        {action ? <div style={{ marginLeft: "auto" }}>{action}</div> : null}
      </header>

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "16px 0",
            fontSize: 13,
            color: C.t2,
          }}
        >
          <Loader2 className="size-4 animate-spin" /> {loadingLabel}
        </div>
      ) : error ? (
        <div style={{ fontSize: 13, color: C.t2, padding: "8px 0" }}>
          {errorLabel}
        </div>
      ) : empty ? (
        <div style={{ fontSize: 13, color: C.t3, padding: "8px 0" }}>
          {emptyLabel}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/** Provenance pill used by the connector-query widget ("via Cue · …"). */
export function ProvenanceBadge({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10,
        letterSpacing: "0.04em",
        color: C.t3,
        border: `1px solid ${C.line2}`,
        borderRadius: 999,
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Small colored status dot. */
export function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: color,
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}
