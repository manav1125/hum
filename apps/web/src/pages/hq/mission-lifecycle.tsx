/**
 * §6 · Mission lifecycle frames — how a mission ends.
 *
 *   Achieved  → the payoff. The receipt of everything it took (cycles · outputs
 *               · spend · time back), made to share. Share copies the summary +
 *               archives; the mission drops into the retrospective.
 *   Paused    → calm & reversible. Linked work is safe, nothing expires;
 *               Resume / Archive.
 *
 * The Drifting frame lives in its own file ({@link import("./drift-nudge")})
 * because it's also droppable on HQ rows. All three are presentational: the
 * verbs are callbacks, so mission-detail wires them to PATCH status / run-cycle
 * / navigate.
 */

import { relativeTime } from "@/domains/activity/theme";

import { C, fmtCents, mono, serif } from "./hq-kit";
import {
  durationLabel,
  type MissionAchievedSummary,
} from "./use-mission-lifecycle";

/**
 * ◆ ACHIEVED · celebration. The dark receipt card: outcome headline, the four
 * life stats, and Share (copy summary + archive to retrospective).
 */
export function AchievedCelebration({
  title,
  outcome,
  summary,
  durationMs,
  spentCents,
  onShare,
  shared = false,
}: {
  title: string;
  outcome: string;
  summary: MissionAchievedSummary | null;
  /** Fallback duration when the rollup hasn't loaded. */
  durationMs?: number | null;
  /** Fallback spend when the rollup hasn't loaded. */
  spentCents?: number;
  onShare?: () => void;
  shared?: boolean;
}) {
  const days = durationLabel(summary?.durationMs ?? durationMs ?? null);
  const spend = summary?.spentCents ?? spentCents ?? 0;
  return (
    <div
      style={{
        background: "linear-gradient(150deg, #16202E, #0C121B)",
        borderRadius: 18,
        padding: "26px 28px",
        color: "#fff",
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.green,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span aria-hidden>◆</span> Mission achieved
        {days ? (
          <span style={{ color: "rgba(255,255,255,.5)" }}>· {days}</span>
        ) : null}
      </div>
      <div
        style={{
          fontFamily: serif,
          fontSize: 30,
          lineHeight: 1.1,
          marginTop: 10,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 13.5,
          color: "rgba(255,255,255,.75)",
          marginTop: 7,
        }}
      >
        {outcome}
      </div>

      {/* Life stats */}
      <div
        style={{
          display: "flex",
          gap: 26,
          flexWrap: "wrap",
          marginTop: 22,
          paddingTop: 20,
          borderTop: "1px solid rgba(255,255,255,.12)",
        }}
      >
        <BigStat
          n={summary ? String(summary.cycles) : "—"}
          label="cycles run"
        />
        <BigStat n={summary ? String(summary.outputs) : "—"} label="outputs" />
        <BigStat n={fmtCents(spend)} label="Cue spend" />
        <BigStat
          n={
            summary && summary.hoursSaved > 0 ? `~${summary.hoursSaved}h` : "—"
          }
          label="yours back"
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 22,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: "rgba(255,255,255,.6)" }}>
          Archived to retrospective — reusable for the next one.
        </span>
        {onShare ? (
          <button
            type="button"
            onClick={onShare}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12.5,
              fontWeight: 500,
              background: shared ? "rgba(255,255,255,.08)" : "#fff",
              color: shared ? "rgba(255,255,255,.8)" : "#0C121B",
              border: "1px solid rgba(255,255,255,.2)",
              borderRadius: 10,
              padding: "9px 16px",
              cursor: "pointer",
            }}
          >
            {shared ? "Copied ✓" : "Share ↗"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BigStat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: serif, fontSize: 26, lineHeight: 1 }}>{n}</div>
      <div
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.06em",
          color: "rgba(255,255,255,.55)",
          marginTop: 5,
        }}
      >
        {label}
      </div>
    </div>
  );
}

/**
 * Build the plain-text share/copy summary for an achieved mission — the string
 * Share writes to the clipboard.
 */
export function buildAchievedShareText(opts: {
  title: string;
  outcome: string;
  summary: MissionAchievedSummary | null;
  spentCents?: number;
}): string {
  const { title, outcome, summary } = opts;
  const days = durationLabel(summary?.durationMs ?? null);
  const spend = summary?.spentCents ?? opts.spentCents ?? 0;
  const lines = [
    `✦ Mission achieved${days ? ` · ${days}` : ""}`,
    title,
    outcome,
    "",
  ];
  if (summary) {
    lines.push(
      `${summary.cycles} cycles · ${summary.outputs} outputs · ${fmtCents(
        spend,
      )} spend${summary.hoursSaved > 0 ? ` · ~${summary.hoursSaved}h back` : ""}`,
    );
  } else {
    lines.push(`${fmtCents(spend)} spend`);
  }
  return lines.join("\n");
}

/**
 * ◼ PAUSED · calm & reversible. Reassures that linked work is held, nothing
 * expires, and offers Resume / Archive.
 */
export function PausedState({
  title,
  pausedAt,
  reason,
  onResume,
  onArchive,
  busy = false,
}: {
  title: string;
  /** When it was paused (epoch ms) for the "3 days ago" line. */
  pausedAt?: number | null;
  /** Optional "paused by you" / "at the budget ceiling" clause. */
  reason?: string | null;
  onResume?: () => void;
  onArchive?: () => void;
  busy?: boolean;
}) {
  const when = relativeTime(pausedAt ?? null);
  return (
    <div
      style={{
        border: `1px solid ${C.line2}`,
        borderRadius: 14,
        padding: 18,
        background: C.sunken,
        opacity: busy ? 0.65 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13.5,
          fontWeight: 600,
          color: C.t1,
        }}
      >
        <span aria-hidden style={{ color: C.t3 }}>
          ⏸
        </span>
        {title}
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            color: C.t3,
            fontWeight: 400,
          }}
        >
          {reason ?? "paused"}
          {when ? ` · ${when}` : ""}
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: C.t2,
          marginTop: 9,
          lineHeight: 1.5,
        }}
      >
        Linked work is safe — threads are held, no outreach sent, agents idle.
        Nothing expires.
      </div>
      <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
        {onResume ? (
          <button
            type="button"
            disabled={busy}
            onClick={onResume}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              padding: "8px 16px",
              borderRadius: 9,
              border: "none",
              background: C.ink,
              color: C.bg,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Resume
          </button>
        ) : null}
        {onArchive ? (
          <button
            type="button"
            disabled={busy}
            onClick={onArchive}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              padding: "8px 16px",
              borderRadius: 9,
              border: `1px solid ${C.line2}`,
              background: C.surface,
              color: C.t2,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Archive
          </button>
        ) : null}
      </div>
    </div>
  );
}
