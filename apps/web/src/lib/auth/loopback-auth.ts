/**
 * Loopback authentication for local-mode web UI.
 *
 * Mirrors the CLI's `vellum login` browser flow: navigates to the
 * platform's login page, which authenticates via WorkOS and redirects
 * back to `http://127.0.0.1:{port}/callback?state=...&session_token=...`.
 * The local web server forwards `/callback` to the SPA's
 * `PlatformLoopbackPage` which validates the state and installs the
 * session cookie.
 */

const LOOPBACK_STATE_KEY = "vellum:loopback:state";
const LOOPBACK_RETURN_TO_KEY = "vellum:loopback:returnTo";

interface VellumConfig {
  webUrl?: string;
  platformUrl?: string;
}

/**
 * Where the login page lives when the host has not said.
 *
 * This used to be a hardcoded `https://www.vellum.ai`, and on any deployment
 * that does not inject `__VELLUM_CONFIG__` — which is every self-hosted one —
 * the consequences chained: `isPlatformLocal()` compared the upstream fork's
 * domain against this origin, got false, and `startAuthFlow` classified the
 * install as "standalone local mode" and sent the browser off-origin. The
 * first button on the first screen of a fresh Cue install opened another
 * company's sign-in page and asked the reader for credentials there.
 *
 * It could not have completed either: the callback it requests is
 * `http://127.0.0.1:{port}/callback`, so on a phone there was nothing
 * listening to come back to.
 *
 * Same-origin is the only defensible default. A deployment that genuinely
 * authenticates elsewhere injects `webUrl` and is unaffected; one that says
 * nothing gets its own login page, which is the one it is already serving.
 */
function getLocalConfig(): { webUrl: string } {
  const injected = (window as unknown as { __VELLUM_CONFIG__?: VellumConfig })
    .__VELLUM_CONFIG__;
  if (injected?.webUrl) return { webUrl: injected.webUrl };
  return { webUrl: window.location.origin };
}

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isPlatformLocal(): boolean {
  return getLocalConfig().webUrl === window.location.origin;
}

export function useIsPlatformLocal(): boolean {
  return isPlatformLocal();
}

export async function startLoopbackAuth(
  returnTo?: string,
  options?: { intent?: string },
): Promise<void> {
  const { webUrl } = getLocalConfig();
  const state = generateState();
  const port = window.location.port || "3000";

  sessionStorage.setItem(LOOPBACK_STATE_KEY, state);
  if (returnTo) {
    sessionStorage.setItem(LOOPBACK_RETURN_TO_KEY, returnTo);
  }

  const callbackReturnTo = `/accounts/cli/callback?port=${port}&state=${state}`;
  const page = options?.intent === "signup" ? "signup" : "login";
  const loginUrl = `${webUrl}/account/${page}?returnTo=${encodeURIComponent(callbackReturnTo)}`;

  window.location.href = loginUrl;
}
