/**
 * Direct password sign-in (migration 9) — the mailbox-less exception.
 *
 * Cue is magic-link only. This path exists because App Review rejected iOS
 * 1.0 twice under Guideline 2.1: the reviewer has no access to the demo
 * account's inbox, reads only the User Name / Password fields in App Store
 * Connect, and will not follow instructions to act outside the app. So one
 * account — the review account — carries a password.
 *
 * What these tests pin down is the boundary: an account WITHOUT a password
 * must behave exactly as it always did, and the password must never leak.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";

const ADMIN = "test-admin-token";
const PASSWORD = "correct-horse-battery";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_SESSION_SECRET",
  "HQ_SITE_DIR",
  "HQ_PUBLIC_SITE_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "HQ_ALPHA_ALLOWLIST",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SESSION_SECRET = "test-session-secret";
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setup() {
  const db = new HqDb(":memory:");
  const resendCalls: { body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.resend.com")) {
      if (url.endsWith("/domains")) {
        return Response.json({
          data: [{ name: "justcue.ai", status: "verified" }],
        });
      }
      resendCalls.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ id: "email_1" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const handle = createHandler({
    db,
    driver: new MockDriver(),
    adminToken: ADMIN,
    fetchImpl,
  });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    handle(
      new Request(`http://hq.local${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const adminHeaders = { Authorization: `Bearer ${ADMIN}` };
  return { db, handle, post, adminHeaders, resendCalls };
}

/** A customer with a live-looking row and a password already set. */
async function withPassword(s: ReturnType<typeof setup>, email: string) {
  const customer = s.db.createCustomer({ email, name: "App Review" });
  const res = await s.post(
    `/admin/customers/${customer.id}/signin-password`,
    { password: PASSWORD },
    s.adminHeaders,
  );
  expect(res.status).toBe(200);
  return customer;
}

describe("direct password sign-in", () => {
  test("an account with a password is asked for one, and no email is sent", async () => {
    const s = setup();
    process.env.RESEND_API_KEY = "re_test";
    await withPassword(s, "reviewer@example.com");

    const res = await s.post("/signin", { email: "reviewer@example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; token?: string };
    expect(body.status).toBe("password_required");
    // The whole point: nothing goes to a mailbox nobody can read.
    expect(s.resendCalls).toHaveLength(0);
    expect(body.token).toBeUndefined();
  });

  test("the right password returns a usable one-time token", async () => {
    const s = setup();
    await withPassword(s, "reviewer@example.com");

    const res = await s.post("/signin", {
      email: "reviewer@example.com",
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; token: string };
    expect(body.status).toBe("password_ok");
    // 32 random bytes as hex — the same shape the email link carries, so
    // GET /auth consumes it through the established path.
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);

    // And it really is live: consuming it once works, twice does not.
    const { hashSigninToken } = await import("../sessions.js");
    expect(s.db.consumeSigninToken(hashSigninToken(body.token))).not.toBeNull();
    expect(s.db.consumeSigninToken(hashSigninToken(body.token))).toBeNull();
  });

  test("a wrong password is rejected with no token and no email", async () => {
    const s = setup();
    process.env.RESEND_API_KEY = "re_test";
    await withPassword(s, "reviewer@example.com");

    const res = await s.post("/signin", {
      email: "reviewer@example.com",
      password: "not-the-password",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: string; token?: string };
    expect(body.status).toBe("password_invalid");
    expect(body.token).toBeUndefined();
    expect(s.resendCalls).toHaveLength(0);
  });

  test("an ordinary customer is completely unaffected", async () => {
    const s = setup();
    process.env.RESEND_API_KEY = "re_test";
    s.db.createCustomer({ email: "someone@example.com", name: "Someone" });

    const res = await s.post("/signin", { email: "someone@example.com" });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("sent");
    expect(s.resendCalls).toHaveLength(1);

    // Even if a password is supplied for an account that has none, the
    // magic link is still what happens — a password can never be used to
    // sign in to an account that was never given one.
    const res2 = await s.post("/signin", {
      email: "someone@example.com",
      password: PASSWORD,
    });
    expect(((await res2.json()) as { status: string }).status).toBe("sent");
  });

  test("the password hash never leaves HQ", async () => {
    const s = setup();
    const customer = await withPassword(s, "reviewer@example.com");

    // The admin setter confirms only that a password now exists.
    const res = await s.post(
      `/admin/customers/${customer.id}/signin-password`,
      { password: PASSWORD },
      s.adminHeaders,
    );
    const raw = await res.text();
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("$argon2");
    expect(JSON.parse(raw)).toEqual({ ok: true, hasPassword: true });

    // Nor does the admin page render it.
    const page = await s.handle(
      new Request("http://hq.local/admin", { headers: s.adminHeaders }),
    );
    const html = await page.text();
    expect(html).not.toContain("$argon2");
  });

  test("a password can be taken away again", async () => {
    const s = setup();
    process.env.RESEND_API_KEY = "re_test";
    const customer = await withPassword(s, "reviewer@example.com");

    const cleared = await s.post(
      `/admin/customers/${customer.id}/signin-password`,
      { password: null },
      s.adminHeaders,
    );
    expect(await cleared.json()).toEqual({ ok: true, hasPassword: false });

    // Back to the ordinary emailed-link flow.
    const res = await s.post("/signin", { email: "reviewer@example.com" });
    expect(((await res.json()) as { status: string }).status).toBe("sent");
    expect(s.resendCalls).toHaveLength(1);
  });

  test("repeated wrong guesses are throttled before the hash is even checked", async () => {
    const s = setup();
    // A distinct address per run: the throttle map is process-local and
    // shared across tests in this file.
    const email = "throttled@example.com";
    await withPassword(s, email);

    const guess = () =>
      s.post("/signin", { email, password: "not-the-password" });

    for (let i = 0; i < 5; i++) {
      expect((await guess()).status).toBe(401);
    }
    // Sixth attempt is refused outright.
    const blocked = await guess();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { status: string };
    expect(body.status).toBe("password_throttled");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);

    // And the throttle holds even against the CORRECT password — it is a
    // lockout, not a "wrong answers only" filter.
    const right = await s.post("/signin", { email, password: PASSWORD });
    expect(right.status).toBe(429);
  });

  test("a successful sign-in clears the failure count", async () => {
    const s = setup();
    const email = "recovers@example.com";
    await withPassword(s, email);

    for (let i = 0; i < 4; i++) {
      await s.post("/signin", { email, password: "wrong" });
    }
    // Correct password before the 5th failure: allowed, and resets.
    expect((await s.post("/signin", { email, password: PASSWORD })).status).toBe(
      200,
    );
    // So four more wrong guesses still do not lock the account out.
    for (let i = 0; i < 4; i++) {
      expect((await s.post("/signin", { email, password: "wrong" })).status).toBe(
        401,
      );
    }
  });

  test("a too-short password is refused rather than stored weakly", async () => {
    const s = setup();
    const customer = s.db.createCustomer({
      email: "reviewer@example.com",
      name: "App Review",
    });
    const res = await s.post(
      `/admin/customers/${customer.id}/signin-password`,
      { password: "short" },
      s.adminHeaders,
    );
    expect(res.status).toBe(400);
    expect(s.db.getCustomer(customer.id)?.signinPasswordHash).toBeNull();
  });
});
