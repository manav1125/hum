/**
 * Owns the single process-wide observation driver.
 *
 * The driver is deliberately long-lived and idempotent to start. It idles
 * while no session is armed — its tick re-reads the gate and returns — so
 * there is no reason to tear it down when a session ends, and one good reason
 * not to: a session can be armed from more than one surface, and every extra
 * start/stop edge is another chance to leave the daemon armed with nothing
 * looking, which would show the owner a "Cue is watching your screen" banner
 * over a loop that captures nothing.
 *
 * Starting is attached to the first thing that could need it — a session
 * actually being started — rather than to daemon startup, so a daemon whose
 * owner never turns watching on never creates the timer at all.
 */

import { observeHostScreen } from "../daemon/host-observe-proxy.js";
import { getLogger } from "../util/logger.js";
import { getObservationCaptureSessionView } from "./observation-capture.js";
import {
  type ObservationDriverHandle,
  startObservationDriver,
} from "./observation-driver.js";

const log = getLogger("cuelive-observation-lifecycle");

let driver: ObservationDriverHandle | undefined;

/**
 * How many driver loops this process has created.
 *
 * Exposed because "there is exactly one driver" is otherwise unobservable: a
 * second `startObservationDriver` would overwrite the handle above, leaving
 * the first loop ticking with nothing holding it and nothing able to stop it.
 * Counting creations is the only way a test can tell that apart from a
 * correctly idempotent start.
 */
let startCount = 0;

/**
 * Start the driver if it is not already running.
 *
 * The capture source is bound here rather than inside the driver so the driver
 * stays testable without a Mac on the other end — see its header.
 * `observeHostScreen` returns `null` whenever no client advertises
 * `host_observe`, which is what makes this safe to call unconditionally: on a
 * daemon with no desktop attached the loop ticks, asks nothing and files
 * nothing.
 *
 * The session id is read per tick rather than captured once, because the
 * driver outlives any single session and binding it at start would attribute a
 * later session's observations to an earlier one.
 */
export function ensureObservationDriverStarted(): void {
  if (driver?.running) return;
  driver = startObservationDriver((signal) =>
    observeHostScreen(
      getObservationCaptureSessionView().sessionId ?? "",
      signal,
    ),
  );
  startCount += 1;
  log.info("observation driver started");
}

/** Stop the driver. Exported for tests and daemon shutdown. */
export async function stopObservationDriver(): Promise<void> {
  const handle = driver;
  driver = undefined;
  await handle?.stop();
}

/** For tests. */
export function isObservationDriverRunning(): boolean {
  return driver?.running ?? false;
}

/** For tests — see {@link startCount}. */
export function _observationDriverStartCountForTests(): number {
  return startCount;
}

/** For tests. */
export function _resetObservationDriverStartCountForTests(): void {
  startCount = 0;
}
