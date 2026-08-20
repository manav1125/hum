/**
 * The stream budget bounds SILENCE, not the call.
 *
 * These pin the distinction that the sidechain timeouts turned on: a reasoning
 * model can think for a minute and stream perfectly well afterwards, so a timer
 * armed once at request start kills healthy calls. The mutation check is the
 * important one — remove the rearm and a stream that never goes quiet still
 * dies on schedule, which is precisely the shipped behaviour we replaced.
 */

import { describe, expect, test } from "bun:test";

import { createStreamTimeout } from "../stream-timeout.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reason text an aborted signal carries, whatever shape the reason took. */
function reasonOf(signal: AbortSignal): string {
  const r = signal.reason as unknown;
  return r instanceof Error ? r.message : String(r);
}

describe("silence, not duration", () => {
  test("a stream that keeps producing outlives its budget", async () => {
    // 60ms budget, chunks every 25ms, 150ms total — two and a half budgets
    // long. This is the mock experiment in miniature (15s budget, 8s gaps,
    // 43.7s total) that the old timer aborted at 15s.
    const t = createStreamTimeout(60);
    for (let i = 0; i < 6; i++) {
      await tick(25);
      t.rearm();
    }
    expect(t.signal.aborted).toBe(false);
    t.cleanup();
  });

  test("MUTATION CHECK: without rearming, the same stream dies", async () => {
    // Delete the rearm calls in the providers and this is what they get back —
    // the exact behaviour that made the relevance judge answer 5 times in 161.
    const t = createStreamTimeout(60);
    await tick(150);
    expect(t.signal.aborted).toBe(true);
    t.cleanup();
  });

  test("real silence still aborts, and says so", async () => {
    const t = createStreamTimeout(40);
    t.rearm();
    await tick(120);
    expect(t.signal.aborted).toBe(true);
    // The message must not claim the CALL was capped — it was the quiet.
    expect(reasonOf(t.signal)).toContain("stalled");
    t.cleanup();
  });
});

describe("teardown and cancellation still hold", () => {
  test("cleanup stops the timer firing afterwards", async () => {
    const t = createStreamTimeout(30);
    t.cleanup();
    await tick(90);
    expect(t.signal.aborted).toBe(false);
  });

  test("MUTATION CHECK: rearming after cleanup cannot resurrect the timer", async () => {
    // A late chunk arriving during teardown must not schedule a fresh abort
    // against a stream nobody is reading any more.
    const t = createStreamTimeout(30);
    t.cleanup();
    t.rearm();
    await tick(90);
    expect(t.signal.aborted).toBe(false);
  });

  test("an external abort propagates and carries its own reason", () => {
    const outer = new AbortController();
    const t = createStreamTimeout(10_000, outer.signal);
    outer.abort(new Error("user cancelled"));
    expect(t.signal.aborted).toBe(true);
    expect(reasonOf(t.signal)).toBe("user cancelled");
    t.cleanup();
  });

  test("an already-aborted external signal aborts immediately", () => {
    const outer = new AbortController();
    outer.abort(new Error("already gone"));
    const t = createStreamTimeout(10_000, outer.signal);
    expect(t.signal.aborted).toBe(true);
    expect(reasonOf(t.signal)).toBe("already gone");
    t.cleanup();
  });

  test("rearming after a real stall does not clear the abort", async () => {
    const t = createStreamTimeout(30);
    await tick(90);
    expect(t.signal.aborted).toBe(true);
    t.rearm();
    expect(t.signal.aborted).toBe(true);
    t.cleanup();
  });
});
