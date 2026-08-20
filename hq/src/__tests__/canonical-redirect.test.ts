import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";
import { canonicalHostRedirect } from "../site.js";

// A miniature site directory so non-API GETs resolve to a page.
const siteDir = mkdtempSync(join(tmpdir(), "hq-canon-"));
writeFileSync(join(siteDir, "index.html"), "<!doctype html>landing");
writeFileSync(join(siteDir, "pricing.html"), "<!doctype html>pricing page");

afterAll(() => rmSync(siteDir, { recursive: true, force: true }));

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_CANONICAL_HOST",
  "HQ_INSTANCE_DOMAIN",
  "HQ_SITE_DIR",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SITE_DIR = siteDir;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setup() {
  const db = new HqDb(":memory:");
  const handle = createHandler({ db, driver: new MockDriver(), adminToken: "t" });
  return { db, handle };
}

describe("canonicalHostRedirect (unit)", () => {
  test("no-op when HQ_CANONICAL_HOST is unset", () => {
    const url = new URL("https://cue-hq.fly.dev/pricing");
    const req = new Request(url);
    expect(canonicalHostRedirect(req, url, "/pricing")).toBeNull();
  });

  test("redirects a foreign host, preserving path + query", () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const url = new URL("https://justcue.io/pricing?plan=operator");
    const req = new Request(url, { headers: { host: "justcue.io" } });
    const res = canonicalHostRedirect(req, url, "/pricing");
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe(
      "https://justcue.ai/pricing?plan=operator",
    );
  });

  test("/admin is exempt — a redirect would strip the Bearer header", () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const url = new URL("http://localhost:8790/admin/status");
    const req = new Request(url, { headers: { host: "localhost:8790" } });
    expect(canonicalHostRedirect(req, url, "/admin/status")).toBeNull();
    expect(canonicalHostRedirect(req, url, "/admin")).toBeNull();
  });

  test("host matching is case-insensitive and ignores ports", () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const url = new URL("http://localhost:8790/");
    const canonical = new Request(url, { headers: { host: "JustCue.AI:443" } });
    expect(canonicalHostRedirect(canonical, url, "/")).toBeNull();
    const other = new Request(url, { headers: { host: "www.justcue.ai" } });
    expect(canonicalHostRedirect(other, url, "/")?.status).toBe(301);
  });
});

describe("canonical-host redirect (through the handler)", () => {
  test("off by default: any host serves the site directly", async () => {
    const { handle } = setup();
    const res = await handle(new Request("https://cue-hq.fly.dev/pricing"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pricing page");
  });

  test("GET on justcue.io / www / .fly.dev 301s to the canonical host", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const { handle } = setup();
    for (const host of ["justcue.io", "www.justcue.ai", "cue-hq.fly.dev"]) {
      const res = await handle(new Request(`https://${host}/pricing?x=1`));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://justcue.ai/pricing?x=1");
    }
  });

  test("the canonical host itself is served, not redirected", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const { handle } = setup();
    const res = await handle(new Request("https://justcue.ai/pricing"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pricing page");
  });

  test("POST /webhooks/stripe is NEVER redirected (any host)", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const { handle } = setup();
    const res = await handle(
      new Request("https://cue-hq.fly.dev/webhooks/stripe", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).not.toBe(301);
    // Reached the actual webhook handler (Stripe unconfigured here).
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("other POSTs also pass through on a non-canonical host", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const { handle } = setup();
    const res = await handle(
      new Request("https://justcue.io/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "w@x.io", name: "W" }),
      }),
    );
    expect(res.status).toBe(201);
  });

  test("/healthz answers 200 on any host (platform probes)", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const { handle } = setup();
    const res = await handle(new Request("https://cue-hq.fly.dev/healthz"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  // Regression: /admin used to 301 to the canonical host like any other GET.
  // fetch drops the Authorization header across a cross-origin redirect, so a
  // Bearer call from inside the machine (localhost / .fly.dev) arrived
  // unauthenticated and 401'd, while `?token=` survived in the query string —
  // which read as "the Bearer path is broken" rather than "we redirected it".
  test("admin API on a non-canonical host authenticates instead of redirecting", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const { handle } = setup();
    for (const origin of ["http://localhost:8790", "https://cue-hq.fly.dev"]) {
      const res = await handle(
        new Request(`${origin}/admin/status?probe=0`, {
          headers: { Authorization: "Bearer t" },
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    }
  });

  test("exempting /admin does not skip its auth — a bad token still 401s", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    const { handle } = setup();
    const res = await handle(
      new Request("https://cue-hq.fly.dev/admin/status?probe=0", {
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("instance-domain hosts are exempt", async () => {
    process.env.HQ_CANONICAL_HOST = "justcue.ai";
    process.env.HQ_INSTANCE_DOMAIN = "justcue.app";
    const { handle } = setup();
    for (const host of ["manav.justcue.app", "justcue.app"]) {
      const res = await handle(new Request(`https://${host}/`));
      expect(res.status).not.toBe(301);
    }
    // …but unrelated hosts still redirect.
    const res = await handle(new Request("https://justcue.io/"));
    expect(res.status).toBe(301);
  });
});
