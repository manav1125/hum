/**
 * One lane (column) of the Mission Control board.
 *
 * A lane is a labeled, scrollable region with an accent header + count badge.
 * On desktop the five lanes sit side by side as flex columns; on mobile a
 * single lane fills the width and the parent swaps which lane is shown via the
 * lane-tab bar. The lane body is whatever the page passes in — reused Activity
 * section components, the Home feed, etc.
 *
 * Accessibility: each lane is a labeled `region` so screen-reader users can
 * jump between lanes; the count is folded into the accessible name.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { C, mono } from "@/domains/activity/theme";

export interface MissionLaneProps {
  id: string;
  title: string;
  icon: LucideIcon;
  accent: string;
  /** Header tally for this lane (e.g. number of awaiting items). */
  count?: number | null;
  /** Pulse the count badge to draw the eye (used for Awaiting you). */
  urgent?: boolean;
  children: ReactNode;
}

export function MissionLane({
  id,
  title,
  icon: Icon,
  accent,
  count,
  urgent = false,
  children,
}: MissionLaneProps) {
  const showCount = typeof count === "number";
  return (
    <section
      data-slot="mission-lane"
      data-lane={id}
      aria-label={showCount ? `${title}, ${count} items` : title}
      style={{
        display: "flex",
        flexDirection: "column",
        // Fills its grid cell on desktop and grows to fill the board on mobile
        // (single-lane flex-column layout).
        flex: "1 1 auto",
        minWidth: 0,
        minHeight: 0,
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderTop: `3px solid ${accent}`,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 14px",
          borderBottom: `1px solid ${C.line2}`,
          flexShrink: 0,
        }}
      >
        <Icon size={15} color={accent} aria-hidden style={{ flexShrink: 0 }} />
        <span
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: C.t1,
            fontWeight: 600,
          }}
        >
          {title}
        </span>
        {showCount ? (
          <span
            aria-hidden
            style={{
              marginLeft: "auto",
              minWidth: 20,
              height: 20,
              padding: "0 6px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 999,
              fontFamily: mono,
              fontSize: 11,
              fontWeight: 600,
              color: count && count > 0 ? "#fff" : C.t3,
              background: count && count > 0 ? accent : C.sunken,
              animation:
                urgent && count && count > 0
                  ? "cueLanePulse 1.8s ease-out infinite"
                  : "none",
            }}
          >
            {count}
          </span>
        ) : null}
      </header>
      <div
        data-slot="mission-lane-body"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "12px 12px 20px",
          background: C.bg,
        }}
      >
        {children}
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes cueLanePulse{0%{box-shadow:0 0 0 0 rgba(218,73,26,.5)}70%{box-shadow:0 0 0 6px rgba(218,73,26,0)}100%{box-shadow:0 0 0 0 rgba(218,73,26,0)}}",
        }}
      />
    </section>
  );
}
