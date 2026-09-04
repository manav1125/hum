/**
 * Gateway proxy for the Cue Design tool bridge (sidecar → Cue, reverse hop).
 *
 * The Cue Design sidecar's headless studio agent (opencode) can call a curated,
 * READ-ONLY allowlist of Cue tools during a design build — starting with web
 * research so it can gather live material. The agent runs a small `cue-bridge`
 * CLI shim that POSTs to `https://<cue-internal>/design/tools/<name>` with a
 * `Bearer` header; the gateway authenticates that hop and forwards it to the
 * assistant daemon's `design-bridge` route over IPC.
 *
 * Security model (fail-closed, default-off):
 *
 * - **Off by default.** When `DESIGN_BRIDGE_TOKEN` is unset this handler is a
 *   no-op (404) — no behaviour changes and the route is inert. Enabling the
 *   bridge is a deliberate act (a Fly secret on both apps, mirroring
 *   `OPENROUTER_API_KEY`).
 * - **Authenticated every call.** The sidecar reaches the gateway only over the
 *   private 6PN network, and additionally must present
 *   `Authorization: Bearer <DESIGN_BRIDGE_TOKEN>`, validated here with a
 *   constant-time compare.
 * - **The allowlist IS the boundary.** Only the literal tool names in
 *   {@link ALLOWED_TOOLS} are accepted; everything else is 404. The gateway
 *   forwards the same Bearer to the daemon, which re-checks it and runs the
 *   read-only executor (reusing Cue's SSRF guard / search provider). No
 *   memory / email / connectors / filesystem / terminal / schedule is reachable.
 *
 * Unlike `design-proxy.ts` (which proxies the whole design ORIGIN to the
 * sidecar), this route calls the local assistant DAEMON over IPC — the same
 * `ipcCallAssistant` mechanism the IPC runtime proxy uses.
 */

import { timingSafeEqual } from "node:crypto";

import {
  IpcHandlerError,
  IpcTransportError,
  ipcCallAssistant,
} from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";

const log = getLogger("design-tools-proxy");

/**
 * The hard-coded allowlist: tool name → daemon route operationId. This is the
 * whole security surface — a name not present here is rejected before any
 * daemon call. Keep it read-only; never add a side-effectful tool.
 */
const ALLOWED_TOOLS: Record<string, string> = {
  web_search: "designBridgeWebSearch",
  web_fetch: "designBridgeWebFetch",
};

/** Max request-body bytes accepted from the sidecar agent (defensive cap). */
const MAX_BODY_BYTES = 8 * 1024;

/** Per-request cap on the whole daemon round-trip. */
const REQUEST_TIMEOUT_MS = 25_000;

function designBridgeToken(): string | undefined {
  const raw = process.env.DESIGN_BRIDGE_TOKEN?.trim();
  return raw ? raw : undefined;
}

/** Constant-time comparison that never short-circuits on length. */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function isAuthorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);
  return presented.length > 0 && constantTimeEquals(presented, token);
}

/** `true` when the bridge is enabled (a token is configured). */
export function isDesignToolsBridgeConfigured(): boolean {
  return designBridgeToken() !== undefined;
}

/**
 * Handle `POST /design/tools/:name`.
 *
 * Returns 404 when the bridge is off or the tool is not allowlisted, 401 on a
 * bad/absent token, 400 on a malformed body, and otherwise relays the daemon's
 * JSON result (or its error status).
 */
export async function handleDesignTool(
  req: Request,
  toolName: string,
): Promise<Response> {
  const token = designBridgeToken();
  if (!token) {
    // Feature off — indistinguishable from "no such route".
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!isAuthorized(req, token)) {
    log.warn({ toolName }, "Design tools bridge: unauthorized request");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const operationId = ALLOWED_TOOLS[toolName];
  if (!operationId) {
    log.warn({ toolName }, "Design tools bridge: tool not in allowlist");
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Read the body with a hard size cap before parsing.
  let bodyText: string;
  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    bodyText = new TextDecoder().decode(raw);
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json(
          { error: "Invalid request body" },
          { status: 400 },
        );
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const start = performance.now();
  try {
    // Forward the same Bearer so the daemon route re-validates it (uniform
    // gate across the gateway→daemon hop).
    const result = await withTimeout(
      ipcCallAssistant(operationId, {
        body,
        headers: { authorization: `Bearer ${token}` },
      }),
      REQUEST_TIMEOUT_MS,
    );

    log.info(
      {
        toolName,
        operationId,
        duration: Math.round(performance.now() - start),
      },
      "Design tools bridge request completed",
    );

    if (result === undefined || result === null) {
      return new Response(null, { status: 204 });
    }
    return Response.json(result);
  } catch (err) {
    const duration = Math.round(performance.now() - start);

    if (err instanceof IpcHandlerError) {
      log.warn(
        { toolName, statusCode: err.statusCode, errorCode: err.code, duration },
        "Design tools bridge handler error",
      );
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }

    if (err instanceof IpcTransportError || err instanceof TimeoutError) {
      log.error(
        { err, toolName, duration },
        "Design tools bridge transport error",
      );
      return Response.json(
        { error: "Design bridge unavailable" },
        {
          status: 502,
        },
      );
    }

    log.error(
      { err, toolName, duration },
      "Design tools bridge unexpected error",
    );
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

class TimeoutError extends Error {
  constructor() {
    super("Design bridge request timed out");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
