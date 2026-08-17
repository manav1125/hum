/**
 * The writer — the daemon composing each ritual once per period and keeping
 * what it composed.
 *
 * ## Why a job and not the read route
 *
 * `GET /brief/morning` composes on demand, which makes it the obvious place
 * to write from and the wrong one. Two reasons, and the second is the real
 * one:
 *
 *   · A GET handler must not mutate database state (runtime/CLAUDE.md), and
 *     its documented exceptions are all caches serving the same request.
 *   · A brief composed because somebody opened the app at 9pm is not the
 *     brief that went out. Design's constraint is that snapshots are written
 *     when a ritual is COMPOSED, and the moment a ritual is composed for its
 *     owner is its own time of day — 07:30 for the brief, Friday noon for the
 *     weekly. This job runs on that clock.
 *
 * It reads `notifications.morningBrief.time` / `.timezone` so the recorded
 * brief and the pushed brief are composed from the same moment in the same
 * calendar, but it does NOT read `.enabled`: turning the notification off is
 * a statement about being interrupted, not about keeping a record. The
 * archive keeps accumulating either way.
 *
 * ## Once per period, first compose wins
 *
 * The tick is cheap and frequent; the write is idempotent. `recordRitual-
 * Snapshot` inserts against a unique `(ritual, period_key)`, so the first
 * compose of a day is the one that survives and every later tick is a
 * no-op — including across daemon restarts, where the row itself is the
 * durable "already done" marker and no in-memory flag is trusted.
 *
 * Nothing here backfills. A daemon that has been down for a week comes back
 * and records today; the six days it did not watch stay absent, because the
 * figures for them no longer exist anywhere to be honest about.
 */

import { getConfig } from "../config/loader.js";
import { localClock } from "../notifications/local-clock.js";
import { getLogger } from "../util/logger.js";
import {
  composeBriefSnapshot,
  composeWeeklySnapshot,
  isoWeekKey,
  weekdayOfDateKey,
} from "./ritual-compose.js";
import {
  getRitualSnapshotByPeriod,
  recordRitualSnapshot,
  type RitualKind,
} from "./ritual-snapshot-store.js";

const log = getLogger("ritual-snapshots");

/** Tick cadence — the windows are hours wide, so ten minutes is plenty. */
const TICK_INTERVAL_MS = 10 * 60_000;
/** Let the daemon finish starting before the first compose. */
const STARTUP_DELAY_MS = 90_000;

const DEFAULT_BRIEF_MINUTES = 7 * 60 + 30; // 07:30
/** Friday's weekly opens at noon (`ritual-slot.ts#isWeeklyWindow`). */
const WEEKLY_FROM_MINUTES = 12 * 60;

function parseBriefMinutes(raw: string | undefined): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw ?? "");
  if (!match) return DEFAULT_BRIEF_MINUTES;
  return Number(match[1]) * 60 + Number(match[2]);
}

interface RitualClockConfig {
  timezone: string | null;
  briefMinutes: number;
}

/** Config reads never throw the tick — an unreadable config falls back. */
function readClockConfig(): RitualClockConfig {
  try {
    const cfg = getConfig().notifications.morningBrief;
    return {
      timezone: cfg.timezone ?? null,
      briefMinutes: parseBriefMinutes(cfg.time),
    };
  } catch (err) {
    log.warn({ err: String(err) }, "ritual snapshot: config read failed");
    return { timezone: null, briefMinutes: DEFAULT_BRIEF_MINUTES };
  }
}

/**
 * Friday from noon, then all of Saturday and Sunday — the weekly's window,
 * evaluated in the effective timezone.
 */
export function isWeeklyWindow(dateKey: string, minutesOfDay: number): boolean {
  const day = weekdayOfDateKey(dateKey);
  if (day === 5) return minutesOfDay >= WEEKLY_FROM_MINUTES;
  return day === 6 || day === 0;
}

export interface EnsureResult {
  /** Rituals whose snapshot this call actually wrote. */
  written: RitualKind[];
}

/**
 * Record any ritual that is due and not yet on file for its period.
 *
 * Safe to call as often as you like: a period already on file short-circuits
 * before the compose runs, so a healthy daemon pays one work-item read per
 * ritual per period and nothing else.
 */
export async function ensureRitualSnapshots(
  now: Date = new Date(),
): Promise<EnsureResult> {
  const { timezone, briefMinutes } = readClockConfig();
  const clock = localClock(now, timezone);
  const written: RitualKind[] = [];

  // The brief, once the day has reached the hour the brief goes out. Before
  // that hour there is nothing to record: a "brief" composed at 00:05 would
  // freeze an empty night as the day's record.
  if (
    clock.minutesOfDay >= briefMinutes &&
    !getRitualSnapshotByPeriod("brief", clock.dateKey)
  ) {
    const input = await composeBriefSnapshot(now, timezone);
    if (input) {
      const { written: didWrite } = recordRitualSnapshot(input);
      if (didWrite) {
        written.push("brief");
        log.info(
          { periodKey: input.periodKey, headline: input.headline },
          "Recorded brief snapshot",
        );
      }
    }
  }

  // The weekly, once inside its window.
  const weekKey = isoWeekKey(clock.dateKey);
  if (
    isWeeklyWindow(clock.dateKey, clock.minutesOfDay) &&
    !getRitualSnapshotByPeriod("weekly", weekKey)
  ) {
    const input = composeWeeklySnapshot(now, timezone);
    if (input) {
      const { written: didWrite } = recordRitualSnapshot(input);
      if (didWrite) {
        written.push("weekly");
        log.info(
          { periodKey: input.periodKey, headline: input.headline },
          "Recorded weekly snapshot",
        );
      }
    }
  }

  return { written };
}

let tickInFlight = false;

async function tick(now: Date): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await ensureRitualSnapshots(now);
  } catch (err) {
    // A failed tick loses nothing: the next one re-evaluates the same period.
    log.warn({ err: String(err) }, "Ritual snapshot tick failed");
  } finally {
    tickInFlight = false;
  }
}

/**
 * Start the ritual snapshot job. Returns a stop function. Timers are unref'd
 * and every failure is caught — this can never block daemon startup or keep
 * the process alive (assistant/CLAUDE.md startup rules).
 */
export function startRitualSnapshotScheduler(): () => void {
  const startupTimer = setTimeout(() => {
    void tick(new Date());
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    void tick(new Date());
  }, TICK_INTERVAL_MS);

  startupTimer.unref?.();
  interval.unref?.();

  log.info("Ritual snapshot scheduler started");

  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}
