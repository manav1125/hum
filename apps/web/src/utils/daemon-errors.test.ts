import { describe, expect, test } from "bun:test";

const { isExpectedDaemonTransientError, shouldRetryDaemonError } =
  await import("@/utils/daemon-errors");
const { ApiError } = await import("@/utils/api-errors");

describe("isExpectedDaemonTransientError", () => {
  test("returns true for 503 daemon starting up", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(503, "Your assistant is still starting up."),
      ),
    ).toBe(true);
  });

  test("returns true for 502 bad gateway", () => {
    expect(
      isExpectedDaemonTransientError(new ApiError(502, "Bad gateway")),
    ).toBe(true);
  });

  test("returns true for 401 auth race", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(401, "Authentication credentials were not provided."),
      ),
    ).toBe(true);
  });

  test("returns true for 400 org-header missing", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(400, "Vellum-Organization-Id header is required."),
      ),
    ).toBe(true);
  });

  test("returns false for 400 without org-header message", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(400, "Invalid request body."),
      ),
    ).toBe(false);
  });

  test("returns false for 500 internal server error", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(500, "Internal Server Error"),
      ),
    ).toBe(false);
  });

  test("returns false for non-ApiError instances", () => {
    expect(isExpectedDaemonTransientError(new Error("random error"))).toBe(
      false,
    );
    expect(
      isExpectedDaemonTransientError(new TypeError("Failed to fetch")),
    ).toBe(false);
    expect(isExpectedDaemonTransientError("string error")).toBe(false);
    expect(isExpectedDaemonTransientError(null)).toBe(false);
  });
});

describe("shouldRetryDaemonError", () => {
  test("retries transient daemon errors within budget", () => {
    const err = new ApiError(503, "Your assistant is still starting up.");
    expect(shouldRetryDaemonError(0, err)).toBe(true);
    expect(shouldRetryDaemonError(1, err)).toBe(true);
    expect(shouldRetryDaemonError(2, err)).toBe(true);
  });

  test("stops retrying after 3 failures", () => {
    const err = new ApiError(503, "Your assistant is still starting up.");
    expect(shouldRetryDaemonError(3, err)).toBe(false);
    expect(shouldRetryDaemonError(4, err)).toBe(false);
  });

  test("does not retry non-transient errors", () => {
    expect(
      shouldRetryDaemonError(0, new ApiError(500, "Internal Server Error")),
    ).toBe(false);
    expect(shouldRetryDaemonError(0, new Error("random error"))).toBe(false);
    expect(shouldRetryDaemonError(0, new TypeError("Failed to fetch"))).toBe(
      false,
    );
  });

  test("retries 502 bad gateway", () => {
    expect(shouldRetryDaemonError(0, new ApiError(502, "Bad gateway"))).toBe(
      true,
    );
  });

  // B2: 401 is EXPECTED (so it stays out of Sentry) but must NOT be retried.
  // The gateway blocks an IP after 10 auth failures in 60s, so retrying turned
  // one lost auth race into four gateway 401s — and several queries racing at
  // once manufactured a lockout of the user's own instance. Recovery comes from
  // the token-refresh path issuing a new credential, not from re-sending the
  // rejected one.
  test("does NOT retry 401 — retrying it manufactures a rate-limit lockout", () => {
    expect(
      shouldRetryDaemonError(
        0,
        new ApiError(401, "Authentication credentials were not provided."),
      ),
    ).toBe(false);
  });

  test("401 is still classified as expected, so it stays out of Sentry", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(401, "Authentication credentials were not provided."),
      ),
    ).toBe(true);
  });

  test("retries 400 org-header missing", () => {
    expect(
      shouldRetryDaemonError(
        0,
        new ApiError(400, "Vellum-Organization-Id header is required."),
      ),
    ).toBe(true);
  });
});
