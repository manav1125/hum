/**
 * Cue instance auto-detection.
 *
 * A self-hosted Cue user runs their gateway at a remote origin (e.g.
 * `https://manav.justcue.app`), NOT on loopback. The extension has no way
 * to know that origin a priori — but the user is almost always signed into
 * their instance in the same Chrome, on a tab whose SPA is served under
 * `/assistant/…`. This module derives the gateway origin from such open
 * tabs and verifies each candidate actually hosts a Cue gateway before we
 * commit to pairing against it.
 *
 * Verification probes the gateway's own `POST /v1/pair` endpoint: a real
 * Cue gateway answers an unauthenticated probe with 200 / 401 / 403 (the
 * endpoint exists and enforces the pairing handshake), whereas an arbitrary
 * site under some `/assistant` path returns 404 or a network error. That
 * distinction is what separates a genuine instance from a look-alike URL.
 *
 * The `x-vellum-interface-id` header and the `/v1/pair` path are
 * protocol/contract identifiers shared with the gateway — they stay
 * `vellum` per the Cue rebrand boundary.
 */

/** Path of the gateway pairing endpoint used to verify a candidate origin. */
export const PAIR_PROBE_PATH = "/v1/pair";

/** Default timeout for a single gateway probe. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Normalize a full tab URL down to its `scheme://host[:port]` origin.
 * Returns `null` for non-http(s) URLs (chrome://, extension pages, etc.)
 * and for anything that isn't a parseable URL.
 */
export function normalizeOrigin(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Is this tab URL a Cue SPA route? The web app is served under
 * `/assistant/…`, which is the anchor we use to tell a Cue instance tab
 * apart from an arbitrary website. This is a heuristic for *candidate*
 * selection only — every candidate is still verified via {@link
 * probeCueGateway} before it is trusted.
 */
export function isCueSpaTabUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.pathname === "/assistant" || u.pathname.startsWith("/assistant/");
  } catch {
    return false;
  }
}

/**
 * Collect the distinct candidate gateway origins from a set of open tab
 * URLs, preserving input order (callers pass the most-relevant tabs, e.g.
 * the active/last-focused tab, first). Only tabs whose path looks like a
 * Cue SPA route contribute a candidate.
 */
export function candidateGatewayOriginsFromTabs(
  tabUrls: Array<string | undefined | null>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tabUrls) {
    if (!raw) continue;
    if (!isCueSpaTabUrl(raw)) continue;
    const origin = normalizeOrigin(raw);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/**
 * Verify that `origin` hosts a Cue gateway by probing its `/v1/pair`
 * endpoint. Resolves `true` only when the endpoint answers like a real
 * gateway (200 / 401 / 403); network errors, timeouts, and 404s resolve
 * `false`. Never throws.
 */
export async function probeCueGateway(
  origin: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const resp = await fetchFn(`${origin.replace(/\/$/, "")}${PAIR_PROBE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vellum-interface-id": "chrome-extension",
      },
      credentials: "omit",
      ...(controller ? { signal: controller.signal } : {}),
    });
    return resp.status === 200 || resp.status === 401 || resp.status === 403;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Detect a reachable Cue gateway URL from the given open tab URLs. Returns
 * the first candidate origin that passes {@link probeCueGateway}, or `null`
 * when none of the open tabs point at a verifiable Cue instance.
 */
export async function detectCueGatewayUrl(
  tabUrls: Array<string | undefined | null>,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const candidates = candidateGatewayOriginsFromTabs(tabUrls);
  for (const origin of candidates) {
    if (await probeCueGateway(origin, fetchFn)) return origin;
  }
  return null;
}
