import { describe, test, expect } from "bun:test";

import { AuthRateLimiter } from "../auth-rate-limiter.js";
import {
  UPSTREAM_RESPONSE_MARKER_HEADER,
  wrapWithAuthFailureTracking,
} from "../http/middleware/auth.js";

const CLIENT_IP = "203.0.113.7";

/** AuthRateLimiter with a spy on recordFailure. */
function makeLimiterSpy() {
  const limiter = new AuthRateLimiter();
  const calls: string[] = [];
  const original = limiter.recordFailure.bind(limiter);
  limiter.recordFailure = (ip: string) => {
    calls.push(ip);
    original(ip);
  };
  return { limiter, calls };
}

describe("wrapWithAuthFailureTracking", () => {
  test("plain 401 without marker records an auth failure", async () => {
    const { limiter, calls } = makeLimiterSpy();
    const wrapped = wrapWithAuthFailureTracking(
      () => Response.json({ error: "Unauthorized" }, { status: 401 }),
      limiter,
      () => CLIENT_IP,
    );

    const res = await wrapped(new Request("http://localhost/v1/x"));

    expect(res.status).toBe(401);
    expect(calls).toEqual([CLIENT_IP]);
  });

  test("401 with upstream marker does NOT record a failure and strips the marker", async () => {
    // An upstream (daemon) 401 relayed by the proxy is not a client auth
    // failure — the gateway already validated the client's edge token.
    const { limiter, calls } = makeLimiterSpy();
    const wrapped = wrapWithAuthFailureTracking(
      () =>
        Response.json(
          { error: "Unauthorized" },
          {
            status: 401,
            headers: {
              [UPSTREAM_RESPONSE_MARKER_HEADER]: "1",
              "x-custom": "preserved",
            },
          },
        ),
      limiter,
      () => CLIENT_IP,
    );

    const res = await wrapped(new Request("http://localhost/v1/x"));

    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
    // The internal marker must never leak to the client.
    expect(res.headers.has(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe(false);
    // Other headers and the body survive the strip.
    expect(res.headers.get("x-custom")).toBe("preserved");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("repeated upstream 401s never block the client IP", async () => {
    const { limiter } = makeLimiterSpy();
    const wrapped = wrapWithAuthFailureTracking(
      () =>
        Response.json(
          { error: "Unauthorized" },
          {
            status: 401,
            headers: { [UPSTREAM_RESPONSE_MARKER_HEADER]: "1" },
          },
        ),
      limiter,
      () => CLIENT_IP,
    );

    // Well past the default 10-failures/60s threshold.
    for (let i = 0; i < 25; i++) {
      await wrapped(new Request("http://localhost/v1/x"));
    }

    expect(limiter.isBlocked(CLIENT_IP)).toBe(false);
  });

  test("marker is stripped even on success responses", async () => {
    const { limiter, calls } = makeLimiterSpy();
    const wrapped = wrapWithAuthFailureTracking(
      () =>
        new Response("ok", {
          status: 200,
          headers: { [UPSTREAM_RESPONSE_MARKER_HEADER]: "1" },
        }),
      limiter,
      () => CLIENT_IP,
    );

    const res = await wrapped(new Request("http://localhost/v1/x"));

    expect(res.status).toBe(200);
    expect(res.headers.has(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe(false);
    expect(calls).toEqual([]);
    expect(await res.text()).toBe("ok");
  });

  test("custom failureStatuses [400] still record without marker (oauth callback contract)", async () => {
    const { limiter, calls } = makeLimiterSpy();
    const wrapped = wrapWithAuthFailureTracking(
      () => Response.json({ error: "Bad Request" }, { status: 400 }),
      limiter,
      () => CLIENT_IP,
      [400],
    );

    const res = await wrapped(
      new Request("http://localhost/webhooks/oauth/callback"),
    );

    expect(res.status).toBe(400);
    expect(calls).toEqual([CLIENT_IP]);
  });

  test("non-failure statuses without marker do not record", async () => {
    const { limiter, calls } = makeLimiterSpy();
    const wrapped = wrapWithAuthFailureTracking(
      () => new Response("ok", { status: 200 }),
      limiter,
      () => CLIENT_IP,
    );

    const res = await wrapped(new Request("http://localhost/v1/x"));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
