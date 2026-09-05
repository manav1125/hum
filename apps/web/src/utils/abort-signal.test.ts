import { describe, expect, test } from "bun:test";

import { withTimeout } from "@/utils/abort-signal";

describe("withTimeout", () => {
  test("aborts when the caller's signal aborts", () => {
    /**
     * The combined signal must relay a caller-side cancel (TanStack Query
     * key switch / unmount) so an in-flight fetch is actually torn down.
     */
    // GIVEN a caller-owned controller combined with a long timeout
    const controller = new AbortController();
    const combined = withTimeout(controller.signal, 60_000);
    expect(combined.aborted).toBe(false);

    // WHEN the caller aborts
    controller.abort();

    // THEN the combined signal is aborted
    expect(combined.aborted).toBe(true);
  });

  test("aborts on its own once the deadline elapses", async () => {
    /**
     * A hung socket never rejects by itself; the deadline is what turns the
     * hang into a settled error the caller can retry.
     */
    // GIVEN a combined signal with a tiny deadline and a caller that never cancels
    const controller = new AbortController();
    const combined = withTimeout(controller.signal, 5);

    // WHEN the deadline elapses
    await new Promise((resolve) => {
      combined.addEventListener("abort", resolve, { once: true });
    });

    // THEN the combined signal is aborted with a timeout reason
    expect(combined.aborted).toBe(true);
    expect((combined.reason as DOMException | undefined)?.name).toBe(
      "TimeoutError",
    );
  });

  test("an already-aborted caller signal yields an aborted combined signal", () => {
    // GIVEN a caller signal that aborted before combining
    const controller = new AbortController();
    controller.abort();

    // WHEN combined with a long deadline
    const combined = withTimeout(controller.signal, 60_000);

    // THEN the combined signal starts aborted
    expect(combined.aborted).toBe(true);
  });
});
