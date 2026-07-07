import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb, type CustomerPlan } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import {
  DEFAULT_REFERRAL_AWARD_CREDITS,
  awardReferralOnPaidInvoice,
  recordReferralRedemption,
  referralSummary,
  validateReferralCode,
} from "../referrals.js";
import { createHandler } from "../server.js";
import {
  createCheckoutSession,
  handleStripeWebhook,
  signStripePayload,
} from "../stripe.js";

const WHSEC = "whsec_test_secret";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_CHIEF_OF_STAFF",
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
  "HQ_REFERRAL_AWARD_CREDITS",
  "HQ_REFERRAL_EARN_CAP_CREDITS",
  "HQ_PUBLIC_SITE_URL",
  "KLAVIYO_PRIVATE_KEY", // keep fire-and-forget marketing sync out of mocks
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

async function deliver(
  deps: Parameters<typeof handleStripeWebhook>[0],
  body: string,
) {
  return handleStripeWebhook(deps, body, signStripePayload(body, WHSEC));
}

function activeCustomerWithSub(
  db: HqDb,
  email: string,
  stripeSubId: string,
  plan: CustomerPlan = "chief_of_staff",
) {
  const c = db.createCustomer({ email, name: "T", plan });
  db.transitionCustomer(c.id, "invited");
  db.transitionCustomer(c.id, "active");
  db.upsertSubscription({
    customerId: c.id,
    stripeCustomerId: `cus_${stripeSubId}`,
    stripeSubId,
    status: "active",
    currentPeriodEnd: null,
    plan,
  });
  return c;
}

describe("referral codes", () => {
  test("minted lazily, stable, REF- prefixed, unique per customer", () => {
    const db = new HqDb(":memory:");
    const a = db.createCustomer({ email: "a@x.io", name: "A" });
    const b = db.createCustomer({ email: "b@x.io", name: "B" });
    const codeA = db.ensureReferralCode(a.id);
    expect(codeA.code).toMatch(/^REF-[A-Z2-9]{8}$/);
    // Idempotent: second call returns the same code, no new row.
    expect(db.ensureReferralCode(a.id).code).toBe(codeA.code);
    expect(db.ensureReferralCode(b.id).code).not.toBe(codeA.code);
  });

  test("validation: unknown and self-referral rejected, case-insensitive ok", () => {
    const db = new HqDb(":memory:");
    const a = db.createCustomer({ email: "a@x.io", name: "A" });
    const b = db.createCustomer({ email: "b@x.io", name: "B" });
    const code = db.ensureReferralCode(a.id).code;

    expect(validateReferralCode(db, "REF-NOPE9999", b.id)).toEqual({
      ok: false,
      reason: "referral_unknown",
    });
    expect(validateReferralCode(db, code, a.id)).toEqual({
      ok: false,
      reason: "referral_self",
    });
    const ok = validateReferralCode(db, code.toLowerCase(), b.id);
    expect(ok).toEqual({ ok: true, code, referrerCustomerId: a.id });
  });

  test("a referee can only ever be referred once (first touch wins)", () => {
    const db = new HqDb(":memory:");
    const a = db.createCustomer({ email: "a@x.io", name: "A" });
    const b = db.createCustomer({ email: "b@x.io", name: "B" });
    const referee = db.createCustomer({ email: "r@x.io", name: "R" });
    const codeA = db.ensureReferralCode(a.id).code;
    const codeB = db.ensureReferralCode(b.id).code;

    const first = recordReferralRedemption(db, {
      code: codeA,
      refereeCustomerId: referee.id,
    });
    const second = recordReferralRedemption(db, {
      code: codeB,
      refereeCustomerId: referee.id,
    });
    expect(first?.code).toBe(codeA);
    expect(second?.id).toBe(first!.id); // codeB did not displace codeA
  });
});

describe("checkout carries the referral code", () => {
  test("createCheckoutSession sets session + subscription metadata", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_CHIEF_OF_STAFF = "price_cos";
    let form: URLSearchParams | null = null;
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      form = new URLSearchParams(String(init?.body ?? ""));
      return Response.json({ id: "cs_1", url: "https://stripe/cs_1" });
    }) as typeof fetch;

    const result = await createCheckoutSession(
      {
        customerId: "cust-1",
        email: "r@x.io",
        plan: "chief_of_staff",
        referralCode: "REF-ABCDEFGH",
      },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(form!.get("metadata[referralCode]")).toBe("REF-ABCDEFGH");
    expect(form!.get("subscription_data[metadata][referralCode]")).toBe(
      "REF-ABCDEFGH",
    );
  });

  test("/redeem validates the referral code and drops invalid ones", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_CHIEF_OF_STAFF = "price_cos";
    const db = new HqDb(":memory:");
    const referrer = db.createCustomer({ email: "ref@x.io", name: "Ref" });
    const code = db.ensureReferralCode(referrer.id).code;
    db.createInvite({ maxUses: 10 });
    const invite = db.listInvites()[0];

    const forms: URLSearchParams[] = [];
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({ id: "cs_r", url: "https://stripe/cs_r" });
    }) as typeof fetch;
    const handle = createHandler({ db, driver: new MockDriver(), fetchImpl });
    const post = (body: Record<string, unknown>) =>
      handle(
        new Request("http://hq.local/redeem", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );

    const good = await post({
      code: invite.code,
      email: "friend@x.io",
      name: "Friend",
      referralCode: code.toLowerCase(),
    });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { referralApplied: boolean }).referralApplied).toBe(true);
    expect(forms.at(-1)!.get("metadata[referralCode]")).toBe(code);

    const bad = await post({
      code: invite.code,
      email: "other@x.io",
      name: "Other",
      referralCode: "REF-NOPE9999",
    });
    expect(((await bad.json()) as { referralApplied: boolean }).referralApplied).toBe(false);
    expect(forms.at(-1)!.get("metadata[referralCode]")).toBeNull();
    expect(
      db.listEvents().some((e) => e.kind === "referral_code_rejected"),
    ).toBe(true);
  });
});

describe("award on the referee's first paid invoice", () => {
  function setupPair(db: HqDb) {
    const referrer = activeCustomerWithSub(db, "referrer@x.io", "sub_ref");
    const code = db.ensureReferralCode(referrer.id).code;
    const referee = activeCustomerWithSub(db, "referee@x.io", "sub_new");
    return { referrer, referee, code };
  }

  test("checkout.session.completed binds; invoice.paid awards ONCE across replays", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const { referrer, referee, code } = setupPair(db);

    // 1. Checkout completed with the referral code in metadata → pending.
    const checkout = event("checkout.session.completed", {
      id: "cs_ref_1",
      mode: "subscription",
      customer: "cus_sub_new",
      subscription: "sub_new",
      metadata: { app: "cue", customerId: referee.id, plan: "chief_of_staff", referralCode: code },
    });
    expect((await deliver({ db, driver }, checkout)).status).toBe(200);
    expect(db.getReferralRedemptionByReferee(referee.id)?.status).toBe("pending");
    expect(db.getCreditBalance(referrer.id)).toBe(0); // nothing paid yet

    // 2. First paid invoice → referrer earns the award.
    const invoice = event("invoice.paid", {
      id: "in_ref_1",
      customer: "cus_sub_new",
      subscription: "sub_new",
      period_start: 1750000000,
    });
    const first = await deliver({ db, driver }, invoice);
    expect(first.status).toBe(200);
    expect(db.getCreditBalance(referrer.id)).toBe(DEFAULT_REFERRAL_AWARD_CREDITS);
    const redemption = db.getReferralRedemptionByReferee(referee.id)!;
    expect(redemption.status).toBe("awarded");
    expect(redemption.creditsAwarded).toBe(DEFAULT_REFERRAL_AWARD_CREDITS);
    expect(redemption.invoiceId).toBe("in_ref_1");

    // 3. WEBHOOK REPLAY of the exact same invoice.paid → award once.
    const replay = await deliver({ db, driver }, invoice);
    expect(replay.status).toBe(200);
    expect(db.getCreditBalance(referrer.id)).toBe(DEFAULT_REFERRAL_AWARD_CREDITS);
    expect(
      db.listCreditEntries(referrer.id).filter((e) => e.kind === "topup").length,
    ).toBe(1);

    // 4. Next month's invoice: referee gets their grant, referrer nothing.
    const renewal = event("invoice.paid", {
      id: "in_ref_2",
      customer: "cus_sub_new",
      subscription: "sub_new",
      period_start: 1752678000,
    });
    await deliver({ db, driver }, renewal);
    expect(db.getCreditBalance(referrer.id)).toBe(DEFAULT_REFERRAL_AWARD_CREDITS);
  });

  test("invoice.paid arriving BEFORE checkout.session.completed still awards (subscription metadata fallback)", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const { referrer, referee, code } = setupPair(db);

    const invoice = event("invoice.paid", {
      id: "in_early_1",
      customer: "cus_sub_new",
      subscription: "sub_new",
      period_start: 1750000000,
      subscription_details: {
        metadata: { customerId: referee.id, referralCode: code },
      },
    });
    await deliver({ db, driver }, invoice);
    expect(db.getCreditBalance(referrer.id)).toBe(DEFAULT_REFERRAL_AWARD_CREDITS);

    // The late checkout.session.completed is a harmless no-op for referrals.
    const checkout = event("checkout.session.completed", {
      id: "cs_late",
      mode: "subscription",
      customer: "cus_sub_new",
      subscription: "sub_new",
      metadata: { app: "cue", customerId: referee.id, referralCode: code },
    });
    await deliver({ db, driver }, checkout);
    expect(db.getCreditBalance(referrer.id)).toBe(DEFAULT_REFERRAL_AWARD_CREDITS);
    expect(db.getReferralRedemptionByReferee(referee.id)?.status).toBe("awarded");
  });

  test("self-referral metadata never awards", async () => {
    const db = new HqDb(":memory:");
    const driver = new MockDriver();
    const c = activeCustomerWithSub(db, "selfie@x.io", "sub_self");
    const code = db.ensureReferralCode(c.id).code;

    const invoice = event("invoice.paid", {
      id: "in_self_1",
      subscription: "sub_self",
      period_start: 1,
      subscription_details: { metadata: { customerId: c.id, referralCode: code } },
    });
    await deliver({ db, driver }, invoice);
    expect(db.getReferralRedemptionByReferee(c.id)).toBeNull();
    // Only the plan grant landed — no referral top-up.
    expect(
      db.listCreditEntries(c.id).filter((e) => e.kind === "topup").length,
    ).toBe(0);
  });

  test("lifetime cap: partial award at the boundary, then capped at zero", async () => {
    process.env.HQ_REFERRAL_AWARD_CREDITS = "1000";
    process.env.HQ_REFERRAL_EARN_CAP_CREDITS = "1500";
    const db = new HqDb(":memory:");
    const referrer = activeCustomerWithSub(db, "cap@x.io", "sub_cap");
    const code = db.ensureReferralCode(referrer.id).code;

    const refereeFor = (n: number) =>
      activeCustomerWithSub(db, `friend${n}@x.io`, `sub_f${n}`);

    // Referee 1: full 1000.
    const r1 = refereeFor(1);
    expect(
      awardReferralOnPaidInvoice(db, {
        refereeCustomerId: r1.id,
        invoiceId: "in_f1",
        referralCode: code,
      }),
    ).toMatchObject({ awarded: true, credits: 1000 });

    // Referee 2: only 500 headroom remains.
    const r2 = refereeFor(2);
    expect(
      awardReferralOnPaidInvoice(db, {
        refereeCustomerId: r2.id,
        invoiceId: "in_f2",
        referralCode: code,
      }),
    ).toMatchObject({ awarded: true, credits: 500 });

    // Referee 3: cap reached → resolved as capped, zero credits.
    const r3 = refereeFor(3);
    expect(
      awardReferralOnPaidInvoice(db, {
        refereeCustomerId: r3.id,
        invoiceId: "in_f3",
        referralCode: code,
      }),
    ).toEqual({ awarded: false, reason: "capped" });
    expect(db.getReferralRedemptionByReferee(r3.id)?.status).toBe("capped");
    expect(db.getCreditBalance(referrer.id)).toBe(1500);
    expect(db.sumReferralCreditsAwarded(code)).toBe(1500);

    // Replaying referee 3's invoice stays a no-op.
    expect(
      awardReferralOnPaidInvoice(db, {
        refereeCustomerId: r3.id,
        invoiceId: "in_f3",
        referralCode: code,
      }),
    ).toEqual({ awarded: false, reason: "already_resolved" });
  });

  test("referralSummary mints the code and reports earnings against the cap", () => {
    const db = new HqDb(":memory:");
    const referrer = activeCustomerWithSub(db, "sum@x.io", "sub_sum");
    const referee = activeCustomerWithSub(db, "sumref@x.io", "sub_sumref");
    const summaryBefore = referralSummary(db, referrer.id, "https://justcue.ai");
    expect(summaryBefore.code).toMatch(/^REF-/);
    expect(summaryBefore.shareUrl).toBe(
      `https://justcue.ai/redeem?ref=${summaryBefore.code}`,
    );
    expect(summaryBefore.earnedCredits).toBe(0);

    awardReferralOnPaidInvoice(db, {
      refereeCustomerId: referee.id,
      invoiceId: "in_sum",
      referralCode: summaryBefore.code,
    });
    const after = referralSummary(db, referrer.id, "https://justcue.ai");
    expect(after.earnedCredits).toBe(DEFAULT_REFERRAL_AWARD_CREDITS);
    expect(after.convertedCount).toBe(1);
  });
});
