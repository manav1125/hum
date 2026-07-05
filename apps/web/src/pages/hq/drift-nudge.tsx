/**
 * §6 · Drifting — the honest nudge.
 *
 * "📈 $40K MRR hasn't moved in 6 cycles — stuck on the pricing decision.
 *  Growth is idling with nothing to run. Want to replan the approach, step in
 *  yourself, or pause the ring?"  →  Replan · Step in · Pause.
 *
 * A mission is "drifting" when the orchestrator has burned N cycles with no
 * progress-bearing event (item_enqueued / output_ready). The backend records a
 * `checkpoint` event with `{ drift: true }`; {@link driftFromEvents} reads that
 * marker off a mission's event list so the card only shows on a real nudge.
 *
 * Presentational: the three actions are callbacks. Mission detail wires Replan
 * → run-cycle, Step in → open thread, Pause → PATCH status; HQ can drop the
 * same card on a came-in / mission row with its own handlers.
 */

import { C, mono } from "./hq-kit";

export interface DriftInfo {
  /** Cycles idled without progress (from the checkpoint payload). */
  idleCycles: number | null;
  /** When the drift nudge was recorded (epoch ms). */
  at: number | null;
}

/** Minimal event shape — matches the mission-events list rows. */
interface DriftEventLike {
  kind: string;
  payload: string | null;
  at: number;
}

/**
 * Pull the most-recent drift marker off a mission's events, or null if the
 * mission isn't drifting. A drift marker is a `checkpoint` whose JSON payload
 * carries `drift: true`.
 */
export function driftFromEvents(
  events: readonly DriftEventLike[],
): DriftInfo | null {
  // Events arrive chronological; scan from newest.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "checkpoint" || !e.payload) continue;
    try {
      const p = JSON.parse(e.payload) as {
        drift?: unknown;
        idleCycles?: unknown;
      };
      if (p.drift === true) {
        return {
          idleCycles: typeof p.idleCycles === "number" ? p.idleCycles : null,
          at: e.at,
        };
      }
    } catch {
      // Non-JSON checkpoint — keep scanning.
    }
  }
  return null;
}

/**
 * The drift nudge card. `title` is the mission/metric name; `stuckOn` is the
 * optional "stuck on the pricing decision" clause. Actions default to hidden
 * when their handler is omitted, so HQ and mission-detail can offer whichever
 * subset fits the surface.
 */
export function DriftNudge({
  title,
  metric,
  idleCycles,
  stuckOn,
  busy = false,
  compact = false,
  onReplan,
  onStepIn,
  onPause,
}: {
  title: string;
  /** Metric glyph/label prefix, e.g. "$40K MRR" — defaults to the title. */
  metric?: string | null;
  idleCycles?: number | null;
  stuckOn?: string | null;
  busy?: boolean;
  compact?: boolean;
  onReplan?: () => void;
  onStepIn?: () => void;
  onPause?: () => void;
}) {
  const cyclesLabel =
    idleCycles && idleCycles > 0
      ? `hasn't moved in ${idleCycles} cycle${idleCycles === 1 ? "" : "s"}`
      : "has stalled";
  return (
    <div
      role="alert"
      style={{
        border: `1px solid color-mix(in srgb, ${C.amber} 45%, ${C.line})`,
        borderRadius: 13,
        padding: compact ? 13 : 15,
        background: `color-mix(in srgb, ${C.amber} 7%, ${C.surface})`,
        opacity: busy ? 0.65 : 1,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.amber,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span aria-hidden>!</span> Drifting
      </div>
      <div
        style={{
          fontSize: 13.5,
          color: C.t1,
          fontWeight: 500,
          marginTop: 8,
          lineHeight: 1.4,
        }}
      >
        {metric ?? title} {cyclesLabel}
        {stuckOn ? (
          <span style={{ color: C.t2, fontWeight: 400 }}> — {stuckOn}</span>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: C.t2,
          marginTop: 6,
          lineHeight: 1.45,
        }}
      >
        Idling with nothing to run. Want to replan the approach, step in
        yourself, or pause the ring?
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {onReplan ? (
          <DriftBtn label="Replan" primary busy={busy} onClick={onReplan} />
        ) : null}
        {onStepIn ? (
          <DriftBtn label="Step in" busy={busy} onClick={onStepIn} />
        ) : null}
        {onPause ? (
          <DriftBtn label="Pause" busy={busy} onClick={onPause} />
        ) : null}
      </div>
    </div>
  );
}

function DriftBtn({
  label,
  primary = false,
  busy = false,
  onClick,
}: {
  label: string;
  primary?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: 500,
        padding: "7px 14px",
        borderRadius: 9,
        cursor: busy ? "default" : "pointer",
        border: primary ? "none" : `1px solid ${C.line2}`,
        background: primary ? C.ink : C.surface,
        color: primary ? C.bg : C.t2,
      }}
    >
      {label}
    </button>
  );
}
