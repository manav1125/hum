import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HQ_DOWNLOADS_DIR", "HQ_SITE_DIR", "HQ_SESSION_SECRET"];
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
  test("serves the DMG from HQ_DOWNLOADS_DIR with the right headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hq-downloads-"));
    try {
      const bytes = Buffer.from("not-really-a-dmg-but-bytes");
      writeFileSync(join(dir, "cue-macos.dmg"), bytes);
      process.env.HQ_DOWNLOADS_DIR = dir;
      const { handle } = setup();

      const res = await handle(
        new Request("http://hq.local/downloads/cue-macos.dmg"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/x-apple-diskimage",
      );
      expect(res.headers.get("content-length")).toBe(String(bytes.length));
      expect(res.headers.get("content-disposition")).toContain(
        "cue-macos.dmg",
      );
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);

      // HEAD answers headers only.
      const head = await handle(
        new Request("http://hq.local/downloads/cue-macos.dmg", {
          method: "HEAD",
        }),
      );
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(bytes.length));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file answers a friendly branded 404 page", async () => {
    process.env.HQ_DOWNLOADS_DIR = "/nonexistent-downloads-dir";
    const { handle } = setup();
    const res = await handle(
      new Request("http://hq.local/downloads/cue-macos.dmg"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Cue");
    expect(html).toContain("isn't ready yet");
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
