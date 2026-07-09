import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { verifyActorToken } from "../secrets.js";
import { createHandler } from "../server.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_SESSION_SECRET",
  "HQ_SITE_DIR",
  "HQ_PUBLIC_SITE_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SESSION_SECRET = "test-session-secret";
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir";
  process.env.RESEND_API_KEY = "re_test";
  process.env.HQ_PUBLIC_SITE_URL = "http://hq.local";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setup() {
  const db = new HqDb(":memory:");
  const resendCalls: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("api.resend.com")) {
      resendCalls.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email_1" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const handle = createHandler({
    db,
    driver: new MockDriver(),
    adminToken: "admintok",
    fetchImpl,
  });
  return { db, handle, resendCalls };
}

const SIGNING_KEY = "a".repeat(64);
const PRINCIPAL = "vellum-principal-test-1234";

function adminReq(path: string, body: unknown) {
  return new Request(`http://hq.local${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer admintok",
    },
    body: JSON.stringify(body),
  });
}
function jsonReq(path: string, body: unknown) {
  return new Request(`http://hq.local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /admin/register-instance", () => {
  test("registers customer + live instance → email sign-in lands in the instance with a valid token", async () => {
    const { db, handle, resendCalls } = setup();

    const reg = await handle(
      adminReq("/admin/register-instance", {
        email: "Owner@example.com", // mixed case → stored lowercased
        name: "Manav Gupta",
        url: "https://manav.justcue.app/", // trailing slash → stripped
        signingKey: SIGNING_KEY,
        guardianPrincipalId: PRINCIPAL,
        externalId: "cue-manav-prod",
      }),
    );
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as { ok: boolean; url: string };
    expect(regBody.ok).toBe(true);
    expect(regBody.url).toBe("https://manav.justcue.app");

    const customer = db.getCustomerByEmail("owner@example.com");
    expect(customer).not.toBeNull();
    const inst = db.listInstancesByCustomer(customer!.id)[0];
    expect(inst.state).toBe("live");

    // Full email sign-in: /signin → emailed link → /auth → magic link.
    const signin = await handle(jsonReq("/signin", { email: "owner@example.com" }));
    expect(signin.status).toBe(200);
    const match = /\/auth\?token=([0-9a-f]{64})/.exec(
      String(resendCalls[0].html),
    );
    expect(match).not.toBeNull();

    const auth = await handle(
      new Request(`http://hq.local/auth?token=${match![1]}`),
    );
    expect(auth.status).toBe(302);
    const loc = auth.headers.get("location") ?? "";
    expect(loc).toStartWith("https://manav.justcue.app/assistant/?cueToken=");

    // The minted magic-link token verifies under the registered signing key
    // and carries the guardian principal we registered.
    const token = new URL(loc).searchParams.get("cueToken") ?? "";
    const v = verifyActorToken(token, SIGNING_KEY);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.sub).toBe(`actor:Cue:${PRINCIPAL}`);
  });

  test("validates email, url, and 64-hex signing key", async () => {
    const { handle } = setup();
    const base = {
      email: "x@example.com",
      url: "https://a.b",
      signingKey: SIGNING_KEY,
      guardianPrincipalId: "p",
    };
    expect(
      (await handle(adminReq("/admin/register-instance", { ...base, signingKey: "short" }))).status,
    ).toBe(400);
    expect(
      (await handle(adminReq("/admin/register-instance", { ...base, email: "bad" }))).status,
    ).toBe(400);
    expect(
      (await handle(adminReq("/admin/register-instance", { ...base, url: "notaurl" }))).status,
    ).toBe(400);
    expect(
      (await handle(adminReq("/admin/register-instance", { ...base, guardianPrincipalId: "" }))).status,
    ).toBe(400);
  });

  test("refuses a second live instance for the same customer, and requires admin auth", async () => {
    const { handle } = setup();
    const ok = await handle(
      adminReq("/admin/register-instance", {
        email: "dup@example.com",
        url: "https://one.app",
        signingKey: SIGNING_KEY,
        guardianPrincipalId: "p1",
      }),
    );
    expect(ok.status).toBe(200);
    const dup = await handle(
      adminReq("/admin/register-instance", {
        email: "dup@example.com",
        url: "https://two.app",
        signingKey: "b".repeat(64),
        guardianPrincipalId: "p2",
      }),
    );
    expect(dup.status).toBe(409);

    const noauth = await handle(
      jsonReq("/admin/register-instance", {
        email: "z@example.com",
        url: "https://z.app",
        signingKey: "c".repeat(64),
        guardianPrincipalId: "p3",
      }),
    );
    expect(noauth.status).toBe(401);
  });
});
