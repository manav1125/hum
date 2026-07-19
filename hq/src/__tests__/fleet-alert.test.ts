/**
 * P0-6: the fleet sweep is now actually scheduled and alerts an operator.
 * These tests cover sweepAndAlert's alerting contract; the sweep mechanics
 * themselves are covered in fleet.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { sweepAndAlert } from "../fleet.js";
import { MockDriver } from "../providers/mock-driver.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["RESEND_API_KEY", "HQ_OPS_ALERT_EMAIL", "HQ_PUBLIC_SITE_URL"];
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

function setupUnhealthyFleet() {
  const db = new HqDb(":memory:");
  const driver = new MockDriver();
  const customer = db.createCustomer({ email: "maya@example.com", name: "Maya" });
  db.createInstance({
    customerId: customer.id,
    driver: "mock",
    externalId: "mock-dead",
    url: "http://dead.mock.local",
    state: "live",
  });
  driver.healthByUrl.set("http://dead.mock.local", false);
  return { db, driver, customer };
}

describe("sweepAndAlert", () => {
  test("health failure + configured ops email → Resend alert + ops_alert_sent", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const { db, driver } = setupUnhealthyFleet();
    const resendBodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.resend.com")) {
        resendBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "email_ops_1" });
      }
      // Usage-sync probes against the dead instance fail — fine.
      return new Response("unreachable", { status: 502 });
    }) as typeof fetch;

    const result = await sweepAndAlert(db, driver, {
      fetchImpl,
      alertEmail: "ops@example.com",
    });
    expect(result.failed.length).toBe(1);
    expect(resendBodies.length).toBe(1);
    expect(resendBodies[0].to).toEqual(["ops@example.com"]);
    expect(String(resendBodies[0].subject)).toContain("Fleet sweep");
    expect(String(resendBodies[0].html)).toContain("dead.mock.local");
    expect(db.findLatestEventByKindData("ops_alert_sent", "")).not.toBeNull();
  });

  test("no ops email configured → no alert event, sweep still audited", async () => {
    const { db, driver } = setupUnhealthyFleet();
    const fetchImpl = (async (_input: RequestInfo | URL) =>
      new Response("unreachable", { status: 502 })) as typeof fetch;

    const result = await sweepAndAlert(db, driver, { fetchImpl });
    expect(result.failed.length).toBe(1);
    expect(db.findLatestEventByKindData("ops_alert_sent", "")).toBeNull();
    expect(db.findLatestEventByKindData("ops_alert_failed", "")).toBeNull();
    expect(db.findLatestEventByKindData("fleet_sweep_completed", "")).not.toBeNull();
  });

  test("log-only email mode records ops_alert_failed-style honesty (sent:false)", async () => {
    // RESEND_API_KEY unset: sendEmail reports sent:false → ops_alert_failed
    // is the honest outcome (nobody actually got alerted).
    const { db, driver } = setupUnhealthyFleet();
    const fetchImpl = (async (_input: RequestInfo | URL) =>
      new Response("unreachable", { status: 502 })) as typeof fetch;

    await sweepAndAlert(db, driver, { fetchImpl, alertEmail: "ops@example.com" });
    expect(db.findLatestEventByKindData("ops_alert_failed", "")).not.toBeNull();
    expect(db.findLatestEventByKindData("ops_alert_sent", "")).toBeNull();
  });

  test("healthy fleet sends nothing", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const customer = db.createCustomer({ email: "ok@example.com", name: "Ok" });
    db.createInstance({
      customerId: customer.id,
      driver: "mock",
      externalId: "mock-ok",
      url: "http://ok.mock.local",
      state: "live",
    });
    driver.healthByUrl.set("http://ok.mock.local", true);
    let resendCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("api.resend.com")) {
        resendCalls += 1;
        return Response.json({ id: "x" });
      }
      return new Response("no usage endpoint", { status: 404 });
    }) as typeof fetch;

    const result = await sweepAndAlert(db, driver, {
      fetchImpl,
      alertEmail: "ops@example.com",
    });
    expect(result.healthy).toBe(1);
    expect(resendCalls).toBe(0);
  });
});
