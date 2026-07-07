import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";
import { getShareSkill } from "../share.js";

// A miniature site dir (for the /skills index-page fallthrough check) and a
// miniature first-party catalog the share pages render from.
const siteDir = mkdtempSync(join(tmpdir(), "hq-share-site-"));
writeFileSync(join(siteDir, "skills.html"), "<!doctype html>static skills index");

const catalogDir = mkdtempSync(join(tmpdir(), "hq-share-catalog-"));
const catalogPath = join(catalogDir, "catalog.json");
writeFileSync(
  catalogPath,
  JSON.stringify({
    version: 1,
    skills: [
      {
        id: "email-triage",
        name: "email-triage",
        description: "Triage your inbox & draft <replies> automatically.",
        metadata: {
          emoji: "📬",
          vellum: {
            "display-name": "Email Triage",
            category: "email",
            connectors: ["gmail", "outlook"],
            includes: ["vellum-browser-use"],
          },
        },
      },
      {
        id: "plain-skill",
        name: "plain-skill",
        description: "A skill with no declared capabilities.",
      },
    ],
  }),
);

afterAll(() => {
  rmSync(siteDir, { recursive: true, force: true });
  rmSync(catalogDir, { recursive: true, force: true });
});

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_SITE_DIR",
  "HQ_SKILLS_CATALOG",
  "HQ_PUBLIC_SITE_URL",
  "HQ_PUBLIC_URL",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SITE_DIR = siteDir;
  process.env.HQ_SKILLS_CATALOG = catalogPath;
  process.env.HQ_PUBLIC_SITE_URL = "https://justcue.ai";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Sensitive strings seeded into the DB — none may ever reach a share page. */
const SECRET_EMAIL = "leaky.customer@secret.example";
const SECRET_NAME = "Leaky Customer";
const SECRET_TOKEN_HASH = "deadbeefdeadbeefdeadbeefdeadbeef";
const SECRET_BOOTSTRAP = "bootstrap-secret-vAlUe-123";

function setup() {
  const db = new HqDb(":memory:");
  // Seed genuinely sensitive rows so the leak assertions bite.
  const customer = db.createCustomer({ email: SECRET_EMAIL, name: SECRET_NAME });
  const instance = db.createInstance({
    customerId: customer.id,
    driver: "mock",
    externalId: "mock-leak-1",
    url: "http://instance.internal.local",
    secretsJson: JSON.stringify({
      bootstrapSecret: SECRET_BOOTSTRAP,
      actorTokenSigningKey: "aa".repeat(32),
    }),
  });
  db.createSigninToken({
    customerId: customer.id,
    tokenHash: SECRET_TOKEN_HASH,
    ttlMs: 60_000,
  });
  const handle = createHandler({ db, driver: new MockDriver() });
  const get = (path: string, method = "GET") =>
    handle(new Request(`http://hq.local${path}`, { method }));
  return { db, customer, instance, get };
}

describe("shareable skill pages", () => {
  test("catalog skill renders 200 with OG tags, attribution, integrations, CTA", async () => {
    const { get } = setup();
    const res = await get("/skills/email-triage");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();

    // OG meta tags.
    expect(html).toContain('<meta property="og:title" content="Email Triage — Cue Skills">');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('<meta property="og:url" content="https://justcue.ai/skills/email-triage">');
    expect(html).toContain('<meta property="og:image" content="https://justcue.ai/assets/ui-skills.png"');
    expect(html).toContain('name="twitter:card"');

    // Attribution + declared integrations + companion skills.
    expect(html).toContain("Cue official");
    expect(html).toContain("Requires these integrations");
    expect(html).toContain("gmail");
    expect(html).toContain("outlook");
    expect(html).toContain("vellum-browser-use");

    // Install CTA deep-links into the app flow.
    expect(html).toContain('href="https://justcue.ai/signin?install=email-triage"');

    // Description is HTML-escaped (the catalog text contains & and <>).
    expect(html).toContain("&lt;replies&gt;");
    expect(html).not.toContain("<replies>");
  });

  test("seed-source community slug renders with owner/repo attribution", async () => {
    const { get } = setup();
    const res = await get("/skills/anthropics--skills--pdf");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pdf");
    expect(html).toContain("anthropics/skills");
    expect(html).toContain('href="https://github.com/anthropics/skills"');
    expect(html).toContain("signin?install=anthropics--skills--pdf");
  });

  test("unknown slugs and non-seeded repos 404", async () => {
    const { get } = setup();
    expect((await get("/skills/not-a-real-skill")).status).toBe(404);
    // owner/repo NOT in the seed list must not render (no dressing up
    // arbitrary links with a Cue-branded page).
    expect((await get("/skills/evil--repo--phish")).status).toBe(404);
    expect(getShareSkill("evil--repo--phish")).toBeNull();
    expect(getShareSkill("../etc/passwd")).toBeNull();
  });

  test("share pages leak ZERO customer data, tokens, or daemon endpoints", async () => {
    const { get, customer, instance } = setup();
    for (const path of ["/skills/email-triage", "/skills/plain-skill", "/skills/nope"]) {
      const res = await get(path);
      const html = await res.text();
      // No customer identity.
      expect(html).not.toContain(SECRET_EMAIL);
      expect(html).not.toContain(SECRET_NAME);
      expect(html).not.toContain(customer.id);
      // No secrets or tokens.
      expect(html).not.toContain(SECRET_BOOTSTRAP);
      expect(html).not.toContain(SECRET_TOKEN_HASH);
      expect(html.toLowerCase()).not.toContain("secretsjson");
      // No daemon/instance endpoints.
      expect(html).not.toContain(instance.url);
      expect(html).not.toContain(instance.id);
      // No session machinery on a public page.
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("HEAD answers headers-only; /skills index page stays static", async () => {
    const { get } = setup();
    const head = await get("/skills/email-triage", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    // The static /skills page (site dir) is untouched by the share route.
    const index = await get("/skills");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("static skills index");

    // Deeper paths fall through to static serving (miss ⇒ JSON 404).
    expect((await get("/skills/a/b")).status).toBe(404);
  });

  test("missing/malformed catalog degrades to 404, never a 500", async () => {
    process.env.HQ_SKILLS_CATALOG = join(catalogDir, "missing.json");
    const { get } = setup();
    expect((await get("/skills/email-triage")).status).toBe(404);
  });
});
