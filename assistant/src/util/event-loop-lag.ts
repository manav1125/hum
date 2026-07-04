/**
 * Event-loop lag monitor + perf-stage attribution.
 *
 * The daemon runs on a single Bun event loop, so any synchronous work in the
 * turn path (big `JSON.stringify`, sync sqlite statements against large
 * tables, sync fs) stalls EVERY in-flight HTTP request. Symptom in prod:
 * unrelated GET/PATCH requests that take 0.1–0.4s when idle stall for tens of
 * seconds while an LLM turn is in flight.
 *
 * This module provides two cheap primitives to attribute those stalls:
 *
 * 1. A drift-based lag monitor: an unref'd interval timer that measures how
 *    late it fires. When the loop was blocked for longer than the warn
 *    threshold, it logs a structured `event_loop_blocked` line including the
 *    perf stage that was active when the block started — turning "something
 *    froze the daemon" into "persist_llm_request_log blocked the loop for
 *    12.4s".
 *
 * 2. Perf-stage markers: hot paths call `markPerfStage("...")` before a
 *    potentially heavy synchronous section and `clearPerfStage()` after.
 *    Setting a string + timestamp is O(1); there is no per-stage allocation
 *    or logging unless a block is actually observed.
 *
 * Env knobs (non-secret, see `env-registry.ts`):
 *  - CUE_DISABLE_LOOP_LAG_MONITOR: kill switch (default: monitor runs).
 *  - CUE_LOOP_LAG_WARN_MS: warn threshold in ms (default 500).
 */

import {
  getLoopLagMonitorDisabled,
  getLoopLagWarnMs,
} from "../config/env-registry.js";
import { getLogger } from "./logger.js";

const log = getLogger("event-loop-lag");

/** How often the drift probe fires. Small enough to catch sub-second blocks,
 * large enough to be free (one Date.now() + compare per tick). */
const PROBE_INTERVAL_MS = 250;

const DEFAULT_WARN_THRESHOLD_MS = 500;

let currentStage: string | null = null;
let currentStageSince = 0;

/**
 * Mark the currently-running (potentially blocking) stage so a lag warning
 * can attribute the block. Overwrites any previous stage — stages are not a
 * stack; the hot paths that use them do not nest blocking sections.
 */
export function markPerfStage(stage: string): void {
  currentStage = stage;
  currentStageSince = Date.now();
}

/** Clear the current perf stage (call after the guarded section completes). */
export function clearPerfStage(): void {
  currentStage = null;
  currentStageSince = 0;
}

/** Snapshot the active perf stage for inclusion in timing logs. */
export function getPerfStage(): { stage: string; stageAgeMs: number } | null {
  if (currentStage === null) return null;
  return { stage: currentStage, stageAgeMs: Date.now() - currentStageSince };
}

/**
 * Run `fn` with a perf stage marked, clearing it afterwards. For synchronous
 * sections only — an `await` inside would leave the stage attributed across
 * unrelated loop turns.
 */
export function withPerfStage<T>(stage: string, fn: () => T): T {
  markPerfStage(stage);
  try {
    return fn();
  } finally {
    clearPerfStage();
  }
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the drift-based event-loop lag monitor. Idempotent; unref'd so it
 * never keeps the process alive. Call once during daemon startup.
 */
export function startEventLoopLagMonitor(): void {
  if (monitorTimer) return;
  if (getLoopLagMonitorDisabled()) {
    log.info(
      "Event-loop lag monitor disabled via CUE_DISABLE_LOOP_LAG_MONITOR",
    );
    return;
  }
  const configuredWarnMs = getLoopLagWarnMs();
  const warnThresholdMs =
    configuredWarnMs !== undefined && configuredWarnMs > 0
      ? configuredWarnMs
      : DEFAULT_WARN_THRESHOLD_MS;

  let expected = Date.now() + PROBE_INTERVAL_MS;
  monitorTimer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - expected;
    // Capture the stage BEFORE resetting `expected` — the stage active when
    // the probe finally fires is the one that was running during the block
    // (blocked sections can't clear their marker until the loop resumes).
    if (lagMs >= warnThresholdMs) {
      const stage = getPerfStage();
      log.warn(
        {
          lagMs,
          stage: stage?.stage ?? null,
          stageAgeMs: stage?.stageAgeMs ?? null,
        },
        "event_loop_blocked — the daemon event loop was stalled by synchronous work",
      );
    }
    expected = now + PROBE_INTERVAL_MS;
  }, PROBE_INTERVAL_MS);
  monitorTimer.unref?.();
  log.info(
    { probeIntervalMs: PROBE_INTERVAL_MS, warnThresholdMs },
    "Event-loop lag monitor started",
  );
}

/** Stop the monitor (tests only). */
export function stopEventLoopLagMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
