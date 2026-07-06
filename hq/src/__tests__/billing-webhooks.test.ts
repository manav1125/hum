import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb, type CustomerPlan } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { generateInstanceSecrets } from "../secrets.js";
import {
  createTopupCheckoutSession,
  ensureCatalog,
  handleStripeWebhook,
  signStripePayload,
} from "../stripe.js";

const WHSEC = "whsec_test_secret";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_TOPUP_1000",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function event(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({ id: "evt_1", type, data: { object } });
}

function activeCustomerWithSub(
  db: HqDb,
  email: string,
  plan: CustomerPlan = "chief_of_staff",
) {
  const c = db.createCustomer({ email, name: "T", plan });
  db.transitionCustomer(c.id, "invited");
  db.transitionCustomer(c.id, "active");
  db.upsertSubscription({
    customerId: c.id,
    stripeCustomerId: "cus_1",
    stripeSubId: "sub_1",
    status: "active",
    currentPeriodEnd: null,
    plan,
  });
  return c;
}

function keyedInstance(db: HqDb, customerId: string, keyHash = "kh_bill") {
  const secrets = generateInstanceSecrets();
  secrets.guardianPrincipalId = "vellum-principal-bill";
  const inst = db.createInstance({
    customerId,
    driver: "mock",
    externalId: "mock-b1",
    url: "http://bill.mock.local",
    secretsJson: JSON.stringify(secrets),
    state: "provisioning",
  });
  db.transitionInstance(inst.id, "live");
  db.setInstanceOpenrouterKeyHash(inst.id, keyHash);
  return db.getInstance(inst.id)!;
}

/** Mock covering the OpenRouter key endpoints used by the webhook flows. */
function openRouterMock(usage = 2.5) {
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openrouter.ai") && init?.method === "PATCH") {
      patches.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ data: { hash: "kh_bill", disabled: true, limit: 0, usage } });
    }
    if (url.includes("openrouter.ai")) {
      return Response.json({ data: { hash: "kh_bill", disabled: false, limit: 25, usage } });
    }
    return Response.json({}); // stripe customer metadata PATCH etc.
  }) as typeof fetch;
  return { fetchImpl, patches };
}

async function deliver(
  deps: Parameters<typeof handleStripeWebhook>[0],
  body: string,
) {
  return handleStripeWebhook(deps, body, signStripePayload(body, WHSEC));
}

describe("invoice.paid → monthly grant + key-limit reset", () => {
  test("grants once per period, idempotent across Stripe retries", async () => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = activeCustomerWithSub(db, "inv@x.io");
    keyedInstance(db, c.id);
    const { fetchImpl, patches } = openRouterMock(2.5);

    const body = event("invoice.paid", {
      id: "in_1",
      customer: "cus_1",
      subscription: "sub_1",
      period_start: 1750000000,
    });
    const first = await deliver({ db, driver, fetchImpl }, body);
    expect(first.status).toBe(200);
    expect(first.body.granted).toBe(true);
    expect(db.getCreditBalance(c.id)).toBe(10000);
    // Child key re-limited: $2.50 spent + $25 headroom (10000 credits).
    expect(patches.length).toBe(1);
    expect(patches[0].body.limit).toBe(27.5);

    // Retry of the same invoice period: no double grant, no extra PATCH.
    const retry = await deliver({ db, driver, fetchImpl }, body);
    expect(retry.body.granted).toBe(false);
    expect(db.getCreditBalance(c.id)).toBe(10000);
    expect(patches.length).toBe(1);

    // Next month's invoice grants again.
    const renewal = event("invoice.paid", {
      id: "in_2",
      customer: "cus_1",
      subscription: "sub_1",
      period_start: 1752678000,
    });
    const second = await deliver({ db, driver, fetchImpl }, renewal);
    expect(second.body.granted).toBe(true);
    expect(db.getCreditBalance(c.id)).toBe(20000);
  });

  test("invoices for unknown subscriptions are acknowledged as orphans", async () => {
    const db = new HqDb(":memory:");
    const outcome = await deliver(
      { db, driver: new MockDriver() },
      event("invoice.paid", { id: "in_x", subscription: "sub_nope" }),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.body.orphan).toBe(true);
  });

  test("resolves the customer via subscription_details metadata too", async () => {
    const db = new HqDb(":memory:");
    const c = activeCustomerWithSub(db, "meta@x.io", "assistant");
    const body = event("invoice.paid", {
      id: "in_m",
      subscription: "sub_other",
      period_start: 1,
      subscription_details: { metadata: { customerId: c.id } },
    });
    const outcome = await deliver({ db, driver: new MockDriver() }, body);
    expect(outcome.body.granted).toBe(true);
    // Plan comes from the stored subscription row (assistant → 4000).
    expect(db.getCreditBalance(c.id)).toBe(4000);
  });
});

describe("checkout.session.completed", () => {
  test("payment-mode top-up applies credits idempotently by session id", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = activeCustomerWithSub(db, "top@x.io");

    const body = event("checkout.session.completed", {
      id: "cs_topup_1",
      mode: "payment",
      metadata: { app: "cue", customerId: c.id, topup: "topup_1000", credits: "1000" },
    });
    const first = await deliver({ db, driver }, body);
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(true);
    expect(db.getCreditBalance(c.id)).toBe(1000);

    const retry = await deliver({ db, driver }, body);
    expect(retry.body.applied).toBe(false);
    expect(db.getCreditBalance(c.id)).toBe(1000);
    expect(db.listCreditEntries(c.id).length).toBe(1);
  });

  test("subscription mode records the plan from session metadata", async () => {
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "up@x.io", name: "Up" });
    db.transitionCustomer(c.id, "invited");
    const body = event("checkout.session.completed", {
      id: "cs_sub_1",
      mode: "subscription",
      customer: "cus_9",
      subscription: "sub_9",
      metadata: { app: "cue", customerId: c.id, plan: "operator" },
    });
    const outcome = await deliver({ db, driver: new MockDriver() }, body);
    expect(outcome.status).toBe(200);
    expect(db.getCustomer(c.id)?.plan).toBe("operator");
    expect(db.getCustomer(c.id)?.status).toBe("active");
    expect(db.getSubscription(c.id)?.plan).toBe("operator");
  });
});

describe("subscription.deleted → suspend + disable child key", () => {
  test("disables every provisioned key when the provisioning key is set", async () => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = activeCustomerWithSub(db, "bye@x.io");
    const provisioned = await driver.provision({ customerId: c.id, name: "cue-bye", env: {} });
    const secrets = generateInstanceSecrets();
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: provisioned.externalId,
      url: provisioned.url,
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");
    db.setInstanceOpenrouterKeyHash(inst.id, "kh_bill");
    const { fetchImpl, patches } = openRouterMock();

    const body = event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" });
    const outcome = await deliver({ db, driver, fetchImpl }, body);
    expect(outcome.status).toBe(200);
    expect(db.getCustomer(c.id)?.status).toBe("churned");
    expect(db.getInstance(inst.id)?.state).toBe("suspended");
    expect(patches.length).toBe(1);
    expect(patches[0].body).toEqual({ disabled: true });
    expect(db.listEvents().some((e) => e.kind === "openrouter_key_disabled")).toBe(true);
  });
});

describe("top-up checkout + catalog", () => {
  test("top-up checkout session carries topup metadata and the CUE suffix", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_TOPUP_1000 = "price_t1000";
    let form: URLSearchParams | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      form = new URLSearchParams(String(init?.body ?? ""));
      return Response.json({ id: "cs_t1", url: "https://checkout.stripe.com/c/pay/cs_t1" });
    }) as typeof fetch;

    const result = await createTopupCheckoutSession(
      { customerId: "cust-1", email: "t@x.io", topupId: "topup_1000" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(form!.get("mode")).toBe("payment");
    expect(form!.get("line_items[0][price]")).toBe("price_t1000");
    expect(form!.get("metadata[topup]")).toBe("topup_1000");
    expect(form!.get("metadata[credits]")).toBe("1000");
    expect(form!.get("payment_intent_data[statement_descriptor_suffix]")).toBe("CUE");
  });

  test("ensureCatalog creates missing products/prices once, then reuses", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    const known = new Map<string, string>(); // lookup_key → price id
    const creates: string[] = [];
    let priceCounter = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/prices?lookup_keys")) {
        const key = decodeURIComponent(url.match(/lookup_keys\[\]=([^&]+)/)![1]);
        const id = known.get(key);
        return Response.json({
          data: id ? [{ id, product: `prod_of_${id}` }] : [],
        });
      }
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (url.endsWith("/v1/products")) {
        creates.push(`product:${form.get("id")}`);
        expect(form.get("name")).toStartWith("Cue — ");
        expect(form.get("metadata[app]")).toBe("cue");
        expect(form.get("statement_descriptor")).toBe("CUE");
        return Response.json({ id: form.get("id") });
      }
      if (url.endsWith("/v1/prices")) {
        priceCounter += 1;
        const id = `price_${priceCounter}`;
        known.set(form.get("lookup_key")!, id);
        creates.push(`price:${form.get("lookup_key")}`);
        expect(form.get("metadata[app]")).toBe("cue");
        return Response.json({ id });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const first = await ensureCatalog(fetchImpl);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entries.length).toBe(5); // 3 plans + 2 top-ups
    expect(first.entries.every((e) => e.created)).toBe(true);
    expect(first.entries.map((e) => e.envVar)).toContain("STRIPE_PRICE_OPERATOR");
    // Plans are recurring, top-ups are not.
    expect(creates).toContain("price:cue_assistant_monthly");
    expect(creates).toContain("price:cue_topup_5000");

    const second = await ensureCatalog(fetchImpl);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entries.every((e) => !e.created)).toBe(true);
    expect(creates.length).toBe(10); // no new creates on the second run
  });

  test("not-configured mode returns typed errors", async () => {
    expect(await ensureCatalog()).toEqual({ ok: false, reason: "stripe_not_configured" });
    const topup = await createTopupCheckoutSession({
      customerId: "c",
      email: "x@x.io",
      topupId: "topup_1000",
    });
    expect(topup).toEqual({ ok: false, reason: "stripe_not_configured" });
  });
});
