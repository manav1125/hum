import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { autoProvisionOnPayment } from "../provisioning.js";
import { generateInstanceSecrets } from "../secrets.js";
import { createHandler } from "../server.js";
import { signStripePayload } from "../stripe.js";

const WHSEC = "whsec_welcome";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HQ_SITE_DIR",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "HQ_SESSION_SECRET",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir";
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function fakeGuardianFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/guardian/init")) {
      return Response.json({
        guardianPrincipalId: "vellum-principal-welcome",
        accessToken: "a.b.c",
        accessTokenExpiresAt: Date.now() + 1000,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function setup() {
  const db = new HqDb(":memory:");
  const driver = new MockDriver();
  const handle = createHandler({
    db,
    driver,
    adminToken: "t",
    healthTimeoutMs: 200,
    healthIntervalMs: 10,
    fetchImpl: fakeGuardianFetch(),
  });
  const status = (sid: string) =>
    handle(new Request(`http://hq.local/welcome/status?session_id=${encodeURIComponent(sid)}`));
  return { db, driver, handle, status };
}

async function statusBody(res: Response) {
  return (await res.json()) as {
    state: string;
    magicLink?: string;
    firstName?: string;
    email?: string;
  };
}

describe("GET /welcome/status", () => {
  test("unknown session id → unknown; missing param → 400", async () => {
    const { status, handle } = setup();
    const res = await status("cs_bogus");
    expect(res.status).toBe(200);
    expect((await statusBody(res)).state).toBe("unknown");
    const bad = await handle(new Request("http://hq.local/welcome/status"));
    expect(bad.status).toBe(400);
  });

  test("fresh checkout without an instance → provisioning (with identity)", async () => {
    const { db, status } = setup();
    const c = db.createCustomer({ email: "w@x.io", name: "Wren Yu", plan: "chief_of_staff" });
    db.setCustomerCheckoutSession(c.id, "cs_fresh");
    const body = await statusBody(await status("cs_fresh"));
    expect(body.state).toBe("provisioning");
    expect(body.firstName).toBe("Wren");
    expect(body.email).toBe("w@x.io");
  });

  test("live instance → ready with a freshly minted magic link", async () => {
    const { db, status } = setup();
    const c = db.createCustomer({ email: "r@x.io", name: "Rae", plan: "operator" });
    db.setCustomerCheckoutSession(c.id, "cs_ready");
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-ready";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-r",
      url: "http://r.mock.local",
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");

    const body = await statusBody(await status("cs_ready"));
    expect(body.state).toBe("ready");
    expect(body.magicLink).toStartWith("http://r.mock.local/assistant/?cueToken=");
    expect(body.firstName).toBe("Rae");
  });

  test("over 10 minutes without an instance → delayed; failure event → delayed immediately", async () => {
    const { db, status } = setup();
    const slow = db.createCustomer({ email: "slow@x.io", name: "Slow" });
    db.setCustomerCheckoutSession(slow.id, "cs_slow", Date.now() - 11 * 60_000);
    expect((await statusBody(await status("cs_slow"))).state).toBe("delayed");

    const failed = db.createCustomer({ email: "fail@x.io", name: "Fail" });
    db.setCustomerCheckoutSession(failed.id, "cs_fail");
    db.recordEvent("auto_provision_failed", failed.id, { error: "boom" });
    expect((await statusBody(await status("cs_fail"))).state).toBe("delayed");
  });

  test("polling is lightly rate-limited per session id", async () => {
    const { db, status } = setup();
    const c = db.createCustomer({ email: "rl@x.io", name: "RL" });
    db.setCustomerCheckoutSession(c.id, "cs_rl");
    expect((await status("cs_rl")).status).toBe(200);
    expect((await status("cs_rl")).status).toBe(429);
  });
});

describe("auto-provision on checkout.session.completed", () => {
  function completedEvent(customerId: string, sessionId: string): string {
    return JSON.stringify({
      id: "evt_w",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "subscription",
          customer: "cus_w",
          subscription: "sub_w",
          metadata: { customerId, plan: "chief_of_staff" },
        },
      },
    });
  }

  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!cond() && Date.now() - start < ms) await Bun.sleep(20);
  }

  test("webhook links the session, provisions async, and welcome/status flips to ready", async () => {
    const { db, handle, status } = setup();
    const c = db.createCustomer({ email: "auto@x.io", name: "Auto Founder", status: "invited" });

    const body = completedEvent(c.id, "cs_auto");
    const res = await handle(
      new Request("http://hq.local/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signStripePayload(body, WHSEC) },
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect(db.getCustomer(c.id)?.status).toBe("active");
    expect(db.getCustomerByCheckoutSession("cs_auto")?.id).toBe(c.id);

    await waitFor(() => db.listInstancesByCustomer(c.id).some((i) => i.state === "live"));
    const instances = db.listInstancesByCustomer(c.id);
    expect(instances.length).toBe(1);
    expect(instances[0].state).toBe("live");
    // The welcome email was attempted (log-only mode records the event).
    expect(db.findLatestEvent("welcome_email_sent", c.id)).not.toBeNull();

    const st = await statusBody(await status("cs_auto"));
    expect(st.state).toBe("ready");
    expect(st.magicLink).toContain("cueToken=");
  });

  test("webhook retries never provision twice", async () => {
    const { db, handle } = setup();
    const c = db.createCustomer({ email: "retry@x.io", name: "Retry", status: "invited" });
    const body = completedEvent(c.id, "cs_retry");
    const deliver = () =>
      handle(
        new Request("http://hq.local/webhooks/stripe", {
          method: "POST",
          headers: { "stripe-signature": signStripePayload(body, WHSEC) },
          body,
        }),
      );
    await deliver();
    await waitFor(() => db.listInstancesByCustomer(c.id).some((i) => i.state === "live"));
    await deliver(); // Stripe retry
    await deliver(); // and another
    await Bun.sleep(100);
    expect(db.listInstancesByCustomer(c.id).length).toBe(1);
  });

  test("autoProvisionOnPayment is idempotent when called directly", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const deps = {
      db,
      driver,
      fetchImpl: fakeGuardianFetch(),
      healthTimeoutMs: 200,
      healthIntervalMs: 10,
    };
    const c = db.createCustomer({ email: "idem@x.io", name: "Idem" });
    const first = await autoProvisionOnPayment(deps, c.id);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.provisioned).toBe(true);
    const second = await autoProvisionOnPayment(deps, c.id);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.provisioned).toBe(false);
    expect(db.listInstancesByCustomer(c.id).length).toBe(1);
    expect(driver.calls.filter((call) => call.method === "provision").length).toBe(1);
  });

  test("provision failure records auto_provision_failed", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    driver.health = async () => false; // never healthy
    const deps = {
      db,
      driver,
      fetchImpl: fakeGuardianFetch(),
      healthTimeoutMs: 30,
      healthIntervalMs: 10,
    };
    const c = db.createCustomer({ email: "boom@x.io", name: "Boom" });
    const result = await autoProvisionOnPayment(deps, c.id);
    expect(result.ok).toBe(false);
    expect(db.findLatestEvent("auto_provision_failed", c.id)).not.toBeNull();
  });
});
