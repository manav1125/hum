/**
 * Host proxy message router and daemon connection lifecycle.
 *
 * Listens for lockfile changes and maintains an SSE + poster pair for each
 * assistant. Local assistants (with a gatewayPort) connect to the loopback
 * gateway; cloud/managed assistants connect to the platform via
 * assistant-scoped URLs with session-token auth.
 *
 * A THIRD source has no lockfile entry at all: the self-hosted instance this
 * install is pointed at (`selfHostUrl`). It is reconciled on a timer rather
 * than from the lockfile — see `reconcileSelfHostConnection`. Without it every
 * desktop capability is dead for self-host owners: the daemon never sees a
 * `macos` client, so `host_bash`/`host_cu`/Desktop control have no target and
 * Cue Live's routes reach nothing.
 *
 * Incoming SSE messages are dispatched to pluggable executors; unimplemented
 * executors post error results so daemon requests don't hang.
 */

import {
  getGuardianAccessToken,
  resolveConfigDir,
  type CliInvocation,
} from "@vellumai/local-mode";
import type { Lockfile } from "@vellumai/local-mode/contract";

import { HostProxySseClient, type HostProxySseMessage } from "./host-proxy-sse";
import { HostProxyPoster } from "./host-proxy-poster";
import { hostBashExecutor } from "./executors/host-bash-executor";
import { hostFileExecutor } from "./executors/host-file-executor";
import { hostTransferExecutor } from "./executors/host-transfer-executor";
import { onLockfileChange, getWatchedLockfile } from "./lockfile-watcher";
import { HostBrowserExecutor } from "./executors/host-browser-executor";
import { hostCuExecutor } from "./executors/host-cu-executor";
import { hostAppControlExecutor } from "./executors/host-app-control-executor";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";
import { getSessionToken } from "./session-token-store";
import { resolveSelfHostUrl } from "./app-config";
import {
  getCachedSelfHostActorToken,
  refreshSelfHostActorToken,
} from "./self-host-token";
import log from "./logger";

// ---------------------------------------------------------------------------
// Executor interface
// ---------------------------------------------------------------------------

export interface HostProxyExecutor {
  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void;
  handleCancel(message: HostProxySseMessage, poster: HostProxyPoster): void;
}

// ---------------------------------------------------------------------------
// Connection entry
// ---------------------------------------------------------------------------

interface AssistantConnection {
  sse: HostProxySseClient;
  poster: HostProxyPoster;
  /** Opaque string for detecting config changes that warrant a reconnect. */
  fingerprint: string;
  /**
   * How main-process features (Cue Live) reach this assistant's routes
   * directly. Carried here rather than re-parsed out of `fingerprint`, whose
   * cloud form embeds a URL and is therefore ambiguous to split.
   */
  target:
    | { kind: "local"; assistantId: string; gatewayPort: number }
    | {
        kind: "cloud";
        assistantId: string;
        baseUrl: string;
        organizationId?: string;
      }
    | { kind: "selfhost"; assistantId: string; baseUrl: string };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const connections = new Map<string, AssistantConnection>();
const executors = new Map<string, HostProxyExecutor>();

// Injected by installHostProxyBridge; kept at module scope so the
// lockfile-change listener (which cannot be async) can reference it.
let resolveCliInvocation: (() => Promise<CliInvocation>) | null = null;

// ---------------------------------------------------------------------------
// Executor registry
// ---------------------------------------------------------------------------

export function setExecutor(kind: string, executor: HostProxyExecutor): void {
  executors.set(kind, executor);
}

export function removeExecutor(kind: string): void {
  executors.delete(kind);
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

const EXECUTOR_KINDS = [
  "host_bash",
  "host_file",
  "host_transfer",
  "host_browser",
  "host_cu",
  "host_app_control",
] as const;

/** Route type → executor kind. Returns null for unknown types. */
function executorKindForType(
  type: string,
): { kind: string; action: "request" | "cancel" } | null {
  for (const kind of EXECUTOR_KINDS) {
    if (type === `${kind}_request`) return { kind, action: "request" };
    if (type === `${kind}_cancel`) return { kind, action: "cancel" };
  }
  return null;
}

function dispatchMessage(
  message: HostProxySseMessage,
  poster: HostProxyPoster,
): void {
  const { type } = message;
  const route = executorKindForType(type);
  if (!route) {
    // The events stream is the assistant's whole event feed, not a host-proxy
    // channel: `assistant_thinking_delta`, `tool_use_start`, `usage_progress`
    // and friends all arrive here and are simply none of our business. Warning
    // on those buries the log under every conversation. A `host_*` message we
    // cannot route IS a real defect, so that one still warns.
    if (type.startsWith("host_")) {
      log.warn("[host-proxy-router] unroutable host message, ignoring", {
        type,
      });
    }
    return;
  }

  const executor = executors.get(route.kind);

  if (executor) {
    if (route.action === "request") {
      executor.handleRequest(message, poster);
    } else {
      executor.handleCancel(message, poster);
    }
    return;
  }

  // No executor registered — post an error result so the daemon doesn't hang.
  const requestId = message.requestId as string | undefined;
  if (!requestId) {
    log.warn(
      "[host-proxy-router] message missing requestId, cannot post stub error",
      { type },
    );
    return;
  }

  log.warn("[host-proxy-router] executor not yet implemented", { type });

  switch (route.kind) {
    case "host_bash":
      void poster.postBashResult({
        requestId,
        stdout: "",
        stderr: "Executor not yet implemented",
        exitCode: 1,
        timedOut: false,
      });
      break;
    case "host_file":
      void poster.postFileResult({
        requestId,
        content: "Executor not yet implemented",
        isError: true,
      });
      break;
    case "host_transfer":
      void poster.postTransferResult({
        requestId,
        isError: true,
        errorMessage: "Executor not yet implemented",
      });
      break;
    case "host_browser":
      void poster.postBrowserResult({
        requestId,
        content: "Executor not yet implemented",
        isError: true,
      });
      break;
    case "host_cu":
      void poster.postCuResult({
        requestId,
        executionError: "Executor not yet implemented",
      });
      break;
    case "host_app_control":
      void poster.postAppControlResult({
        requestId,
        state: "missing",
        executionError: "Executor not yet implemented",
      });
      break;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle — connect / disconnect per assistant
// ---------------------------------------------------------------------------

/**
 * Exchange a guardian access token for a gateway JWT via POST /auth/token.
 */
async function exchangeForGatewayToken(
  gatewayPort: number,
  guardianToken: string,
): Promise<{ token: string; expiresAt: number } | null> {
  try {
    const url = `http://127.0.0.1:${gatewayPort}/auth/token`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guardianToken}`,
        Origin: `http://127.0.0.1:${gatewayPort}`,
      },
    });
    if (!res.ok) {
      log.warn("[host-proxy-router] gateway token exchange failed", {
        status: res.status,
      });
      return null;
    }
    const body = (await res.json()) as { token: string; expiresAt: number };
    return body;
  } catch (err) {
    log.warn("[host-proxy-router] gateway token exchange error", { err });
    return null;
  }
}

async function acquireGatewayToken(
  assistantId: string,
  gatewayPort: number,
): Promise<string | null> {
  if (!resolveCliInvocation) return null;

  const configDir = resolveConfigDir(process.env);

  let invocation: CliInvocation;
  try {
    invocation = await resolveCliInvocation();
  } catch (err) {
    log.error("[host-proxy-router] failed to resolve CLI invocation", {
      assistantId,
      err,
    });
    return null;
  }

  const tokenResult = await getGuardianAccessToken(
    assistantId,
    configDir,
    invocation,
    true,
  );

  if (!tokenResult.ok) {
    log.warn("[host-proxy-router] failed to obtain guardian token", {
      assistantId,
      error: tokenResult.error,
    });
    return null;
  }

  const exchanged = await exchangeForGatewayToken(
    gatewayPort,
    tokenResult.accessToken,
  );
  if (!exchanged) return null;

  return exchanged.token;
}

// A connection's fingerprint encodes everything that, if changed, requires a
// reconnect. Single-sourced here so the value set on connect and the value
// recomputed in `handleLockfileChange` can never drift (a mismatch would loop
// connect/disconnect forever).
const localFingerprint = (gatewayPort: number): string =>
  `local:${gatewayPort}`;
const cloudFingerprint = (
  runtimeUrl: string,
  organizationId?: string,
): string => `cloud:${runtimeUrl}:${organizationId ?? ""}`;
const selfHostFingerprint = (baseUrl: string): string => `selfhost:${baseUrl}`;

/**
 * Connections map key for the self-host instance. It is NOT an assistant id
 * from the lockfile, so it deliberately cannot collide with one — and the
 * lockfile prune step skips it (see `handleLockfileChange`).
 */
const SELF_HOST_CONNECTION_KEY = "self-host";
/** Every self-host route is assistant-scoped to the literal `self`. */
const SELF_HOST_ASSISTANT_ID = "self";

// ---------------------------------------------------------------------------
// Authenticated daemon requests (for main-process features like Cue Live)
// ---------------------------------------------------------------------------

let cachedGatewayToken: {
  key: string;
  token: string;
  fetchedAt: number;
} | null = null;
const GATEWAY_TOKEN_TTL_MS = 4 * 60 * 1000;

async function getCachedGatewayToken(
  assistantId: string,
  gatewayPort: number,
  forceFresh = false,
): Promise<string | null> {
  const key = `${assistantId}:${gatewayPort}`;
  if (
    !forceFresh &&
    cachedGatewayToken &&
    cachedGatewayToken.key === key &&
    Date.now() - cachedGatewayToken.fetchedAt < GATEWAY_TOKEN_TTL_MS
  ) {
    return cachedGatewayToken.token;
  }
  const token = await acquireGatewayToken(assistantId, gatewayPort);
  cachedGatewayToken = token ? { key, token, fetchedAt: Date.now() } : null;
  return token;
}

/** The connected local assistant, if any. */
function activeLocalConnection(): Extract<
  AssistantConnection["target"],
  { kind: "local" }
> | null {
  for (const conn of connections.values()) {
    if (conn.target.kind === "local") return conn.target;
  }
  return null;
}

/** The connected cloud assistant, if any. */
function activeCloudConnection(): Extract<
  AssistantConnection["target"],
  { kind: "cloud" }
> | null {
  for (const conn of connections.values()) {
    if (conn.target.kind === "cloud") return conn.target;
  }
  return null;
}

/** The connected self-hosted instance, if any. */
function activeSelfHostConnection(): Extract<
  AssistantConnection["target"],
  { kind: "selfhost" }
> | null {
  const conn = connections.get(SELF_HOST_CONNECTION_KEY);
  return conn && conn.target.kind === "selfhost" ? conn.target : null;
}

async function readJson<T>(res: Response | null): Promise<T | null> {
  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * POST to a route on the connected LOCAL daemon, authenticated with the same
 * guardian→gateway token exchange the SSE/poster connection uses (short-lived
 * token cache + a single 401 re-mint).
 */
async function requestLocalRoute<T>(
  target: Extract<AssistantConnection["target"], { kind: "local" }>,
  routePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<T | null> {
  const url = `http://127.0.0.1:${target.gatewayPort}/v1/assistants/${encodeURIComponent(
    target.assistantId,
  )}${routePath}`;
  const origin = `http://127.0.0.1:${target.gatewayPort}`;

  const attempt = async (token: string): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  let token = await getCachedGatewayToken(
    target.assistantId,
    target.gatewayPort,
  );
  if (!token) return null;
  let res = await attempt(token);
  if (res && res.status === 401) {
    // Stale gateway token → re-mint once and retry.
    token = await getCachedGatewayToken(
      target.assistantId,
      target.gatewayPort,
      true,
    );
    if (!token) return null;
    res = await attempt(token);
  }
  return readJson<T>(res);
}

/** POST to a route on the connected CLOUD assistant, using the session token. */
async function requestCloudRoute<T>(
  target: Extract<AssistantConnection["target"], { kind: "cloud" }>,
  routePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<T | null> {
  const sessionToken = getSessionToken();
  if (!sessionToken) return null;
  const url = `${target.baseUrl}/v1/assistants/${encodeURIComponent(
    target.assistantId,
  )}${routePath}`;
  const headers: Record<string, string> = {
    "X-Session-Token": sessionToken,
    "Content-Type": "application/json",
  };
  if (target.organizationId) {
    headers["Vellum-Organization-Id"] = target.organizationId;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await readJson<T>(res);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST to a route on the connected SELF-HOST instance, using the actor token
 * the renderer's session holds (cached by `self-host-token`). One 401 retry
 * with a freshly-read token covers the case where the session rotated under us.
 */
async function requestSelfHostRoute<T>(
  target: Extract<AssistantConnection["target"], { kind: "selfhost" }>,
  routePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<T | null> {
  const url = `${target.baseUrl}/v1/assistants/${encodeURIComponent(
    target.assistantId,
  )}${routePath}`;

  const attempt = async (token: string): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  let token =
    getCachedSelfHostActorToken() ?? (await refreshSelfHostActorToken());
  if (!token) return null;
  let res = await attempt(token);
  if (res && res.status === 401) {
    token = await refreshSelfHostActorToken();
    if (!token) return null;
    res = await attempt(token);
  }
  return readJson<T>(res);
}

/**
 * POST to a route on whichever assistant this app is connected to, for
 * main-process features (Cue Live) that need a response body.
 *
 * Local is preferred when present — it is on the loopback and answers fastest.
 * Otherwise the request goes to the connected cloud assistant. Without that
 * fallback, Cue Live is dead for every cloud-only install: the summon reaches
 * no daemon, and `null` surfaces as "look returned invalid payload" with no
 * hint that the request was never sent. Returns null when nothing is connected,
 * auth fails, or the request errors — callers treat it as best-effort.
 */
/**
 * Whether any assistant (local or cloud) is reachable right now.
 *
 * Polling callers check this first: without it a background loop calls
 * {@link requestAssistantRoute} on every tick and each miss logs a warning,
 * which buries the log in noise while the app is simply idle.
 */
export function hasAssistantConnection(): boolean {
  return Boolean(
    activeLocalConnection() ??
    activeCloudConnection() ??
    activeSelfHostConnection(),
  );
}

export async function requestAssistantRoute<T = unknown>(
  routePath: string,
  body: unknown,
  timeoutMs = 9_000,
): Promise<T | null> {
  const local = activeLocalConnection();
  if (local) return requestLocalRoute<T>(local, routePath, body, timeoutMs);
  const cloud = activeCloudConnection();
  if (cloud) return requestCloudRoute<T>(cloud, routePath, body, timeoutMs);
  const selfHost = activeSelfHostConnection();
  if (selfHost) {
    return requestSelfHostRoute<T>(selfHost, routePath, body, timeoutMs);
  }
  log.warn("[host-proxy-router] no assistant connected — cannot reach route", {
    routePath,
  });
  return null;
}

// -- Local assistant connection ---------------------------------------------

async function connectLocalAssistant(
  assistantId: string,
  gatewayPort: number,
): Promise<void> {
  if (connections.has(assistantId)) return;

  const gatewayToken = await acquireGatewayToken(assistantId, gatewayPort);
  if (!gatewayToken) {
    log.warn(
      "[host-proxy-router] could not acquire gateway token, skipping connection",
      { assistantId },
    );
    return;
  }

  let currentToken = gatewayToken;
  const authHeaders = () => ({ Authorization: `Bearer ${currentToken}` });

  const onRefreshToken = async (): Promise<string | null> => {
    const fresh = await acquireGatewayToken(assistantId, gatewayPort);
    if (fresh) currentToken = fresh;
    return fresh;
  };

  const eventsUrl = `http://127.0.0.1:${gatewayPort}/v1/events`;
  const endpointBase = `http://127.0.0.1:${gatewayPort}/v1`;

  const sse = new HostProxySseClient({
    eventsUrl,
    authHeaders,
    onRefreshToken,
  });
  const poster = new HostProxyPoster({ endpointBase, authHeaders });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));
  sse.connect();

  connections.set(assistantId, {
    sse,
    poster,
    fingerprint: localFingerprint(gatewayPort),
    target: { kind: "local", assistantId, gatewayPort },
  });
  log.info("[host-proxy-router] connected to local assistant", {
    assistantId,
    gatewayPort,
  });
}

// -- Cloud assistant connection ---------------------------------------------

function connectCloudAssistant(
  assistantId: string,
  runtimeUrl: string,
  organizationId?: string,
): void {
  if (connections.has(assistantId)) return;

  const sessionToken = getSessionToken();
  if (!sessionToken) {
    log.warn(
      "[host-proxy-router] no session token, skipping cloud connection",
      { assistantId },
    );
    return;
  }

  const baseUrl = runtimeUrl.replace(/\/$/, "");

  const authHeaders = (): Record<string, string> => {
    const token = getSessionToken();
    if (!token) return {};
    const headers: Record<string, string> = { "X-Session-Token": token };
    if (organizationId) headers["Vellum-Organization-Id"] = organizationId;
    return headers;
  };

  const eventsUrl = `${baseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/events`;
  const endpointBase = `${baseUrl}/v1/assistants/${encodeURIComponent(assistantId)}`;

  const sse = new HostProxySseClient({ eventsUrl, authHeaders });
  const poster = new HostProxyPoster({ endpointBase, authHeaders });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));
  sse.connect();

  connections.set(assistantId, {
    sse,
    poster,
    fingerprint: cloudFingerprint(runtimeUrl, organizationId),
    target: { kind: "cloud", assistantId, baseUrl, organizationId },
  });
  log.info("[host-proxy-router] connected to cloud assistant", {
    assistantId,
    runtimeUrl,
    organizationId,
  });
}

// -- Self-host instance connection ------------------------------------------

/**
 * The instance origin this install is pointed at, or null when it isn't
 * connected to one. `resolveSelfHostUrl` returns the SPA URL
 * (`https://<instance>/assistant/`); the API lives at the origin.
 */
function selfHostBaseUrl(): string | null {
  const url = resolveSelfHostUrl();
  return url ? url.origin : null;
}

/**
 * Register this Mac as a host-proxy client of the self-hosted instance.
 *
 * The SSE client already sends `X-Vellum-Client-Id` / `X-Vellum-Interface-Id:
 * macos` / `X-Vellum-Machine-Name`, which is what makes the daemon record the
 * connection as a `macos` client with the five host-proxy capabilities. The
 * `actorPrincipalId` that host targeting fails closed on is NOT sent from
 * here — the daemon derives it from the bearer token's auth context, so the
 * Mac lands under the same principal as the owner's other requests and shows
 * up in `organizer/session` targets.
 */
function connectSelfHostAssistant(baseUrl: string): void {
  if (connections.has(SELF_HOST_CONNECTION_KEY)) return;

  const authHeaders = (): Record<string, string> => {
    const token = getCachedSelfHostActorToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const eventsUrl = `${baseUrl}/v1/assistants/${SELF_HOST_ASSISTANT_ID}/events`;
  const endpointBase = `${baseUrl}/v1/assistants/${SELF_HOST_ASSISTANT_ID}`;

  const sse = new HostProxySseClient({
    eventsUrl,
    authHeaders,
    // Re-read the renderer's session before each reconnect: the actor token
    // can be re-seeded (new connect link) while the app runs.
    onRefreshToken: () => refreshSelfHostActorToken(),
  });
  const poster = new HostProxyPoster({ endpointBase, authHeaders });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));
  sse.connect();

  connections.set(SELF_HOST_CONNECTION_KEY, {
    sse,
    poster,
    fingerprint: selfHostFingerprint(baseUrl),
    target: {
      kind: "selfhost",
      assistantId: SELF_HOST_ASSISTANT_ID,
      baseUrl,
    },
  });
  log.info("[host-proxy-router] connected to self-host instance", { baseUrl });
}

/**
 * Bring the self-host connection in line with the app's current state:
 * connected to the instance it is pointed at, disconnected when it isn't, and
 * reconnected when the instance changes.
 *
 * Runs on a timer because neither of its two inputs is observable: the
 * instance is a persisted setting, and the token lives in the renderer's
 * localStorage, which is only readable once a window has loaded. It does NOT
 * spin against an unreachable instance — once a connection exists this is a
 * no-op and `HostProxySseClient` owns the (backing-off) retry.
 */
let loggedMissingSelfHostToken = false;

async function reconcileSelfHostConnection(): Promise<void> {
  const baseUrl = selfHostBaseUrl();
  const existing = connections.get(SELF_HOST_CONNECTION_KEY);

  if (!baseUrl) {
    if (existing) disconnectAssistant(SELF_HOST_CONNECTION_KEY);
    return;
  }

  const fingerprint = selfHostFingerprint(baseUrl);
  if (existing && existing.fingerprint !== fingerprint) {
    log.info("[host-proxy-router] self-host instance changed, reconnecting", {
      oldFingerprint: existing.fingerprint,
      newFingerprint: fingerprint,
    });
    disconnectAssistant(SELF_HOST_CONNECTION_KEY);
  } else if (existing) {
    return;
  }

  // Only connect once the session actually has a token: a connection with no
  // Authorization header would 401-loop and, worse, register nothing while
  // making the app look connected.
  const token = await refreshSelfHostActorToken();
  if (!token) {
    if (!loggedMissingSelfHostToken) {
      loggedMissingSelfHostToken = true;
      log.info(
        "[host-proxy-router] self-host instance set but no session token yet — waiting",
      );
    }
    return;
  }
  loggedMissingSelfHostToken = false;

  connectSelfHostAssistant(baseUrl);
}

// -- Disconnect -------------------------------------------------------------

function disconnectAssistant(assistantId: string): void {
  const conn = connections.get(assistantId);
  if (!conn) return;
  conn.sse.disconnect();
  connections.delete(assistantId);
  log.info("[host-proxy-router] disconnected from assistant", { assistantId });
}

// ---------------------------------------------------------------------------
// Lockfile change handler
// ---------------------------------------------------------------------------

function handleLockfileChange(lockfile: Lockfile): void {
  const activeIds = new Set<string>();

  for (const assistant of lockfile.assistants) {
    const port = assistant.resources?.gatewayPort;
    const isCloud =
      !port && assistant.cloud === "vellum" && assistant.runtimeUrl;
    if (!port && !isCloud) continue;

    activeIds.add(assistant.assistantId);
    const fp = port
      ? localFingerprint(port)
      : cloudFingerprint(assistant.runtimeUrl!, assistant.organizationId);

    const existing = connections.get(assistant.assistantId);
    if (existing && existing.fingerprint !== fp) {
      log.info("[host-proxy-router] connection config changed, reconnecting", {
        assistantId: assistant.assistantId,
        oldFingerprint: existing.fingerprint,
        newFingerprint: fp,
      });
      disconnectAssistant(assistant.assistantId);
    }
    if (!connections.has(assistant.assistantId)) {
      if (port) {
        void connectLocalAssistant(assistant.assistantId, port);
      } else {
        connectCloudAssistant(
          assistant.assistantId,
          assistant.runtimeUrl!,
          assistant.organizationId,
        );
      }
    }
  }

  // Disconnect assistants that are no longer in the lockfile. The self-host
  // connection is never in the lockfile — it is reconciled separately — so
  // pruning it here would tear it down on every lockfile event.
  for (const assistantId of connections.keys()) {
    if (assistantId === SELF_HOST_CONNECTION_KEY) continue;
    if (!activeIds.has(assistantId)) {
      disconnectAssistant(assistantId);
    }
  }
}

// ---------------------------------------------------------------------------
// Public install / teardown
// ---------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null;
let selfHostTimer: ReturnType<typeof setInterval> | null = null;

/**
 * How often the self-host connection is reconciled. Short enough that the Mac
 * registers within seconds of the renderer finishing its first load (that is
 * when the token becomes readable), long enough to be free.
 */
const SELF_HOST_RECONCILE_INTERVAL_MS = 5_000;

/**
 * Wire the host proxy bridge into the app lifecycle. Call once from
 * `app.whenReady()` after `installLockfileWatcher()`. Returns a teardown
 * function for `before-quit`.
 */
export function installHostProxyBridge(
  cliResolver: () => Promise<CliInvocation>,
): () => void {
  resolveCliInvocation = cliResolver;
  setExecutor("host_bash", hostBashExecutor);
  setExecutor("host_file", hostFileExecutor);
  setExecutor("host_transfer", hostTransferExecutor);
  // Computer-use + app-control run through the shared, signed mac-helper (same
  // binary as Cue Live → inherits its Accessibility + Screen-Recording grants).
  setExecutor("host_cu", hostCuExecutor);
  setExecutor("host_app_control", hostAppControlExecutor);
  unsubscribe = onLockfileChange(handleLockfileChange);

  // Seed from any assistants already present in the lockfile
  const currentLockfile = getWatchedLockfile();
  if (currentLockfile.assistants.length > 0) {
    handleLockfileChange(currentLockfile);
  }

  // Register built-in executors
  const browserExecutor = new HostBrowserExecutor();
  setExecutor("host_browser", browserExecutor);

  // The self-hosted instance has no lockfile entry, so it gets its own
  // reconcile loop. Without it a self-host install never registers a `macos`
  // client and every desktop capability has no target.
  void reconcileSelfHostConnection();
  selfHostTimer = setInterval(() => {
    void reconcileSelfHostConnection();
  }, SELF_HOST_RECONCILE_INTERVAL_MS);
  selfHostTimer.unref?.();

  return () => {
    unsubscribe?.();
    unsubscribe = null;
    if (selfHostTimer) {
      clearInterval(selfHostTimer);
      selfHostTimer = null;
    }
    for (const assistantId of [...connections.keys()]) {
      disconnectAssistant(assistantId);
    }
    browserExecutor.destroy();
    removeExecutor("host_browser");
    removeExecutor("host_cu");
    removeExecutor("host_app_control");
    shutdownSharedCuHelper();
    resolveCliInvocation = null;
  };
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __testing = {
  get connections() {
    return connections;
  },
  get executors() {
    return executors;
  },
  dispatchMessage,
  connectLocalAssistant,
  connectCloudAssistant,
  connectSelfHostAssistant,
  reconcileSelfHostConnection,
  disconnectAssistant,
  handleLockfileChange,
  SELF_HOST_CONNECTION_KEY,
  reset() {
    for (const assistantId of [...connections.keys()]) {
      disconnectAssistant(assistantId);
    }
    executors.clear();
    resolveCliInvocation = null;
    loggedMissingSelfHostToken = false;
    unsubscribe?.();
    unsubscribe = null;
    if (selfHostTimer) {
      clearInterval(selfHostTimer);
      selfHostTimer = null;
    }
  },
};
