import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  _resetRetrievalBreaker,
  getRetrievalBreakerState,
  RETRIEVAL_BREAKER_THRESHOLD,
  runWithRetrievalBudget,
} from "../retrieval-budget.js";

/** An op that never settles unless its signal aborts (abort-aware hang). */
function hangingOp(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** An op that never settles at all (abort-oblivious hang). */
function blackholeOp(): Promise<never> {
  return new Promise(() => {});
}

describe("runWithRetrievalBudget", () => {
  beforeEach(() => {
    _resetRetrievalBreaker();
  });

  afterEach(() => {
    _resetRetrievalBreaker();
  });

  test("returns the op result and resets the breaker on success", async () => {
    const result = await runWithRetrievalBudget(async () => "hello", {
      budgetMs: 1_000,
    });
    expect(result).toEqual({ outcome: "ok", value: "hello" });
    expect(getRetrievalBreakerState()).toEqual({
      consecutiveFailures: 0,
      openUntil: 0,
    });
  });

  test("caps an abort-aware hanging op at the budget", async () => {
    const startedAt = performance.now();
    const result = await runWithRetrievalBudget(hangingOp, { budgetMs: 50 });
    const elapsed = performance.now() - startedAt;

    expect(result.outcome).toBe("timeout");
    expect(elapsed).toBeLessThan(1_000);
  });

  test("caps an abort-oblivious hanging op at the budget", async () => {
    const startedAt = performance.now();
    const result = await runWithRetrievalBudget(blackholeOp, { budgetMs: 50 });
    const elapsed = performance.now() - startedAt;

    expect(result.outcome).toBe("timeout");
    expect(elapsed).toBeLessThan(1_000);
  });

  test("aborts the op signal when the budget fires", async () => {
    let observedAbort = false;
    await runWithRetrievalBudget(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(signal.reason);
          });
        }),
      { budgetMs: 20 },
    );
    expect(observedAbort).toBe(true);
  });

  test("returns a structured error outcome on op failure", async () => {
    const boom = new Error("qdrant down");
    const result = await runWithRetrievalBudget(
      async () => {
        throw boom;
      },
      { budgetMs: 1_000 },
    );
    expect(result).toEqual({ outcome: "error", error: boom });
    expect(getRetrievalBreakerState().consecutiveFailures).toBe(1);
  });

  test("re-throws when the caller's own signal aborted (conversation cancel)", async () => {
    const caller = new AbortController();
    const promise = runWithRetrievalBudget(hangingOp, {
      budgetMs: 5_000,
      signal: caller.signal,
    });
    caller.abort(new DOMException("Aborted", "AbortError"));
    await expect(promise).rejects.toThrow();
    // A user cancel must not count against retrieval health.
    expect(getRetrievalBreakerState().consecutiveFailures).toBe(0);
  });

  test("opens the circuit after consecutive timeouts and skips while open", async () => {
    for (let i = 0; i < RETRIEVAL_BREAKER_THRESHOLD; i++) {
      const result = await runWithRetrievalBudget(blackholeOp, {
        budgetMs: 10,
      });
      expect(result.outcome).toBe("timeout");
    }
    expect(getRetrievalBreakerState().openUntil).toBeGreaterThan(Date.now());

    // While open, the op is not even invoked.
    const op = mock(async () => "should not run");
    const skipped = await runWithRetrievalBudget(op, { budgetMs: 10 });
    expect(skipped.outcome).toBe("circuit_open");
    expect(op).not.toHaveBeenCalled();
  });

  test("a success after failures closes the breaker again", async () => {
    await runWithRetrievalBudget(blackholeOp, { budgetMs: 10 });
    expect(getRetrievalBreakerState().consecutiveFailures).toBe(1);

    const result = await runWithRetrievalBudget(async () => 42, {
      budgetMs: 1_000,
    });
    expect(result).toEqual({ outcome: "ok", value: 42 });
    expect(getRetrievalBreakerState()).toEqual({
      consecutiveFailures: 0,
      openUntil: 0,
    });
  });
});
