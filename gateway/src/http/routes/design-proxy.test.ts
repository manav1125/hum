import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createDesignProxyHandler,
  isDesignHostRequest,
  isDesignProxyConfigured,
} from "./design-proxy.js";

/**
 * Mock Cue Design (OpenDesign daemon) upstream: records the last request and
 * answers with a body naming the path it saw, so assertions can check the
 * verbatim path pass-through, header rewrites, and cookie stripping.
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
      return new Response(`upstream saw ${url.pathname}`, {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  process.env.DESIGN_UPSTREAM_URL = `http://localhost:${upstream.port}`;
  process.env.DESIGN_HOST = "design.justcue.test";
});

afterAll(() => {
  delete process.env.DESIGN_UPSTREAM_URL;
  delete process.env.DESIGN_HOST;
  void upstream.stop(true);
});

function mintCookie(
  handler: ReturnType<typeof createDesignProxyHandler>,
): string {
  const res = handler.handleMintSession(
    new Request("https://justcue.test/design/cue-session", { method: "POST" }),
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toContain("cue_design=");
  expect(setCookie).toContain("HttpOnly");
  // The parent-domain attribute is what lets the app-origin cookie ride to
  // the design hostname.
  expect(setCookie).toContain("Domain=justcue.test");
  return setCookie.split(";")[0];
}

describe("design proxy", () => {
  test("configured only when both envs are set", () => {
    expect(isDesignProxyConfigured()).toBe(true);
    const saved = process.env.DESIGN_HOST;
    delete process.env.DESIGN_HOST;
    expect(isDesignProxyConfigured()).toBe(false);
    process.env.DESIGN_HOST = saved;
  });

  test("host matching is exact, case-insensitive, and port-tolerant", () => {
    const mk = (host: string) =>
      new Request("https://x/", { headers: { host } });
    expect(isDesignHostRequest(mk("design.justcue.test"))).toBe(true);
    expect(isDesignHostRequest(mk("Design.JustCue.test"))).toBe(true);
    expect(isDesignHostRequest(mk("design.justcue.test:443"))).toBe(true);
    expect(isDesignHostRequest(mk("justcue.test"))).toBe(false);
    expect(isDesignHostRequest(mk("evil-design.justcue.test"))).toBe(false);
  });

  test("x-forwarded-host wins over host for dispatch", () => {
    const req = new Request("https://x/", {
      headers: {
        host: "internal.fly.local",
        "x-forwarded-host": "design.justcue.test",
      },
    });
    expect(isDesignHostRequest(req)).toBe(true);
  });

  test("mint response carries the design surface URL", async () => {
    const handler = createDesignProxyHandler();
    const res = handler.handleMintSession(
      new Request("https://justcue.test/design/cue-session", {
        method: "POST",
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe("https://design.justcue.test/");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("proxies verbatim paths with a valid cookie and strips it upstream", async () => {
    const handler = createDesignProxyHandler();
    const cookie = mintCookie(handler);
    const res = await handler.handleDesignHost(
      new Request("https://design.justcue.test/api/skills?limit=5", {
        headers: { cookie: `${cookie}; other=1` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream saw /api/skills");
    expect(lastUpstreamReq?.path).toBe("/api/skills?limit=5");
    // Session cookie is gateway business; sibling cookies still cross.
    expect(lastUpstreamReq?.headers.get("cookie")).toBe("other=1");
    expect(lastUpstreamReq?.headers.get("x-forwarded-host")).toBe(
      "design.justcue.test",
    );
  });

  test("unauthenticated HTML navigation bounces to the app origin", async () => {
    const handler = createDesignProxyHandler();
    const res = await handler.handleDesignHost(
      new Request("https://design.justcue.test/", {
        headers: { accept: "text/html", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://justcue.test/assistant/design",
    );
  });

  test("unauthenticated API calls get a plain 401", async () => {
    const handler = createDesignProxyHandler();
    const res = await handler.handleDesignHost(
      new Request("https://design.justcue.test/api/projects", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("a forged cookie is rejected", async () => {
    const handler = createDesignProxyHandler();
    const res = await handler.handleDesignHost(
      new Request("https://design.justcue.test/api/projects", {
        headers: { cookie: `cue_design=${Date.now() + 60000}.deadbeef` },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("cookies from one process are invalid in another (per-process secret)", async () => {
    const cookie = mintCookie(createDesignProxyHandler());
    const other = createDesignProxyHandler();
    const res = await other.handleDesignHost(
      new Request("https://design.justcue.test/api/projects", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("skills list proxies the sidecar catalog", async () => {
    const handler = createDesignProxyHandler();
    const res = await handler.handleSkillsList(
      new Request("https://justcue.test/design/skills"),
    );
    expect(res.status).toBe(200);
    // The mock upstream echoes the path it saw; the real one returns a
    // catalog, but this proves the request reaches /api/skills.
    expect(lastUpstreamReq?.path).toBe("/api/skills");
    expect(lastUpstreamReq?.headers.get("origin")).toBe(
      "https://design.justcue.test",
    );
  });

  test("skills list fails open to an empty list when design is unconfigured", async () => {
    const savedUrl = process.env.DESIGN_UPSTREAM_URL;
    delete process.env.DESIGN_UPSTREAM_URL;
    const handler = createDesignProxyHandler();
    const res = await handler.handleSkillsList(
      new Request("https://justcue.test/design/skills"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skills: [] });
    process.env.DESIGN_UPSTREAM_URL = savedUrl;
  });

  test("unconfigured proxy 404s the mint and the host handler", async () => {
    const savedUrl = process.env.DESIGN_UPSTREAM_URL;
    delete process.env.DESIGN_UPSTREAM_URL;
    const handler = createDesignProxyHandler();
    expect(
      handler.handleMintSession(
        new Request("https://justcue.test/design/cue-session", {
          method: "POST",
        }),
      ).status,
    ).toBe(404);
    const res = await handler.handleDesignHost(
      new Request("https://design.justcue.test/api/skills"),
    );
    expect(res.status).toBe(404);
    process.env.DESIGN_UPSTREAM_URL = savedUrl;
  });
});
