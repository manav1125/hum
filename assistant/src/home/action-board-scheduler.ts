/**
 * Daily Action Board morning tick.
 *
 * The action board is normally built lazily when the user opens Home (see
 * `maybeBuildActionBoardForToday`, wired into `home-content-refresh.ts`). This
 * tick is the backstop for the "app was never opened today" case: once per day,
 * after a configured morning hour, it builds the board so it is already waiting
 * when the user next looks. The write publishes `home_feed_updated` over SSE,
 * so a connected client's unread badge updates without a manual refresh.
 *
 * It reuses the same once-per-day guards as the lazy path (the board's summary
 * card on disk + an in-memory attempt flag), so the tick and a home-open on the
 * same day cannot double-build. No notification is emitted here: the cards are
 * the surface, and emitting a separate signal would write a redundant feed card
 * and run the notification decision engine for no added value. OS-level push
 * while the app is closed is a platform concern handled elsewhere.
 */

import { getLogger } from "../util/logger.js";
import { maybeBuildActionBoardForToday } from "./action-board.js";

const log = getLogger("action-board-scheduler");

/** Check cadence. 30 min keeps the tick cheap while reacting promptly once the
 *  morning hour passes. */
const TICK_INTERVAL_MS = 30 * 60_000;
/** Short delay before the first tick so it doesn't pile onto daemon startup. */
const STARTUP_DELAY_MS = 30_000;
/** Default local hour (24h) after which the morning build may run. */
const DEFAULT_MORNING_HOUR = 7;

function morningHour(): number {
  const raw = process.env.CUE_ACTION_BOARD_HOUR;
  if (raw === undefined) return DEFAULT_MORNING_HOUR;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    return DEFAULT_MORNING_HOUR;
  }
  return parsed;
}

async function tick(now: Date): Promise<void> {
  if (now.getHours() < morningHour()) return;
  try {
    // notify: true — the morning backstop is the one path that may push to
    // connected channels (macOS/Telegram/Slack) when something's urgent.
    await maybeBuildActionBoardForToday({ now, notify: true });
  } catch (err) {
    log.warn({ err: String(err) }, "Action board morning tick failed");
  }
}

/**
 * Start the morning-build backstop. Returns a stop function that clears the
 * timers. Safe to call once at daemon startup.
 */
export function startActionBoardScheduler(): () => void {
  const startupTimer = setTimeout(() => {
    void tick(new Date());
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    void tick(new Date());
  }, TICK_INTERVAL_MS);

  // Non-critical background timers — don't keep the event loop alive or block
  // process exit on shutdown. They're cheap (a feed-card existence check after
  // the morning hour) and die with the process.
  startupTimer.unref?.();
  interval.unref?.();

  log.info({ morningHour: morningHour() }, "Action board morning tick started");

  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}
