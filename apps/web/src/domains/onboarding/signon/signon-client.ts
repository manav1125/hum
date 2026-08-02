/**
 * The sign-on flow's one network seam: asking Cue HQ to email a magic link.
 *
 * A self-hosted instance (`<name>.justcue.app`) has NO account service of its
 * own — HQ is the only thing that knows which email owns which instance and
 * the only thing that can mint a link. So this module talks cross-origin to
 * HQ's `POST /signin`, and every failure mode degrades to something the user
 * can still act on rather than a dead end:
 *
 *   - HQ answers          → we report exactly what it said (sent / not on the
 *                           alpha list / your Cue isn't set up / send failed).
 *   - the device is offline → "offline", which is a retry, not an error.
 *   - HQ is unreachable or the browser blocks the cross-origin call
 *                         → "unreachable", carrying the HQ sign-in URL so the
 *                           user can finish the same flow on justcue.ai.
 *
 * The unreachable case is not hypothetical: HQ scopes its CORS allow-list to
 * known app origins, so an instance origin that HQ has not been taught about
 * gets a browser-level block that is indistinguishable from a network error.
 * That is precisely why the fallback exists and why it is a first-class
 * outcome rather than a catch-all "something went wrong".
 *
 * PRIVACY: the email address is only ever sent in a POST body. It is never
 * put in a URL, never in a query string, and never persisted. The fallback
 * link is the bare sign-in page — the user retypes their address there.
 *
 * There is no password field anywhere in this flow and there must never be
 * one: Cue is magic-link only by design.
 */

/** Hosted Cue sign-in origin. Overridable per-deploy at build time. */
export function signinBase(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = env.VITE_CUE_SIGNIN_URL?.trim();
  if (!raw) return "https://justcue.ai";
  // The env var has historically held the full page URL
  // (`https://justcue.ai/signin`); accept either and normalise to an origin.
  try {
    return new URL(raw).origin;
  } catch {
    return "https://justcue.ai";
  }
}

/** The hosted sign-in PAGE — the honest fallback when the API is unreachable. */
export function signinPageUrl(): string {
  return `${signinBase()}/signin`;
}

export type SigninOutcome =
  /** A link is genuinely in flight. */
  | { kind: "sent" }
  /** HQ has no mailer configured — nothing was sent, and it said so. */
  | { kind: "email_not_configured" }
  /** On the alpha list, but no instance provisioned yet. */
  | { kind: "invited_no_account"; message: string }
  /** Not recognised — the D2 state. */
  | { kind: "invite_required"; message: string }
  /** HQ tried and its mailer refused. */
  | { kind: "send_failed" }
  /** No network. The D3 state; a retry, not a failure. */
  | { kind: "offline" }
  /** HQ could not be reached from here. Carries the page the user can use. */
  | { kind: "unreachable"; signinUrl: string };

/** Cheap client-side shape check. Deliberately permissive — HQ is authority. */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return v.length >= 3 && v.includes("@") && !/\s/.test(v);
}

/** True when the platform is confident it has no network. */
function isOffline(): boolean {
  try {
    return globalThis.navigator?.onLine === false;
  } catch {
    return false;
  }
}

/**
 * Ask HQ to email a one-time sign-in link to `email`.
 *
 * Never throws: every path resolves to a `SigninOutcome` the UI can render.
 */
export async function requestSigninLink(
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SigninOutcome> {
  if (isOffline()) return { kind: "offline" };

  let res: Response;
  try {
    res = await fetchImpl(`${signinBase()}/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email: email.trim() }),
    });
  } catch {
    // A CORS block and a dead network look identical from here. Check the
    // platform's own signal once more before blaming the network.
    if (isOffline()) return { kind: "offline" };
    return { kind: "unreachable", signinUrl: signinPageUrl() };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON answer means we are not talking to the HQ we expect (a proxy
    // error page, a captive portal). Hand the user the page that works.
    return { kind: "unreachable", signinUrl: signinPageUrl() };
  }

  const status = typeof body.status === "string" ? body.status : "";
  const message = typeof body.message === "string" ? body.message : "";

  switch (status) {
    case "sent":
      return { kind: "sent" };
    case "email_not_configured":
      return { kind: "email_not_configured" };
    case "invited_no_account":
      return {
        kind: "invited_no_account",
        message:
          message ||
          "You're on the alpha list, but your Cue isn't set up yet — use the invite link from your welcome email, or contact hello@justcue.ai.",
      };
    case "invite_required":
      return {
        kind: "invite_required",
        message:
          message ||
          "Cue is in private alpha — request an invite at hello@justcue.ai.",
      };
    case "send_failed":
      return { kind: "send_failed" };
    default:
      // Includes HQ's 503 "signin not configured" and any status this build
      // has not been taught. Do not invent a success.
      return { kind: "unreachable", signinUrl: signinPageUrl() };
  }
}

/** The customer-instance domain every provisioned Cue lives under. */
export const INSTANCE_DOMAIN = ".justcue.app";

/**
 * Turn what the user typed on the "Enter your Cue address" screen into an
 * instance URL, or null if it cannot be one.
 *
 * Accepts a bare name (`cue-ada`), a full host (`cue-ada.justcue.app`) or a
 * pasted https URL. Always returns an https origin — never a token-bearing
 * link, and never a URL this function invented credentials for.
 */
export function instanceUrlFromAddress(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  const host = value.endsWith(INSTANCE_DOMAIN)
    ? value
    : `${value}${INSTANCE_DOMAIN}`;
  // One label, the characters DNS actually allows. Rejects "a/b", "a b",
  // "a.b.justcue.app" and the empty name.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.justcue\.app$/.test(host)) return null;
  return `https://${host}`;
}
