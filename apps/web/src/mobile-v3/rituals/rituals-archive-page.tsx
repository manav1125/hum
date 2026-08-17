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
 * ## Two kinds of row, and the difference is load-bearing
 *
 * **The live rows** — today's brief and this week's review — open the real
 * surfaces, which compose from the live stores. They are the two rituals you
 * can still act on.
 *
 * **The kept rows** are snapshots: what a ritual actually said, recorded by
 * the daemon at the moment it composed it (`ritual_snapshots`, migration 330,
 * read through `GET /rituals/snapshots`). They deliberately do not navigate.
 * `GET /brief/morning` takes no date, so tapping Tuesday through to it would
 * recompute today's numbers under a Tuesday heading — the fabrication rule
 * with a date on it. The stored sentence and its figures ARE the re-read:
 * they were composed on the day and have not been touched since.
 *
 * ## And there is no backfill
 *
 * The snapshot store starts the day it is written. Briefs that went out
 * before it existed cannot be reconstructed — the sliding windows they were
 * computed from have moved on — so this page shows no rows for them and says
 * so in a line instead, for exactly as long as that is true. See
 * `ritual-archive.ts#interimLine`.
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
import { dayLabel, interimLine, keptRows } from "./ritual-archive";
import { useRitualSnapshots } from "./use-ritual-snapshots";

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

const CARD: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "var(--mv3-card)",
  border: "1px solid var(--mv3-card-border)",
  borderRadius: 16,
  padding: "13px 14px",
  fontFamily: "inherit",
  color: "inherit",
  WebkitTapHighlightColor: "transparent",
};

export function Mv3RitualsArchivePage() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stamped once per mount, like every other mv3 surface that phrases a clock
  // — reading the wall clock during render is impure, and this page's row
  // labels and states are all functions of it.
  const [now] = useState(() => new Date());
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const rows = buildRows(now);
  const { archive, loaded } = useRitualSnapshots(assistantId);
  const kept = keptRows(now, archive.snapshots);
  const absence = interimLine(now, archive.storeStartedAt, loaded);

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
                ...CARD,
                cursor: assistantId ? "pointer" : "default",
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

          {/*
            The kept rows. Not buttons: there is nowhere honest to send a tap
            (the live surfaces have no sense of a past date), and a control
            that looks tappable and answers with today's numbers is worse than
            a row that plainly states what it said at the time.
          */}
          {kept.map((row) => (
            <div key={row.key} data-slot="mv3-ritual-kept" style={CARD}>
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
                {row.detail ? (
                  <span style={{ fontSize: 11.5, color: "var(--mv3-muted)" }}>
                    {row.detail}
                  </span>
                ) : null}
              </div>
              {row.sentence ? (
                <div
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: "var(--mv3-muted)",
                    marginTop: 6,
                  }}
                >
                  {row.sentence}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {/*
          The honest line, in the place a longer list would be. Drift the owner
          can see is a decision; drift they discover is a bug — so while the
          log is younger than the history it is meant to hold, the page says
          what it does not have rather than quietly implying that these rows
          are all there has ever been. It removes itself after a week.
        */}
        {absence ? (
          <div
            style={{
              fontSize: 11.5,
              lineHeight: 1.55,
              color: "var(--mv3-muted)",
              marginTop: 16,
              padding: "0 2px",
            }}
          >
            {absence}
          </div>
        ) : null}
      </div>
    </div>
  );
}
