/**
 * Creates an AbortController that aborts when the provider goes QUIET for
 * `timeoutMs`, optionally linked to an external AbortSignal so cancellation
 * propagates both ways.
 *
 * ## Why this is an idle budget, not a total-duration one
 *
 * This used to be a single timer armed at request start: a call was killed
 * `timeoutMs` after it opened, no matter how healthily it was streaming at that
 * moment. That is wrong for reasoning models, and it is the mechanism behind
 * the sidechain timeouts — filing, contact memory and the relevance judge all
 * aborting against 12–20s budgets while the model needed 8–61s, with the judge
 * answering 5 times out of 161. We read that as budgets being too small. It is
 * worse than that: **no total-duration budget is safe, because thinking time is
 * unbounded while silence is not.** Raising the number only moves the cliff.
 *
 * Measured against a mock that emits a chunk every 8s for 43.7s total, with a
 * 15s budget: the old total-duration timer aborted at 15.0s after one chunk and
 * lost the response; an idle budget completes and keeps all five. DeepSeek's
 * own harness bounds each outstanding read the same way (`streamIdleTimeoutMs`,
 * five-minute default) rather than bounding the call.
 *
 * Callers MUST call {@link StreamTimeout.rearm} on every chunk or event they
 * receive; a caller that never rearms gets exactly the old behaviour. `cleanup`
 * must run in a finally block to clear the timer and detach the external
 * listener.
 */
export interface StreamTimeout {
  /** Pass to the provider SDK. */
  signal: AbortSignal;
  /** Call on each received chunk/event — restarts the silence budget. */
  rearm: () => void;
  /** MUST run in a finally block. */
  cleanup: () => void;
}

export function createStreamTimeout(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): StreamTimeout {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const fire = (): void => {
    settled = true;
    controller.abort(
      // The wording stays silence-specific: a caller reading this in a log
      // should not think the whole call was capped at `timeoutMs`.
      new Error(`Provider stream stalled for ${timeoutMs / 1000}s`),
    );
  };

  const arm = (): void => {
    // Rearming after the abort has fired must not resurrect the timer, and a
    // late chunk arriving during teardown must not schedule a new one.
    if (settled) return;
    if (handle !== undefined) clearTimeout(handle);
    handle = setTimeout(fire, timeoutMs);
  };

  arm();

  const onExternalAbort = (): void => {
    settled = true;
    if (handle !== undefined) clearTimeout(handle);
    controller.abort(externalSignal!.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      settled = true;
      if (handle !== undefined) clearTimeout(handle);
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const cleanup = (): void => {
    settled = true;
    if (handle !== undefined) clearTimeout(handle);
    handle = undefined;
    externalSignal?.removeEventListener("abort", onExternalAbort);
  };

  return { signal: controller.signal, rearm: arm, cleanup };
}
