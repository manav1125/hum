import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyTopup } from "../credits.js";
import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { sweepFleet } from "../fleet.js";
import { generateInstanceSecrets } from "../secrets.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENROUTER_PROVISIONING_KEY", "OPENROUTER_SHARED_KEY"];

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

describe("fleet sweep", () => {
  test("healthy instances pass; failures are audited", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = db.createCustomer({ email: "fleet@x.io", name: "Fleet" });

    const good = await driver.provision({ customerId: c.id, name: "good", env: {} });
    const bad = await driver.provision({ customerId: c.id, name: "bad", env: {} });
    for (const p of [good, bad]) {
      const inst = db.createInstance({
        customerId: c.id,
        driver: "mock",
        externalId: p.externalId,
        url: p.url,
        state: "provisioning",
      });
      db.transitionInstance(inst.id, "live");
    }
    driver.healthByUrl.set(bad.url, false);

    const result = await sweepFleet(db, driver);
    expect(result.checked).toBe(2);
    expect(result.healthy).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].url).toBe(bad.url);

    const kinds = db.listEvents().map((e) => e.kind);
    expect(kinds).toContain("fleet_health_failed");
    expect(kinds).toContain("fleet_sweep_completed");
  });

  test("suspended and deleted instances are skipped", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = db.createCustomer({ email: "skip@x.io", name: "Skip" });
    const p = await driver.provision({ customerId: c.id, name: "s", env: {} });
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: p.externalId,
      url: p.url,
      state: "provisioning",
    });
    db.transitionInstance(inst.id, "live");
    db.transitionInstance(inst.id, "suspended");

    const result = await sweepFleet(db, driver);
    expect(result.checked).toBe(0);
  });

  test("usage sync debits credits; exhausted customers get frozen keys", async () => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = db.createCustomer({ email: "meter@x.io", name: "Meter" });
    // 100 credits of runway — the reported usage below burns through it.
    applyTopup(db, { customerId: c.id, credits: 100, ref: "seed" });

    const p = await driver.provision({ customerId: c.id, name: "meter", env: {} });
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-meter";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: p.externalId,
      url: p.url,
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");
    db.setInstanceOpenrouterKeyHash(inst.id, "kh_meter");

    const patches: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/assistants/self/guardrails")) {
        // 75 COGS cents reported → 300 credits → balance -200.
        return Response.json({ ledger: { summary: { totalCents: 75 } } });
      }
      if (url.includes("openrouter.ai") && init?.method === "PATCH") {
        patches.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ data: { hash: "kh_meter", disabled: false, limit: 3, usage: 0.75 } });
      }
      if (url.includes("openrouter.ai")) {
        return Response.json({ data: { hash: "kh_meter", disabled: false, limit: 25, usage: 0.75 } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await sweepFleet(db, driver, { fetchImpl });
    expect(result.creditsUsed).toBe(300);
    expect(db.getCreditBalance(c.id)).toBe(-200);
    expect(result.exhausted).toEqual([c.id]);
    // Freeze: limit re-pointed at exactly what's spent (zero headroom).
    expect(patches.length).toBe(1);
    expect(patches[0].body.limit).toBe(0.75);

    const kinds = db.listEvents().map((e) => e.kind);
    expect(kinds).toContain("credits_exhausted");

    // A second sweep with the same cumulative usage is a no-op debit.
    const again = await sweepFleet(db, driver, { fetchImpl });
    expect(again.creditsUsed).toBe(0);
    expect(db.getCreditBalance(c.id)).toBe(-200);
  });

  test("customers with no credit history are never frozen", async () => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = db.createCustomer({ email: "fresh@x.io", name: "Fresh" });
    const p = await driver.provision({ customerId: c.id, name: "fresh", env: {} });
    const secrets = generateInstanceSecrets();
    secrets.guardianPrincipalId = "vellum-principal-fresh";
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: p.externalId,
      url: p.url,
      secretsJson: JSON.stringify(secrets),
    });
    db.transitionInstance(inst.id, "live");

    const fetchImpl = (async (_input: RequestInfo | URL) =>
      Response.json({ ledger: { summary: { totalCents: 0 } } })) as typeof fetch;
    const result = await sweepFleet(db, driver, { fetchImpl });
    expect(result.exhausted).toEqual([]);
    expect(db.listEvents().every((e) => e.kind !== "credits_exhausted")).toBe(true);
  });
});
