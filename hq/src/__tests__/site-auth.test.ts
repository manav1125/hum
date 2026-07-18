import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { generateInstanceSecrets } from "../secrets.js";
import { createHandler } from "../server.js";
import {
  SESSION_COOKIE_NAME,
  hashSigninToken,
  mintSessionValue,
  verifySessionValue,
} from "../sessions.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_SESSION_SECRET",
  "HQ_SITE_DIR",
  "HQ_PUBLIC_SITE_URL",
  "HQ_PUBLIC_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_TOPUP_1000",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SESSION_SECRET = "test-session-secret";
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir"; // JSON 404s, not pages
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Mock fetch capturing Resend + Stripe calls. */
function outboundMock() {
  const resendCalls: Record<string, unknown>[] = [];
  const stripeCalls: { path: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.resend.com")) {
      resendCalls.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email_1" });
    }
    if (url.includes("api.stripe.com")) {
      stripeCalls.push({
        path: new URL(url).pathname,
        form: new URLSearchParams(String(init?.body)),
      });
      if (url.includes("billing_portal")) {
        return Response.json({ id: "bps_1", url: "https://billing.stripe.com/p/session_1" });
      }
      return Response.json({ id: "cs_topup_1", url: "https://checkout.stripe.com/c/pay/cs_topup_1" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, resendCalls, stripeCalls };
}

function setup() {
  const db = new HqDb(":memory:");
  const { fetchImpl, resendCalls, stripeCalls } = outboundMock();
  const handle = createHandler({ db, driver: new MockDriver(), adminToken: "t", fetchImpl });
  return { db, handle, resendCalls, stripeCalls };
}

function jsonReq(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://hq.local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("session cookie sign/verify", () => {
  test("round-trips a customer id", () => {
    const value = mintSessionValue("cust-123");
    expect(verifySessionValue(value)).toBe("cust-123");
  });

  test("rejects tampering, expiry, and garbage", () => {
    const value = mintSessionValue("cust-123");
    expect(verifySessionValue(value.slice(0, -2) + "xx")).toBeNull();
    const expired = mintSessionValue("cust-123", Date.now(), -10);
    expect(verifySessionValue(expired)).toBeNull();
    expect(verifySessionValue("v1.only.three")).toBeNull();
    expect(verifySessionValue("")).toBeNull();
    // Signature is bound to the id: swapping the payload breaks it.
    const parts = value.split(".");
    parts[1] = Buffer.from("cust-456").toString("base64url");
    expect(verifySessionValue(parts.join("."))).toBeNull();
  });
});

describe("signin token lifecycle", () => {
  test("known email → emailed link → /auth sets cookie → /account works; token is one-time", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.HQ_PUBLIC_SITE_URL = "http://hq.local";
    const { db, handle, resendCalls } = setup();
    const c = db.createCustomer({ email: "maya@x.io", name: "Maya Chen", plan: "chief_of_staff" });

    const res = await handle(jsonReq("/signin", { email: "maya@x.io" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(resendCalls.length).toBe(1);
    const html = String(resendCalls[0].html);
    const match = /\/auth\?token=([0-9a-f]{64})/.exec(html);
    expect(match).not.toBeNull();
    const rawToken = match![1];

    // Consume the link: 302 → /account (no live instance to land in) with
    // the session cookie set.
    const auth = await handle(new Request(`http://hq.local/auth?token=${rawToken}`));
    expect(auth.status).toBe(302);
    expect(auth.headers.get("location")).toBe("/account");
    const setCookie = auth.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookieValue = setCookie.split(";")[0].split("=").slice(1).join("=");
    expect(verifySessionValue(cookieValue)).toBe(c.id);

    // Cookie-authed summary.
    const summary = await handle(
      new Request("http://hq.local/account/summary", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
      }),
    );
    expect(summary.status).toBe(200);

    // Replay: the token was consumed — no cookie the second time.
    const replay = await handle(new Request(`http://hq.local/auth?token=${rawToken}`));
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("/signin?error=link_expired");
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  test("unknown email answers ok:true and sends nothing (no existence leak)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const { handle, resendCalls } = setup();
    const res = await handle(jsonReq("/signin", { email: "stranger@x.io" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(resendCalls.length).toBe(0);
  });

  test("expired tokens cannot be consumed", () => {
    const { db } = setup();
    const c = db.createCustomer({ email: "e@x.io", name: "E" });
    db.createSigninToken({
      customerId: c.id,
      tokenHash: hashSigninToken("raw-expired"),
      ttlMs: -1,
    });
    expect(db.consumeSigninToken(hashSigninToken("raw-expired"))).toBeNull();
    // A live one consumes exactly once.
    db.createSigninToken({
      customerId: c.id,
      tokenHash: hashSigninToken("raw-live"),
      ttlMs: 60_000,
    });
    expect(db.consumeSigninToken(hashSigninToken("raw-live"))?.customerId).toBe(c.id);
    expect(db.consumeSigninToken(hashSigninToken("raw-live"))).toBeNull();
  });

  test("signin without HQ_SESSION_SECRET is 503", async () => {
    delete process.env.HQ_SESSION_SECRET;
    const { handle } = setup();
    const res = await handle(jsonReq("/signin", { email: "a@x.io" }));
    expect(res.status).toBe(503);
  });

  test("/auth with a live instance lands in the app (fresh magic link) + cookie", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.HQ_PUBLIC_SITE_URL = "http://hq.local";
    const { db, handle, resendCalls } = setup();
    const c = db.createCustomer({ email: "live@x.io", name: "Liv", plan: "chief_of_staff" });
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-live";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-live",
      url: "http://live.mock.local",
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");

    await handle(jsonReq("/signin", { email: "live@x.io" }));
    const match = /\/auth\?token=([0-9a-f]{64})/.exec(String(resendCalls[0].html));
    const auth = await handle(
      new Request(`http://hq.local/auth?token=${match![1]}`),
    );
    expect(auth.status).toBe(302);
    expect(auth.headers.get("location")).toStartWith(
      "http://live.mock.local/assistant/?cueToken=",
    );
    const cookieValue = (auth.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .split("=")
      .slice(1)
      .join("=");
    expect(verifySessionValue(cookieValue)).toBe(c.id);
  });

  test("native mode resolves the token to JSON — no redirect, no cookie", async () => {
    // The mobile app opens the universal link and needs the instance + token
    // as data (it navigates its own WebView), not a 302 it can't read.
    process.env.RESEND_API_KEY = "re_test";
    process.env.HQ_PUBLIC_SITE_URL = "http://hq.local";
    const { db, handle, resendCalls } = setup();
    const c = db.createCustomer({ email: "nat@example.com", name: "Nat Rivera", plan: "chief_of_staff" });
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-nat";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-nat",
      url: "http://nat.mock.local",
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");

    await handle(jsonReq("/signin", { email: "nat@example.com" }));
    const raw = /\/auth\?token=([0-9a-f]{64})/.exec(String(resendCalls[0].html))![1];
    const res = await handle(
      new Request(`http://hq.local/auth?token=${raw}&native=1`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.instanceUrl).toBe("http://nat.mock.local");
    expect(typeof body.cueToken).toBe("string");
    expect(body.name).toBe("Nat"); // first name, for the "You're in, Nat" landing
  });

  test("native mode answers JSON for a dead link — the app can show a real error", async () => {
    process.env.HQ_PUBLIC_SITE_URL = "http://hq.local";
    const { handle } = setup();
    const res = await handle(
      new Request("http://hq.local/auth?token=deadbeef&native=1"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  test("the app's cross-origin sign-in fetch gets CORS; the browser doesn't", async () => {
    const { handle } = setup();
    // Preflight from the iOS WebView origin.
    const pre = await handle(
      new Request("http://hq.local/signin", {
        method: "OPTIONS",
        headers: { origin: "capacitor://localhost" },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(
      "capacitor://localhost",
    );
    // The actual POST reflects the same origin.
    const post = await handle(
      new Request("http://hq.local/signin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "capacitor://localhost",
        },
        body: JSON.stringify({ email: "who@example.com" }),
      }),
    );
    expect(post.headers.get("access-control-allow-origin")).toBe(
      "capacitor://localhost",
    );
    // A random web origin gets no CORS grant.
    const evil = await handle(
      new Request("http://hq.local/signin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example.com",
        },
        body: JSON.stringify({ email: "who@example.com" }),
      }),
    );
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("serves the Apple app-site-association so the app claims the link", async () => {
    const { handle } = setup();
    const res = await handle(
      new Request("http://hq.local/.well-known/apple-app-site-association"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const aasa = (await res.json()) as {
      applinks: { details: Array<{ appIDs: string[]; components: unknown[] }> };
    };
    expect(aasa.applinks.details[0].appIDs).toContain(
      "XU8BLQACGU.com.ventureverse.cue",
    );
    expect(aasa.applinks.details[0].components.length).toBeGreaterThan(0);
  });
});

describe("/account", () => {
  function authedCustomer(db: HqDb) {
    const c = db.createCustomer({ email: "acct@x.io", name: "Acct", plan: "chief_of_staff" });
    db.upsertSubscription({
      customerId: c.id,
      stripeCustomerId: "cus_acct",
      stripeSubId: "sub_acct",
      status: "active",
      currentPeriodEnd: Date.now() + 20 * 86_400_000,
      plan: "chief_of_staff",
    });
    const cookie = `${SESSION_COOKIE_NAME}=${mintSessionValue(c.id)}`;
    return { c, cookie };
  }

  test("summary requires the session cookie", async () => {
    const { handle } = setup();
    const res = await handle(new Request("http://hq.local/account/summary"));
    expect(res.status).toBe(401);
  });

  test("summary shape: plan, credits cycle math, 30 usage days", async () => {
    const { db, handle } = setup();
    const { c, cookie } = authedCustomer(db);
    db.appendCreditEntry({ customerId: c.id, delta: 10000, kind: "grant", note: "grant sub_acct@1" });
    db.appendCreditEntry({ customerId: c.id, delta: -1200, kind: "usage_sync", note: "usage_sync i 0c→300c" });
    db.appendCreditEntry({ customerId: c.id, delta: 500, kind: "topup", note: "topup t1" });

    const res = await handle(
      new Request("http://hq.local/account/summary", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      email: string;
      plan: { id: string; name: string; priceUsd: number; monthlyCredits: number };
      renewalDate: string | null;
      credits: { balance: number; grantedThisCycle: number; usedThisCycle: number; refreshDate: string | null };
      usage: { days: { date: string; credits: number }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.email).toBe("acct@x.io");
    expect(body.plan).toEqual({
      id: "chief_of_staff",
      name: "Chief of Staff",
      priceUsd: 99,
      monthlyCredits: 10000,
    });
    expect(body.credits.balance).toBe(9300);
    expect(body.credits.grantedThisCycle).toBe(10000);
    expect(body.credits.usedThisCycle).toBe(1200);
    expect(body.renewalDate).not.toBeNull();
    expect(body.usage.days.length).toBe(30);
    const todayTotal = body.usage.days[body.usage.days.length - 1].credits;
    expect(todayTotal).toBe(1200);
  });

  test("topup: pack validation, Stripe checkout with /account return, honest degradation", async () => {
    const { db, handle, stripeCalls } = setup();
    const { cookie } = authedCustomer(db);

    const bad = await handle(jsonReq("/account/topup", { pack: "mega" }, { cookie }));
    expect(bad.status).toBe(400);

    // Stripe unconfigured → redeem-style honest null.
    const degraded = await handle(jsonReq("/account/topup", { pack: "topup_1000" }, { cookie }));
    expect(degraded.status).toBe(200);
    const dBody = (await degraded.json()) as { ok: boolean; checkoutUrl: null; reason: string };
    expect(dBody.checkoutUrl).toBeNull();
    expect(dBody.reason).toBe("stripe_not_configured");

    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_TOPUP_1000 = "price_topup_1000";
    const ok = await handle(jsonReq("/account/topup", { pack: "1000" }, { cookie }));
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { checkoutUrl: string };
    expect(okBody.checkoutUrl).toContain("checkout.stripe.com");
    const form = stripeCalls[stripeCalls.length - 1].form;
    expect(form.get("mode")).toBe("payment");
    expect(form.get("success_url")).toContain("/account?topup=success");
    expect(form.get("cancel_url")).toContain("/account");
  });

  test("topup rejects cross-origin requests (CSRF)", async () => {
    const { db, handle } = setup();
    const { cookie } = authedCustomer(db);
    const res = await handle(
      jsonReq("/account/topup", { pack: "topup_1000" }, { cookie, origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    // Matching origin passes the guard.
    const ok = await handle(
      jsonReq("/account/topup", { pack: "topup_1000" }, { cookie, origin: "http://hq.local" }),
    );
    expect(ok.status).toBe(200);
  });

  test("portal: 302 to Stripe billing portal; unauthenticated → /signin", async () => {
    const { db, handle } = setup();
    const { cookie } = authedCustomer(db);
    process.env.STRIPE_SECRET_KEY = "sk_test";

    const anon = await handle(new Request("http://hq.local/account/portal"));
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/signin");

    const res = await handle(
      new Request("http://hq.local/account/portal", { headers: { cookie } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://billing.stripe.com/p/session_1");
  });

  test("open: 302 to a fresh magic link; no instance → quiet fallback; anon → /signin", async () => {
    const { db, handle } = setup();
    const { c, cookie } = authedCustomer(db);

    const anon = await handle(new Request("http://hq.local/account/open"));
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/signin");

    // Authed but instanceless → the quiet notice fallback.
    const none = await handle(
      new Request("http://hq.local/account/open", { headers: { cookie } }),
    );
    expect(none.status).toBe(302);
    expect(none.headers.get("location")).toBe("/account?error=no_instance");

    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-open";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-open",
      url: "http://open.mock.local",
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");

    const res = await handle(
      new Request("http://hq.local/account/open", { headers: { cookie } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith(
      "http://open.mock.local/assistant/?cueToken=",
    );
  });

  test("summary reports the live instance url for the Open Cue button", async () => {
    const { db, handle } = setup();
    const { c, cookie } = authedCustomer(db);
    const secrets = generateInstanceSecrets();
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-a1",
      url: "http://acct.mock.local",
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");
    const res = await handle(
      new Request("http://hq.local/account/summary", { headers: { cookie } }),
    );
    const body = (await res.json()) as { instanceUrl: string };
    expect(body.instanceUrl).toBe("http://acct.mock.local");
  });
});
