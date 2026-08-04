/**
 * The two densities of one census — the Glance strip and the Deck rail.
 *
 * They live in one file because they are one thing seen twice, and keeping
 * them apart is what would let them drift. Both take `HqLaneReading[]` straight
 * off {@link buildHqCensus}; neither computes a number, and neither can: a
 * reading's `stat` is either a queried count or the sentence saying why there
 * isn't one, and there is no third case to invent.
 *
 * What the rail earns over the strip is detail, never data:
 *   · the strip prints `stat` + label;
 *   · the tile prints `stat` + title + the `detail` sentence;
 *   · the Missions tile additionally draws one status ring per mission.
 *
 * Those rings are **status-only** — a full arc tinted by the honest state with
 * the state glyph in the middle. Design's frame draws them as percentages
 * ("74%", "36%"), and there is no percentage to draw: mission progress has no
 * connected metric, so a swept arc would be a fabricated number wearing a
 * chart's clothes. Blocked-ness is drawn here and nowhere else on HQ.
 *
 * No state on either surface is carried by colour alone: every cell and tile
 * prints its lane glyph beside the number, and the failing-watcher case says
 * "can't be reached" in words.
 */

import type { CSSProperties, ReactNode } from "react";
import { Link, useNavigate } from "react-router";

import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import {
  blockedMissions,
  isTappable,
  type HqLaneId,
  type HqLaneReading,
  type LaneTone,
} from "./hq-census";
import type { HqDensity } from "./hq-density";
import {
  C,
  MicroLabel,
  RING_META,
  StatusRing,
  mono,
  type RingStatus,
} from "./hq-kit";
import { useMissionAchievedSummary } from "./use-mission-lifecycle";
import { ringStatusFor, type Mission } from "./use-missions";

/** Tone → the TEXT leg of each hue. Small copy never rides a fill leg. */
function toneColor(tone: LaneTone): string {
  switch (tone) {
    case "good":
      return C.greenText;
    case "attention":
      return C.amberText;
    case "alarm":
      return C.dangerText;
    default:
      return C.t1;
  }
}

// ---------------------------------------------------------------------------
// The toggle
// ---------------------------------------------------------------------------

/** ◒ Glance / ▦ Deck — the one control, top-right. */
export function DensityToggle({
  density,
  onChange,
}: {
  density: HqDensity;
  onChange: (density: HqDensity) => void;
}) {
  const options: Array<{ id: HqDensity; label: string }> = [
    { id: "glance", label: "◒ Glance" },
    { id: "deck", label: "▦ Deck" },
  ];
  return (
    <div
      data-slot="hq-density-toggle"
      role="group"
      aria-label="HQ density"
      title="⌘. switches"
      style={{
        display: "inline-flex",
        background: C.sunken,
        border: `1px solid ${C.line}`,
        borderRadius: 9,
        padding: 2,
      }}
    >
      {options.map((option) => {
        const on = density === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => {
              haptic.light();
              onChange(option.id);
            }}
            style={{
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: on ? 600 : 400,
              color: on ? C.bg : C.t2,
              background: on ? C.ink : "transparent",
              border: "none",
              borderRadius: 6,
              padding: "5px 12px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glance — the footer strip
// ---------------------------------------------------------------------------

/**
 * One footer cell.
 *
 * A cell with a queried count is a button that opens Deck focused on that lane.
 * A cell whose stat is `unknown` is **not** a button: it prints its glyph and
 * the reason, because offering a tap into a lane we could not read is the
 * unreachable-number defect.
 */
function StripCell({
  reading,
  last,
  onOpen,
}: {
  reading: HqLaneReading;
  last: boolean;
  onOpen: (id: HqLaneId) => void;
}) {
  const shell: CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: "13px 8px",
    textAlign: "center",
    borderRight: last ? "none" : `1px solid ${C.line}`,
    background: "none",
    font: "inherit",
  };
  const label = (
    <div
      style={{
        fontFamily: mono,
        fontSize: 8.5,
        letterSpacing: "0.05em",
        color: C.t3,
        marginTop: 3,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {reading.stripLabel}
    </div>
  );

  if (!isTappable(reading) || reading.stat.kind !== "count") {
    return (
      <div
        data-hq-strip-cell={reading.id}
        style={shell}
        title={reading.stat.kind === "unknown" ? reading.stat.why : undefined}
      >
        <div style={{ fontSize: 15, color: C.t3 }} aria-hidden>
          {reading.glyph}
        </div>
        <div
          style={{
            fontSize: 10,
            color: C.t3,
            marginTop: 3,
            lineHeight: 1.3,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {reading.stat.kind === "unknown" ? reading.stat.why : reading.detail}
        </div>
        {label}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-hq-strip-cell={reading.id}
      className="cue-pressable"
      aria-label={`${reading.stripLabel}: ${reading.detail} — open in Deck`}
      onClick={() => {
        haptic.light();
        onOpen(reading.id);
      }}
      style={{ ...shell, border: "none", cursor: "pointer" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: 5,
          fontSize: 17,
          fontWeight: 700,
          color: toneColor(reading.tone),
        }}
      >
        {/* The glyph rides beside the number so the state is never the colour
            alone — the strip is five bare digits otherwise. */}
        <span aria-hidden style={{ fontSize: 10 }}>
          {reading.glyph}
        </span>
        {reading.stat.value}
      </div>
      {label}
    </button>
  );
}

/** The five tappable numbers. Glance is never a dead end. */
export function GlanceStrip({
  cells,
  onOpen,
  valveDoor,
}: {
  cells: HqLaneReading[];
  onOpen: (id: HqLaneId) => void;
  /**
   * The valve control, as a ⚙ at the END of the strip (design V2, door 1).
   *
   * Passed in rather than mounted here so `hq-lane-ui` keeps taking nothing but
   * readings: the strip and the rail are two views of ONE census object, and a
   * component in here that fetched its own state would be the first crack in
   * that. Both densities are handed the same element from the page.
   */
  valveDoor?: ReactNode;
}) {
  return (
    <div
      data-slot="hq-glance-strip"
      style={{
        display: "flex",
        alignItems: "stretch",
        background: C.sunken,
        borderTop: `1px solid ${C.line}`,
      }}
    >
      {cells.map((reading, i) => (
        <StripCell
          key={reading.id}
          reading={reading}
          last={i === cells.length - 1 && !valveDoor}
          onOpen={onOpen}
        />
      ))}
      {valveDoor ? (
        <div
          data-slot="hq-strip-valve"
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            borderLeft: `1px solid ${C.line}`,
          }}
        >
          {valveDoor}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deck — the rail
// ---------------------------------------------------------------------------

/**
 * The mission rings — the one richness Deck earns over Glance.
 *
 * Status-only, four at most, each a door into its mission. This replaces the
 * full-bleed rings hero: the portfolio's health reads in one tile instead of
 * one screen, and blocked-ness stops being drawn three times.
 */
function MissionRings({
  assistantId,
  missions,
}: {
  assistantId: string;
  missions: Mission[];
}) {
  const shown = missions.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 9, marginTop: 10 }}>
      {shown.map((m) => (
        <MissionRing key={m.id} assistantId={assistantId} mission={m} />
      ))}
    </div>
  );
}

/**
 * One ring, its title, and — when blocked — how many cycles it has run.
 *
 * The cycle count is design's V3 requirement and the one number the ring is
 * allowed to carry, because it is measured rather than modelled: the daemon
 * counts distinct `cycleId`s in the mission's own event trail. It is fetched
 * ONLY for a blocked mission, which is both the frame's rule and a cost one:
 * the missions list does not carry it, so every count is a request, and a
 * request per healthy ring would buy nothing.
 *
 * When that request has not landed the label is simply `BLOCKED` — exactly the
 * unavailable twin design's own frame draws beside "BLOCKED 12c". A pending
 * count renders as no count; it never renders as `0c`, which would say this
 * mission has never run.
 */
function MissionRing({
  assistantId,
  mission,
}: {
  assistantId: string;
  mission: Mission;
}) {
  const navigate = useNavigate();
  const status = ringStatusFor(mission);
  const blocked = status === "blocked";
  const { summary } = useMissionAchievedSummary(
    assistantId,
    mission.id,
    blocked,
  );
  const cycles = blocked && summary ? summary.cycles : null;
  const stateLine = blocked
    ? cycles == null
      ? "BLOCKED"
      : `BLOCKED ${cycles}c`
    : RING_META[status].label.toUpperCase();
  return (
    <button
      type="button"
      className="cue-pressable"
      title={`${mission.title} — ${RING_META[status].label}${cycles == null ? "" : ` · ${cycles} cycles run`}`}
      onClick={() => {
        haptic.light();
        navigate(routes.hqMission(mission.id));
      }}
      style={{
        flex: 1,
        minWidth: 0,
        background: "none",
        border: "none",
        padding: 0,
        font: "inherit",
        cursor: "pointer",
        textAlign: "center",
      }}
    >
      <StatusRing status={status} size={38} stroke={4.5} />
      <div
        style={{
          fontSize: 8.5,
          color: status === "on_track" ? C.t3 : toneColorForRing(status),
          marginTop: 4,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {mission.title}
      </div>
      {/* The state in words under every ring — no ring's meaning is carried by
          its colour and sweep alone. */}
      <div
        data-slot="hq-ring-state"
        style={{
          fontFamily: mono,
          fontSize: 7.5,
          letterSpacing: "0.06em",
          color: status === "on_track" ? C.t3 : toneColorForRing(status),
          marginTop: 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {stateLine}
      </div>
    </button>
  );
}

function toneColorForRing(status: RingStatus): string {
  if (status === "blocked") return C.dangerText;
  if (status === "needs_you") return C.amberText;
  if (status === "moving") return C.blueText;
  return C.t3;
}

/** One rail tile: header (glyph · title · stat ›) then the detail sentence. */
function RailTile({
  reading,
  focused,
  children,
}: {
  reading: HqLaneReading;
  focused: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      data-hq-lane={reading.id}
      data-slot="hq-rail-tile"
      style={{
        background: C.surface,
        border: focused
          ? `1px solid color-mix(in srgb, ${C.blue} 55%, ${C.line})`
          : `1px solid ${C.line}`,
        boxShadow: focused
          ? `0 0 0 3px color-mix(in srgb, ${C.blue} 16%, transparent)`
          : "none",
        borderRadius: 11,
        padding: "11px 13px",
        transition: "box-shadow .3s ease, border-color .3s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span aria-hidden style={{ fontSize: 11, color: C.t3 }}>
          {reading.glyph}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1, minWidth: 0 }}>
          {reading.tileTitle}
        </span>
        {reading.stat.kind === "count" ? (
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              fontWeight: 600,
              color: toneColor(reading.tone),
            }}
          >
            {reading.stat.value}
          </span>
        ) : null}
        <Link
          to={reading.href}
          aria-label={`Open ${reading.tileTitle}`}
          style={{ fontSize: 10, color: C.t3, textDecoration: "none" }}
        >
          ›
        </Link>
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: "var(--hq-muted)",
          marginTop: 6,
          lineHeight: 1.5,
        }}
      >
        {reading.detail}
      </div>
      {/* The valve's honesty note. Rendered wherever the lane is, because a
          lane the valve has not judged must not read as one it has. */}
      {reading.caveat ? (
        <div
          data-slot="hq-lane-caveat"
          style={{
            fontSize: 10,
            color: C.amberText,
            marginTop: 5,
            lineHeight: 1.45,
          }}
        >
          {reading.caveat}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The 300px rail — five live tiles, always visible, never scrolls.
 *
 * "Never scrolls" is why every tile is a fixed-height statement rather than a
 * list: the moment a tile grows rows, the rail becomes a second scroll region
 * and HQ is back to being a mile of it.
 */
export function HqRail({
  assistantId,
  tiles,
  missions,
  focus,
  valveDoor,
}: {
  assistantId: string;
  tiles: HqLaneReading[];
  /** Open missions — the rings. Blocked-ness is derived once, in the census. */
  missions: Mission[];
  focus: HqLaneId | null;
  /**
   * "Reaching you: Needs you ▾" — the rail's first row (design V2, door 1).
   *
   * It sits above the tiles because it is the sentence that qualifies all of
   * them: the rail's numbers are what the valve let through, and a rail that
   * showed them without saying so would let an unfiltered board pass for a
   * filtered one. Same element the Glance strip is handed — one control.
   */
  valveDoor?: ReactNode;
}) {
  return (
    <aside
      data-slot="hq-rail"
      aria-label="Everything else, at a glance"
      style={{
        width: 300,
        flexShrink: 0,
        background: C.sunken,
        borderLeft: `1px solid ${C.line}`,
        padding: "18px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        // The rail is a statement board, not a second feed. If it ever needs a
        // scrollbar, a tile has started growing and that is the bug.
        overflow: "hidden",
      }}
    >
      {valveDoor}
      <MicroLabel style={{ fontSize: 9, letterSpacing: "0.12em" }}>
        Everything else · at a glance
      </MicroLabel>
      {tiles.map((reading) => (
        <RailTile
          key={reading.id}
          reading={reading}
          focused={focus === reading.id}
        >
          {reading.id === "blocked" ? (
            <MissionRings assistantId={assistantId} missions={missions} />
          ) : null}
          {reading.id === "blocked" && blockedMissions(missions).length > 0 ? (
            <div
              style={{
                fontSize: 9.5,
                color: C.dangerText,
                marginTop: 9,
                paddingTop: 8,
                borderTop: `1px solid ${C.line}`,
              }}
            >
              ◼ {blockedMissions(missions).length} blocked on your call —{" "}
              <Link
                to={routes.allWork}
                style={{ color: C.dangerText, textDecoration: "underline" }}
              >
                decide ›
              </Link>
            </div>
          ) : null}
        </RailTile>
      ))}
      <div style={{ marginTop: "auto", textAlign: "center", paddingTop: 6 }}>
        <Link
          to={routes.allWork}
          style={{ fontSize: 11, color: C.blueText, textDecoration: "none" }}
        >
          Open All work ›
        </Link>
      </div>
    </aside>
  );
}

export { isTappable };
