import { buildVellumHeaders } from "@/lib/auth/request-headers";

/**
 * Mint the gateway's learn-session cookie (HttpOnly `cue_learn`) that every
 * proxied `/learn/*` and `/api/*` request rides on. Shared by the Learn page
 * (before mounting the iframe) and the Library's course catalog (before
 * listing courses). The cookie's signing secret is per-gateway-process, so
 * callers mint per mount/fetch rather than caching the outcome long-term.
 *
 * "unconfigured" = the deployment has no Learn sidecar (gateway answers 404).
 */
export type LearnSessionState = "ready" | "unconfigured" | "error";

export async function mintLearnSession(): Promise<LearnSessionState> {
  try {
    // The gateway route authenticates the Bearer edge token itself; CSRF
    // headers are a daemon/platform concern, so the safe-request builder is
    // the right one here despite the POST.
    const res = await fetch("/learn/cue-session", {
      method: "POST",
      headers: buildVellumHeaders(),
      credentials: "include",
    });
    if (res.status === 404) return "unconfigured";
    return res.ok ? "ready" : "error";
  } catch {
    return "error";
  }
}
