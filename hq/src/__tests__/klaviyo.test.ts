import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { grantMonthlyCredits } from "../credits.js";
import { HqDb } from "../db.js";
import { sweepFleet } from "../fleet.js";
import {
  KLAVIYO_REVISION,
  buildEventPayload,
  isKlaviyoConfigured,
  trackEvent,
} from "../klaviyo.js";
import { MockDriver } from "../providers/mock-driver.js";
import { generateInstanceSecrets } from "../secrets.js";
import { createHandler } from "../server.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "KLAVIYO_PRIVATE_KEY",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
  "HQ_SITE_DIR",
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

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function capturingFetch(captured: CapturedCall[], status = 202): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(status === 202 ? null : "boom", { status });
  }) as typeof fetch;
}

describe("trackEvent client shape", () => {
  test("posts the Events API JSON:API payload with auth + revision headers", async () => {
    process.env.KLAVIYO_PRIVATE_KEY = "pk_test_123";
    expect(isKlaviyoConfigured()).toBe(true);
    const db = new HqDb(":memory:");
    const captured: CapturedCall[] = [];

    await trackEvent(
      db,
      {
        metric: "Cue Subscribed",
        email: "maya@x.io",
        firstName: "Maya",
        profileProps: { plan: "operator" },
        props: { plan: "operator" },
        uniqueId: "subscribed:cs_test_1",
        customerId: "c1",
      },
      capturingFetch(captured),
    );

    expect(captured.length).toBe(1);
    const call = captured[0];
    expect(call.url).toBe("https://a.klaviyo.com/api/events");
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe("Klaviyo-API-Key pk_test_123");
    expect(call.headers.get("revision")).toBe(KLAVIYO_REVISION);
    expect(call.headers.get("content-type")).toBe("application/json");

    const data = call.body.data as Record<string, any>;
    expect(data.type).toBe("event");
    expect(data.attributes.metric.data.type).toBe("metric");
    expect(data.attributes.metric.data.attributes.name).toBe("Cue Subscribed");
    expect(data.attributes.profile.data.type).toBe("profile");
    expect(data.attributes.profile.data.attributes.email).toBe("maya@x.io");
    expect(data.attributes.profile.data.attributes.first_name).toBe("Maya");
    expect(data.attributes.profile.data.attributes.properties).toEqual({
      plan: "operator",
    });
    expect(data.attributes.properties).toEqual({ plan: "operator" });
    expect(data.attributes.unique_id).toBe("subscribed:cs_test_1");

    // A clean send leaves no failure events behind.
    expect(db.listEvents().every((e) => e.kind !== "klaviyo_sync_failed")).toBe(true);
  });

  test("payload omits first_name and profile properties when absent", () => {
    const payload = buildEventPayload({
      metric: "Cue TestFlight Interest",
      email: "stranger@x.io",
      uniqueId: "testflight:stranger@x.io",
    }) as Record<string, any>;
    const profileAttrs = payload.data.attributes.profile.data.attributes;
    expect(profileAttrs).toEqual({ email: "stranger@x.io" });
  });
});

describe("trackEvent no-op + failure modes", () => {
  test("unconfigured mode never touches the network", async () => {
    const db = new HqDb(":memory:");
    const captured: CapturedCall[] = [];
    await trackEvent(
      db,
      { metric: "Cue Waitlist Joined", email: "a@x.io", uniqueId: "waitlist:1" },
      capturingFetch(captured),
    );
    expect(captured.length).toBe(0);
    expect(db.listEvents().length).toBe(0);
  });

  test("HTTP errors record klaviyo_sync_failed and never throw", async () => {
    process.env.KLAVIYO_PRIVATE_KEY = "pk_test_123";
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "err@x.io", name: "Err" });
    const captured: CapturedCall[] = [];

    await trackEvent(
      db,
      {
        metric: "Cue Subscribed",
        email: c.email,
        uniqueId: "subscribed:bad",
        customerId: c.id,
      },
      capturingFetch(captured, 500),
    );

    const failure = db.listEvents().find((e) => e.kind === "klaviyo_sync_failed");
    expect(failure).toBeDefined();
    expect(failure!.customerId).toBe(c.id);
    expect(failure!.dataJson).toContain("klaviyo_error_500");
    expect(failure!.dataJson).toContain("Cue Subscribed");
  });

  test("network failures record klaviyo_sync_failed and never throw", async () => {
    process.env.KLAVIYO_PRIVATE_KEY = "pk_test_123";
    const db = new HqDb(":memory:");
    const fetchImpl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    // Must resolve (not reject) even when fetch itself blows up.
    await trackEvent(
      db,
      { metric: "Cue Cancelled", email: "a@x.io", uniqueId: "cancelled:1" },
      fetchImpl,
    );

    const failure = db.listEvents().find((e) => e.kind === "klaviyo_sync_failed");
    expect(failure).toBeDefined();
    expect(failure!.dataJson).toContain("klaviyo_fetch_failed");
    expect(failure!.dataJson).toContain("connection reset");
  });
});

describe("credits-low single-fire per cycle (fleet sweep)", () => {
  test("fires once per billing period, again after the next grant's crossing", async () => {
    process.env.KLAVIYO_PRIVATE_KEY = "pk_test_123";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    // founding resolves to chief_of_staff: 10,000 credits/mo → threshold 1,500.
    const c = db.createCustomer({ email: "low@x.io", name: "Low Battery" });
    grantMonthlyCredits(db, {
      customerId: c.id,
      plan: c.plan,
      stripeSubId: "sub_low",
      periodStart: 100,
    });

    const p = await driver.provision({ customerId: c.id, name: "low", env: {} });
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-low";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: p.externalId,
      url: p.url,
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");

    // Cumulative reported COGS, in cents; 2250c → 9,000 credits debited
    // → balance 1,000 (< 1,500 threshold, > 0 so not exhausted).
    let totalCents = 2250;
    const klaviyoCalls: CapturedCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/assistants/self/guardrails")) {
        return Response.json({ ledger: { summary: { totalCents } } });
      }
      if (url.includes("a.klaviyo.com")) {
        klaviyoCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await sweepFleet(db, driver, { fetchImpl });
    expect(db.getCreditBalance(c.id)).toBe(1000);
    const lowCalls = () =>
      klaviyoCalls.filter((k) => {
        const data = k.body.data as Record<string, any>;
        return data?.attributes?.metric?.data?.attributes?.name === "Cue Credits Low";
      });
    expect(lowCalls().length).toBe(1);
    const first = lowCalls()[0].body.data as Record<string, any>;
    expect(first.attributes.unique_id).toBe(
      `credits-low:${c.id}:grant sub_low@100`,
    );
    expect(first.attributes.profile.data.attributes.properties.credit_balance).toBe(1000);

    // Second sweep, same cycle, still low → no re-fire (local single-fire).
    await sweepFleet(db, driver, { fetchImpl });
    expect(lowCalls().length).toBe(1);
    expect(
      db.listEvents().filter((e) => e.kind === "credits_low").length,
    ).toBe(1);

    // New billing period: fresh grant (balance 11,000 — above threshold,
    // no fire), then usage drops it under 1,500 again → fires once with
    // the NEW period's unique_id.
    grantMonthlyCredits(db, {
      customerId: c.id,
      plan: c.plan,
      stripeSubId: "sub_low",
      periodStart: 200,
    });
    await sweepFleet(db, driver, { fetchImpl });
    expect(lowCalls().length).toBe(1); // healthy balance — nothing fired

    totalCents = 2250 + 2400; // +9,600 credits used → balance 1,400
    await sweepFleet(db, driver, { fetchImpl });
    expect(db.getCreditBalance(c.id)).toBe(1400);
    expect(lowCalls().length).toBe(2);
    const second = lowCalls()[1].body.data as Record<string, any>;
    expect(second.attributes.unique_id).toBe(
      `credits-low:${c.id}:grant sub_low@200`,
    );
  });

  test("exhausted customers emit Cue Credits Exhausted (not Credits Low)", async () => {
    process.env.KLAVIYO_PRIVATE_KEY = "pk_test_123";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = db.createCustomer({ email: "empty@x.io", name: "Empty" });
    grantMonthlyCredits(db, {
      customerId: c.id,
      plan: c.plan,
      stripeSubId: "sub_empty",
      periodStart: 100,
    });

    const p = await driver.provision({ customerId: c.id, name: "empty", env: {} });
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-empty";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: p.externalId,
      url: p.url,
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");

    const metrics: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/assistants/self/guardrails")) {
        // 3000c → 12,000 credits → balance -2,000.
        return Response.json({ ledger: { summary: { totalCents: 3000 } } });
      }
      if (url.includes("a.klaviyo.com")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        metrics.push(
          (body as Record<string, any>).data?.attributes?.metric?.data?.attributes?.name,
        );
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await sweepFleet(db, driver, { fetchImpl });
    expect(result.exhausted).toEqual([c.id]);
    expect(metrics).toEqual(["Cue Credits Exhausted"]);
    expect(db.listEvents().some((e) => e.kind === "credits_exhausted")).toBe(true);
  });
});

describe("integration: POST /waitlist tracks Cue Waitlist Joined", () => {
  test("the route's response does not wait on Klaviyo, but the event is sent", async () => {
    process.env.KLAVIYO_PRIVATE_KEY = "pk_test_123";
    process.env.HQ_SITE_DIR = "/nonexistent-site-dir";
    const db = new HqDb(":memory:");
    const captured: CapturedCall[] = [];
    const handle = createHandler({
      db,
      driver: new MockDriver(),
      adminToken: "t",
      fetchImpl: capturingFetch(captured),
    });

    const res = await handle(
      new Request("http://hq.local/waitlist", {
        method: "POST",
        body: JSON.stringify({ email: "maya@x.io", name: "Maya Chen" }),
      }),
    );
    expect(res.status).toBe(201);
    await Bun.sleep(0); // let the fire-and-forget microtask land

    const klaviyo = captured.filter((c) => c.url.includes("a.klaviyo.com"));
    expect(klaviyo.length).toBe(1);
    const data = klaviyo[0].body.data as Record<string, any>;
    expect(data.attributes.metric.data.attributes.name).toBe("Cue Waitlist Joined");
    expect(data.attributes.profile.data.attributes.email).toBe("maya@x.io");
    expect(data.attributes.profile.data.attributes.first_name).toBe("Maya");
    expect(data.attributes.unique_id).toMatch(/^waitlist:/);

    // Repeat submission answers existing:true and does not re-track.
    const again = await handle(
      new Request("http://hq.local/waitlist", {
        method: "POST",
        body: JSON.stringify({ email: "maya@x.io", name: "Maya Chen" }),
      }),
    );
    expect(again.status).toBe(200);
    await Bun.sleep(0);
    expect(captured.filter((c) => c.url.includes("a.klaviyo.com")).length).toBe(1);
  });
});
