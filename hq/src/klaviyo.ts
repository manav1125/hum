/**
 * Cue HQ — lifecycle event sync to Klaviyo (marketing/CRM) via the Events
 * API, plain fetch and zero deps (mirroring email.ts / stripe.ts style).
 *
 * Every commercially meaningful lifecycle transition emits a metric so
 * funnels/flows in Klaviyo can trigger off real product state. The metric
 * catalog lives in the README ("Klaviyo sync") — keep it in sync when
 * adding call sites.
 *
 * Fire-and-forget contract: `trackEvent` NEVER throws and callers NEVER
 * await it (matching how welcome emails are sent) — a Klaviyo outage can
 * not slow or fail a checkout, webhook, or sweep. Failures are recorded as
 * `klaviyo_sync_failed` audit events. Every emission carries a stable
 * `unique_id` so Klaviyo dedupes webhook retries server-side.
 *
 * Runs cleanly in "not configured" mode: without KLAVIYO_PRIVATE_KEY the
 * would-be event is logged at info level and nothing is sent.
 *
 * Env contract:
 *   KLAVIYO_PRIVATE_KEY — Klaviyo private API key (pk_…). Unset ⇒ no-op.
 */

import type { HqDb } from "./db.js";

const KLAVIYO_API_BASE = "https://a.klaviyo.com";

/**
 * Klaviyo API revision (stable). Klaviyo cuts a stable revision quarterly;
 * 2026-04-15 is the current stable line per the SDK/docs.
 */
export const KLAVIYO_REVISION = "2026-04-15";

export function isKlaviyoConfigured(): boolean {
  return !!process.env.KLAVIYO_PRIVATE_KEY;
}

export interface KlaviyoEventParams {
  /** Metric name exactly as it appears in Klaviyo (e.g. "Cue Subscribed"). */
  metric: string;
  email: string;
  firstName?: string;
  /** Profile-level properties (plan, credit balance, …) — merged onto the profile. */
  profileProps?: Record<string, unknown>;
  /** Event-level properties (plan, credits, instance url, …). */
  props?: Record<string, unknown>;
  /** Stable idempotency key — Klaviyo drops repeats (webhook retries). */
  uniqueId: string;
  /** Our customer id, for the klaviyo_sync_failed audit event. */
  customerId?: string | null;
}

/** The Events API JSON:API payload — exported for tests. */
export function buildEventPayload(params: KlaviyoEventParams): Record<string, unknown> {
  return {
    data: {
      type: "event",
      attributes: {
        properties: params.props ?? {},
        unique_id: params.uniqueId,
        metric: {
          data: {
            type: "metric",
            attributes: { name: params.metric },
          },
        },
        profile: {
          data: {
            type: "profile",
            attributes: {
              email: params.email,
              ...(params.firstName ? { first_name: params.firstName } : {}),
              ...(params.profileProps && Object.keys(params.profileProps).length > 0
                ? { properties: params.profileProps }
                : {}),
            },
          },
        },
      },
    },
  };
}

/**
 * Track one lifecycle event in Klaviyo. Fire-and-forget: NEVER throws, and
 * callers must NOT await it (`void trackEvent(…)`) — the caller path never
 * blocks on marketing sync. Failures land as `klaviyo_sync_failed` events.
 */
export async function trackEvent(
  db: HqDb,
  params: KlaviyoEventParams,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isKlaviyoConfigured()) {
    console.info(
      `[hq/klaviyo] not configured — would track metric=${JSON.stringify(params.metric)} email=${params.email} unique_id=${params.uniqueId}`,
    );
    return;
  }
  try {
    const res = await fetchImpl(`${KLAVIYO_API_BASE}/api/events`, {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_KEY}`,
        revision: KLAVIYO_REVISION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildEventPayload(params)),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      db.recordEvent("klaviyo_sync_failed", params.customerId ?? null, {
        metric: params.metric,
        uniqueId: params.uniqueId,
        reason: `klaviyo_error_${res.status}: ${text.slice(0, 300)}`,
      });
    }
  } catch (err) {
    db.recordEvent("klaviyo_sync_failed", params.customerId ?? null, {
      metric: params.metric,
      uniqueId: params.uniqueId,
      reason: `klaviyo_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** "Maya Chen" → "Maya" — the profile first_name for our customer rows. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
