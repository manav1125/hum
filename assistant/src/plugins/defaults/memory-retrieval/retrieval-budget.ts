/**
 * Hard time budget + failure circuit breaker for per-turn memory retrieval.
 *
 * Memory retrieval sits on the turn's critical path (context assembly runs
 * before the first provider call), and its pipeline fans out into network
 * dependencies — embedding backends, Qdrant, the credential store. Any one
 * of them degrading used to stall the whole turn: a degraded credential
 * backend once stretched context assembly to ~106 s for a one-line reply.
 * Memory injection is valuable but never worth more than a few seconds; a
 * turn without injected memory beats a turn the user gave up on.
 *
 * Two layers of protection:
 *
 *  1. **Budget** — retrieval races a hard deadline. At the deadline the
 *     retrieval's AbortSignal fires (abort-aware awaits unwind promptly) and
 *     the caller proceeds without injection even if some await inside the
 *     pipeline ignores the signal.
 *  2. **Circuit breaker** — after `RETRIEVAL_BREAKER_THRESHOLD` consecutive
 *     timeouts/errors, retrieval is skipped outright for
 *     `RETRIEVAL_BREAKER_COOLDOWN_MS` so a persistently broken dependency
 *     costs one log line per turn instead of a full budget wait. One probe
 *     runs after each cooldown window; success closes the circuit.
 *
 * Conversation aborts (the caller's own signal) propagate as throws and do
 * not count as breaker failures — the user cancelling a turn says nothing
 * about retrieval health.
 */

import { getLogger } from "../../../util/logger.js";

const log = getLogger("memory-retrieval-budget");

/** Default hard budget for one retrieval pass. */
export const DEFAULT_MEMORY_RETRIEVAL_BUDGET_MS = 5_000;

/** Consecutive failures (timeout or error) that open the circuit. */
export const RETRIEVAL_BREAKER_THRESHOLD = 3;

/** How long retrieval stays skipped once the circuit opens. */
export const RETRIEVAL_BREAKER_COOLDOWN_MS = 60_000;

/**
 * Resolve the effective budget: `VELLUM_MEMORY_RETRIEVAL_BUDGET_MS` env
 * override (positive integer, ms) or the default. Read per call so tests
 * and operators can adjust without a daemon restart.
 */
export function getMemoryRetrievalBudgetMs(): number {
  const raw = process.env.VELLUM_MEMORY_RETRIEVAL_BUDGET_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MEMORY_RETRIEVAL_BUDGET_MS;
}

export type BudgetedRetrievalOutcome<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "timeout"; budgetMs: number }
  | { outcome: "error"; error: unknown }
  | { outcome: "circuit_open"; retryAtMs: number };

interface BreakerState {
  consecutiveFailures: number;
  /** Epoch ms until which retrieval is skipped. 0 = circuit closed. */
  openUntil: number;
}

const breaker: BreakerState = { consecutiveFailures: 0, openUntil: 0 };

/** @internal Test-only: reset breaker state between tests. */
export function _resetRetrievalBreaker(): void {
  breaker.consecutiveFailures = 0;
  breaker.openUntil = 0;
}

/** Current breaker snapshot — exposed for logging/diagnostics. */
export function getRetrievalBreakerState(): Readonly<BreakerState> {
  return { ...breaker };
}

function recordFailure(now: number): void {
  breaker.consecutiveFailures++;
  if (breaker.consecutiveFailures >= RETRIEVAL_BREAKER_THRESHOLD) {
    breaker.openUntil = now + RETRIEVAL_BREAKER_COOLDOWN_MS;
    log.warn(
      {
        consecutiveFailures: breaker.consecutiveFailures,
        cooldownMs: RETRIEVAL_BREAKER_COOLDOWN_MS,
      },
      "memory retrieval circuit open — skipping retrieval for cooldown window",
    );
  }
}

/**
 * Run one retrieval pass under the budget + breaker.
 *
 * `op` receives an AbortSignal that fires at the budget deadline (and when
 * the caller's own `signal` aborts). The returned promise always settles by
 * `budgetMs` even if `op` never does — the losing `op` promise is detached
 * with a no-op catch so late rejections can't become unhandled.
 *
 * Throws only when the caller's `signal` aborted (conversation cancel) —
 * every retrieval-health failure comes back as a structured outcome so the
 * caller can degrade gracefully.
 */
export async function runWithRetrievalBudget<T>(
  op: (signal: AbortSignal) => Promise<T>,
  options?: { budgetMs?: number; signal?: AbortSignal },
): Promise<BudgetedRetrievalOutcome<T>> {
  const budgetMs = options?.budgetMs ?? getMemoryRetrievalBudgetMs();
  const callerSignal = options?.signal;
  const now = Date.now();

  if (breaker.openUntil > now) {
    return { outcome: "circuit_open", retryAtMs: breaker.openUntil };
  }

  const budgetController = new AbortController();
  const opSignal = callerSignal
    ? AbortSignal.any([callerSignal, budgetController.signal])
    : budgetController.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"__budget_timeout__">((resolve) => {
    timer = setTimeout(() => {
      budgetController.abort(
        new DOMException("Memory retrieval budget exceeded", "TimeoutError"),
      );
      resolve("__budget_timeout__");
    }, budgetMs);
  });

  const opPromise = op(opSignal);
  // Detach so a late rejection after we've already returned "timeout"
  // doesn't surface as an unhandled rejection.
  opPromise.catch(() => {});

  try {
    const raced = await Promise.race([opPromise, timeoutPromise]);
    if (raced === "__budget_timeout__") {
      recordFailure(Date.now());
      return { outcome: "timeout", budgetMs };
    }
    breaker.consecutiveFailures = 0;
    breaker.openUntil = 0;
    return { outcome: "ok", value: raced as T };
  } catch (error) {
    if (callerSignal?.aborted) {
      // Conversation cancel — propagate, and don't penalize the breaker.
      throw error;
    }
    recordFailure(Date.now());
    if (budgetController.signal.aborted) {
      // An abort-aware await inside `op` rejected on the budget abort before
      // the timeout sentinel settled — same budget breach, same label.
      return { outcome: "timeout", budgetMs };
    }
    return { outcome: "error", error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
