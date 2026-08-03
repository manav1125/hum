import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HQ_ORIGIN,
  HQ_SIGNIN_PATH,
  buildHqProxyResponse,
  buildHqUnreachableResponse,
  planHqForward,
  resolveHqOrigin,
} from "./hq-forward";

const request = (pathname: string, method = "POST") => ({
  url: `app://vellum.ai${pathname}`,
  method,
});

describe("planHqForward", () => {
  test("passes the renderer's own assets through to static serving", () => {
    expect(planHqForward(request("/assistant/assets/app.js", "GET"), DEFAULT_HQ_ORIGIN)).toEqual({
      kind: "pass",
    });
    expect(planHqForward(request("/assistant", "GET"), DEFAULT_HQ_ORIGIN)).toEqual({
      kind: "pass",
    });
    // A path that merely starts with the mount's characters is not the mount.
    expect(
      planHqForward(request("/assistant/__hqsomething", "GET"), DEFAULT_HQ_ORIGIN),
    ).toEqual({ kind: "pass" });
  });

  test("forwards the sign-in POST to HQ", () => {
    const plan = planHqForward(request(HQ_SIGNIN_PATH), DEFAULT_HQ_ORIGIN);
    expect(plan.kind).toBe("forward");
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://justcue.ai/signin");
    expect(plan.method).toBe("POST");
  });

  test("builds its own headers rather than copying the renderer's", () => {
    const plan = planHqForward(request(HQ_SIGNIN_PATH), DEFAULT_HQ_ORIGIN);
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect([...plan.headers.keys()].sort()).toEqual(["accept", "content-type"]);
    expect(plan.headers.get("content-type")).toBe("application/json");
  });

  test("drops the query string so an email can never ride the URL", () => {
    const plan = planHqForward(
      { url: `app://vellum.ai${HQ_SIGNIN_PATH}?email=owner%40example.com`, method: "POST" },
      DEFAULT_HQ_ORIGIN,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://justcue.ai/signin");
    expect(plan.url).not.toContain("email");
    expect(plan.url).not.toContain("?");
  });

  test("the destination is ours — a renderer-supplied host cannot redirect it", () => {
    // Every shape a renderer might try to smuggle a destination through: an
    // absolute URL in the path, a host swap, a traversal back out of the mount.
    for (const attempt of [
      `/assistant/__hq/signin/../../../evil`,
      `/assistant/__hq/https://evil.example.com/signin`,
      `/assistant/__hq/signin@evil.example.com`,
    ]) {
      const plan = planHqForward(request(attempt), DEFAULT_HQ_ORIGIN);
      // Whatever it decides, the one thing it must never do is forward
      // somewhere the renderer named. (A `..` climb normalizes back out of the
      // mount and simply isn't ours.)
      if (plan.kind === "forward") {
        expect(plan.url).toBe("https://justcue.ai/signin");
      } else {
        expect(plan.kind === "pass" || plan.kind === "reject").toBe(true);
      }
    }
    // …and a request that arrives claiming another origin entirely still
    // forwards to HQ, because the destination never comes from the request.
    const plan = planHqForward(
      { url: `https://evil.example.com${HQ_SIGNIN_PATH}`, method: "POST" },
      DEFAULT_HQ_ORIGIN,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://justcue.ai/signin");
  });

  test("refuses every route under the mount except signin", () => {
    for (const path of [
      "/assistant/__hq",
      "/assistant/__hq/",
      "/assistant/__hq/admin",
      "/assistant/__hq/signin/extra",
      "/assistant/__hq/customers",
    ]) {
      expect(planHqForward(request(path), DEFAULT_HQ_ORIGIN)).toEqual({
        kind: "reject",
        status: 404,
        message: "Not Found",
      });
    }
  });

  test("refuses every method except POST", () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      expect(planHqForward(request(HQ_SIGNIN_PATH, method), DEFAULT_HQ_ORIGIN)).toEqual({
        kind: "reject",
        status: 405,
        message: "Method Not Allowed",
      });
    }
  });
});

describe("resolveHqOrigin", () => {
  test("defaults to production HQ", () => {
    expect(resolveHqOrigin({})).toBe("https://justcue.ai");
    expect(resolveHqOrigin({ CUE_HQ_URL: "   " })).toBe("https://justcue.ai");
  });

  test("honors an https override for staging", () => {
    expect(resolveHqOrigin({ CUE_HQ_URL: "https://hq.staging.example/" })).toBe(
      "https://hq.staging.example",
    );
  });

  test("allows plain http only on loopback", () => {
    expect(resolveHqOrigin({ CUE_HQ_URL: "http://localhost:8787" })).toBe(
      "http://localhost:8787",
    );
    expect(resolveHqOrigin({ CUE_HQ_URL: "http://127.0.0.1:8787" })).toBe(
      "http://127.0.0.1:8787",
    );
  });

  test("refuses to send an email address anywhere unencrypted or unparseable", () => {
    for (const raw of [
      "http://hq.evil.example",
      "ftp://justcue.ai",
      "not a url",
      "//justcue.ai",
    ]) {
      expect(resolveHqOrigin({ CUE_HQ_URL: raw })).toBe("https://justcue.ai");
    }
  });
});

describe("proxy responses", () => {
  test("a transport failure reads as unreachable, never as a sent link", async () => {
    const res = buildHqUnreachableResponse();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string };
    // Not one of HQ's statuses, so the sign-on client's `default` branch maps
    // it to `unreachable` — the honest state with the justcue.ai fallback.
    expect(body.status).toBe("unreachable");
    expect(body.status).not.toBe("sent");
  });

  test("HQ's status and body reach the renderer verbatim", async () => {
    const res = buildHqProxyResponse(200, JSON.stringify({ status: "sent" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"sent"}');
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  test("does not replay HQ's own response headers onto the app origin", () => {
    const res = buildHqProxyResponse(200, "{}");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
