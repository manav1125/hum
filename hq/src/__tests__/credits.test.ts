import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  adjustCredits,
  applyTopup,
  getBalance,
  grantMonthlyCredits,
  syncKeyLimitsToBalance,
  syncUsage,
} from "../credits.js";
import { HqDb } from "../db.js";
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

function customer(db: HqDb, email: string) {
  return db.createCustomer({ email, name: "T", plan: "chief_of_staff" });
}

/** Live instance with usable secrets (signing key + guardian principal). */
function liveInstance(db: HqDb, customerId: string) {
  const secrets = generateInstanceSecrets();
  secrets.guardianPrincipalId = "vellum-principal-usage";
  const inst = db.createInstance({
    customerId,
    driver: "mock",
    externalId: "mock-u1",
    url: "http://usage.mock.local",
    secretsJson: JSON.stringify(secrets),
    state: "provisioning",
  });
  return db.transitionInstance(inst.id, "live");
}

describe("monthly grants", () => {
  test("grants the plan's credits and is idempotent per period", () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "grant@x.io");

    const first = grantMonthlyCredits(db, {
      customerId: c.id,
      plan: "chief_of_staff",
      stripeSubId: "sub_1",
      periodStart: 1750000000,
    });
    expect(first.granted).toBe(true);
    expect(first.balance).toBe(10000);

    // Stripe retries the webhook → same period must no-op.
    const retry = grantMonthlyCredits(db, {
      customerId: c.id,
      plan: "chief_of_staff",
      stripeSubId: "sub_1",
      periodStart: 1750000000,
    });
    expect(retry.granted).toBe(false);
    expect(retry.balance).toBe(10000);
    expect(db.listCreditEntries(c.id).length).toBe(1);

    // Next billing period grants again.
    const renewal = grantMonthlyCredits(db, {
      customerId: c.id,
      plan: "chief_of_staff",
      stripeSubId: "sub_1",
      periodStart: 1752678000,
    });
    expect(renewal.granted).toBe(true);
    expect(renewal.balance).toBe(20000);
  });

  test("legacy founding plans grant chief_of_staff credits", () => {
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "legacy@x.io", name: "L" }); // founding
    const grant = grantMonthlyCredits(db, {
      customerId: c.id,
      plan: c.plan,
      stripeSubId: "sub_legacy",
      periodStart: 1,
    });
    expect(grant.balance).toBe(10000);
  });
});

describe("top-ups and adjustments", () => {
  test("top-up applies once per ref", () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "topup@x.io");
    expect(applyTopup(db, { customerId: c.id, credits: 1000, ref: "cs_1" }).applied).toBe(true);
    expect(applyTopup(db, { customerId: c.id, credits: 1000, ref: "cs_1" }).applied).toBe(false);
    expect(getBalance(db, c.id)).toBe(1000);
    expect(applyTopup(db, { customerId: c.id, credits: 5000, ref: "cs_2" }).applied).toBe(true);
    expect(getBalance(db, c.id)).toBe(6000);
  });

  test("rejects non-positive top-ups", () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "bad@x.io");
    expect(() => applyTopup(db, { customerId: c.id, credits: 0, ref: "x" })).toThrow();
    expect(() => applyTopup(db, { customerId: c.id, credits: 10.5, ref: "x" })).toThrow();
  });

  test("adjustments are signed and tracked in the running balance", () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "adj@x.io");
    applyTopup(db, { customerId: c.id, credits: 1000, ref: "seed" });
    const entry = adjustCredits(db, { customerId: c.id, delta: -300, note: "abuse refund" });
    expect(entry.balanceAfter).toBe(700);
    expect(getBalance(db, c.id)).toBe(700);
    const kinds = db.listCreditEntries(c.id).map((e) => e.kind);
    expect(kinds).toContain("adjustment");
  });
});

describe("usage sync (instance guardrails rollup → ledger)", () => {
  function usageFetch(totalCentsByCall: number[]) {
    const seen: { url: string; auth: string | null }[] = [];
    let call = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get("authorization") });
      const totalCents = totalCentsByCall[Math.min(call, totalCentsByCall.length - 1)];
      call += 1;
      return Response.json({
        ledger: { summary: { totalCents, byModel: [] } },
        window: { days: 7, from: 0, to: 1 },
      });
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  test("debits 4x the reported COGS and advances the cursor idempotently", async () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "usage@x.io");
    applyTopup(db, { customerId: c.id, credits: 10000, ref: "seed" });
    const inst = liveInstance(db, c.id);
    const { fetchImpl, seen } = usageFetch([250, 250, 400]);

    // First sync: 250 reported COGS cents → 1000 credits.
    const first = await syncUsage(db, db.getInstance(inst.id)!, { fetchImpl });
    expect(first).toMatchObject({ ok: true, creditsUsed: 1000, reportedCents: 250 });
    expect(getBalance(db, c.id)).toBe(9000);
    // The REAL proxied route with an actor token.
    expect(seen[0].url).toContain("/v1/assistants/self/guardrails?days=");
    expect(seen[0].auth).toStartWith("Bearer ");

    // Same cumulative total again → no double-charge.
    const second = await syncUsage(db, db.getInstance(inst.id)!, { fetchImpl });
    expect(second).toMatchObject({ ok: true, creditsUsed: 0 });
    expect(getBalance(db, c.id)).toBe(9000);

    // Growth to 400 cents → only the 150-cent delta is charged (600 credits).
    const third = await syncUsage(db, db.getInstance(inst.id)!, { fetchImpl });
    expect(third).toMatchObject({ ok: true, creditsUsed: 600, reportedCents: 400 });
    expect(getBalance(db, c.id)).toBe(8400);
    expect(db.getInstance(inst.id)!.usageSyncedCents).toBe(400);
  });

  test("a shrinking rollup (pruned history) never re-charges", async () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "shrink@x.io");
    const inst = liveInstance(db, c.id);
    db.setInstanceUsageSyncedCents(inst.id, 500);
    const { fetchImpl } = usageFetch([120]);
    const result = await syncUsage(db, db.getInstance(inst.id)!, { fetchImpl });
    expect(result).toMatchObject({ ok: true, creditsUsed: 0, reportedCents: 500 });
  });

  test("missing secrets and HTTP failures return typed errors", async () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "nosecrets@x.io");
    const bare = db.createInstance({
      customerId: c.id,
      driver: "mock",
      externalId: "mock-n",
      url: "http://n.mock.local",
    });
    expect(await syncUsage(db, bare, {})).toEqual({
      ok: false,
      reason: "instance_missing_secrets",
    });

    const inst = liveInstance(db, c.id);
    const fetch401 = (async (_input: RequestInfo | URL) =>
      new Response("no", { status: 401 })) as typeof fetch;
    expect(await syncUsage(db, db.getInstance(inst.id)!, { fetchImpl: fetch401 })).toEqual({
      ok: false,
      reason: "usage_http_401",
    });
  });
});

describe("child-key limit maintenance", () => {
  test("no-op without a provisioning key (shared-key mode)", async () => {
    const db = new HqDb(":memory:");
    const c = customer(db, "nokey@x.io");
    let fetched = 0;
    const fetchImpl = (async (_input: RequestInfo | URL) => {
      fetched += 1;
      return Response.json({});
    }) as typeof fetch;
    expect(await syncKeyLimitsToBalance(db, c.id, fetchImpl)).toEqual({ updated: 0 });
    expect(fetched).toBe(0);
  });

  test("re-points the key limit at spend + remaining-balance headroom", async () => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
    const db = new HqDb(":memory:");
    const c = customer(db, "limit@x.io");
    applyTopup(db, { customerId: c.id, credits: 4000, ref: "seed" }); // $10 COGS headroom
    const inst = liveInstance(db, c.id);
    db.setInstanceOpenrouterKeyHash(inst.id, "hash-abc");

    const patches: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        patches.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ data: { hash: "hash-abc", disabled: false, limit: 12.5, usage: 2.5 } });
      }
      // GET current key state: $2.50 already spent.
      return Response.json({ data: { hash: "hash-abc", disabled: false, limit: 10, usage: 2.5 } });
    }) as typeof fetch;

    const result = await syncKeyLimitsToBalance(db, c.id, fetchImpl);
    expect(result.updated).toBe(1);
    expect(patches.length).toBe(1);
    expect(patches[0].url).toContain("/api/v1/keys/hash-abc");
    expect(patches[0].body.limit).toBe(12.5); // 2.50 spent + $10 headroom
  });
});
