/**
 * Direct route calls to a self-host assistant, for main-process features
 * (Cue Live) that need a response body.
 *
 * A self-host install has no local-mode lockfile, so `host-proxy-router` never
 * registers a connection for it and `requestAssistantRoute` finds nothing to
 * call. But the app is plainly talking to an assistant — the renderer is
 * loading its SPA. The session lives in the renderer (the self-host connect
 * flow stores the actor token in `localStorage`), so main borrows it from the
 * window rather than duplicating the connect flow.
 */

import { resolveSelfHostUrl } from "./app-config";
import log from "./logger";
import { current as currentMainWindow } from "./main-window";

/** Where the self-host connect flow parks the actor token. */
const ACTOR_TOKEN_KEY = "cue:selfHost:actorToken";
/**
 * The credential the renderer actually authenticates with.
 *
 * Self-host keeps two: `cue:selfHost:actorToken` is the durable ~30d one the
 * connect link seeded, and `vellum:gw:token` is the live slot the auth layer
 * rotates, re-mints on 401s, and re-derives from the durable one when it goes
 * missing. Only the second is guaranteed to have been minted by the gateway
 * that is running now.
 *
 * Main was reading the durable one, and on this owner's instance that token
 * predates a change of the gateway's signing key — so it failed
 * `invalid_signature` on every request main made, forever, while the renderer
 * sailed on with its rotated slot. Reading the live slot first is what
 * "borrow the credential from the window" was always supposed to mean.
 */
const GATEWAY_TOKEN_KEY = "vellum:gw:token";
const SELF_HOST_FLAG_KEY = "cue:selfHost";

/**
 * Read the actor token out of the renderer's localStorage. Returns null when
 * the window is gone, the renderer hasn't finished loading, or the user isn't
 * connected to a self-host instance yet.
 *
 * Exported as the token source `index.ts` hands to `self-host-token`, so the
 * host-proxy connection and these route calls borrow the same one session.
 */
export async function readActorToken(): Promise<string | null> {
  const win = currentMainWindow();
  if (!win || win.webContents.isDestroyed()) return null;
  try {
    const token = (await win.webContents.executeJavaScript(
      // Live slot first, durable one as the fallback for a session seeded
      // before that slot existed — the same preference order, and the same
      // reason, as `EXTENSION_SESSION_TOKEN_LS_KEYS` reversed: the extension
      // wants the long-lived credential to pair with, main wants the one that
      // verifies right now.
      `(() => { try {
         if (localStorage.getItem(${JSON.stringify(SELF_HOST_FLAG_KEY)}) !== "1") return null;
         return localStorage.getItem(${JSON.stringify(GATEWAY_TOKEN_KEY)})
           || localStorage.getItem(${JSON.stringify(ACTOR_TOKEN_KEY)});
       } catch { return null; } })()`,
      true,
    )) as unknown;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** POST to a self-host route, returning the raw Response (or null). */
async function postSelfHost(
  routePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response | null> {
  const base = resolveSelfHostUrl();
  if (!base) return null;
  const token = await readActorToken();
  if (!token) {
    log.warn("[self-host-request] no actor token in the renderer", {
      routePath,
    });
    return null;
  }

  const url = `${base.origin}/v1/assistants/self${routePath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[self-host-request] route call failed", {
        routePath,
        status: res.status,
      });
      return null;
    }
    return res;
  } catch (err) {
    log.warn("[self-host-request] route call errored", { routePath, err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST to a route on the self-host assistant. Returns the parsed JSON body, or
 * null when self-host is disabled, the renderer holds no token, or the request
 * fails — callers treat it as best-effort.
 */
export async function requestSelfHostRoute<T = unknown>(
  routePath: string,
  body: unknown,
  timeoutMs = 9_000,
): Promise<T | null> {
  const res = await postSelfHost(routePath, body, timeoutMs);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * POST to a route that answers with binary (the TTS routes return audio/mpeg),
 * returning it base64-encoded so it can cross the JSON-RPC pipe to the helper.
 */
export async function requestSelfHostBinary(
  routePath: string,
  body: unknown,
  timeoutMs = 15_000,
): Promise<string | null> {
  const res = await postSelfHost(routePath, body, timeoutMs);
  if (!res) return null;
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf.toString("base64") : null;
  } catch {
    return null;
  }
}
