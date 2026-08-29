/**
 * The cadence that turns a capture session into repeated observations.
 *
 * `observation-capture.ts` has always been able to gate, extract and file one
 * observation — 947 lines of it, with tests. What it never had is anything
 * calling it on a schedule, so the whole pass only ever ran when Cue Live's
 * `look` verb happened to fire. This is that missing loop, and nothing more:
 * it decides WHEN to observe and hands the result to the existing seam.
 *
 * ## Demonstration, not surveillance
 *
 * The product this serves is "show Cue how you do this, so it can offer to do
 * it next time" — not ambient watching. That is why the loop is bounded by the
 * same explicit, expiring session the routes already expose rather than by a
 * daemon-lifetime timer: the owner starts it, the owner stops it, and it stops
 * itself regardless. A demonstration also produces a BETTER signal than
 * ambient capture, because the owner's start and stop label where the workflow
 * begins and ends instead of leaving Cue to guess boundaries out of a day.
 *
 * ## Why the capture source is injected
 *
 * The macOS accessibility read (`computer_use_observe`) executes on the HOST —
 * the guardian's device across the host bridge — not in the daemon. Its proxy
 * is per-conversation and owned by the agent loop, so a background driver
 * cannot borrow it, and a driver that imported it would be untestable without
 * a Mac on the other end. Taking a {@link CaptureSource} keeps the decision
 * logic — which is all of the risk here — testable on its own, and lets the
 * same loop drive a browser accessibility tree later without changing.
 *
 * ## What this deliberately does NOT do
 *
 * Every restraint stays where it already lives. The driver does not decide
 * whether a screen is sensitive, does not dedupe, does not count extractions
 * or items, and cannot file anything: it calls the seam, and the seam refuses
 * or accepts. Re-implementing any of that here would create a second opinion
 * about the same rules, and the two would drift.
 */

import { getLogger } from "../util/logger.js";
import {
  isObservationCaptureArmed,
  kickScreenObservationCapture,
  resolveObservationCaptureSettings,
  type ScreenObservationInput,
} from "./observation-capture.js";

const log = getLogger("cuelive-observation-driver");

/**
 * One look at the screen, or `null` when there is nothing to report.
 *
 * `null` is a real answer — the host may be disconnected, the screen locked,
 * or the read may simply have failed. It is distinct from an empty
 * description, which would be a claim that the screen holds nothing.
 */
export type CaptureSource = (
  signal: AbortSignal,
) => Promise<ScreenObservationInput | null>;

/**
 * Where a captured observation goes.
 *
 * Injected for the same reason {@link CaptureSource} is: the loop decides
 * WHEN to look, and the sink decides what the looking is FOR. Ambient capture
 * files work items; a teach session accumulates an ordered timeline it will
 * later turn into a skill. Neither should be able to trigger the other's side
 * effects, and a single hardwired sink would mean a demonstration silently
 * filed todos.
 */
export type ObservationSink = (observation: ScreenObservationInput) => void;

/**
 * Whether the loop may look right now.
 *
 * Re-read every tick, never captured at start, so an owner who stops a
 * session — or a session that expires mid-loop — takes effect on the next
 * tick rather than one interval later.
 */
export type ArmedPredicate = () => boolean;

export interface ObservationDriverHandle {
  /** Stop the loop and wait for an in-flight capture to settle. */
  stop: () => Promise<void>;
  /** True until {@link stop} completes. */
  readonly running: boolean;
}

/**
 * Floor on the interval read from CONFIG. It does not apply to an interval
 * passed in explicitly.
 *
 * `observation-capture` already clamps its own interval, but the clamp there
 * governs what it will ACCEPT, not how often something asks. A driver reading
 * a mis-set config could otherwise spin against a rejecting gate, burning host
 * round-trips to be told "too soon" — the cost of an ignored observation is
 * not zero when each one crosses the host bridge.
 *
 * An explicit `intervalMs` is a caller who has stated a number, not a config
 * that drifted, so it is honoured as given. Clamping it too made this loop
 * impossible to exercise at speed, which is its own kind of unsafe.
 */
const MIN_CONFIG_TICK_MS = 5_000;

/**
 * Start the capture loop.
 *
 * Ticks while a session is armed, asks `capture` for one observation, and
 * hands it to the existing seam. It never starts one capture while another is
 * in flight: a slow host read must not queue up behind itself and arrive as a
 * burst the moment it recovers.
 */
export function startObservationDriver(
  capture: CaptureSource,
  opts: {
    intervalMs?: number;
    /** Defaults to the ambient screen-observation session gate. */
    isArmed?: ArmedPredicate;
    /** Defaults to filing work items through the capture seam. */
    sink?: ObservationSink;
  } = {},
): ObservationDriverHandle {
  const isArmed = opts.isArmed ?? isObservationCaptureArmed;
  const sink = opts.sink ?? kickScreenObservationCapture;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let running = true;

  const intervalMs = () => {
    if (opts.intervalMs !== undefined) return Math.max(1, opts.intervalMs);
    const settings = resolveObservationCaptureSettings();
    return Math.max(MIN_CONFIG_TICK_MS, settings.intervalSeconds * 1000);
  };

  const tick = async (): Promise<void> => {
    if (!running) return;

    // The session gate is re-read every tick rather than captured at start:
    // an owner who stops a session, or a session that expires mid-loop, must
    // take effect on the next tick and not one interval later.
    if (!isArmed()) return;

    try {
      const observation = await capture(controller.signal);
      if (!observation) return; // nothing to report — not an error
      if (!running) return; // stopped while the host was answering
      sink(observation);
    } catch (err) {
      if (controller.signal.aborted) return;
      // A failed read is expected — the desktop disconnects, the screen locks.
      // It must never stop the loop, and it must never be mistaken for "the
      // screen had nothing on it".
      log.debug({ err }, "screen capture failed; will try again next tick");
    }
  };

  const schedule = (): void => {
    if (!running) return;
    timer = setTimeout(() => {
      inFlight = tick().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, intervalMs());
    // An idle watch loop must not be a reason the process stays alive.
    timer.unref?.();
  };

  schedule();

  return {
    get running() {
      return running;
    },
    async stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      controller.abort();
      // Await the in-flight capture so a stopped driver is actually quiet.
      // Returning while a host read is still outstanding would let an
      // observation land after the owner asked us to stop watching.
      await inFlight?.catch(() => undefined);
    },
  };
}
