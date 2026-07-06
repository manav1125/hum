import { describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { sweepFleet } from "../fleet.js";

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
});
