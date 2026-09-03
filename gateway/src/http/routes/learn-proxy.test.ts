import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createLearnProxyHandler,
  isLearnProxyConfigured,
} from "./learn-proxy.js";

/**
 * Mock OpenMAIC upstream: records the last request and answers with a body
 * naming the path it saw, so assertions can check the path mapping, header
 * rewrites, and cookie stripping without a real Next.js server.
 */
let upstream: ReturnType<typeof Bun.serve>;
let lastUpstreamReq: { path: string; headers: Headers } | undefined;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      lastUpstreamReq = {
        path: url.pathname + url.search,
        headers: req.headers,
      };
      // Mirror Next's compression: gzip when the client advertises it, so
      // the compressed-pass-through contract has a real body to check.
      if (url.pathname === "/learn/gzip-probe") {
        const body = Bun.gzipSync(Buffer.from("compressed hello"));
        return new Response(body, {
          headers: {
            "content-type": "text/plain",
            "content-encoding": "gzip",
          },
        });
      }
      return new Response(`upstream saw ${url.pathname}`, {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  process.env.LEARN_UPSTREAM_URL = `http://localhost:${upstream.port}`;
});

afterAll(() => {
  delete process.env.LEARN_UPSTREAM_URL;
  void upstream.stop(true);
});

function mintCookie(
  handler: ReturnType<typeof createLearnProxyHandler>,
): string {
  const res = handler.handleMintSession(
    new Request("http://gateway.local/learn/cue-session", { method: "POST" }),
  );
  expect(res.status).toBe(204);
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toContain("cue_learn=");
  expect(setCookie).toContain("HttpOnly");
  return setCookie.split(";")[0];
}

describe("learn-proxy", () => {
  test("is configured only while LEARN_UPSTREAM_URL is set", () => {
    expect(isLearnProxyConfigured()).toBe(true);
    const saved = process.env.LEARN_UPSTREAM_URL;
    delete process.env.LEARN_UPSTREAM_URL;
    expect(isLearnProxyConfigured()).toBe(false);
    process.env.LEARN_UPSTREAM_URL = saved;
  });

  test("rejects an uncookied API request with 401", async () => {
    const handler = createLearnProxyHandler();
    const res = await handler.handleApiShim(
      new Request("http://gateway.local/api/generate", { method: "POST" }),
      "/generate",
    );
    expect(res.status).toBe(401);
  });

  test("redirects an uncookied page navigation into the app", async () => {
    const handler = createLearnProxyHandler();
    const res = await handler.handleLearnPath(
      new Request("http://gateway.local/learn/", {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
      "/",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/assistant/learn");
  });

  test("rejects a forged cookie", async () => {
    const handler = createLearnProxyHandler();
    const res = await handler.handleLearnPath(
      new Request("http://gateway.local/learn/", {
        headers: {
          accept: "text/html",
          cookie: `cue_learn=${Date.now() + 60_000}.deadbeef`,
        },
      }),
      "/",
    );
    expect(res.status).toBe(302);
  });

  test("a cookie from one process is invalid in another (ephemeral secret)", async () => {
    const cookie = mintCookie(createLearnProxyHandler());
    const other = createLearnProxyHandler();
    const res = await other.handleLearnPath(
      new Request("http://gateway.local/learn/", {
        headers: { accept: "text/html", cookie },
      }),
      "/",
    );
    expect(res.status).toBe(302);
  });

  test("proxies a cookied /learn request through with forwarded-host set", async () => {
    const handler = createLearnProxyHandler();
    const cookie = mintCookie(handler);
    const res = await handler.handleLearnPath(
      new Request("http://gateway.local/learn/classroom/abc?x=1", {
        headers: { accept: "text/html", cookie },
      }),
      "/classroom/abc",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream saw /learn/classroom/abc");
    expect(lastUpstreamReq?.path).toBe("/learn/classroom/abc?x=1");
    expect(lastUpstreamReq?.headers.get("x-forwarded-host")).toBe(
      "gateway.local",
    );
    // The session cookie is gateway business and must not reach OpenMAIC.
    expect(lastUpstreamReq?.headers.get("cookie")).toBeNull();
  });

  test("maps the /api shim onto the upstream /learn/api namespace", async () => {
    const handler = createLearnProxyHandler();
    const cookie = mintCookie(handler);
    const res = await handler.handleApiShim(
      new Request("http://gateway.local/api/generate-classroom", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ requirement: "test" }),
      }),
      "/generate-classroom",
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamReq?.path).toBe("/learn/api/generate-classroom");
  });

  test("keeps OpenMAIC's own cookies while stripping the session cookie", async () => {
    const handler = createLearnProxyHandler();
    const cookie = mintCookie(handler);
    await handler.handleLearnPath(
      new Request("http://gateway.local/learn/", {
        headers: {
          accept: "text/html",
          cookie: `${cookie}; openmaic_access=abc123`,
        },
      }),
      "/",
    );
    expect(lastUpstreamReq?.headers.get("cookie")).toBe(
      "openmaic_access=abc123",
    );
  });

  test("maps public-asset shim paths onto the upstream /learn namespace", async () => {
    const handler = createLearnProxyHandler();
    const cookie = mintCookie(handler);
    const res = await handler.handlePublicAssetShim(
      new Request("http://gateway.local/avatars/user.png", {
        headers: { cookie },
      }),
      "/avatars/user.png",
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamReq?.path).toBe("/learn/avatars/user.png");
  });

  test("passes compressed bodies through verbatim with their encoding header", async () => {
    const handler = createLearnProxyHandler();
    const cookie = mintCookie(handler);
    const res = await handler.handleLearnPath(
      new Request("http://gateway.local/learn/gzip-probe", {
        headers: { cookie, "accept-encoding": "gzip" },
      }),
      "/gzip-probe",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    // The upstream saw the client's accept-encoding (not a stripped one)…
    expect(lastUpstreamReq?.headers.get("accept-encoding")).toBe("gzip");
    // …and the body arrives still gzipped, not transparently decompressed.
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(Buffer.from(Bun.gunzipSync(bytes)).toString()).toBe(
      "compressed hello",
    );
  });

  test("a trusted (loopback-daemon) request needs no cookie", async () => {
    const handler = createLearnProxyHandler();
    const res = await handler.handleApiShim(
      new Request("http://gateway.local/api/classroom-sources"),
      "/classroom-sources",
      true,
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamReq!.path).toBe("/learn/api/classroom-sources");
  });

  test("injects the upstream access secret and strips a forged copy", async () => {
    process.env.LEARN_UPSTREAM_SECRET = "s3cret";
    try {
      const handler = createLearnProxyHandler();
      const cookie = mintCookie(handler);
      const res = await handler.handleLearnPath(
        new Request("http://gateway.local/learn/api/stages", {
          headers: { cookie, "x-openmaic-access": "attacker-guess" },
        }),
        "/api/stages",
      );
      expect(res.status).toBe(200);
      expect(lastUpstreamReq!.headers.get("x-openmaic-access")).toBe("s3cret");
    } finally {
      delete process.env.LEARN_UPSTREAM_SECRET;
    }
  });

  test("a forged access header is stripped even with no secret configured", async () => {
    const handler = createLearnProxyHandler();
    const cookie = mintCookie(handler);
    const res = await handler.handleLearnPath(
      new Request("http://gateway.local/learn/api/stages", {
        headers: { cookie, "x-openmaic-access": "attacker-guess" },
      }),
      "/api/stages",
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamReq!.headers.get("x-openmaic-access")).toBeNull();
  });

  test("answers 404 everywhere when unconfigured", async () => {
    const saved = process.env.LEARN_UPSTREAM_URL;
    delete process.env.LEARN_UPSTREAM_URL;
    try {
      const handler = createLearnProxyHandler();
      const mint = handler.handleMintSession(
        new Request("http://gateway.local/learn/cue-session", {
          method: "POST",
        }),
      );
      expect(mint.status).toBe(404);
      const page = await handler.handleLearnPath(
        new Request("http://gateway.local/learn/"),
        "/",
      );
      expect(page.status).toBe(404);
    } finally {
      process.env.LEARN_UPSTREAM_URL = saved;
    }
  });
});
