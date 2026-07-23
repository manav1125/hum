/**
 * Gateway pairing client for the Cue browser relay.
 *
 * The extension acquires the short-lived edge token it uses as `Authorization:
 * Bearer` on the SSE `/v1/events` stream and the host-browser callback POSTs by
 * pairing with the target Cue gateway. There are two pairing paths, chosen by
 * whether the gateway is on loopback or is a remote self-hosted instance:
 *
 *   - **Loopback** (`http://127.0.0.1:7830`, the desktop-app gateway):
 *     `POST /v1/pair`. Zero-auth, but the gateway guards it with
 *     `enforceLoopbackOnly` (peer IP + Host markers), so only a process on the
 *     same machine can reach it. Unchanged from the original single-mode build.
 *
 *   - **Remote** (`https://<name>.justcue.app`, a self-hosted instance reached
 *     over the public edge): `POST /v1/pair/session`. Loopback-only zero-auth
 *     would be a token-minting oracle if exposed publicly, so this path instead
 *     requires the caller to PROVE it holds the instance owner's live signed-in
 *     session by presenting the SAME `actor_client_v1` edge token the web SPA
 *     holds, as `Authorization: Bearer`. The gateway (`pair-session.ts`)
 *     validates that token (non-expired, non-revoked, `scope_profile ===
 *     actor_client_v1`, principal === the instance's bound guardian) plus the
 *     `X-Vellum-Interface-Id: chrome-extension` header and a known extension
 *     Origin, then mints a NARROW `chrome_extension_v1` token (chat.read +
 *     approval.write, 24h). We only ever send that session token to the user's
 *     OWN instance, over HTTPS, and never persist or log it.
 *
 * Both paths return the same response shape (`{ token, expiresAt?, guardianId?,
 * assistantId? }`); only `token` is load-bearing for the relay.
 *
 * The `x-vellum-interface-id` header and the `/v1/pair[/session]` paths are
 * protocol/contract identifiers shared with the gateway — they stay `vellum`
 * per the Cue rebrand boundary.
 */

/** Zero-auth loopback pairing endpoint (desktop-app gateway). */
export const LOOPBACK_PAIR_PATH = "/v1/pair";

/** Session-authenticated remote pairing endpoint (self-hosted instance). */
export const SESSION_PAIR_PATH = "/v1/pair/session";

/** Shared response shape of both pairing endpoints. */
export interface PairResult {
  /** The minted edge token — Bearer for the SSE stream + callback POSTs. */
  token: string;
  expiresAt?: string;
  guardianId?: string;
  assistantId?: string;
}

/** A pairing HTTP request failed. `status` is the gateway's HTTP status, if any. */
export class PairError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PairError";
    this.status = status;
  }
}

/**
 * Is this gateway URL a loopback (same-machine) address? Loopback gateways use
 * the zero-auth `/v1/pair` path; everything else is treated as a remote
 * instance that must be paired via the session-authenticated path.
 */
export function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "[::1]" ||
      h.startsWith("127.") ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/** A JWT is three dot-separated base64url segments. Cheap shape check only. */
export function looksLikeJwt(value: string | null | undefined): value is string {
  return typeof value === "string" && value.split(".").length === 3;
}

function normalizePairResult(body: unknown): PairResult {
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).token !== "string"
  ) {
    throw new PairError("pair response did not include a token");
  }
  const b = body as Record<string, unknown>;
  const out: PairResult = { token: b.token as string };
  if (typeof b.expiresAt === "string") out.expiresAt = b.expiresAt;
  if (typeof b.guardianId === "string") out.guardianId = b.guardianId;
  if (typeof b.assistantId === "string") out.assistantId = b.assistantId;
  return out;
}

/**
 * Pair with a loopback gateway via the zero-auth `POST /v1/pair` path. Throws
 * {@link PairError} on a non-2xx response or a missing token.
 */
export async function requestLoopbackPairToken(
  gatewayUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<PairResult> {
  const url = `${gatewayUrl.replace(/\/$/, "")}${LOOPBACK_PAIR_PATH}`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vellum-interface-id": "chrome-extension",
      },
      credentials: "omit",
    });
  } catch (err) {
    throw new PairError(
      `pair request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!resp.ok) {
    throw new PairError(`pair failed (${resp.status})`, resp.status);
  }
  return normalizePairResult(await resp.json());
}

/**
 * Pair with a REMOTE self-hosted instance via `POST /v1/pair/session`, proving
 * ownership with the user's signed-in `actor_client_v1` session token.
 *
 * SECURITY: the session token is high-value (a ~30-day owner credential). It is
 * sent ONLY to the user's own instance and ONLY over HTTPS — this function
 * refuses any non-`https:` instance URL so a downgraded/rewritten origin can
 * never receive it. The caller must never log the token or persist it; only the
 * minted narrow token in the returned {@link PairResult} is retained.
 *
 * Chrome sets the `Origin: chrome-extension://<id>` header automatically on this
 * service-worker fetch; the gateway checks it against its extension allowlist.
 * Throws {@link PairError} on a non-2xx response or a missing token.
 */
export async function requestSessionPairToken(
  instanceUrl: string,
  sessionToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<PairResult> {
  let parsed: URL;
  try {
    parsed = new URL(instanceUrl);
  } catch {
    throw new PairError(`invalid instance URL: ${instanceUrl}`);
  }
  // Never transmit the session token over a plaintext channel.
  if (parsed.protocol !== "https:") {
    throw new PairError(
      "remote pairing requires an https instance URL; refusing to send the session token over http",
    );
  }
  if (!looksLikeJwt(sessionToken)) {
    throw new PairError("session token is not a well-formed JWT");
  }

  const url = `${instanceUrl.replace(/\/$/, "")}${SESSION_PAIR_PATH}`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vellum-interface-id": "chrome-extension",
        authorization: `Bearer ${sessionToken}`,
      },
      credentials: "omit",
    });
  } catch (err) {
    throw new PairError(
      `pair/session request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!resp.ok) {
    throw new PairError(`pair/session failed (${resp.status})`, resp.status);
  }
  return normalizePairResult(await resp.json());
}
