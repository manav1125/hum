import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HqDb, InvalidTransitionError } from "../db.js";

function memDb(): HqDb {
  return new HqDb(":memory:");
}

describe("migrations", () => {
  test("apply idempotently on a shared file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hq-db-"));
    const path = join(dir, "hq.db");
    const a = new HqDb(path);
    a.createCustomer({ email: "a@x.io", name: "A" });
    a.close();
    // Re-opening re-runs the migration runner — must be a no-op.
    const b = new HqDb(path);
    expect(b.listCustomers().length).toBe(1);
    b.close();
  });
});

describe("instance flyUrl column (migration 5)", () => {
  test("persists across reopen; create without flyUrl defaults to null", () => {
    const dir = mkdtempSync(join(tmpdir(), "hq-db-flyurl-"));
    const path = join(dir, "hq.db");
    const a = new HqDb(path);
    const c = a.createCustomer({ email: "fly@x.io", name: "Fly" });
    const custom = a.createInstance({
      customerId: c.id,
      driver: "fly",
      externalId: "cue-fly-1",
      url: "https://cue-fly-1.justcue.app",
      flyUrl: "https://cue-fly-1.fly.dev",
    });
    const plain = a.createInstance({
      customerId: c.id,
      driver: "fly",
      externalId: "cue-fly-2",
      url: "https://cue-fly-2.fly.dev",
    });
    expect(custom.flyUrl).toBe("https://cue-fly-1.fly.dev");
    expect(plain.flyUrl).toBeNull();
    a.close();

    // Survives reopen (the migration runner no-ops on the second open).
    const b = new HqDb(path);
    expect(b.getInstance(custom.id)?.flyUrl).toBe("https://cue-fly-1.fly.dev");
    expect(b.getInstance(custom.id)?.url).toBe("https://cue-fly-1.justcue.app");
    expect(b.getInstance(plain.id)?.flyUrl).toBeNull();
    b.close();
  });
});

describe("customer state machine", () => {
  test("waitlist → invited → active → suspended → active", () => {
    const db = memDb();
    const c = db.createCustomer({ email: "founder@x.io", name: "Founder" });
    expect(c.status).toBe("waitlist");
    expect(db.transitionCustomer(c.id, "invited").status).toBe("invited");
    expect(db.transitionCustomer(c.id, "active").status).toBe("active");
    expect(db.transitionCustomer(c.id, "suspended").status).toBe("suspended");
    expect(db.transitionCustomer(c.id, "active").status).toBe("active");
  });

  test("illegal transitions throw and persist nothing", () => {
    const db = memDb();
    const c = db.createCustomer({ email: "w@x.io", name: "W" });
    expect(() => db.transitionCustomer(c.id, "active")).toThrow(
      InvalidTransitionError,
    );
    expect(() => db.transitionCustomer(c.id, "suspended")).toThrow(
      InvalidTransitionError,
    );
    expect(db.getCustomer(c.id)?.status).toBe("waitlist");
  });

  test("same-state transition is an idempotent no-op", () => {
    const db = memDb();
    const c = db.createCustomer({ email: "n@x.io", name: "N" });
    expect(db.transitionCustomer(c.id, "waitlist").status).toBe("waitlist");
  });

  test("email is unique and normalized", () => {
    const db = memDb();
    db.createCustomer({ email: "Dup@X.io ", name: "One" });
    expect(db.getCustomerByEmail("dup@x.io")?.name).toBe("One");
    expect(() => db.createCustomer({ email: "dup@x.io", name: "Two" })).toThrow();
  });
});

describe("instance state machine", () => {
  test("provisioning → live → suspended → live → deleted", () => {
    const db = memDb();
    const c = db.createCustomer({ email: "i@x.io", name: "I" });
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-1",
      url: "http://one.mock.local",
    });
    expect(inst.state).toBe("provisioning");
    expect(db.transitionInstance(inst.id, "live").state).toBe("live");
    expect(db.transitionInstance(inst.id, "suspended").state).toBe("suspended");
    expect(db.transitionInstance(inst.id, "live").state).toBe("live");
    expect(db.transitionInstance(inst.id, "deleted").state).toBe("deleted");
  });

  test("deleted is terminal; provisioning cannot suspend", () => {
    const db = memDb();
    const c = db.createCustomer({ email: "t@x.io", name: "T" });
    const inst = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-2",
      url: "http://two.mock.local",
    });
    expect(() => db.transitionInstance(inst.id, "suspended")).toThrow(
      InvalidTransitionError,
    );
    db.transitionInstance(inst.id, "deleted");
    expect(() => db.transitionInstance(inst.id, "live")).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("events + subscriptions", () => {
  test("audit trail is append-only and queryable", () => {
    const db = memDb();
    const c = db.createCustomer({ email: "e@x.io", name: "E" });
    db.transitionCustomer(c.id, "invited");
    const kinds = db.listEvents().map((e) => e.kind);
    expect(kinds).toContain("customer_created");
    expect(kinds).toContain("customer_status_changed");
  });

  test("subscription upsert overwrites by customer", () => {
    const db = memDb();
    const c = db.createCustomer({ email: "s@x.io", name: "S" });
    db.upsertSubscription({
      customerId: c.id,
      stripeCustomerId: "cus_1",
      stripeSubId: "sub_1",
      status: "active",
      currentPeriodEnd: null,
    });
    db.upsertSubscription({
      customerId: c.id,
      stripeCustomerId: "cus_1",
      stripeSubId: "sub_1",
      status: "past_due",
      currentPeriodEnd: 123,
    });
    expect(db.getSubscription(c.id)?.status).toBe("past_due");
    expect(db.getSubscriptionByStripeSubId("sub_1")?.customerId).toBe(c.id);
  });
});
