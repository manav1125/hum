import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import {
  createCheckoutSession,
  handleStripeWebhook,
  signStripePayload,
  verifyStripeSignature,
} from "../stripe.js";

const WHSEC = "whsec_test_secret";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_FOUNDING",
  "STRIPE_PRICE_FOUNDING_BYO",
  // The legacy-alias tests set this; without it here the value leaks into
  // every file that runs after this one.
  "STRIPE_PRICE_CHIEF_OF_STAFF",
];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function activeCustomer(db: HqDb, email: string) {
  const c = db.createCustomer({ email, name: "T" });
  db.transitionCustomer(c.id, "invited");
  return c;
}

function event(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({ id: "evt_1", type, data: { object } });
}

describe("signature verification", () => {
  test("accepts a valid signature and rejects tampering", () => {
    const body = '{"hello":"world"}';
    const header = signStripePayload(body, WHSEC);
    expect(verifyStripeSignature(body, header, WHSEC)).toBe(true);
    expect(verifyStripeSignature(body + " ", header, WHSEC)).toBe(false);
    expect(verifyStripeSignature(body, header, "whsec_other")).toBe(false);
    expect(verifyStripeSignature(body, null, WHSEC)).toBe(false);
    expect(verifyStripeSignature(body, "garbage", WHSEC)).toBe(false);
  });

  test("rejects stale timestamps outside tolerance", () => {
    const body = "{}";
    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    const header = signStripePayload(body, WHSEC, staleTs);
    expect(verifyStripeSignature(body, header, WHSEC)).toBe(false);
    expect(verifyStripeSignature(body, header, WHSEC, 7200)).toBe(true);
  });
});

describe("webhook state flips", () => {
  test("not-configured mode returns 503 without touching state", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const db = new HqDb(":memory:");
    const outcome = await handleStripeWebhook(
      { db, driver: new MockDriver() },
      "{}",
      null,
    );
    expect(outcome.status).toBe(503);
  });

  test("checkout.session.completed → customer active + subscription row", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = activeCustomer(db, "buy@x.io");

    const body = event("checkout.session.completed", {
      id: "cs_123",
      customer: "cus_123",
      subscription: "sub_123",
      metadata: { customerId: c.id },
    });
    const outcome = await handleStripeWebhook(
      { db, driver },
      body,
      signStripePayload(body, WHSEC),
    );
    expect(outcome.status).toBe(200);
    expect(db.getCustomer(c.id)?.status).toBe("active");
    expect(db.getSubscription(c.id)?.stripeSubId).toBe("sub_123");
  });

  test("invalid signature never flips state", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = new HqDb(":memory:");
    const c = activeCustomer(db, "sig@x.io");
    const body = event("checkout.session.completed", {
      metadata: { customerId: c.id },
    });
    const outcome = await handleStripeWebhook(
      { db, driver: new MockDriver() },
      body,
      signStripePayload(body, "whsec_wrong"),
    );
    expect(outcome.status).toBe(400);
    expect(db.getCustomer(c.id)?.status).toBe("invited");
  });

  test("subscription.deleted → churned + instance suspended via driver", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = activeCustomer(db, "churn@x.io");
    db.transitionCustomer(c.id, "active");
    const provisioned = await driver.provision({
      customerId: c.id,
      name: "cue-churn",
      env: {},
    });
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: provisioned.externalId,
      url: provisioned.url,
      state: "provisioning",
    });
    db.transitionInstance(inst.id, "live");
    db.upsertSubscription({
      customerId: c.id,
      stripeCustomerId: "cus_9",
      stripeSubId: "sub_9",
      status: "active",
      currentPeriodEnd: null,
    });

    const body = event("customer.subscription.deleted", {
      id: "sub_9",
      customer: "cus_9",
    });
    const outcome = await handleStripeWebhook(
      { db, driver },
      body,
      signStripePayload(body, WHSEC),
    );
    expect(outcome.status).toBe(200);
    expect(db.getCustomer(c.id)?.status).toBe("churned");
    expect(db.getInstance(inst.id)?.state).toBe("suspended");
    expect(driver.calls.some((call) => call.method === "suspend")).toBe(true);
  });

  test("subscription.updated active → resumes a suspended customer", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = activeCustomer(db, "back@x.io");
    db.transitionCustomer(c.id, "active");
    db.transitionCustomer(c.id, "suspended");
    const provisioned = await driver.provision({
      customerId: c.id,
      name: "cue-back",
      env: {},
    });
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: provisioned.externalId,
      url: provisioned.url,
      state: "provisioning",
    });
    db.transitionInstance(inst.id, "live");
    db.transitionInstance(inst.id, "suspended");

    const body = event("customer.subscription.updated", {
      id: "sub_up",
      customer: "cus_up",
      status: "active",
      current_period_end: Math.floor(Date.now() / 1000) + 86400,
      metadata: { customerId: c.id },
    });
    const outcome = await handleStripeWebhook(
      { db, driver },
      body,
      signStripePayload(body, WHSEC),
    );
    expect(outcome.status).toBe(200);
    expect(db.getCustomer(c.id)?.status).toBe("active");
    expect(db.getInstance(inst.id)?.state).toBe("live");
    expect(driver.calls.some((call) => call.method === "resume")).toBe(true);
  });

  test("unknown event types are acknowledged and audited", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    const db = new HqDb(":memory:");
    // invoice.paid is handled now — use a genuinely unhandled type.
    const body = event("customer.created", {});
    const outcome = await handleStripeWebhook(
      { db, driver: new MockDriver() },
      body,
      signStripePayload(body, WHSEC),
    );
    expect(outcome.status).toBe(200);
    expect(db.listEvents().some((e) => e.kind === "stripe_webhook_ignored")).toBe(
      true,
    );
  });
});

describe("checkout session (mock fetch)", () => {
  test("not-configured mode returns a typed error", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const result = await createCheckoutSession({
      customerId: "c1",
      email: "x@x.io",
      plan: "founding",
    });
    expect(result).toEqual({ ok: false, reason: "stripe_not_configured" });
  });

  test("posts a subscription-mode session with customer metadata", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PRICE_FOUNDING = "price_f1";
    let captured: { url: string; body: string } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), body: String(init?.body ?? "") };
      return Response.json({
        id: "cs_test_1",
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
      });
    }) as typeof fetch;

    const result = await createCheckoutSession(
      { customerId: "cust-42", email: "pay@x.io", plan: "founding" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain("checkout.stripe.com");
    }
    expect(captured!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const form = new URLSearchParams(captured!.body);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_f1");
    expect(form.get("metadata[customerId]")).toBe("cust-42");
  });
});

describe("legacy plan aliases still resolve a price", () => {
  test("REGRESSION: founding falls back to the chief_of_staff price", async () => {
    // Prod carries STRIPE_PRICE_CHIEF_OF_STAFF and no STRIPE_PRICE_FOUNDING.
    // The legacy branch used to return early with `undefined`, so every
    // founding customer — which on this instance is BOTH real customers — got
    // `no_price_configured_for_founding` instead of a checkout.
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    delete process.env.STRIPE_PRICE_FOUNDING;
    process.env.STRIPE_PRICE_CHIEF_OF_STAFF = "price_cos";
    let body = "";
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return Response.json({ id: "cs_1", url: "https://checkout.stripe.com/1" });
    }) as typeof fetch;

    const result = await createCheckoutSession(
      { customerId: "c1", email: "legacy@x.io", plan: "founding" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(new URLSearchParams(body).get("line_items[0][price]")).toBe(
      "price_cos",
    );
  });

  test("a dedicated founding price still wins when it is set", () => {
    // The fallback must not override an explicitly configured legacy price.
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PRICE_FOUNDING = "price_legacy";
    process.env.STRIPE_PRICE_CHIEF_OF_STAFF = "price_cos";
    // Asserted through the same public seam the checkout uses.
    return createCheckoutSession(
      { customerId: "c2", email: "legacy2@x.io", plan: "founding" },
      (async (_i: RequestInfo | URL, init?: RequestInit) => {
        expect(
          new URLSearchParams(String(init?.body ?? "")).get(
            "line_items[0][price]",
          ),
        ).toBe("price_legacy");
        return Response.json({ id: "cs_2", url: "https://checkout.stripe.com/2" });
      }) as typeof fetch,
    ).then((r) => {
      expect(r.ok).toBe(true);
    });
  });
});

describe("a promised discount is never silently dropped", () => {
  /**
   * Replies 403 to the promotion-code calls and 200 to everything else —
   * exactly what HQ's RESTRICTED key does today: `GET /v1/coupons` returns
   * `more_permissions_required`, so a discount cannot be minted.
   */
  function restrictedKeyFetch(seen: string[]): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("promotion_codes") || url.includes("coupons")) {
        return Response.json(
          { error: { code: "more_permissions_required" } },
          { status: 403 },
        );
      }
      return Response.json({ id: "cs_x", url: "https://checkout.stripe.com/x" });
    }) as typeof fetch;
  }

  test("REGRESSION: no checkout session is created at full price", async () => {
    // The shipped behaviour was to continue without the discount. Someone
    // handed a 100%-off invite would have been billed the entire plan, with
    // nothing telling them — or us — that the discount had been dropped.
    process.env.STRIPE_SECRET_KEY = "rk_test_restricted";
    process.env.STRIPE_PRICE_FOUNDING = "price_f1";
    const seen: string[] = [];

    const result = await createCheckoutSession(
      {
        customerId: "cust-1",
        email: "colleague@x.io",
        plan: "founding",
        inviteCode: "FREE100",
        percentOff: 100,
      },
      restrictedKeyFetch(seen),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("discount_unavailable");
    // The decisive assertion: we never reached the endpoint that charges.
    expect(seen.some((u) => u.includes("/checkout/sessions"))).toBe(false);
  });

  test("an invite with no discount is unaffected", async () => {
    // Only a PROMISED discount can be broken. A full-price invite has nothing
    // to drop, so it must still check out.
    process.env.STRIPE_SECRET_KEY = "rk_test_restricted";
    process.env.STRIPE_PRICE_FOUNDING = "price_f1";
    const seen: string[] = [];
    const result = await createCheckoutSession(
      {
        customerId: "cust-2",
        email: "full@x.io",
        plan: "founding",
        inviteCode: "NODISCOUNT",
        percentOff: 0,
      },
      restrictedKeyFetch(seen),
    );
    expect(result.ok).toBe(true);
    expect(seen.some((u) => u.includes("/checkout/sessions"))).toBe(true);
  });
});
