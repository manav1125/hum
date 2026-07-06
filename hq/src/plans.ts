/**
 * Cue HQ — plan tiers, top-up packs, and credit math. The single source of
 * truth for the managed-LLM business model:
 *
 *   1 credit = $0.01 of RETAIL LLM usage value.
 *   COGS = retail / 4 (a 300% margin on model spend) — so the OpenRouter
 *   child-key limit for N credits is creditsToCogsUsd(N), and $1 of
 *   provider-reported cost consumes 400 credits.
 *
 * Everything that prices, grants, meters, or gates on a plan reads from
 * here — stripe.ts (catalog + checkout), credits.ts (grants + usage sync),
 * openrouter.ts callers (child-key limits), and GET /plans (the JSON the
 * marketing site renders).
 */

export type PlanId = "assistant" | "chief_of_staff" | "operator";

/** Legacy plan ids kept as aliases (both map to chief_of_staff). */
export type LegacyPlanId = "founding" | "founding_byo";

/** Per-tier feature flags — the SPA reads these to gate surfaces. */
export interface PlanFeatures {
  /** Connected channels: a count, or "all". */
  channels: number | "all";
  createStudio: "basic" | "full";
  people: boolean;
  voice: boolean;
  videoStudio: boolean;
  fanoutKits: boolean;
  agentsOrg: boolean;
  prioritySupport: boolean;
}

export interface PlanSpec {
  id: PlanId;
  name: string;
  /** Monthly subscription price in whole USD. */
  priceUsd: number;
  /** Credits granted on every paid invoice (monthly renewal). */
  monthlyCredits: number;
  features: PlanFeatures;
  /** Env var holding the Stripe price id for this plan. */
  stripePriceEnvVar: string;
  /** Stable Stripe lookup_key used by ensureCatalog() for idempotency. */
  stripeLookupKey: string;
}

export const PLANS: Record<PlanId, PlanSpec> = {
  assistant: {
    id: "assistant",
    name: "Assistant",
    priceUsd: 49,
    monthlyCredits: 4000,
    features: {
      channels: 1,
      createStudio: "basic",
      people: false,
      voice: false,
      videoStudio: false,
      fanoutKits: false,
      agentsOrg: false,
      prioritySupport: false,
    },
    stripePriceEnvVar: "STRIPE_PRICE_ASSISTANT",
    stripeLookupKey: "cue_assistant_monthly",
  },
  chief_of_staff: {
    id: "chief_of_staff",
    name: "Chief of Staff",
    priceUsd: 99,
    monthlyCredits: 10000,
    features: {
      channels: "all",
      createStudio: "full",
      people: true,
      voice: true,
      videoStudio: false,
      fanoutKits: false,
      agentsOrg: false,
      prioritySupport: false,
    },
    stripePriceEnvVar: "STRIPE_PRICE_CHIEF_OF_STAFF",
    stripeLookupKey: "cue_chief_of_staff_monthly",
  },
  operator: {
    id: "operator",
    name: "Operator",
    priceUsd: 249,
    monthlyCredits: 30000,
    features: {
      channels: "all",
      createStudio: "full",
      people: true,
      voice: true,
      videoStudio: true,
      fanoutKits: true,
      agentsOrg: true,
      prioritySupport: true,
    },
    stripePriceEnvVar: "STRIPE_PRICE_OPERATOR",
    stripeLookupKey: "cue_operator_monthly",
  },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export type TopupId = "topup_1000" | "topup_5000";

export interface TopupSpec {
  id: TopupId;
  name: string;
  credits: number;
  /** One-off price in whole USD. */
  priceUsd: number;
  /** Env var holding the Stripe (one-time) price id for this pack. */
  stripePriceEnvVar: string;
  /** Stable Stripe lookup_key used by ensureCatalog() for idempotency. */
  stripeLookupKey: string;
}

export const TOPUPS: Record<TopupId, TopupSpec> = {
  topup_1000: {
    id: "topup_1000",
    name: "1,000 credits",
    credits: 1000,
    priceUsd: 10,
    stripePriceEnvVar: "STRIPE_PRICE_TOPUP_1000",
    stripeLookupKey: "cue_topup_1000",
  },
  topup_5000: {
    id: "topup_5000",
    name: "5,000-credit pack",
    credits: 5000,
    priceUsd: 40,
    stripePriceEnvVar: "STRIPE_PRICE_TOPUP_5000",
    stripeLookupKey: "cue_topup_5000",
  },
};

export const TOPUP_IDS = Object.keys(TOPUPS) as TopupId[];

// ── credit math ──────────────────────────────────────────────────────────

/** Retail value of one credit, in USD cents. */
export const RETAIL_CENTS_PER_CREDIT = 1;
/** COGS = retail / MARGIN_DIVISOR (a 300% margin on model spend). */
export const MARGIN_DIVISOR = 4;

/** Retail usage value of `credits`, in USD. 1 credit = $0.01. */
export function creditsToRetailUsd(credits: number): number {
  return (credits * RETAIL_CENTS_PER_CREDIT) / 100;
}

/** Provider cost we allow for `credits` — the OpenRouter child-key limit. */
export function creditsToCogsUsd(credits: number): number {
  return creditsToRetailUsd(credits) / MARGIN_DIVISOR;
}

/**
 * Credits consumed by a provider-reported cost (COGS) in cents — the usage
 * sync conversion: $1 of reported cost = 400 credits. Rounded to the
 * nearest whole credit.
 */
export function cogsCentsToCredits(costCents: number): number {
  return Math.round((costCents * MARGIN_DIVISOR) / RETAIL_CENTS_PER_CREDIT);
}

// ── plan resolution ──────────────────────────────────────────────────────

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

export function isTopupId(value: unknown): value is TopupId {
  return typeof value === "string" && value in TOPUPS;
}

/**
 * Resolve any stored plan string — including the legacy founding /
 * founding_byo aliases, which map to chief_of_staff — to its PlanSpec.
 */
export function resolvePlan(plan: string): PlanSpec {
  if (isPlanId(plan)) return PLANS[plan];
  if (plan === "founding" || plan === "founding_byo") {
    return PLANS.chief_of_staff;
  }
  throw new Error(`Unknown plan: ${plan}`);
}

/** The public JSON contract for GET /plans (marketing-site pricing page). */
export function publicCatalog(): {
  plans: PlanSpec[];
  topups: TopupSpec[];
  creditModel: {
    retailUsdPerCredit: number;
    description: string;
  };
} {
  return {
    plans: PLAN_IDS.map((id) => PLANS[id]),
    topups: TOPUP_IDS.map((id) => TOPUPS[id]),
    creditModel: {
      retailUsdPerCredit: RETAIL_CENTS_PER_CREDIT / 100,
      description: "1 credit = $0.01 of LLM usage value",
    },
  };
}
