import { describe, expect, test } from "bun:test";

const { httpStatusFromError, shouldRetryQuery, queryRetryDelay } =
  await import("@/utils/query-retry");
const { ApiError } = await import("@/utils/api-errors");

describe("httpStatusFromError", () => {
  test("reads ApiError.status", () => {
    expect(httpStatusFromError(new ApiError(429, "rate limited"))).toBe(429);
  });

  test("reads a numeric status field", () => {
    expect(httpStatusFromError({ status: 503 })).toBe(503);
  });

  test("reads response.status", () => {
    expect(httpStatusFromError({ response: { status: 502 } })).toBe(502);
  });

  test("returns undefined for network/non-HTTP errors", () => {
    expect(
      httpStatusFromError(new TypeError("Failed to fetch")),
    ).toBeUndefined();
    expect(httpStatusFromError("boom")).toBeUndefined();
  });
});

describe("shouldRetryQuery", () => {
  // Was "never retries 429 (the storm trigger)". That was right against a
  // 300 req/min limiter; the daemon's authenticated budget is now 2,000/min
  // and loopback 5,000, so the premise no longer holds. What did hold was the
  // consequence: one transient 429 was terminal, and several surfaces render a
  // terminal read failure as an EMPTY state — a rate limit shown to the owner
  // as "you have nothing here".
  test("retries a 429 exactly once — it is the one 4xx that self-heals", () => {
    expect(shouldRetryQuery(0, new ApiError(429, "rate limited"))).toBe(true);
  });

  test("does not retry a 429 a second time — one retry cannot storm", () => {
    // The rate at most doubles for a single round and then stops. Three
    // retries could pin the request rate above the limit indefinitely, which
    // is the failure the original policy was written against.
    expect(shouldRetryQuery(1, new ApiError(429, "rate limited"))).toBe(false);
    expect(shouldRetryQuery(2, new ApiError(429, "rate limited"))).toBe(false);
  });

  test("a daemon-bodied RATE_LIMITED is treated the same as a 429", () => {
    // The generated SDK throws the parsed body, which carries no `status`.
    const body = { error: { code: "RATE_LIMITED", message: "Too Many" } };
    expect(shouldRetryQuery(0, body)).toBe(true);
    expect(shouldRetryQuery(1, body)).toBe(false);
  });

  test("never retries other 4xx client errors", () => {
    expect(shouldRetryQuery(0, new ApiError(401, "unauthorized"))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(404, "not found"))).toBe(false);
  });

  test("retries transient 5xx", () => {
    expect(shouldRetryQuery(0, new ApiError(503, "starting"))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError(502, "bad gateway"))).toBe(true);
  });

  test("retries network errors (no status)", () => {
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  test("stops after 3 failures regardless of error", () => {
    expect(shouldRetryQuery(3, new ApiError(503, "starting"))).toBe(false);
    expect(shouldRetryQuery(3, new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  test("capped exponential backoff", () => {
    expect(queryRetryDelay(0)).toBe(1000);
    expect(queryRetryDelay(1)).toBe(2000);
    expect(queryRetryDelay(2)).toBe(4000);
    expect(queryRetryDelay(10)).toBe(30_000); // capped
  });

  test("a 429 waits a jittered fixed delay, not the exponential curve", () => {
    // Jitter is load-bearing, not decoration: a burst rate-limits many queries
    // on the same tick, and a fixed delay would have them all retry together
    // and rebuild the burst exactly. Matches rateLimitRetry's mutation
    // backoff (1200ms + up to 600ms).
    const err = new ApiError(429, "rate limited");
    const samples = Array.from({ length: 50 }, () => queryRetryDelay(0, err));
    for (const d of samples) {
      expect(d).toBeGreaterThanOrEqual(1_200);
      expect(d).toBeLessThan(1_800);
    }
    // Spread, not a constant — otherwise the herd is still synchronised.
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  test("non-429 errors keep the exponential curve", () => {
    expect(queryRetryDelay(1, new ApiError(503, "starting"))).toBe(2000);
  });
});
