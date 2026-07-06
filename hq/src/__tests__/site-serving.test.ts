import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";
import { resolveSitePath } from "../site.js";

// A miniature site directory mirroring the real site/ layout.
const siteDir = mkdtempSync(join(tmpdir(), "hq-site-"));
writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>Cue</title>landing");
writeFileSync(join(siteDir, "pricing.html"), "<!doctype html>pricing page");
writeFileSync(join(siteDir, "welcome.html"), "<!doctype html>welcome page");
writeFileSync(join(siteDir, "commerce.js"), "window.CueCommerce = {};");
mkdirSync(join(siteDir, "assets"));
writeFileSync(join(siteDir, "assets", "ui.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

afterAll(() => rmSync(siteDir, { recursive: true, force: true }));

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HQ_SITE_DIR", "OPENROUTER_PROVISIONING_KEY", "OPENROUTER_SHARED_KEY"];
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
  const get = (path: string) => handle(new Request(`http://hq.local${path}`));
  return { db, handle, get };
}

describe("static site serving", () => {
  test("/ serves index.html as text/html", async () => {
    const { get } = setup();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("landing");
  });

  test("clean URLs: /pricing → pricing.html; exact files also served", async () => {
    const { get } = setup();
    const clean = await get("/pricing");
    expect(clean.status).toBe(200);
    expect(await clean.text()).toContain("pricing page");

    const exact = await get("/pricing.html");
    expect(exact.status).toBe(200);

    const js = await get("/commerce.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

    const png = await get("/assets/ui.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  test("checkout redirect contract: /checkout/success → welcome, /checkout/cancel → pricing", async () => {
    const { get } = setup();
    const success = await get("/checkout/success?session_id=cs_x");
    expect(success.status).toBe(200);
    expect(await success.text()).toContain("welcome page");
    const cancel = await get("/checkout/cancel");
    expect(await cancel.text()).toContain("pricing page");
  });

  test("API routes keep priority over static files", async () => {
    const { get, handle } = setup();
    // /plans is JSON even though the static fallthrough exists.
    const plans = await get("/plans");
    expect(plans.headers.get("content-type")).toContain("application/json");
    const body = (await plans.json()) as { plans: unknown[] };
    expect(body.plans.length).toBe(3);

    // POST /waitlist still works (static serving is GET/HEAD only).
    const wl = await handle(
      new Request("http://hq.local/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "s@x.io", name: "S" }),
      }),
    );
    expect(wl.status).toBe(201);
  });

  test("path traversal is blocked and unknown paths 404 as JSON", async () => {
    expect(resolveSitePath(siteDir, "/../../etc/passwd")).toBeNull();
    expect(resolveSitePath(siteDir, "/..%2f..%2fetc/passwd")).toBeNull();
    const { get } = setup();
    const missing = await get("/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  });
});
