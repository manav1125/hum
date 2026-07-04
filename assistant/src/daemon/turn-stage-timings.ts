/**
 * Per-request context-assembly sub-stage timings.
 *
 * Context assembly (`HOOKS.USER_PROMPT_SUBMIT`) runs as an opaque plugin
 * chain, so the agent loop can only time the whole thing. When it regresses
 * (e.g. a degraded credential backend stalling embedding lookups), the
 * `turn_timing` line says "contextAssemblyMs: 106475" without naming the
 * culprit. This registry lets each hook record named sub-stage durations
 * keyed by the turn's request id; the agent loop drains them into the
 * `turn_timing` log line so the next regression names itself.
 *
 * Write side: `recordTurnStageTiming(requestId, "memoryRetrievalMs", 4812)`.
 * Read side: `takeTurnStageTimings(requestId)` — returns-and-deletes so
 * entries don't accumulate. A small insertion-order cap guards against
 * requests that never reach the read side (e.g. hard-aborted turns).
 */

const timingsByRequest = new Map<string, Record<string, number>>();

/** Cap on tracked requests; oldest entries are evicted beyond this. */
const MAX_TRACKED_REQUESTS = 200;

/** Record (or accumulate onto) a named sub-stage duration for a request. */
export function recordTurnStageTiming(
  requestId: string,
  stage: string,
  ms: number,
): void {
  let entry = timingsByRequest.get(requestId);
  if (!entry) {
    entry = {};
    timingsByRequest.set(requestId, entry);
    if (timingsByRequest.size > MAX_TRACKED_REQUESTS) {
      const oldest = timingsByRequest.keys().next().value;
      if (oldest !== undefined) timingsByRequest.delete(oldest);
    }
  }
  entry[stage] = (entry[stage] ?? 0) + Math.round(ms);
}

/**
 * Return-and-delete the recorded sub-stage timings for a request, or
 * undefined when nothing was recorded.
 */
export function takeTurnStageTimings(
  requestId: string,
): Record<string, number> | undefined {
  const entry = timingsByRequest.get(requestId);
  if (entry) timingsByRequest.delete(requestId);
  return entry;
}
