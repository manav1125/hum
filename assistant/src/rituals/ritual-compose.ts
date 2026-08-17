/**
 * Composing a ritual, server-side, so there is something to keep.
 *
 * The brief and the weekly are composed here from the same stores and the
 * same definitions their surfaces use, and the result is what
 * `ritual-snapshot-job.ts` records. Two things follow from that and both are
 * deliberate:
 *
 *   · **Compose, not read.** A snapshot is written when a ritual is composed,
 *     never when one is read. `GET /brief/morning` composing on demand is a
 *     read — it happens whenever an app is opened, at any hour, and writing
 *     there would also make a GET mutate state (see runtime/CLAUDE.md). The
 *     job below composes once per period, on the daemon's own clock.
 *
 *   · **The sentence is composed from the figures, never written around
 *     them.** Design's rule, and the reason `composeBriefSnapshot` returns
 *     null rather than a vague line when the figures cannot be computed: a
 *     serif sentence is not licence to be vague. A period with no honest
 *     figures gets no row, and the archive says so.
 *
 * The weekly's two numbers are derived here rather than read off an endpoint
 * because there is no server-side weekly today — the Weekly page and the
 * ritual slot both fold `workitemsGet` + `actsSummaryGet` client-side through
 * `apps/web/src/mobile-v3/weekly/weekly-signal.ts`. The definitions below are
 * that file's, restated against the store types, and `ritual-snapshot-job.test.ts`
 * pins them against seeded work items so the two cannot drift silently apart.
 */

import { localClock } from "../notifications/local-clock.js";
import { buildMorningBrief } from "../runtime/routes/morning-brief-routes.js";
import { getLogger } from "../util/logger.js";
import { getActsSummary } from "../work-items/agent-act-store.js";
import { withRanProvenance } from "../work-items/work-item-provenance.js";
import { listWorkItems, type WorkItem } from "../work-items/work-item-store.js";
import { deriveWaitingState } from "../work-items/work-item-waiting.js";
import type {
  BriefSnapshotFacts,
  RecordRitualSnapshotInput,
  WeeklySnapshotFacts,
} from "./ritual-snapshot-store.js";

const log = getLogger("ritual-compose");

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Nothing has touched it in this long → it slipped (weekly-signal.ts). */
export const STALE_DAYS = 5;

const DONE_STATUSES = new Set(["done", "completed"]);
const CLOSED_STATUSES = new Set(["done", "completed", "cancelled", "archived"]);

// ---------------------------------------------------------------------------
// Period keys — the archive's headings
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The weekday of a `YYYY-MM-DD` key (0 Sun … 6 Sat), read back out of the key
 * rather than off the `Date`, so a daemon in UTC and a configured timezone
 * agree about which day it is.
 */
export function weekdayOfDateKey(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/**
 * ISO week key — `2026-W33`. Friday-from-noon through Sunday all land in one
 * ISO week, which is exactly the span the weekly's window covers, so one
 * weekly snapshot per ISO week needs no special-casing of the weekend.
 */
export function isoWeekKey(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  // ISO: Thursday of the same week decides the year and the week number.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / DAY_MS + 1) / 7);
  return `${year}-W${pad2(week)}`;
}

// ---------------------------------------------------------------------------
// Sentences — the same three shapes the slot and the push use
// ---------------------------------------------------------------------------

const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** Small numbers as words — a sentence does not open with a numeral. */
function spell(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "no";
  return n < WORDS.length ? WORDS[n]! : String(n);
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The brief's stored line. Mirrors `ritual-slot.ts#briefSentence`. */
export function briefSentence(input: {
  done: number;
  needsYou: number;
}): string {
  if (input.done > 0) {
    return `While you slept, Cue finished ${spell(input.done)} ${
      input.done === 1 ? "thing" : "things"
    }.`;
  }
  if (input.needsYou > 0) return "Nothing finished overnight.";
  return "All quiet overnight.";
}

/** The weekly's stored line. Mirrors `ritual-slot.ts#weeklySentence`. */
export function weeklySentence(input: {
  moved: number;
  slipped: number;
}): string {
  const { moved, slipped } = input;
  if (moved === 0 && slipped === 0) return "A quiet week.";
  const first =
    moved === 0
      ? "Nothing moved."
      : `${cap(spell(moved))} ${moved === 1 ? "thing" : "things"} moved.`;
  const second =
    slipped === 0 ? "Nothing slipped." : `${cap(spell(slipped))} slipped.`;
  return `${first} ${second}`;
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/**
 * Compose today's brief and shape it into a snapshot.
 *
 * Runs the real `buildMorningBrief` — the same function `GET /brief/morning`
 * serves — so the recorded figures are the brief's figures and not a second
 * opinion about them. Returns null when the compose throws: a period with no
 * honest figures gets no row rather than a row of zeros, because a stored
 * zero is a claim that nothing happened.
 */
export async function composeBriefSnapshot(
  now: Date,
  timezone: string | null,
): Promise<RecordRitualSnapshotInput | null> {
  let brief: Awaited<ReturnType<typeof buildMorningBrief>>;
  try {
    brief = await buildMorningBrief({ now });
  } catch (err) {
    log.warn({ err: String(err) }, "brief compose failed; no snapshot written");
    return null;
  }

  const done = brief.overnight.filter((o) => o.state === "done").length;
  const review = brief.overnight.filter((o) => o.state === "review").length;
  // The ask is the same item the overnight list drops, so it is added once
  // and never double-counted — the identical reconciliation the push makes.
  let needsYou = review;
  if (brief.ask?.kind === "approval") needsYou += 1;
  else if (brief.ask?.kind === "review" && review === 0) needsYou = 1;

  const facts: BriefSnapshotFacts = {
    done,
    review,
    needsYou,
    dayEntries: brief.day.length,
    calendarAvailable: brief.calendarAvailable,
  };

  const composedAt = Date.parse(brief.generatedAt);
  const since = Date.parse(brief.since);
  return {
    ritual: "brief",
    periodKey: localClock(now, timezone).dateKey,
    // The span the figures actually cover — the brief's own lookback window,
    // not a notional midnight-to-midnight day it never read.
    periodStart: Number.isFinite(since) ? since : now.getTime() - DAY_MS,
    periodEnd: Number.isFinite(composedAt) ? composedAt : now.getTime(),
    composedAt: Number.isFinite(composedAt) ? composedAt : now.getTime(),
    headline: briefSentence({ done, needsYou }),
    facts,
  };
}

// ---------------------------------------------------------------------------
// The weekly
// ---------------------------------------------------------------------------

type WeeklyItem = WorkItem & { ranProvenance: string };

/** "You cleared N" — done inside the window, by the owner rather than by Cue. */
function countCleared(items: WeeklyItem[], now: number): number {
  return items.filter(
    (i) =>
      DONE_STATUSES.has(i.status) &&
      (i.updatedAt ?? 0) >= now - WEEK_MS &&
      (i.ranProvenance === "manual" || i.completedElsewhere === 1),
  ).length;
}

/** Overdue, going cold, or nothing for `STALE_DAYS`. Uncapped, on purpose. */
function countSlipped(items: WeeklyItem[], now: number): number {
  let slipped = 0;
  for (const i of items) {
    if (CLOSED_STATUSES.has(i.status)) continue;
    if (i.dueAt && i.dueAt < now) {
      slipped += 1;
      continue;
    }
    if (deriveWaitingState(i, now) === "going_cold") {
      slipped += 1;
      continue;
    }
    const idle = i.lastActivityAt ? now - i.lastActivityAt : 0;
    if (idle > STALE_DAYS * DAY_MS) slipped += 1;
  }
  return slipped;
}

/**
 * Compose this week's review and shape it into a snapshot.
 *
 * `moved` is acts in the week plus what the owner cleared themselves — the
 * same sum the slot and the Weekly page make. Returns null when the stores
 * cannot be read, for the same reason the brief does.
 */
export function composeWeeklySnapshot(
  now: Date,
  timezone: string | null,
): RecordRitualSnapshotInput | null {
  const nowMs = now.getTime();
  let items: WeeklyItem[];
  let acts: number;
  try {
    items = withRanProvenance(listWorkItems()) as WeeklyItem[];
    acts = getActsSummary({ days: 7 }).acts;
  } catch (err) {
    log.warn(
      { err: String(err) },
      "weekly compose failed; no snapshot written",
    );
    return null;
  }

  const facts: WeeklySnapshotFacts = {
    moved: acts + countCleared(items, nowMs),
    slipped: countSlipped(items, nowMs),
  };

  return {
    ritual: "weekly",
    periodKey: isoWeekKey(localClock(now, timezone).dateKey),
    periodStart: nowMs - WEEK_MS,
    periodEnd: nowMs,
    composedAt: nowMs,
    headline: weeklySentence(facts),
    facts,
  };
}
