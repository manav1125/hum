/**
 * Cue HQ — Stripe integration without the SDK (plain fetch against
 * api.stripe.com), so hq/ carries zero runtime dependencies.
 *
 * Runs cleanly in "not configured" mode: when STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET are unset, checkout creation returns a typed
 * "not configured" error and the webhook route responds 503 — nothing
 * throws at import or boot time.
 *
 * Env contract:
 *   STRIPE_SECRET_KEY             — sk_… (checkout session creation)
 *   STRIPE_WEBHOOK_SECRET         — whsec_… (signature verification)
 *   STRIPE_PRICE_ASSISTANT        — price id for the `assistant` tier
 *   STRIPE_PRICE_CHIEF_OF_STAFF   — price id for the `chief_of_staff` tier
 *   STRIPE_PRICE_OPERATOR         — price id for the `operator` tier
 *   STRIPE_PRICE_TOPUP_1000/_5000 — one-time top-up price ids
 *   STRIPE_PRICE_FOUNDING(_BYO)   — legacy price ids for the founding aliases
 *   HQ_PUBLIC_URL                 — base for checkout success/cancel URLs
 *   HQ_PUBLIC_SITE_URL            — marketing-site base; wins over
 *                                   HQ_PUBLIC_URL for customer-facing
 *                                   success/cancel redirects
 *
 * Everything HQ creates on Stripe carries metadata {app:"cue"} (products,
 * prices, coupons, promotion codes, checkout sessions, subscriptions via
 * subscription_data.metadata, payment intents) so the account stays
 * auditable next to anything else living in it. ensureCatalog() creates
 * the 3 tier products + prices and the top-up prices idempotently via
 * stable price lookup_keys.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  applyTopup,
  grantMonthlyCredits,
  syncKeyLimitsToBalance,
} from "./credits.js";
import type { CustomerPlan, HqDb } from "./db.js";
import { paymentFailedEmail, sendEmail } from "./email.js";
import { firstNameOf, trackEvent } from "./klaviyo.js";
import { disableKey, isOpenRouterConfigured } from "./openrouter.js";
import {
  PLANS,
  PLAN_IDS,
  TOPUPS,
  TOPUP_IDS,
  isPlanId,
  isTopupId,
  resolvePlan,
  type PlanSpec,
  type TopupId,
  type TopupSpec,
} from "./plans.js";
import type { InstanceDriver } from "./providers/driver.js";

const STRIPE_API_BASE = "https://api.stripe.com";

// ── configuration ────────────────────────────────────────────────────────

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export function isWebhookConfigured(): boolean {
  return !!process.env.STRIPE_WEBHOOK_SECRET;
}

function priceIdForPlan(plan: CustomerPlan): string | undefined {
  // Legacy founding aliases keep their dedicated price env vars so existing
  // founding checkouts are unaffected by the tier rollout.
  if (plan === "founding") return process.env.STRIPE_PRICE_FOUNDING;
  if (plan === "founding_byo") return process.env.STRIPE_PRICE_FOUNDING_BYO;
  return process.env[resolvePlan(plan).stripePriceEnvVar];
}

/** Customer-facing redirect base: the marketing site wins when configured. */
function publicRedirectBase(): string {
  return (
    process.env.HQ_PUBLIC_SITE_URL ??
    process.env.HQ_PUBLIC_URL ??
    "http://localhost:8790"
  );
}

async function stripePost(
  path: string,
  form: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; reason: string }
> {
  const res = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      reason: `stripe_error_${res.status}: ${text.slice(0, 300)}`,
    };
  }
  return {
    ok: true,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function stripeGet(
  path: string,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; reason: string }
> {
  const res = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      reason: `stripe_error_${res.status}: ${text.slice(0, 300)}`,
    };
  }
  return {
    ok: true,
    body: (await res.json()) as Record<string, unknown>,
  };
}

// ── checkout ─────────────────────────────────────────────────────────────

export type CheckoutResult =
  | { ok: true; url: string; sessionId: string }
  | { ok: false; reason: string };

/**
 * Create a subscription-mode Checkout Session for a customer.
 * `metadata[customerId]` links the completed session back to our row.
 */
export async function createCheckoutSession(
  params: {
    customerId: string;
    email: string;
    plan: CustomerPlan;
    inviteCode?: string;
    percentOff?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutResult> {
  if (!isStripeConfigured()) {
    return { ok: false, reason: "stripe_not_configured" };
  }
  const price = priceIdForPlan(params.plan);
  if (!price) {
    return { ok: false, reason: `no_price_configured_for_${params.plan}` };
  }

  const base = publicRedirectBase();
  const form = new URLSearchParams({
    mode: "subscription",
    customer_email: params.email,
    success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel`,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "metadata[app]": "cue",
    "metadata[customerId]": params.customerId,
    "metadata[plan]": params.plan,
    "subscription_data[metadata][app]": "cue",
    "subscription_data[metadata][customerId]": params.customerId,
    "subscription_data[metadata][plan]": params.plan,
  });
  if (params.inviteCode) form.set("metadata[inviteCode]", params.inviteCode);

  // Invite discount: mint (or reuse) a promotion code carrying the invite's
  // percentOff and attach it to the session.
  if (params.percentOff && params.percentOff > 0 && params.inviteCode) {
    const promo = await ensurePromotionCode(
      params.inviteCode,
      params.percentOff,
      fetchImpl,
    );
    if (promo.ok) {
      form.set("discounts[0][promotion_code]", promo.promotionCodeId);
    }
    // A promo failure degrades to full price rather than blocking checkout.
  }

  const created = await stripePost("/v1/checkout/sessions", form, fetchImpl);
  if (!created.ok) return { ok: false, reason: created.reason };
  const session = created.body as { id: string; url: string };
  return { ok: true, url: session.url, sessionId: session.id };
}

/**
 * One-off payment-mode Checkout Session for a credit top-up pack. The
 * webhook (checkout.session.completed, mode=payment, metadata.topup)
 * applies the credits idempotently by session id.
 */
export async function createTopupCheckoutSession(
  params: {
    customerId: string;
    email: string;
    topupId: TopupId;
    /** Optional success/cancel overrides (paths on the public site base). */
    successPath?: string;
    cancelPath?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutResult> {
  if (!isStripeConfigured()) {
    return { ok: false, reason: "stripe_not_configured" };
  }
  const spec = TOPUPS[params.topupId];
  const price = process.env[spec.stripePriceEnvVar];
  if (!price) {
    return { ok: false, reason: `no_price_configured_for_${params.topupId}` };
  }

  const base = publicRedirectBase();
  const form = new URLSearchParams({
    mode: "payment",
    customer_email: params.email,
    success_url: `${base}${params.successPath ?? "/checkout/success?session_id={CHECKOUT_SESSION_ID}"}`,
    cancel_url: `${base}${params.cancelPath ?? "/checkout/cancel"}`,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "metadata[app]": "cue",
    "metadata[customerId]": params.customerId,
    "metadata[topup]": spec.id,
    "metadata[credits]": String(spec.credits),
    "payment_intent_data[metadata][app]": "cue",
    "payment_intent_data[metadata][customerId]": params.customerId,
    "payment_intent_data[statement_descriptor_suffix]": "CUE",
  });

  const created = await stripePost("/v1/checkout/sessions", form, fetchImpl);
  if (!created.ok) return { ok: false, reason: created.reason };
  const session = created.body as { id: string; url: string };
  return { ok: true, url: session.url, sessionId: session.id };
}

/**
 * Stripe Billing Portal session (GET /account/portal): invoices, payment
 * method, cancel — all hosted by Stripe.
 */
export async function createBillingPortalSession(
  params: { stripeCustomerId: string; returnUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  if (!isStripeConfigured()) {
    return { ok: false, reason: "stripe_not_configured" };
  }
  const created = await stripePost(
    "/v1/billing_portal/sessions",
    new URLSearchParams({
      customer: params.stripeCustomerId,
      return_url: params.returnUrl,
    }),
    fetchImpl,
  );
  if (!created.ok) return { ok: false, reason: created.reason };
  return { ok: true, url: String(created.body.url) };
}

// ── catalog (idempotent product/price provisioning) ──────────────────────

export interface CatalogEntry {
  kind: "plan" | "topup";
  id: string;
  productId: string;
  priceId: string;
  /** Env var the operator should point at priceId. */
  envVar: string;
  /** True when this call created the price (vs found an existing one). */
  created: boolean;
}

export type CatalogResult =
  | { ok: true; entries: CatalogEntry[] }
  | { ok: false; reason: string };

/**
 * Ensure the 3 tier products + monthly prices and the top-up products +
 * one-time prices exist. Idempotent: prices are looked up by their stable
 * lookup_key first; only missing ones are created. Names are prefixed
 * "Cue — ", everything carries metadata {app:"cue"}, and products set
 * statement_descriptor "CUE" so card statements read consistently.
 *
 * Returns the priceId → env var mapping the operator pastes into the
 * environment (HQ reads prices from env, never from live lookups).
 */
export async function ensureCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogResult> {
  if (!isStripeConfigured()) {
    return { ok: false, reason: "stripe_not_configured" };
  }

  const entries: CatalogEntry[] = [];
  const specs: { kind: "plan" | "topup"; spec: PlanSpec | TopupSpec }[] = [
    ...PLAN_IDS.map((id) => ({ kind: "plan" as const, spec: PLANS[id] })),
    ...TOPUP_IDS.map((id) => ({ kind: "topup" as const, spec: TOPUPS[id] })),
  ];

  for (const { kind, spec } of specs) {
    // 1. Existing price? lookup_key is unique per Stripe account.
    const found = await stripeGet(
      `/v1/prices?lookup_keys[]=${encodeURIComponent(spec.stripeLookupKey)}&limit=1`,
      fetchImpl,
    );
    if (!found.ok) return { ok: false, reason: found.reason };
    const existing = (found.body.data as Record<string, unknown>[])?.[0];
    if (existing?.id) {
      entries.push({
        kind,
        id: spec.id,
        productId: String(existing.product ?? ""),
        priceId: String(existing.id),
        envVar: spec.stripePriceEnvVar,
        created: false,
      });
      continue;
    }

    // 2. Product (stable custom id → creating twice 409s; reuse on that).
    const productId = `cue_${spec.id}`;
    const productForm = new URLSearchParams({
      id: productId,
      name: `Cue — ${spec.name}`,
      statement_descriptor: "CUE",
      "metadata[app]": "cue",
      "metadata[cueId]": spec.id,
    });
    const product = await stripePost("/v1/products", productForm, fetchImpl);
    if (!product.ok && !/resource_already_exists|already exists/i.test(product.reason)) {
      return { ok: false, reason: product.reason };
    }

    // 3. Price (recurring for plans, one-time for top-ups).
    const priceForm = new URLSearchParams({
      product: productId,
      currency: "usd",
      unit_amount: String(spec.priceUsd * 100),
      lookup_key: spec.stripeLookupKey,
      "metadata[app]": "cue",
      "metadata[cueId]": spec.id,
    });
    if (kind === "plan") priceForm.set("recurring[interval]", "month");
    const price = await stripePost("/v1/prices", priceForm, fetchImpl);
    if (!price.ok) return { ok: false, reason: price.reason };

    entries.push({
      kind,
      id: spec.id,
      productId,
      priceId: String(price.body.id),
      envVar: spec.stripePriceEnvVar,
      created: true,
    });
  }

  return { ok: true, entries };
}

/**
 * Ensure a Stripe promotion code exists for an invite: a percent-off
 * coupon wrapped in a promotion code named after the invite code. Reused
 * when it already exists (promotion codes are unique per code string).
 */
export async function ensurePromotionCode(
  inviteCode: string,
  percentOff: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; promotionCodeId: string } | { ok: false; reason: string }> {
  const existing = await stripeGet(
    `/v1/promotion_codes?code=${encodeURIComponent(inviteCode)}&limit=1`,
    fetchImpl,
  );
  if (!existing.ok) return { ok: false, reason: existing.reason };
  const hit = (existing.body.data as Record<string, unknown>[])?.[0];
  if (hit?.id) return { ok: true, promotionCodeId: String(hit.id) };

  const coupon = await stripePost(
    "/v1/coupons",
    new URLSearchParams({
      percent_off: String(percentOff),
      duration: "forever",
      name: `Cue invite ${inviteCode}`,
      "metadata[app]": "cue",
    }),
    fetchImpl,
  );
  if (!coupon.ok) return { ok: false, reason: coupon.reason };

  const promo = await stripePost(
    "/v1/promotion_codes",
    new URLSearchParams({
      coupon: String(coupon.body.id),
      code: inviteCode,
      "metadata[app]": "cue",
    }),
    fetchImpl,
  );
  if (!promo.ok) return { ok: false, reason: promo.reason };
  return { ok: true, promotionCodeId: String(promo.body.id) };
}

// ── webhook signature verification (HMAC per Stripe docs) ────────────────

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 * Scheme: header is `t=<ts>,v1=<hex>,…`; the signed payload is
 * `${t}.${rawBody}` HMAC-SHA256'd with the webhook secret. Multiple v1
 * entries are allowed (secret rotation) — any match passes.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
  nowMs: number = Date.now(),
): boolean {
  if (!signatureHeader) return false;

  let timestamp = "";
  const v1Signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") v1Signatures.push(v);
  }
  if (!timestamp || v1Signatures.length === 0) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();
  for (const sig of v1Signatures) {
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sig, "hex");
    } catch {
      continue;
    }
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    ) {
      return true;
    }
  }
  return false;
}

/** Build a valid Stripe-Signature header — used by tests. */
export function signStripePayload(
  rawBody: string,
  secret: string,
  tsSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac("sha256", secret)
    .update(`${tsSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${tsSeconds},v1=${sig}`;
}

// ── webhook event handling ───────────────────────────────────────────────

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handle a raw Stripe webhook request: verify the signature, then flip
 * customer/instance/credit state:
 *   checkout.session.completed      → subscription mode: customer active +
 *                                     subscription row (+ plan from metadata);
 *                                     payment mode with topup metadata:
 *                                     apply the top-up + raise the key limit
 *   invoice.paid                    → grant monthly credits (idempotent per
 *                                     period) + reset the child-key limit
 *   invoice.payment_failed          → payment-failed email (grace period)
 *   customer.subscription.updated   → sync status; suspend/resume instances
 *   customer.subscription.deleted   → customer churned + instances suspended
 *                                     + child keys disabled
 *
 * `scheduleAutoProvision` is the website-flow hook: on a completed
 * subscription checkout the webhook records the session id (so
 * GET /welcome/status can find the customer) and kicks off provisioning
 * WITHOUT awaiting it — Stripe gets its 200 immediately; provisioning
 * itself is idempotent (provisioning.ts) so retries are safe.
 */
export async function handleStripeWebhook(
  deps: {
    db: HqDb;
    driver: InstanceDriver;
    fetchImpl?: typeof fetch;
    /** Fire-and-forget auto-provision kick (server.ts wires this). */
    scheduleAutoProvision?: (customerId: string) => void;
  },
  rawBody: string,
  signatureHeader: string | null,
): Promise<WebhookOutcome> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return { status: 503, body: { error: "stripe webhook not configured" } };
  }
  if (!verifyStripeSignature(rawBody, signatureHeader, secret)) {
    return { status: 400, body: { error: "invalid signature" } };
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  const obj = event.data?.object ?? {};
  const { db, driver } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  switch (event.type) {
    case "checkout.session.completed": {
      const metadata = (obj.metadata ?? {}) as Record<string, string>;
      const customerId = metadata.customerId;
      if (!customerId || !db.getCustomer(customerId)) {
        db.recordEvent("stripe_webhook_orphan", null, {
          type: event.type,
          customerId: customerId ?? null,
        });
        return { status: 200, body: { received: true, orphan: true } };
      }

      // Payment mode + topup metadata → a credit pack, not a subscription.
      if (obj.mode === "payment" && metadata.topup) {
        const credits = isTopupId(metadata.topup)
          ? TOPUPS[metadata.topup].credits
          : Number(metadata.credits);
        if (!Number.isInteger(credits) || credits <= 0) {
          db.recordEvent("stripe_topup_invalid", customerId, {
            sessionId: obj.id ?? null,
            topup: metadata.topup,
          });
          return { status: 200, body: { received: true, invalid: true } };
        }
        const result = applyTopup(db, {
          customerId,
          credits,
          ref: String(obj.id ?? `session-${Date.now()}`),
        });
        if (result.applied) {
          await syncKeyLimitsToBalance(db, customerId, fetchImpl);
        }
        db.recordEvent("stripe_topup_completed", customerId, {
          sessionId: obj.id ?? null,
          credits,
          applied: result.applied,
          balance: result.balance,
        });
        if (result.applied) {
          const customer = db.getCustomer(customerId)!;
          void trackEvent(
            db,
            {
              metric: "Cue Topped Up",
              email: customer.email,
              firstName: firstNameOf(customer.name),
              profileProps: { plan: customer.plan, credit_balance: result.balance },
              props: { credits },
              uniqueId: `topup:${String(obj.id ?? event.id ?? "")}`,
              customerId,
            },
            fetchImpl,
          );
        }
        return { status: 200, body: { received: true, applied: result.applied } };
      }

      if (isPlanId(metadata.plan)) {
        db.setCustomerPlan(customerId, metadata.plan);
      }
      // Remember the checkout session so GET /welcome/status?session_id=…
      // can resolve this customer while their instance comes up.
      if (obj.id) {
        db.setCustomerCheckoutSession(customerId, String(obj.id));
      }
      db.upsertSubscription({
        customerId,
        stripeCustomerId: String(obj.customer ?? ""),
        stripeSubId: String(obj.subscription ?? ""),
        status: "active",
        currentPeriodEnd: null,
        plan: metadata.plan ?? null,
      });
      db.transitionCustomer(customerId, "active");
      db.recordEvent("stripe_checkout_completed", customerId, {
        sessionId: obj.id ?? null,
      });
      {
        const customer = db.getCustomer(customerId)!;
        const plan = isPlanId(metadata.plan) ? metadata.plan : customer.plan;
        void trackEvent(
          db,
          {
            metric: "Cue Subscribed",
            email: customer.email,
            firstName: firstNameOf(customer.name),
            profileProps: { plan },
            props: { plan },
            uniqueId: `subscribed:${String(obj.id ?? event.id ?? "")}`,
            customerId,
          },
          fetchImpl,
        );
      }
      // Website flow: paid customers get their instance without an admin in
      // the loop. Not awaited — Stripe's delivery timeout is far shorter
      // than a provision; idempotency lives in provisioning.ts.
      deps.scheduleAutoProvision?.(customerId);
      // Tag the Stripe customer object too (best-effort) so EVERYTHING on
      // the account carries metadata {app:"cue"}.
      if (isStripeConfigured() && obj.customer) {
        await stripePost(
          `/v1/customers/${obj.customer}`,
          new URLSearchParams({
            "metadata[app]": "cue",
            "metadata[customerId]": customerId,
          }),
          fetchImpl,
        ).catch(() => {});
      }
      return { status: 200, body: { received: true } };
    }

    case "invoice.paid": {
      const resolved = resolveCustomerFromInvoice(db, obj);
      if (!resolved) {
        db.recordEvent("stripe_webhook_orphan", null, { type: event.type });
        return { status: 200, body: { received: true, orphan: true } };
      }
      const customer = db.getCustomer(resolved.customerId);
      if (!customer) {
        return { status: 200, body: { received: true, orphan: true } };
      }
      const sub = db.getSubscription(customer.id);
      const plan = sub?.plan ?? customer.plan;
      const grant = grantMonthlyCredits(db, {
        customerId: customer.id,
        plan,
        stripeSubId: resolved.stripeSubId,
        periodStart: Number(obj.period_start ?? 0),
      });
      if (grant.granted) {
        await syncKeyLimitsToBalance(db, customer.id, fetchImpl);
      }
      db.recordEvent("stripe_invoice_paid", customer.id, {
        invoiceId: obj.id ?? null,
        stripeSubId: resolved.stripeSubId,
        granted: grant.granted,
        balance: grant.balance,
      });
      return { status: 200, body: { received: true, granted: grant.granted } };
    }

    case "invoice.payment_failed": {
      const resolved = resolveCustomerFromInvoice(db, obj);
      if (!resolved) {
        db.recordEvent("stripe_webhook_orphan", null, { type: event.type });
        return { status: 200, body: { received: true, orphan: true } };
      }
      const customer = db.getCustomer(resolved.customerId);
      if (!customer) {
        return { status: 200, body: { received: true, orphan: true } };
      }
      // Grace-period messaging (designed template 04). Best-effort.
      const result = await sendEmail(
        customer.email,
        paymentFailedEmail({ portalUrl: `${publicRedirectBase()}/account` }),
        fetchImpl,
      );
      db.recordEvent("stripe_invoice_payment_failed", customer.id, {
        invoiceId: obj.id ?? null,
        emailed: result.ok,
      });
      void trackEvent(
        db,
        {
          metric: "Cue Payment Failed",
          email: customer.email,
          firstName: firstNameOf(customer.name),
          profileProps: { plan: customer.plan },
          props: { invoiceId: obj.id ?? null },
          uniqueId: `payment-failed:${String(obj.id ?? event.id ?? "")}`,
          customerId: customer.id,
        },
        fetchImpl,
      );
      return { status: 200, body: { received: true } };
    }

    case "customer.subscription.updated": {
      const resolved = resolveCustomerFromSubscription(db, obj);
      if (!resolved) {
        db.recordEvent("stripe_webhook_orphan", null, { type: event.type });
        return { status: 200, body: { received: true, orphan: true } };
      }
      const status = String(obj.status ?? "unknown");
      const periodEnd = Number(obj.current_period_end ?? 0);
      db.upsertSubscription({
        customerId: resolved.customerId,
        stripeCustomerId: String(obj.customer ?? resolved.stripeCustomerId),
        stripeSubId: String(obj.id ?? resolved.stripeSubId),
        status,
        currentPeriodEnd: periodEnd > 0 ? periodEnd * 1000 : null,
      });

      const customer = db.getCustomer(resolved.customerId);
      if (customer) {
        if (
          (status === "active" || status === "trialing") &&
          customer.status === "suspended"
        ) {
          db.transitionCustomer(customer.id, "active");
          await setInstancesState(db, driver, customer.id, "live");
        } else if (status === "unpaid" || status === "canceled") {
          if (customer.status === "active") {
            db.transitionCustomer(customer.id, "suspended");
          }
          await setInstancesState(db, driver, customer.id, "suspended");
        }
      }
      return { status: 200, body: { received: true } };
    }

    case "customer.subscription.deleted": {
      const resolved = resolveCustomerFromSubscription(db, obj);
      if (!resolved) {
        db.recordEvent("stripe_webhook_orphan", null, { type: event.type });
        return { status: 200, body: { received: true, orphan: true } };
      }
      db.upsertSubscription({
        customerId: resolved.customerId,
        stripeCustomerId: String(obj.customer ?? resolved.stripeCustomerId),
        stripeSubId: String(obj.id ?? resolved.stripeSubId),
        status: "canceled",
        currentPeriodEnd: null,
      });
      db.transitionCustomer(resolved.customerId, "churned");
      await setInstancesState(db, driver, resolved.customerId, "suspended");
      await disableCustomerKeys(db, resolved.customerId, fetchImpl);
      db.recordEvent("stripe_subscription_deleted", resolved.customerId, {
        stripeSubId: obj.id ?? null,
      });
      const churned = db.getCustomer(resolved.customerId);
      if (churned) {
        void trackEvent(
          db,
          {
            metric: "Cue Cancelled",
            email: churned.email,
            firstName: firstNameOf(churned.name),
            profileProps: { plan: churned.plan },
            props: { stripeSubId: obj.id ?? null },
            uniqueId: `cancelled:${String(obj.id ?? event.id ?? "")}`,
            customerId: churned.id,
          },
          fetchImpl,
        );
      }
      return { status: 200, body: { received: true } };
    }

    default:
      db.recordEvent("stripe_webhook_ignored", null, {
        type: event.type ?? "unknown",
      });
      return { status: 200, body: { received: true, ignored: true } };
  }
}

/** Match an invoice event to our customer via sub metadata or the sub id. */
function resolveCustomerFromInvoice(
  db: HqDb,
  obj: Record<string, unknown>,
): { customerId: string; stripeSubId: string } | null {
  const subId = String(obj.subscription ?? "");
  const subDetails = (obj.subscription_details ?? {}) as {
    metadata?: Record<string, string>;
  };
  const metaCustomerId = subDetails.metadata?.customerId;
  if (metaCustomerId && db.getCustomer(metaCustomerId)) {
    return { customerId: metaCustomerId, stripeSubId: subId };
  }
  if (subId) {
    const sub = db.getSubscriptionByStripeSubId(subId);
    if (sub) return { customerId: sub.customerId, stripeSubId: subId };
  }
  return null;
}

/** Disable every provisioned child key of a customer (suspend/churn). */
async function disableCustomerKeys(
  db: HqDb,
  customerId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!isOpenRouterConfigured()) return;
  for (const instance of db.listInstancesByCustomer(customerId)) {
    if (!instance.openrouterKeyHash) continue;
    const result = await disableKey(instance.openrouterKeyHash, fetchImpl);
    db.recordEvent(
      result.ok ? "openrouter_key_disabled" : "openrouter_key_error",
      customerId,
      {
        instanceId: instance.id,
        ...(result.ok ? {} : { op: "disable", reason: result.reason }),
      },
    );
  }
}

/** Match a subscription event to our customer via metadata or the sub id. */
function resolveCustomerFromSubscription(
  db: HqDb,
  obj: Record<string, unknown>,
): { customerId: string; stripeCustomerId: string; stripeSubId: string } | null {
  const metadata = (obj.metadata ?? {}) as Record<string, string>;
  if (metadata.customerId && db.getCustomer(metadata.customerId)) {
    return {
      customerId: metadata.customerId,
      stripeCustomerId: String(obj.customer ?? ""),
      stripeSubId: String(obj.id ?? ""),
    };
  }
  const subId = String(obj.id ?? "");
  if (subId) {
    const sub = db.getSubscriptionByStripeSubId(subId);
    if (sub) {
      return {
        customerId: sub.customerId,
        stripeCustomerId: sub.stripeCustomerId,
        stripeSubId: sub.stripeSubId,
      };
    }
  }
  return null;
}

/** Drive every non-deleted instance of a customer to live/suspended. */
async function setInstancesState(
  db: HqDb,
  driver: InstanceDriver,
  customerId: string,
  target: "live" | "suspended",
): Promise<void> {
  for (const instance of db.listInstancesByCustomer(customerId)) {
    if (instance.state === "deleted" || instance.state === target) continue;
    if (instance.state === "provisioning") continue; // let provisioning finish
    try {
      if (target === "suspended") await driver.suspend(instance.externalId);
      else await driver.resume(instance.externalId);
      db.transitionInstance(instance.id, target);
    } catch (err) {
      db.recordEvent("instance_driver_error", customerId, {
        instanceId: instance.id,
        op: target === "suspended" ? "suspend" : "resume",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
