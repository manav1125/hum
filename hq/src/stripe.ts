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
 *   STRIPE_SECRET_KEY          — sk_… (checkout session creation)
 *   STRIPE_WEBHOOK_SECRET      — whsec_… (signature verification)
 *   STRIPE_PRICE_FOUNDING      — price id for the `founding` plan
 *   STRIPE_PRICE_FOUNDING_BYO  — price id for the `founding_byo` plan
 *   HQ_PUBLIC_URL              — base for checkout success/cancel URLs
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { CustomerPlan, HqDb } from "./db.js";
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
  return plan === "founding_byo"
    ? process.env.STRIPE_PRICE_FOUNDING_BYO
    : process.env.STRIPE_PRICE_FOUNDING;
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

  const base = process.env.HQ_PUBLIC_URL ?? "http://localhost:8790";
  const form = new URLSearchParams({
    mode: "subscription",
    customer_email: params.email,
    success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel`,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "metadata[customerId]": params.customerId,
    "subscription_data[metadata][customerId]": params.customerId,
  });
  if (params.inviteCode) form.set("metadata[inviteCode]", params.inviteCode);

  const res = await fetchImpl(`${STRIPE_API_BASE}/v1/checkout/sessions`, {
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
      reason: `stripe_error_${res.status}: ${text.slice(0, 300)}`,
    };
  }
  const session = (await res.json()) as { id: string; url: string };
  return { ok: true, url: session.url, sessionId: session.id };
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
 * customer/instance state:
 *   checkout.session.completed      → customer active + subscription row
 *   customer.subscription.updated   → sync status; suspend/resume instances
 *   customer.subscription.deleted   → customer churned + instances suspended
 */
export async function handleStripeWebhook(
  deps: { db: HqDb; driver: InstanceDriver },
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
      db.upsertSubscription({
        customerId,
        stripeCustomerId: String(obj.customer ?? ""),
        stripeSubId: String(obj.subscription ?? ""),
        status: "active",
        currentPeriodEnd: null,
      });
      db.transitionCustomer(customerId, "active");
      db.recordEvent("stripe_checkout_completed", customerId, {
        sessionId: obj.id ?? null,
      });
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
      db.recordEvent("stripe_subscription_deleted", resolved.customerId, {
        stripeSubId: obj.id ?? null,
      });
      return { status: 200, body: { received: true } };
    }

    default:
      db.recordEvent("stripe_webhook_ignored", null, {
        type: event.type ?? "unknown",
      });
      return { status: 200, body: { received: true, ignored: true } };
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
