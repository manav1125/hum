/**
 * Pure planning for the HQ sign-in proxy (`app://vellum.ai/assistant/__hq/signin`).
 *
 * WHY THIS EXISTS
 *
 * Sign-on is the one thing the desktop app must do *before* it is connected to
 * anything. Until the owner connects, the packaged renderer runs at the app's
 * own `app://vellum.ai` origin, and the sign-on screen's only network call is a
 * JSON `POST` to HQ (`https://justcue.ai/signin`) asking for a magic link.
 *
 * A cross-origin JSON POST is not a "simple" request, so Chromium sends a CORS
 * preflight first. Measured, from a real packaged-shaped renderer:
 *
 *   OPTIONS /signin   Origin: app://vellum.ai   Sec-Fetch-Site: cross-site
 *
 * `app://vellum.ai` is NOT the opaque `null` origin — the scheme is registered
 * `standard` in `index.ts`, so it is a real tuple origin — but HQ's allow-list
 * covers the mobile shell origins and `https://<name>.justcue.app` instances
 * only. The preflight 404s, the POST never leaves the machine, and the sign-on
 * client (correctly) reports `unreachable`: *"We couldn't reach Cue's sign-in
 * service from here, so no link was sent."* That is the first-run dead end the
 * owner hit, and why signing in on the web first "fixes" it — once connected,
 * the renderer runs at the instance's https origin, which HQ does allow.
 *
 * The fix is to take the call out of the browser's CORS model entirely rather
 * than to widen HQ's allow-list. Widening it to the opaque `null` origin would
 * be actively unsafe (every sandboxed iframe and `data:` URL presents `null`),
 * and even allow-listing `app://vellum.ai` would only paper over a request that
 * has no business being cross-origin: the renderer asks its OWN origin, and the
 * main process makes the HQ hop server-side, where CORS does not apply. This is
 * the same rail `gateway-forward.ts` and `platform-forward.ts` already ride.
 *
 * SECURITY CONTRACT — the reason this is a planner and not a proxy:
 *
 *   - The destination is OURS, never the renderer's. `hqOrigin` comes from this
 *     module (or a validated operator env var); nothing from the request URL,
 *     headers or body can influence where the forward goes. A renderer-supplied
 *     destination would make the desktop app an open proxy.
 *   - Exactly ONE route is forwardable — `POST .../signin`. Any other path under
 *     the mount is a 404, any other method a 405. There is no wildcard.
 *   - Request headers are BUILT here, not copied. Whatever the renderer attached
 *     (session tokens, cookies, custom headers) is dropped; HQ receives the two
 *     headers the sign-in contract needs and nothing else.
 *   - The query string is dropped. The email travels in the POST body only —
 *     never a URL, never a query string, never a log line. That is the documented
 *     contract in `apps/web/src/domains/onboarding/signon/signon-client.ts` and
 *     it is preserved end to end here.
 *   - There is no password in this flow and there must never be one: Cue is
 *     magic-link only.
 */

/** Mount for main-process-brokered HQ calls, under the renderer's own mount. */
export const HQ_MOUNT = "/assistant/__hq";

/** The single forwardable route. */
export const HQ_SIGNIN_PATH = `${HQ_MOUNT}/signin`;

/** Cue HQ. The only host this forwarder will ever talk to. */
export const DEFAULT_HQ_ORIGIN = "https://justcue.ai";

/**
 * Resolve HQ's origin: the constant above, or `CUE_HQ_URL` for dev/QA against a
 * staging HQ.
 *
 * The override is validated, not trusted — https only, except for loopback,
 * where a developer's HQ legitimately runs over plain http. Anything else falls
 * back to production HQ rather than silently pointing the sign-in POST (which
 * carries an email address) somewhere unencrypted.
 */
export function resolveHqOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.CUE_HQ_URL?.trim();
  if (!raw) return DEFAULT_HQ_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_HQ_ORIGIN;
  }
  if (url.protocol === "https:") return url.origin;
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && isLoopback) return url.origin;
  return DEFAULT_HQ_ORIGIN;
}

export type HqForwardPlan =
  | { kind: "pass" }
  | { kind: "reject"; status: number; message: string }
  | {
      kind: "forward";
      url: string;
      method: string;
      headers: Headers;
    };

export interface HqForwardRequest {
  url: string;
  method: string;
}

/**
 * Resolve a renderer request to an HQ-proxy plan.
 *
 * `pass` means "not mine" — the caller carries on to the gateway/platform
 * proxies and then to static serving. Only `POST /assistant/__hq/signin`
 * forwards; everything else under the mount is refused so this can never grow
 * into a general-purpose escape hatch by accident.
 */
export function planHqForward(
  request: HqForwardRequest,
  hqOrigin: string,
): HqForwardPlan {
  const { pathname } = new URL(request.url);
  if (pathname !== HQ_MOUNT && !pathname.startsWith(`${HQ_MOUNT}/`)) {
    return { kind: "pass" };
  }
  if (pathname !== HQ_SIGNIN_PATH) {
    return { kind: "reject", status: 404, message: "Not Found" };
  }
  if (request.method.toUpperCase() !== "POST") {
    return { kind: "reject", status: 405, message: "Method Not Allowed" };
  }
  return {
    kind: "forward",
    // Built from OUR origin plus a literal path. Note the request's own query
    // string is not carried over: the email belongs in the body, only.
    url: `${hqOrigin}/signin`,
    method: "POST",
    // A fresh, minimal header set — the renderer's headers are not copied.
    headers: new Headers({
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
  };
}

/**
 * The answer when the main process itself could not reach HQ.
 *
 * `status: "unreachable"` is not one of HQ's own statuses, so the sign-on
 * client's `default` branch maps it to its `unreachable` outcome — the honest
 * "we couldn't reach Cue's sign-in service, here's the web page instead" state,
 * exactly what a browser-level failure produces. A transport failure must never
 * be dressed up as a sent link.
 */
export function buildHqUnreachableResponse(): Response {
  return new Response(JSON.stringify({ status: "unreachable" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Re-shape HQ's answer for the renderer: status and body verbatim, but a
 * header set we construct. HQ's response headers (`Set-Cookie`, its own CORS
 * grants) have no business being replayed onto the app's own origin.
 */
export function buildHqProxyResponse(
  status: number,
  body: string,
  contentType = "application/json",
): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}
