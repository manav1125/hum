import { describe, expect, test } from "bun:test";

import {
  PLANS,
  PLAN_IDS,
  TOPUPS,
  TOPUP_IDS,
  cogsCentsToCredits,
  creditsToCogsUsd,
  creditsToRetailUsd,
  isPlanId,
  isTopupId,
  publicCatalog,
  resolvePlan,
} from "../plans.js";

describe("plan specs", () => {
  test("the three tiers carry the decided prices and credit grants", () => {
    expect(PLAN_IDS).toEqual(["assistant", "chief_of_staff", "operator"]);
    expect(PLANS.assistant.priceUsd).toBe(49);
    expect(PLANS.assistant.monthlyCredits).toBe(4000);
    expect(PLANS.chief_of_staff.priceUsd).toBe(99);
    expect(PLANS.chief_of_staff.monthlyCredits).toBe(10000);
    expect(PLANS.operator.priceUsd).toBe(249);
    expect(PLANS.operator.monthlyCredits).toBe(30000);
  });

  test("feature flags gate up the tiers", () => {
    expect(PLANS.assistant.features.channels).toBe(1);
    expect(PLANS.assistant.features.createStudio).toBe("basic");
    expect(PLANS.assistant.features.voice).toBe(false);

    expect(PLANS.chief_of_staff.features.channels).toBe("all");
    expect(PLANS.chief_of_staff.features.createStudio).toBe("full");
    expect(PLANS.chief_of_staff.features.people).toBe(true);
    expect(PLANS.chief_of_staff.features.voice).toBe(true);
    expect(PLANS.chief_of_staff.features.videoStudio).toBe(false);

    // Operator = everything.
    expect(Object.values(PLANS.operator.features).every((v) => v === true || v === "all" || v === "full")).toBe(true);
  });

  test("top-up packs match the decided pricing", () => {
    expect(TOPUP_IDS).toEqual(["topup_1000", "topup_5000"]);
    expect(TOPUPS.topup_1000).toMatchObject({ credits: 1000, priceUsd: 10 });
    expect(TOPUPS.topup_5000).toMatchObject({ credits: 5000, priceUsd: 40 });
  });

  test("every spec names its Stripe price env var", () => {
    expect(PLANS.assistant.stripePriceEnvVar).toBe("STRIPE_PRICE_ASSISTANT");
    expect(PLANS.chief_of_staff.stripePriceEnvVar).toBe("STRIPE_PRICE_CHIEF_OF_STAFF");
    expect(PLANS.operator.stripePriceEnvVar).toBe("STRIPE_PRICE_OPERATOR");
    expect(TOPUPS.topup_1000.stripePriceEnvVar).toBe("STRIPE_PRICE_TOPUP_1000");
    expect(TOPUPS.topup_5000.stripePriceEnvVar).toBe("STRIPE_PRICE_TOPUP_5000");
  });
});

describe("credit math", () => {
  test("1 credit = $0.01 retail; COGS = retail / 4", () => {
    expect(creditsToRetailUsd(4000)).toBe(40);
    expect(creditsToCogsUsd(4000)).toBe(10);
    expect(creditsToCogsUsd(10000)).toBe(25);
    expect(creditsToCogsUsd(30000)).toBe(75);
  });

  test("$1 of provider cost consumes 400 credits", () => {
    expect(cogsCentsToCredits(100)).toBe(400);
    expect(cogsCentsToCredits(25)).toBe(100);
    expect(cogsCentsToCredits(1)).toBe(4);
    expect(cogsCentsToCredits(0)).toBe(0);
  });

  test("credit → COGS → credit round-trips at the plan grants", () => {
    for (const id of PLAN_IDS) {
      const credits = PLANS[id].monthlyCredits;
      const cogsCents = creditsToCogsUsd(credits) * 100;
      expect(cogsCentsToCredits(cogsCents)).toBe(credits);
    }
  });
});

describe("plan resolution", () => {
  test("legacy founding aliases resolve to chief_of_staff", () => {
    expect(resolvePlan("founding").id).toBe("chief_of_staff");
    expect(resolvePlan("founding_byo").id).toBe("chief_of_staff");
    expect(resolvePlan("operator").id).toBe("operator");
    expect(() => resolvePlan("enterprise")).toThrow("Unknown plan");
  });

  test("type guards accept only real ids", () => {
    expect(isPlanId("assistant")).toBe(true);
    expect(isPlanId("founding")).toBe(false);
    expect(isPlanId(42)).toBe(false);
    expect(isTopupId("topup_1000")).toBe(true);
    expect(isTopupId("topup_999")).toBe(false);
  });
});

describe("public catalog (GET /plans contract)", () => {
  test("exposes plans, topups, and the credit model", () => {
    const catalog = publicCatalog();
    expect(catalog.plans.map((p) => p.id)).toEqual(PLAN_IDS);
    expect(catalog.topups.map((t) => t.id)).toEqual(TOPUP_IDS);
    expect(catalog.creditModel.retailUsdPerCredit).toBe(0.01);
  });
});
