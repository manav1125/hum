/**
 * Owns the single process-wide teach driver.
 *
 * A separate loop from the ambient observation driver, for the same reason the
 * teach session is separate state: the two look at the same screen for
 * different purposes and with different retention. Sharing one loop would mean
 * a demonstration either files todos as a side effect or silently suppresses
 * the ambient pipeline for its duration, and both are surprises.
 *
 * Unlike the ambient driver, this one is torn down when the demonstration
 * ends. The ambient driver idles cheaply because it is expected to be armed
 * again at any moment; a demonstration is an event with a person present, so
 * leaving a timer behind after it finishes would be a loop nobody asked for
 * ticking against a gate that will answer "no" until the next time someone
 * teaches — which may be never.
 *
 * The interval is faster than the ambient one on purpose. Ambient capture is
 * sampling a working day and can afford to miss a moment; a demonstration is a
 * procedure, and a missed step is a missing instruction in the skill that gets
 * written from it.
 */

import {
  type ObservationDriverHandle,
  startObservationDriver,
} from "../cue-live/observation-driver.js";
import { observeHostScreen } from "../daemon/host-observe-proxy.js";
import { getLogger } from "../util/logger.js";
import {
  getTeachSessionView,
  isTeachSessionArmed,
  recordTeachStep,
} from "./teach-session.js";

const log = getLogger("teach-driver");

/**
 * How often to look during a demonstration.
 *
 * Fast enough that a step performed and moved on from inside a few seconds is
 * still seen, slow enough that each look can cross the host bridge and be read
 * before the next is due. Every tick is a real round trip to the owner's
 * machine, so this is not free.
 */
const TEACH_TICK_MS = 4_000;

let driver: ObservationDriverHandle | undefined;

/**
 * Start looking, if a demonstration is running and nothing is looking yet.
 *
 * Idempotent: a second call while the driver runs is a no-op rather than a
 * second loop. Two loops against one session would double every step in the
 * transcript, and the synthesis would read the duplication as the owner
 * repeating themselves.
 */
export function ensureTeachDriverStarted(): void {
  if (driver?.running) return;
  driver = startObservationDriver(
    (signal) =>
      observeHostScreen(getTeachSessionView().sessionId ?? "", signal),
    {
      intervalMs: TEACH_TICK_MS,
      isArmed: () => isTeachSessionArmed(),
      sink: (observation) => recordTeachStep(observation),
    },
  );
  log.info("teach driver started");
}

/**
 * Stop looking and wait for an in-flight read to settle.
 *
 * Awaiting matters here: returning while the host is still answering would let
 * a step land after the owner said stop, and that step would then be part of
 * the skill they thought they had finished teaching.
 */
export async function stopTeachDriver(): Promise<void> {
  const handle = driver;
  driver = undefined;
  if (handle) log.info("teach driver stopped");
  await handle?.stop();
}

/** For tests. */
export function isTeachDriverRunning(): boolean {
  return driver?.running ?? false;
}
