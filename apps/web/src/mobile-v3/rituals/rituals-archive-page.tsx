/**
 * "Briefs & reviews" — the ⋯ entry design ruled *in addition to* the slot.
 *
 * **The slot is the door when a ritual is due; this list is the door when you
 * are looking for one.** That order is the whole ruling. Making the archive
 * the primary door is the mistake that got us here: rituals are time-based and
 * a menu has no sense of time, so in ⋯ these two surfaces were eleventh and
 * twelfth in an alphabetical list — linked, and still dark for weeks. The
 * ritual slot on Today is the fix; this page exists so that "where was that
 * brief" has an answer at 4pm on a Wednesday.
 *
 * ## What this page can honestly list, and what it cannot
 *
 * Design asked for "a dated archive of past ones". **There is no archive.**
 * `GET /brief/morning` composes today's brief from a sliding lookback window
 * over the live stores; it takes no date and there is no per-day snapshot
 * anywhere in the daemon. The weekly is the same shape over a seven-day
 * window. Opening "Tuesday's brief" would therefore not open Tuesday's
 * brief — it would recompute today's numbers under a Tuesday heading, which
 * is the fabrication rule with a date on it.
 *
 * So the list is dated and real: **today's brief and this week's review**,
 * each with the date it covers and the state it is in. The absence of history
 * is stated in a line rather than filled with plausible rows. When the daemon
 * grows a brief archive this page gains rows and nothing else about it
 * changes — which is the point of it being a list rather than two buttons.
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { LargeTitleHeader } from "../large-title-header";
import { microLabel } from "../mv3-kit";
import { readRitualProgress } from "../today/ritual-progress";
import { isBriefWindow, isWeeklyWindow } from "../today/ritual-slot";

const SAFE_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";

interface Row {
  key: string;
  /** "TODAY · SUN 16 AUG" — the dated half. */
  eyebrow: string;
  title: string;
  /** Where it stands right now, in words that are true of this row only. */
  state: string;
  href: string;
}

/** "SUN 16 AUG". */
function dayLabel(d: Date): string {
  return d
    .toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .toUpperCase();
}

/** The Monday–Sunday span the weekly review covers, as words. */
function weekLabel(now: Date): string {
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${fmt(start)} — ${fmt(end)}`.toUpperCase();
}

function buildRows(now: Date): Row[] {
  const brief = readRitualProgress("brief", now);
  const weekly = readRitualProgress("weekly", now);
  return [
    {
      key: "brief",
      eyebrow: `TODAY · ${dayLabel(now)}`,
      title: "Morning brief",
      state: brief.read
        ? "Read"
        : isBriefWindow(now)
          ? "Ready · 2 min"
          : "Today's, still here",
      href: routes.brief,
    },
    {
      key: "weekly",
      eyebrow: `THIS WEEK · ${weekLabel(now)}`,
      title: "Weekly review",
      state: weekly.read
        ? "Read"
        : isWeeklyWindow(now)
          ? "Ready · 4 beats"
          : "Ready Friday · 4 beats",
      href: routes.weekly,
    },
  ];
}

export function Mv3RitualsArchivePage() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stamped once per mount, like every other mv3 surface that phrases a clock
  // — reading the wall clock during render is impure, and this page's row
  // labels and states are all functions of it.
  const [now] = useState(() => new Date());
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const rows = buildRows(now);

  return (
    <div
      data-mv3
      data-slot="mv3-rituals-archive"
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        overflow: "clip",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />
      {/* No eyebrow: the primitive's is a mono uppercase line directly above
          the title, and "BRIEFS & REVIEWS / Briefs & reviews" is the same
          words twice. Each row carries its own dated label instead, which is
          where a date on this page actually means something. */}
      <LargeTitleHeader title="Briefs & reviews" scrollRef={scrollRef} />

      <div
        ref={scrollRef}
        style={{
          position: "relative",
          zIndex: 2,
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: `4px 16px calc(${SAFE_BOTTOM} + 96px)`,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((row) => (
            <button
              key={row.key}
              type="button"
              className="cue-pressable"
              disabled={!assistantId}
              onClick={() => {
                haptic.light();
                void navigate(row.href);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 16,
                padding: "13px 14px",
                fontFamily: "inherit",
                color: "inherit",
                cursor: assistantId ? "pointer" : "default",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <div
                style={{
                  ...microLabel,
                  fontSize: 9,
                  color: "var(--mv3-muted)",
                }}
              >
                {row.eyebrow}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  marginTop: 5,
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 600 }}>
                  {row.title}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{ fontSize: 11.5, color: "var(--mv3-accent-text)" }}
                >
                  {row.state}
                </span>
              </div>
            </button>
          ))}
        </div>

        {/*
          The honest line, in the place a longer list would be. Drift the owner
          can see is a decision; drift they discover is a bug — so the page
          says what it does not have rather than quietly implying that two rows
          is all there has ever been.
        */}
        <div
          style={{
            fontSize: 11.5,
            lineHeight: 1.55,
            color: "var(--mv3-muted)",
            marginTop: 16,
            padding: "0 2px",
          }}
        >
          Cue keeps the current brief and this week's review. Earlier ones
          aren't stored yet, so there's nothing older to open.
        </div>
      </div>
    </div>
  );
}
