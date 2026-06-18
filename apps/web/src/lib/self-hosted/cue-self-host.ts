/**
 * Cue self-host bootstrap.
 *
 * Lets the hosted SPA (served same-origin from the gateway) authenticate to a
 * self-hosted Cue gateway WITHOUT the Vellum Platform's token brokering. A
 * one-time `?cueToken=<actor JWT>` (optionally `&cueExp=<ms>`) seeds the
 * gateway-session token store and flips a persistent self-host flag. After
 * that, `isGatewayAuthEnabled()` reports true and the standard gateway-auth
 * short-circuit (`applyGatewayAuthShortCircuit`) boots straight into an
 * authenticated `self` session against `window.location.origin`.
 *
 * The token is minted out-of-band via `POST /v1/guardian/init` (see
 * deploy/README + the cue-render-selfhost memory).
 */

// Mirror of the gateway-session storage keys (kept in sync deliberately so this
// boot-time module has no import cycle with the auth layer).
const LS_TOKEN_KEY = "vellum:gw:token";
const LS_EXPIRES_KEY = "vellum:gw:expiresAt";
const LS_TOKEN_SOURCE_KEY = "vellum:gw:tokenSource";
const LS_SELF_HOST_FLAG = "cue:selfHost";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d — matches actor_client_v1

/** True when this SPA has been put into self-hosted gateway mode. */
export function isSelfHostMode(): boolean {
  try {
    return localStorage.getItem(LS_SELF_HOST_FLAG) === "1";
  } catch {
    return false;
  }
}

/** Clear self-host mode + the seeded token (e.g. on an explicit disconnect). */
export function clearSelfHostMode(): void {
  try {
    localStorage.removeItem(LS_SELF_HOST_FLAG);
    localStorage.removeItem(LS_TOKEN_KEY);
    localStorage.removeItem(LS_EXPIRES_KEY);
    localStorage.removeItem(LS_TOKEN_SOURCE_KEY);
  } catch {
    // localStorage unavailable
  }
}

/**
 * Consume a one-time `?cueToken=` from the URL: seed the gateway-session token
 * store, flip the self-host flag, and strip the param so the credential never
 * lingers in the address bar or history. Idempotent; safe to call on every boot
 * (a no-op when no `cueToken` is present). Must run before the assistant
 * lifecycle first reads the gateway token.
 */
export function bootstrapCueSelfHost(): void {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  const token = params.get("cueToken");
  if (!token) return;

  // `accessTokenExpiresAt` is epoch-ms; the token store keeps epoch-seconds.
  const expMsRaw = Number(params.get("cueExp"));
  const expMs =
    Number.isFinite(expMsRaw) && expMsRaw > 0
      ? expMsRaw
      : Date.now() + DEFAULT_TTL_MS;
  const expSec = Math.floor(expMs / 1000);

  try {
    localStorage.setItem(LS_TOKEN_KEY, token);
    localStorage.setItem(LS_EXPIRES_KEY, String(expSec));
    localStorage.setItem(LS_TOKEN_SOURCE_KEY, window.location.origin);
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");
  } catch {
    // localStorage unavailable — nothing more we can do
    return;
  }

  // Strip the credential params from the URL without a reload.
  params.delete("cueToken");
  params.delete("cueExp");
  try {
    const qs = params.toString();
    const next =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
  } catch {
    // history unavailable — harmless
  }
}
