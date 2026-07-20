import { describe, expect, test } from "bun:test";

import { isLoopbackAddress } from "../auth.js";
import {
  apiRateLimiter,
  isMutatingMethod,
  loopbackApiRateLimiter,
  selectAuthenticatedRateLimiter,
  WriteBurstLimiter,
} from "../rate-limiter.js";

describe("isLoopbackAddress", () => {
  test("accepts loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.42.0.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects private (non-loopback) and public addresses", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("172.16.0.5")).toBe(false);
    expect(isLoopbackAddress("169.254.0.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
    expect(isLoopbackAddress("fd00::1")).toBe(false);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
  });

  test("rejects malformed input", () => {
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
    expect(isLoopbackAddress("127.0.0")).toBe(false);
    expect(isLoopbackAddress("127.0.0.999")).toBe(false);
  });
});

describe("selectAuthenticatedRateLimiter", () => {
  test("loopback clients get the higher-budget limiter", () => {
    expect(selectAuthenticatedRateLimiter("127.0.0.1")).toBe(
      loopbackApiRateLimiter,
    );
    expect(selectAuthenticatedRateLimiter("::1")).toBe(loopbackApiRateLimiter);
    expect(selectAuthenticatedRateLimiter("::ffff:127.0.0.1")).toBe(
      loopbackApiRateLimiter,
    );
  });

  test("remote and LAN clients get the standard limiter", () => {
    expect(selectAuthenticatedRateLimiter("192.168.1.20")).toBe(apiRateLimiter);
    expect(selectAuthenticatedRateLimiter("203.0.113.9")).toBe(apiRateLimiter);
  });

  test("loopback budget exceeds the standard budget", () => {
    const loopback = loopbackApiRateLimiter.check(
      "test-loopback-budget",
      "/v1/test",
    );
    const standard = apiRateLimiter.check("test-standard-budget", "/v1/test");
    expect(loopback.limit).toBeGreaterThan(standard.limit);
    expect(loopback.limit).toBe(5000);
    expect(standard.limit).toBe(2000);
  });
});

describe("WriteBurstLimiter", () => {
  test("grants a full burst up to capacity, then denies", () => {
    const limiter = new WriteBurstLimiter(20, 0.5);
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) {
      expect(limiter.tryTake("1.2.3.4", now)).toBe(true);
    }
    expect(limiter.tryTake("1.2.3.4", now)).toBe(false);
  });

  test("refills over time at the configured rate", () => {
    const limiter = new WriteBurstLimiter(20, 0.5);
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) limiter.tryTake("k", now);
    expect(limiter.tryTake("k", now)).toBe(false);
    // 0.5 tokens/sec → 1 token after 2s.
    expect(limiter.tryTake("k", now + 2_100)).toBe(true);
    expect(limiter.tryTake("k", now + 2_100)).toBe(false);
    // Long idle refills back to (capped) capacity.
    for (let i = 0; i < 20; i++) {
      expect(limiter.tryTake("k", now + 100_000)).toBe(true);
    }
    expect(limiter.tryTake("k", now + 100_000)).toBe(false);
  });

  test("buckets are per-key", () => {
    const limiter = new WriteBurstLimiter(2, 0.5);
    const now = 5_000;
    expect(limiter.tryTake("a", now)).toBe(true);
    expect(limiter.tryTake("a", now)).toBe(true);
    expect(limiter.tryTake("a", now)).toBe(false);
    expect(limiter.tryTake("b", now)).toBe(true);
  });
});

describe("isMutatingMethod", () => {
  test("write methods qualify; reads do not", () => {
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("PATCH")).toBe(true);
    expect(isMutatingMethod("PUT")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
    expect(isMutatingMethod("patch")).toBe(true);
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    expect(isMutatingMethod("OPTIONS")).toBe(false);
  });
});
