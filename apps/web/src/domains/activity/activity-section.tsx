/**
 * Activity section chrome — a titled card that wraps a group of activity rows.
 *
 * Renders the section header (icon + title + live count + optional accent),
 * then either a loading line, an honest empty state, or its children rows.
 * Every section on the Activity surface uses this frame so the surface reads
 * as one coherent command center.
 */

import { Loader2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { C, mono } from "./theme";

export function ActivitySection({
  icon: Icon,
  title,
  accent = C.t2,
  count,
  loading = false,
  loadingLabel = "Loading…",
  error = false,
  errorLabel = "Couldn’t load this just now — try again in a moment.",
  empty = false,
  emptyLabel,
  children,
}: {
  icon: LucideIcon;
  title: string;
  accent?: string;
  count?: number;
  loading?: boolean;
  loadingLabel?: string;
  error?: boolean;
  errorLabel?: string;
  empty?: boolean;
  emptyLabel: string;
  children?: ReactNode;
}) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: C.surface,
            border: `1px solid ${C.line}`,
            flexShrink: 0,
          }}
        >
          <Icon size={14} color={accent} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
          {title}
        </span>
        {typeof count === "number" && count > 0 ? (
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: accent,
              border: `1px solid ${C.line2}`,
              borderRadius: 7,
              padding: "1px 7px",
            }}
          >
            {count}
          </span>
        ) : null}
      </div>

      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          background: C.surface,
          overflow: "hidden",
        }}
      >
        {loading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "16px 16px",
              fontSize: 13,
              color: C.t2,
            }}
          >
            <Loader2 className="size-4 animate-spin" /> {loadingLabel}
          </div>
        ) : error ? (
          <div style={{ padding: "16px 16px", fontSize: 13, color: C.t2 }}>
            {errorLabel}
          </div>
        ) : empty ? (
          <div style={{ padding: "16px 16px", fontSize: 13, color: C.t3 }}>
            {emptyLabel}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
