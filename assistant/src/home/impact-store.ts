/**
 * Impact store — the data behind the weekly "your week with Cue" recap.
 *
 * Records discrete, real things Cue did on the user's behalf (each with an
 * honest time-saved estimate) to an append-only JSONL log in the workspace,
 * and aggregates them into the hours-saved / tasks-handled / by-category
 * summary the Impact and Home surfaces show.
 *
 * Append-only JSONL (one event per line) so concurrent records never race on a
 * read-modify-write — the daemon appends, the reader folds. Never throws:
 * recording impact is fire-and-forget and must not break the action that
 * produced it.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("impact-store");

const IMPACT_FILENAME = "impact-events.jsonl";

/**
 * The categories the recap breaks time down by. Stable keys; the UI supplies
 * display labels. New features should reuse an existing category where it fits.
 */
export type ImpactCategory =
  | "email"
  | "scheduling"
  | "meetings"
  | "calls"
  | "research"
  | "other";

export interface ImpactEvent {
  /** Discrete event kind, e.g. "email_drafted". */
  type: string;
  category: ImpactCategory;
  /** Honest estimate of minutes this saved the user. */
  minutesSaved: number;
  /** Optional one-line human description for the "a few things Cue handled" list. */
  detail?: string;
  /** ISO-8601 timestamp. */
  at: string;
}

export interface ImpactCategoryRollup {
  category: ImpactCategory;
  count: number;
  hours: number;
}

export interface ImpactSummary {
  rangeDays: number;
  hoursSaved: number;
  taskCount: number;
  byCategory: ImpactCategoryRollup[];
  recent: Array<{ detail: string; category: ImpactCategory; at: string }>;
}

function impactPath(): string {
  return join(getDataDir(), IMPACT_FILENAME);
}

/**
 * Record one impact event. Fire-and-forget — never throws. `at` is stamped
 * here so callers don't have to.
 */
export function recordImpact(event: Omit<ImpactEvent, "at">): void {
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const line = JSON.stringify({ ...event, at: new Date().toISOString() });
    appendFileSync(impactPath(), line + "\n", "utf-8");
  } catch (err) {
    log.warn({ err: String(err) }, "Failed to record impact event");
  }
}

/** Read and parse all recorded events (tolerant of partial/corrupt lines). */
function readEvents(): ImpactEvent[] {
  const path = impactPath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: ImpactEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ImpactEvent;
      if (parsed && typeof parsed.minutesSaved === "number" && parsed.at) {
        out.push(parsed);
      }
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/**
 * Aggregate a list of impact events over the last `rangeDays` into the recap
 * summary. Pure and exported for unit testing.
 */
export function aggregateEvents(
  allEvents: ImpactEvent[],
  rangeDays: number,
  now: Date,
): ImpactSummary {
  const cutoff = now.getTime() - rangeDays * 24 * 60 * 60 * 1000;
  const events = allEvents.filter((e) => {
    const t = Date.parse(e.at);
    return !Number.isNaN(t) && t >= cutoff;
  });

  const totals = new Map<ImpactCategory, { count: number; minutes: number }>();
  let totalMinutes = 0;
  for (const e of events) {
    const slot = totals.get(e.category) ?? { count: 0, minutes: 0 };
    slot.count += 1;
    slot.minutes += e.minutesSaved;
    totals.set(e.category, slot);
    totalMinutes += e.minutesSaved;
  }

  const byCategory: ImpactCategoryRollup[] = [...totals.entries()]
    .map(([category, v]) => ({
      category,
      count: v.count,
      hours: Math.round((v.minutes / 60) * 10) / 10,
    }))
    .sort((a, b) => b.hours - a.hours);

  const recent = events
    .filter((e) => e.detail)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 10)
    .map((e) => ({ detail: e.detail!, category: e.category, at: e.at }));

  return {
    rangeDays,
    hoursSaved: Math.round((totalMinutes / 60) * 10) / 10,
    taskCount: events.length,
    byCategory,
    recent,
  };
}

/**
 * Aggregate the last `rangeDays` of recorded impact into the recap summary.
 */
export function getImpactSummary(
  rangeDays = 7,
  now: Date = new Date(),
): ImpactSummary {
  return aggregateEvents(readEvents(), rangeDays, now);
}

/** Per-action time-saved estimates (minutes). Conservative + documented so the
 *  hours-saved number is honest rather than inflated. */
export const TIME_SAVED_MINUTES = {
  /** Composing + typing a considered reply from scratch. */
  emailDrafted: 6,
  /** Reading + deciding on one inbound email during triage. */
  emailTriaged: 1,
} as const;
