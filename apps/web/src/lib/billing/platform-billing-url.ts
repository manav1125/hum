/**
 * Platform billing-link derivation for the self-host billing page.
 *
 * A self-hosted assistant has no platform session, so the billing page cannot
 * render the platform-hosted billing UI. It CAN deep-link the user to the Cue
 * platform's own billing page. The daemon already exposes its configured
 * `platform.baseUrl` through an existing client-visible config surface
 * (`GET /v1/assistants/{assistant_id}/config/platform` — the generated
 * `configPlatformGet` SDK call); these helpers turn that value into a safe
 * external billing URL.
 *
 * The daemon's `getPlatformBaseUrl()` falls back to internal infrastructure
 * hosts when `platform.baseUrl` is unset (`*.vellum.ai` platform APIs,
 * `localhost:8000` for local dev). Those are not customer-facing billing
 * sites, so they are treated as "unconfigured" and replaced by the Cue
 * platform default.
 */

/** Customer-facing Cue platform used when no usable base URL is configured. */
export const DEFAULT_PLATFORM_BILLING_BASE = "https://justcue.ai";

/**
 * Hosts the daemon reports when `platform.baseUrl` was never configured —
 * internal Vellum platform APIs and local-dev loopback. Linking a user's
 * browser at these is never useful, so they fall back to the Cue platform.
 */
function isInternalDefaultHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "vellum.ai" || host.endsWith(".vellum.ai")) return true;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/**
 * Derive the external billing-page URL from a daemon-reported platform base
 * URL. Returns `<base>/billing` when the base is a usable http(s) URL that
 * isn't an internal default; otherwise `https://justcue.ai/billing`.
 */
export function derivePlatformBillingUrl(baseUrl?: string | null): string {
  const raw = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (raw) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (
      parsed &&
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !isInternalDefaultHost(parsed.hostname)
    ) {
      return `${raw}/billing`;
    }
  }
  return `${DEFAULT_PLATFORM_BILLING_BASE}/billing`;
}

/**
 * Human label for the billing link ("Manage billing on justcue.ai"): the
 * hostname of the derived billing URL. The input always comes from
 * `derivePlatformBillingUrl`, so it parses; the fallback is defensive.
 */
export function platformBillingHost(billingUrl: string): string {
  try {
    return new URL(billingUrl).hostname;
  } catch {
    return new URL(DEFAULT_PLATFORM_BILLING_BASE).hostname;
  }
}
