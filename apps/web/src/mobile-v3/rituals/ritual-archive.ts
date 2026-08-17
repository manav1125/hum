/**
 * The archive's model — which kept rows this page may show, and the one
 * sentence it says about the ones it cannot.
 *
 * Pure, so the honesty rules can be tested at a stated clock rather than at
 * whatever time CI happens to run.
 *
 * ## The rule the whole file exists for
 *
 * A kept row is a row that was WRITTEN on the day it names. There is no
 * backfill in the daemon and there is no reconstruction here: a period with
 * no snapshot gets no row, however confidently its numbers could be guessed
 * at. Before the store existed those numbers are simply gone — the brief
 * composed over a sliding window of live stores that have since moved on —
 * and {@link interimLine} says so in words for as long as it is true.
 */

import type { RitualSnapshot } from "./use-ritual-snapshots";

const DAY_MS = 86_400_000;
/** How long the absence is worth stating. After a week the log speaks for itself. */
export const INTERIM_WINDOW_MS = 7 * DAY_MS;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar date key — `2026-08-17`. Matches the daemon's period key. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO week key — `2026-W33`. Matches `assistant/src/rituals/ritual-compose.ts`. */
export function isoWeekKey(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / DAY_MS + 1) / 7);
  return `${year}-W${pad2(week)}`;
}

/** "SUN 16 AUG". */
export function dayLabel(d: Date): string {
  return d
    .toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .toUpperCase();
}

/** The Monday–Sunday span a weekly covers, as words. */
export function spanLabel(startMs: number, endMs: number): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
  return `${fmt(startMs)} — ${fmt(endMs)}`.toUpperCase();
}

export interface KeptRow {
  key: string;
  /** "MON 17 AUG" / "11 AUG — 17 AUG" — the dated half. */
  eyebrow: string;
  title: string;
  /** The sentence as it was composed on the day. */
  sentence: string;
  /** The figures under it, or null when the row carries none. */
  detail: string | null;
}

function briefDetail(facts: RitualSnapshot["facts"]): string | null {
  const parts: string[] = [];
  if (typeof facts.done === "number") {
    parts.push(`${facts.done} finished`);
  }
  if (typeof facts.needsYou === "number" && facts.needsYou > 0) {
    parts.push(`${facts.needsYou} needed you`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function weeklyDetail(facts: RitualSnapshot["facts"]): string | null {
  if (typeof facts.moved !== "number" && typeof facts.slipped !== "number") {
    return null;
  }
  return `${facts.moved ?? 0} moved · ${facts.slipped ?? 0} slipped`;
}

/**
 * The kept rows to render, newest first.
 *
 * Today's brief and this week's review are dropped: the two live rows above
 * already stand for those periods, and the same period twice — once live,
 * once kept — reads as a duplicate rather than as history.
 */
export function keptRows(now: Date, snapshots: RitualSnapshot[]): KeptRow[] {
  const today = dayKey(now);
  const thisWeek = isoWeekKey(today);
  return snapshots
    .filter((s) =>
      s.ritual === "brief" ? s.periodKey !== today : s.periodKey !== thisWeek,
    )
    .map((s) => ({
      key: s.id,
      eyebrow:
        s.ritual === "brief"
          ? dayLabel(new Date(s.composedAt))
          : spanLabel(s.periodStart, s.periodEnd),
      title: s.ritual === "brief" ? "Morning brief" : "Weekly review",
      sentence: s.headline,
      detail:
        s.ritual === "brief" ? briefDetail(s.facts) : weeklyDetail(s.facts),
    }));
}

/**
 * The honest line about what is missing, or null when there is nothing
 * honest left to say.
 *
 * Three states, and the third is the point:
 *
 *   · **Not loaded** — null. An unanswered request is not evidence of
 *     absence, and a page that says "nothing was kept" because a fetch failed
 *     is lying with more confidence than the empty page it replaced.
 *   · **The store is younger than a week** — design's line, which credits the
 *     rituals that ran before anything was written down instead of implying
 *     they never happened.
 *   · **Older than a week** — null. The line stops being true on its own,
 *     which is the property a good interim state has.
 */
export function interimLine(
  now: Date,
  storeStartedAt: number | null,
  loaded: boolean,
): string | null {
  if (!loaded) return null;

  const tail =
    "Earlier briefs weren't saved — they went out and weren't written down.";

  if (storeStartedAt === null) {
    return `Cue only started keeping these today. ${tail}`;
  }
  if (now.getTime() - storeStartedAt >= INTERIM_WINDOW_MS) return null;
  if (dayKey(new Date(storeStartedAt)) === dayKey(now)) {
    return `Cue only started keeping these today. ${tail}`;
  }
  // Past the first day the word "today" would be the exact kind of wrong date
  // this page exists to avoid, so the sentence names the day it started.
  return `Cue started keeping these on ${dayLabel(new Date(storeStartedAt))}. ${tail}`;
}
