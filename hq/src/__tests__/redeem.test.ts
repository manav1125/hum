import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { createHandler } from "../server.js";

const ADMIN = "test-admin-token";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ASSISTANT",
  "STRIPE_PRICE_CHIEF_OF_STAFF",
  "STRIPE_PRICE_OPERATOR",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Answers Stripe checkout/promo endpoints; records every request. */
function stripeMock() {
  const calls: { method: string; url: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, form: new URLSearchParams(String(init?.body ?? "")) });
    if (url.includes("/v1/promotion_codes?")) return Response.json({ data: [] });
    if (url.endsWith("/v1/coupons")) return Response.json({ id: "coupon_1" });
    if (url.endsWith("/v1/promotion_codes")) return Response.json({ id: "promo_1" });
    if (url.endsWith("/v1/checkout/sessions")) {
      return Response.json({ id: "cs_r1", url: "https://checkout.stripe.com/c/pay/cs_r1" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function setup(fetchImpl?: typeof fetch) {
  const db = new HqDb(":memory:");
  const handle = createHandler({
    db,
    driver: new MockDriver(),
    adminToken: ADMIN,
    fetchImpl,
  });
  const post = (path: string, body: unknown) =>
    handle(
      new Request(`http://hq.local${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const admin = (path: string, body: unknown = {}, method = "POST") =>
    handle(
      new Request(`http://hq.local${path}`, {
        method,
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body),
      }),
    );
  return { db, handle, post, admin };
}

describe("GET /plans", () => {
  test("serves the public pricing catalog", async () => {
    const { handle } = setup();
    const res = await handle(new Request("http://hq.local/plans"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plans: { id: string; priceUsd: number }[];
      topups: { id: string }[];
    };
    expect(body.plans.map((p) => p.id)).toEqual(["assistant", "chief_of_staff", "operator"]);
    expect(body.topups.length).toBe(2);
  });
});

describe("POST /redeem", () => {
  test("rejects bad input and bad codes with typed statuses", async () => {
    const { db, post } = setup();
    expect((await post("/redeem", { code: "", email: "a@x.io", name: "A" })).status).toBe(400);
    expect(
      (await post("/redeem", { code: "CUE-NOPE9999", email: "a@x.io", name: "A" })).status,
    ).toBe(404);

    const expired = db.createInvite({ expiresAt: Date.now() - 1000 });
    expect(
      (await post("/redeem", { code: expired.code, email: "a@x.io", name: "A" })).status,
    ).toBe(410);

    const spent = db.createInvite({ maxUses: 0 });
    expect(
      (await post("/redeem", { code: spent.code, email: "a@x.io", name: "A" })).status,
    ).toBe(410);
  });

  test("valid code creates the customer even in Stripe not-configured mode", async () => {
    const { db, post } = setup();
    const invite = db.createInvite({ maxUses: 1 });
    const res = await post("/redeem", {
      code: invite.code,
      email: "new@x.io",
      name: "New",
      plan: "operator",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.plan).toBe("operator");
    expect(body.checkoutUrl).toBeNull();
    expect(body.reason).toBe("stripe_not_configured");

    const customer = db.getCustomerByEmail("new@x.io")!;
    expect(customer.status).toBe("invited");
    expect(customer.plan).toBe("operator");
    expect(db.getInvite(invite.code)!.uses).toBe(1);

    // Invite is consumed — the second attempt is rejected.
    const again = await post("/redeem", { code: invite.code, email: "o@x.io", name: "O" });
    expect(again.status).toBe(410);
  });

  test("with Stripe configured, returns a checkout URL with the invite promo attached", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_CHIEF_OF_STAFF = "price_cos";
    const { fetchImpl, calls } = stripeMock();
    const { db, post } = setup(fetchImpl);
    const invite = db.createInvite({ percentOff: 30, maxUses: 1 });

    const res = await post("/redeem", {
      code: invite.code,
      email: "pay@x.io",
      name: "Pay",
      plan: "chief_of_staff",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.checkoutUrl).toContain("checkout.stripe.com");

    const session = calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!;
    expect(session.form.get("line_items[0][price]")).toBe("price_cos");
    expect(session.form.get("metadata[app]")).toBe("cue");
    expect(session.form.get("metadata[plan]")).toBe("chief_of_staff");
    expect(session.form.get("subscription_data[metadata][app]")).toBe("cue");
    expect(session.form.get("discounts[0][promotion_code]")).toBe("promo_1");

    const coupon = calls.find((c) => c.url.endsWith("/v1/coupons"))!;
    expect(coupon.form.get("percent_off")).toBe("30");
  });

  test("an existing waitlist customer is flipped to invited on redeem", async () => {
    const { db, post } = setup();
    const existing = db.createCustomer({ email: "wl@x.io", name: "WL" });
    const invite = db.createInvite({ maxUses: 1 });
    const res = await post("/redeem", {
      code: invite.code,
      email: "wl@x.io",
      name: "WL",
      plan: "assistant",
    });
    expect(res.status).toBe(200);
    const updated = db.getCustomer(existing.id)!;
    expect(updated.status).toBe("invited");
    expect(updated.plan).toBe("assistant");
  });
});

describe("admin credit routes", () => {
  test("manual top-up, adjustment, and the ledger read-back", async () => {
    const { db, admin } = setup();
    const c = db.createCustomer({ email: "adm@x.io", name: "Adm" });

    const topup = await admin(`/admin/customers/${c.id}/topup`, { credits: 1000 });
    expect(topup.status).toBe(200);
    expect(((await topup.json()) as { balance: number }).balance).toBe(1000);

    const pack = await admin(`/admin/customers/${c.id}/topup`, { topupId: "topup_5000" });
    expect(((await pack.json()) as { balance: number }).balance).toBe(6000);

    const adj = await admin(`/admin/customers/${c.id}/topup`, {
      kind: "adjustment",
      delta: -500,
      note: "test clawback",
    });
    expect(((await adj.json()) as { balance: number }).balance).toBe(5500);

    const bad = await admin(`/admin/customers/${c.id}/topup`, { credits: -5 });
    expect(bad.status).toBe(400);

    const ledger = await admin(`/admin/customers/${c.id}/credits`, {}, "GET");
    expect(ledger.status).toBe(200);
    const body = (await ledger.json()) as {
      balance: number;
      ledger: { kind: string }[];
    };
    expect(body.balance).toBe(5500);
    expect(body.ledger.length).toBe(3);
    expect(body.ledger.map((e) => e.kind)).toContain("adjustment");
  });

  test("manual top-up with an explicit ref is idempotent", async () => {
    const { db, admin } = setup();
    const c = db.createCustomer({ email: "ref@x.io", name: "Ref" });
    await admin(`/admin/customers/${c.id}/topup`, { credits: 1000, ref: "wire-1" });
    const again = await admin(`/admin/customers/${c.id}/topup`, { credits: 1000, ref: "wire-1" });
    const body = (await again.json()) as { applied: boolean; balance: number };
    expect(body.applied).toBe(false);
    expect(body.balance).toBe(1000);
  });
});
