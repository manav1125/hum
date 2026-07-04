/**
 * Module-level state for the currently-resolved self-hosted assistant
 * connection.
 *
 * The web app holds exactly one active assistant at a time
 * (`useAssistantLifecycle` is global, `assistantId` is `string | null`),
 * so a single module-level connection slot is sufficient — no per-id
 * registry, no lifecycle table. The lifecycle hook calls
 * `setSelfHostedConnection({url, token})` when an assistant resolves to
 * `{ kind: "self_hosted" }`, and `setSelfHostedConnection(null)` when it
 * leaves that state (or transitions to `active`).
 *
 * The HeyAPI request interceptor reads the two slots independently:
 *   - `getSelfHostedIngressUrl()` to decide whether to rewrite a
 *     runtime-proxied `/v1/assistants/.../...` URL to the gateway.
 *   - `getSelfHostedActorToken()` to decide whether to attach an
 *     `Authorization: Bearer` header to the rewritten request.
 *
 * Both slots are null by default — the interceptor is a no-op until the
 * lifecycle hook primes them, and every request flows to the platform
 * as before.
 *
 * Token freshness — gateway-auth (local / Cue self-host) mode:
 * In gateway-auth mode the token slot is primed from a one-time snapshot
 * of `getGatewayToken()` taken when `applyGatewayAuthShortCircuit()` runs.
 * The gateway token is short-lived and rotates (it is re-minted by
 * `ensureGatewayToken()` on resume / `refreshSession()` and read straight
 * from localStorage), so a frozen snapshot goes stale the moment the token
 * expires — every subsequent runtime-proxy request (including the
 * long-lived events SSE) would then carry a missing or stale
 * `Authorization` header and the gateway 401s, surfacing as an
 * intermittent logout. To avoid that, `getSelfHostedActorToken()` reads
 * the *live* gateway token in gateway-auth mode and only falls back to the
 * snapshot for the platform-managed self-hosted path (where the slot holds
 * the platform actor token, which has no live source here).
 */
import {
  getGatewayToken,
  isGatewayAuthEnabled,
} from "@/lib/auth/gateway-session";

interface SelfHostedConnection {
  /**
   * The user's gateway hostname for this assistant (from
   * `AssistantSerializer.ingress_url`). May be null briefly between
   * `is_local=true` flipping and the gateway registering its public
   * hostname — runtime calls fall through to the platform's proxy view
   * in that window.
   */
  url: string | null;
  /**
   * The platform's actor token for this assistant (from
   * `AssistantSerializer.platform_actor_token`). May be null briefly
   * after hatch while `bootstrap_platform_actor_token` runs — the
   * interceptor sends the request without `Authorization` in that
   * window and the gateway responds 401, which the chat surface
   * renders as an error state.
   */
  token: string | null;
}

let current: SelfHostedConnection = { url: null, token: null };

export function setSelfHostedConnection(
  connection: SelfHostedConnection | null,
): void {
  current =
    connection === null
      ? { url: null, token: null }
      : { url: connection.url, token: connection.token };
}

export function getSelfHostedIngressUrl(): string | null {
  return current.url;
}

export function getSelfHostedActorToken(): string | null {
  // Gateway-auth mode (local / Cue self-host): the slot's token is a stale
  // one-time snapshot; read the live, auto-refreshing gateway token so a
  // rotated/expired token never strands runtime-proxy + SSE requests with a
  // missing `Authorization` header (which the gateway 401s → logout). The
  // snapshot remains the source for the platform-managed self-hosted path.
  // `isGatewayAuthEnabled()` (not `isGatewayAuthMode()`) is the guard: the
  // latter additionally requires a currently-valid token, which would flip
  // to false in the exact expiry window this is meant to cover and fall back
  // to the stale snapshot. Gating on "enabled" keeps the live token as the
  // source across rotation; the snapshot is the fallback only before the
  // first mint lands.
  if (isGatewayAuthEnabled()) {
    return getGatewayToken() ?? current.token;
  }
  return current.token;
}
