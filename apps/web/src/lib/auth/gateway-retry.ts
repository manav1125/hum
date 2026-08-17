/**
 * One-shot recovery for a gateway token whose signature has gone stale.
 *
 * A gateway restart rotates its signing key, which invalidates the cached
 * gateway token's *signature* while it stays *time*-valid — so nothing
 * re-mints it and every authed request 401s ("Failed to load …" everywhere,
 * and an events stream that never delivers `confirmation_request`).
 *
 * This module owns the recovery so every transport that talks to a
 * self-hosted gateway shares one implementation and one budget:
 *
 *   - {@link daemonUnreachableInterceptor} — the daemon SDK's response
 *     interceptor, for ordinary REST calls.
 *   - the SSE events stream in `stream-transport.ts`, which cannot use a
 *     response interceptor at all (the generated client runs response
 *     interceptors only on `client.request`, never on `client.sse.*`).
 *
 * The single-flight + cooldown semantics live in {@link remintGatewayTokenOnce},
 * so a storm of concurrent callers — say twenty remounted subscriptions all
 * 401ing in the same second — produces at most one mint per cooldown window,
 * not twenty.
 */
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { remintGatewayTokenOnce } from "@/lib/local-mode";
import { getSelfHostedActorToken } from "@/lib/self-hosted/connection";
import {
  clearSelfHostMode,
  isSelfHostMode,
} from "@/lib/self-hosted/cue-self-host";

/**
 * Header that marks a request already retried with a freshly minted gateway
 * token, so a second 401 (the new token is genuinely unauthorized, not just
 * stale) falls through instead of looping.
 */
export const GATEWAY_RETRY_HEADER = "X-Cue-Gw-Retry";

/**
 * Re-mint the gateway token once and replay `request` with it.
 *
 * Returns the replayed {@link Response} when a retry actually ran — including
 * when that retry itself 401s, which callers must treat as "the credential is
 * genuinely dead", not "try again". Returns `null` when no retry was possible
 * (not in gateway-auth mode, already a retry, re-mint skipped or failed, no
 * token, or a non-idempotent method whose body the first attempt consumed) so
 * callers can fall back to the original response untouched.
 *
 * Never throws: a transport failure on the replay returns `null`.
 */
export async function retryWithRemintedGatewayToken(
  request: Request,
): Promise<Response | null> {
  if (!isGatewayAuthEnabled() || request.headers.has(GATEWAY_RETRY_HEADER)) {
    return null;
  }

  const reminted = await remintGatewayTokenOnce();
  if (!reminted) return null;

  const token = getSelfHostedActorToken();
  const isIdempotent = request.method === "GET" || request.method === "HEAD";
  if (!token || !isIdempotent) return null;

  const retried = new Request(request, {
    headers: new Headers(request.headers),
  });
  retried.headers.set("Authorization", `Bearer ${token}`);
  retried.headers.set(GATEWAY_RETRY_HEADER, "1");
  try {
    const retriedResponse = await fetch(retried);
    // A freshly re-minted token that STILL 401s is not a stale-signature race —
    // the durable actor token behind it has been revoked or the instance's
    // signing key rotated. In self-host mode nothing else can recover from
    // that: the boot path would keep re-deriving a gateway token from the dead
    // actor token, so the install is bricked on a permanent "Failed to load"
    // with no way back to the Connect screen. Clearing sends the user somewhere
    // they can act (paste a fresh magic link) instead of leaving 50-100 people
    // to be recovered by hand.
    if (retriedResponse.status === 401 && isSelfHostMode()) {
      clearSelfHostMode();
      hardNavigate("/");
    }
    return retriedResponse;
  } catch {
    return null;
  }
}
