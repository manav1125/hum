/**
 * Mission-detail (mobile) derivations — round-4 frame 58's honest reads over
 * the REAL mission data (no invented cadence times, no fabricated agents):
 *   · sweepsFromEvents — the "RECENT SWEEPS" rows, grouped per calendar day
 *     from the mission's event feed, honest about "no action" days.
 *   · cadenceLine — "sweeps daily" from the mission's cadence field (the
 *     frame's "8am" is not in the data model, so it is NOT rendered).
 *   · owningAgent — the roster agent most of the mission's work is assigned
 *     to; null when nothing is attributable (never fake an identity).
 *   · missionStatusLabel — the "MISSION · ON TRACK" microlabel leg.
 */
import type { AgentCharter } from "@/pages/hq-agents/charters";
import type {
  Mission,
  MissionEvent,
  HqWorkItem,
} from "@/pages/hq/use-missions";
import { ringStatusFor } from "@/pages/hq/use-missions";

export interface SweepRow {
  key: string;
  /** "Today 8:00" · "Yesterday" · "Jul 18". */
  dayLabel: string;
  /** "4 items queued" · "no action" · "paused for you" · "hit an error". */
  summary: string;
  tone: "ok" | "quiet" | "attention" | "error";
}

function dayKey(at: number): string {
  return new Date(at).toDateString();
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Group the mission's event feed into per-day sweep rows (newest first,
 * capped). A day counts as a sweep when a cycle actually started; what the
 * cycle DID comes from its enqueue/checkpoint/error events. A cycle that
 * assessed and moved nothing reads "no action" — the honest day (spec).
 */
export function sweepsFromEvents(
  events: MissionEvent[],
  now = Date.now(),
  max = 7,
): SweepRow[] {
  const byDay = new Map<
    string,
    { at: number; cycles: number; enqueued: number; checkpoint: boolean; error: boolean }
  >();
  for (const e of events) {
    const key = dayKey(e.at);
    const day = byDay.get(key) ?? {
      at: e.at,
      cycles: 0,
      enqueued: 0,
      checkpoint: false,
      error: false,
    };
    day.at = Math.max(day.at, e.at);
    if (e.kind === "cycle_started") day.cycles += 1;
    if (e.kind === "item_enqueued") day.enqueued += 1;
    if (e.kind === "checkpoint") day.checkpoint = true;
    if (e.kind === "error") day.error = true;
    byDay.set(key, day);
  }

  const rows: SweepRow[] = [];
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(now - 86_400_000);
  const days = [...byDay.entries()]
    .filter(([, d]) => d.cycles > 0)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, max);
  for (const [key, d] of days) {
    const dayLabel =
      key === todayKey
        ? `Today ${clock(d.at)}`
        : key === yesterdayKey
          ? "Yesterday"
          : new Date(d.at).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            });
    let summary: string;
    let tone: SweepRow["tone"];
    if (d.error) {
      summary = "hit an error";
      tone = "error";
    } else if (d.checkpoint) {
      summary = "paused for you";
      tone = "attention";
    } else if (d.enqueued > 0) {
      summary = `${d.enqueued} item${d.enqueued === 1 ? "" : "s"} queued`;
      tone = "ok";
    } else {
      summary = "no action";
      tone = "quiet";
    }
    rows.push({ key, dayLabel, summary, tone });
  }
  return rows;
}

/**
 * "sweeps daily · 8:00 AM" — cadence straight from the mission, the clock
 * from its `sweepAt` ("HH:mm", daemon-local). Legacy rows without a sweep
 * clock (pre-migration-309 daemons or sweepAt PATCHed to null) keep the
 * clock-less "sweeps daily" — never invent a time. Hourly cadence has no
 * meaningful clock, so it stays clock-less too.
 */
export function cadenceLine(
  cadence: string | null,
  sweepAt?: string | null,
): string {
  const c = cadence === "hourly" || cadence === "weekly" ? cadence : "daily";
  if (c === "hourly") return "sweeps hourly";
  const clockLabel = sweepAt ? formatSweepAt(sweepAt) : null;
  return clockLabel ? `sweeps ${c} · ${clockLabel}` : `sweeps ${c}`;
}

/** "08:00" → "8:00 AM" · "21:30" → "9:30 PM"; null for malformed input. */
export function formatSweepAt(sweepAt: string): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(sweepAt.trim());
  if (!match) return null;
  const hour24 = Number(match[1]);
  const minute = match[2];
  const meridiem = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${meridiem}`;
}

/**
 * The roster agent most of this mission's work items are assigned to
 * (case-insensitive `assignee` match, same key `useAgentFor` uses). Null when
 * no item names a roster agent — the caller renders "Cue runs it" then.
 */
export function owningAgent(
  items: HqWorkItem[],
  charters: AgentCharter[],
): AgentCharter | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = (item.assignee ?? "").trim().toLowerCase();
    if (!key || key === "you" || key === "cue") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: AgentCharter | null = null;
  let bestCount = 0;
  for (const c of charters) {
    const n =
      (counts.get(c.name.trim().toLowerCase()) ?? 0) +
      (counts.get(c.id.toLowerCase()) ?? 0);
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/**
 * The mono microlabel: "MISSION · ON TRACK" (uppercased at render).
 *
 * `moving` is folded into the `on_track` TONE rather than given one of its
 * own: the phone's tone set is a palette, not a state machine, and a fourth
 * hue here would be a colour with no legend. The word still changes, so the
 * distinction survives where it is carried — in the text.
 */
export function missionStatusLabel(mission: Mission): {
  text: string;
  tone: "on_track" | "needs_you" | "blocked" | "achieved";
} {
  if (mission.status === "achieved")
    return { text: "Mission · achieved", tone: "achieved" };
  const ring = ringStatusFor(mission);
  const leg =
    mission.status === "paused"
      ? "paused"
      : ring === "on_track"
        ? "on track"
        : ring === "moving"
          ? "moving"
          : ring === "needs_you"
            ? "needs you"
            : ring === "stalled"
              ? "nothing running"
              : "blocked";
  // `stalled` is folded into the `blocked` HUE for the same reason `moving` is
  // folded into `on_track`: the phone's tone set is a palette, not a state
  // machine. "Not progressing" is the honest half these two share, and the
  // word carries the difference — nothing stopped a stalled mission.
  const tone =
    ring === "moving" ? "on_track" : ring === "stalled" ? "blocked" : ring;
  return { text: `Mission · ${leg}`, tone };
}
