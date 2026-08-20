import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HQ_MAC_DOWNLOAD_URL", "HQ_SITE_DIR", "HQ_SESSION_SECRET"];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir"; // JSON 404s, not pages
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

describe("GET /downloads/cue-macos.dmg", () => {
  test("redirects to the current GitHub release asset", async () => {
    const { handle } = setup();
    const res = await handle(
      new Request("http://hq.local/downloads/cue-macos.dmg"),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    // The public URL is stable; only the release tag moves. Assert the shape
    // so a version bump does not need this test edited, but a broken target does.
    expect(loc).toMatch(
      /^https:\/\/github\.com\/manav1125\/cue-releases\/releases\/download\/v[\d.]+\/Cue-[\d.]+-arm64\.dmg$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("HQ_MAC_DOWNLOAD_URL overrides the target", async () => {
    process.env.HQ_MAC_DOWNLOAD_URL = "https://example.com/custom.dmg";
    try {
      const { handle } = setup();
      const res = await handle(
        new Request("http://hq.local/downloads/cue-macos.dmg"),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://example.com/custom.dmg");
    } finally {
      delete process.env.HQ_MAC_DOWNLOAD_URL;
    }
  });
});

describe("POST /testflight", () => {
  function post(handle: (req: Request) => Promise<Response>, body: unknown) {
    return handle(
      new Request("http://hq.local/testflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("records testflight_interest once per email (idempotent, case-insensitive)", async () => {
    const { db, handle } = setup();

    const first = await post(handle, { email: "ios@x.io" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { ok: boolean }).ok).toBe(true);
    expect(
      db.findLatestEventByKindData("testflight_interest", '"email":"ios@x.io"'),
    ).not.toBeNull();

    const again = await post(handle, { email: "IOS@x.io " });
    expect(again.status).toBe(200);
    const body = (await again.json()) as { ok: boolean; existing?: boolean };
    expect(body.ok).toBe(true);
    expect(body.existing).toBe(true);
    // Still exactly one event.
    const events = db
      .listEvents(50)
      .filter((e) => e.kind === "testflight_interest");
    expect(events.length).toBe(1);
  });

  test("links the event to a known customer; validates the email", async () => {
    const { db, handle } = setup();
    const c = db.createCustomer({ email: "known@x.io", name: "Known" });

    const res = await post(handle, { email: "known@x.io" });
    expect(res.status).toBe(200);
    expect(db.findLatestEvent("testflight_interest", c.id)).not.toBeNull();

    expect((await post(handle, { email: "nope" })).status).toBe(400);
    expect((await post(handle, {})).status).toBe(400);
  });
});
