/**
 * Chrome MV3 service worker — Cue browser relay (SSE bridge).
 *
 * Connects to a Cue gateway's SSE `/v1/events` endpoint. The extension
 * pairs with the gateway over loopback (or a user-provided gateway URL)
 * via `POST /v1/pair`, which mints a guardian-bound capability token
 * (`Authorization: Bearer <token>`) used on the SSE stream and on the
 * host-browser callback POSTs. There is NO external identity provider in
 * the shipped extension — the gateway's own pairing flow is the sole
 * auth path.
 *
 * The worker owns the full connect lifecycle:
 *   - **One-click Connect**: The popup sends `connect` and the worker
 *     pairs + opens an SSE connection using the stored gateway URL.
 *   - **Auto-connect on reopen**: After a successful connect, the
 *     `autoConnect` storage flag is set. On service-worker startup the
 *     `bootstrap()` function reads this flag and reconnects.
 *   - **Pause**: The `pause` message clears the `autoConnect` flag and
 *     tears down the connection.
 *
 * Once connected, the worker routes incoming server messages:
 *   - `host_browser_request` / `host_browser_cancel` envelopes are
 *     dispatched to the CDP proxy dispatcher, which drives a
 *     `chrome.debugger` session and POSTs a result envelope back to the
 *     gateway's `/v1/host-browser-result` endpoint.
 *   - Every other payload is logged and discarded.
 *
 * NOTE ON IDENTIFIERS: the `X-Vellum-*` headers, `x-vellum-interface-id:
 * chrome-extension`, and the `vellum.*` storage keys are protocol/contract
 * identifiers shared with the daemon+gateway. They intentionally stay
 * `vellum` per the Cue rebrand boundary — only user-facing display strings
 * are rebranded.
 */

import {
  type ExtensionEnvironment,
  cloudUrlsForEnvironment,
  parseExtensionEnvironment,
  resolveBuildDefaultEnvironment,
} from "./extension-environment.js";
import { type AssistantAuthProfile } from "./assistant-auth-profile.js";
import {
  createHostBrowserDispatcher,
  type HostBrowserDispatcher,
  type HostBrowserEventEnvelope,
  type HostBrowserRequestEnvelope,
  type HostBrowserCancelEnvelope,
  type HostBrowserResultEnvelope,
  type HostBrowserSessionInvalidatedEnvelope,
} from "./host-browser-dispatcher.js";
import { SseConnection, type SseMode } from "./sse-connection.js";
import { appendEvent, clearEventLog, getEventLog, getOperations, getOperationById, recordCallbackFailure, recordRequest, recordResponse } from "./event-log.js";
import { getClientId } from "./client-identity.js";
import {
  getStoredSession,
  clearSession,
  getSelectedAssistant,
  clearSelectedAssistant,
} from "./session-store.js";
import {
  collectDiagnosticBundle,
  submitFeedback,
  type FeedbackFormData,
} from "./feedback.js";

// ── Environment resolution ──────────────────────────────────────────
//
// The effective environment drives the toolbar icon + feedback endpoint.
// Precedence:
//   1. Popup override persisted in chrome.storage.local
//   2. Build-time default injected via `--define` at bundle time
//   3. Fallback to 'production' (see resolveBuildDefaultEnvironment)
//
// The popup can read and write the override via `environment-get` and
// `environment-set` worker messages without requiring an extension reload.

// ── Gateway URL storage ──────────────────────────────────────────────
// The gateway URL is stored in chrome.storage.local so the popup settings
// page can read/write it.
const GATEWAY_URL_STORAGE_KEY = "vellum.selfHostedGatewayUrl";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7830";

async function getStoredGatewayUrl(): Promise<string> {
  const result = await chrome.storage.local.get(GATEWAY_URL_STORAGE_KEY);
  const stored = result[GATEWAY_URL_STORAGE_KEY];
  return typeof stored === "string" && stored.length > 0
    ? stored
    : DEFAULT_GATEWAY_URL;
}

async function setStoredGatewayUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [GATEWAY_URL_STORAGE_KEY]: url });
}
// ─────────────────────────────────────────────────────────────────────

const ENVIRONMENT_OVERRIDE_KEY = "vellum.environmentOverride";

/**
 * Resolve the effective environment by checking for a popup-persisted
 * override first, then falling back to the build-time default.
 */
async function getEffectiveEnvironment(): Promise<ExtensionEnvironment> {
  const result = await chrome.storage.local.get(ENVIRONMENT_OVERRIDE_KEY);
  const override = result[ENVIRONMENT_OVERRIDE_KEY];
  if (typeof override === "string") {
    const parsed = parseExtensionEnvironment(override);
    if (parsed) return parsed;
  }
  return resolveBuildDefaultEnvironment();
}

/**
 * Read the raw override value from storage (null when unset).
 */
async function getOverrideEnvironment(): Promise<ExtensionEnvironment | null> {
  const result = await chrome.storage.local.get(ENVIRONMENT_OVERRIDE_KEY);
  const override = result[ENVIRONMENT_OVERRIDE_KEY];
  if (typeof override === "string") {
    return parseExtensionEnvironment(override);
  }
  return null;
}

/**
 * Persist an environment override. Pass `null` to clear.
 */
async function setOverrideEnvironment(
  env: ExtensionEnvironment | null,
): Promise<void> {
  if (env === null) {
    await chrome.storage.local.remove(ENVIRONMENT_OVERRIDE_KEY);
  } else {
    await chrome.storage.local.set({ [ENVIRONMENT_OVERRIDE_KEY]: env });
  }
}

/**
 * Remove legacy capability-token storage keys left over from older
 * versions. Called when the environment changes so stale entries don't
 * accumulate.
 */
async function invalidateAuthTokens(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter((k) =>
    k.startsWith("vellum.localCapabilityToken"),
  );
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// ── Environment-aware toolbar icon ─────────────────────────────────

/**
 * Update the toolbar icon to match the current environment.
 *
 * Each environment has its own set of pre-generated icon PNGs under
 * `icons/<env>/`, matching the desktop app's environment tinting.
 */
async function updateExtensionIcon(env: ExtensionEnvironment): Promise<void> {
  try {
    await chrome.action.setIcon({
      path: {
        "16": `icons/${env}/icon16.png`,
        "48": `icons/${env}/icon48.png`,
        "128": `icons/${env}/icon128.png`,
      },
    });
  } catch {
    // Best-effort — `chrome.action` may be unavailable in tests or
    // during early service-worker initialization.
  }
}

// Storage key that controls auto-connect on service-worker startup.
// Set to `true` after a successful user-initiated connect, cleared to
// `false` by the `pause` action so the extension stays quiet until
// the user explicitly reconnects.
const AUTO_CONNECT_KEY = "autoConnect";

// Storage key used to surface the most recent auth-related relay error
// to the popup. The popup reads this on open and shows it next to the
// connect button. Cleared on a successful connect so stale errors
// don't linger after the user re-pairs.
const RELAY_AUTH_ERROR_KEY = "vellum.relayAuthError";

interface RelayAuthError {
  message: string;
  mode: "self-hosted";
  at: number;
  debugDetails?: string;
}

async function setRelayAuthError(error: RelayAuthError): Promise<void> {
  try {
    await chrome.storage.local.set({ [RELAY_AUTH_ERROR_KEY]: error });
  } catch (err) {
    console.warn("[cue-relay] Failed to persist relay auth error", err);
  }
}

async function clearRelayAuthError(): Promise<void> {
  try {
    await chrome.storage.local.remove(RELAY_AUTH_ERROR_KEY);
  } catch (err) {
    console.warn("[cue-relay] Failed to clear relay auth error", err);
  }
}

function serializeWorkerError(err: unknown): {
  error: string;
  debugDetails?: string;
} {
  return {
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Persist the auto-connect flag. Called after a successful user-initiated
 * connect so the next service-worker startup (e.g. browser reopen)
 * automatically reconnects.
 */
async function setAutoConnect(enabled: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [AUTO_CONNECT_KEY]: enabled });
  } catch (err) {
    console.warn("[cue-relay] Failed to persist autoConnect flag", err);
  }
}

// ── Connection health state ──────────────────────────────────────────
//
// Explicit state machine for the connection lifecycle. The popup consumes
// this via `get_status` instead of inferring state from a boolean.
//
// States:
//   - `paused`        — user explicitly paused; autoConnect is false.
//   - `connecting`    — initial connect attempt in progress.
//   - `connected`     — SSE connection is open.
//   - `reconnecting`  — connection dropped unexpectedly; reconnect in progress.
//   - `auth_required` — pairing/credentials failed. User must re-pair.
//   - `error`         — unrecoverable non-auth error (e.g. gateway not
//                       reachable, unsupported topology).

/**
 * Structured connection health state exposed to the popup via
 * `get_status`. Transitions are driven by the connect, reconnect,
 * close, and pause actions in the worker.
 */
export type ConnectionHealthState =
  | "paused"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "auth_required"
  | "error";

/**
 * Detail fields attached to the current health state. Populated on
 * disconnect / error transitions and cleared on successful connect.
 */
export interface ConnectionHealthDetail {
  /** Close/error code from the last unexpected disconnect. */
  lastDisconnectCode?: number;
  /** Human-readable error message from the last failure. */
  lastErrorMessage?: string;
  /** Epoch ms of the most recent health state change. */
  lastChangeAt: number;
}

let connectionHealth: ConnectionHealthState = "paused";
let connectionHealthDetail: ConnectionHealthDetail = {
  lastChangeAt: Date.now(),
};

/**
 * Transition the connection health state. Every transition updates
 * `lastChangeAt`. Additional detail fields (disconnect code, error
 * message) are set by the caller via the optional `detail` argument.
 */
function setConnectionHealth(
  state: ConnectionHealthState,
  detail?: Partial<Omit<ConnectionHealthDetail, "lastChangeAt">>,
): void {
  connectionHealth = state;
  connectionHealthDetail = {
    ...connectionHealthDetail,
    ...detail,
    lastChangeAt: Date.now(),
  };
  // Clear stale error fields when entering a non-error state so
  // previous `lastErrorMessage` / `lastDisconnectCode` values don't
  // bleed into unrelated transitions (e.g. auth_required → paused).
  if (state === "connected" || state === "paused" || state === "connecting") {
    delete connectionHealthDetail.lastDisconnectCode;
    delete connectionHealthDetail.lastErrorMessage;
  }
}

// ── Connection state ───────────────────────────────────────────────
//
// A single mode: self-hosted. The extension pairs with the gateway
// (`POST /v1/pair`) and connects via SSE (`/v1/events`).

/**
 * The auth profile of the current (or last-attempted) connection.
 * Always `self-hosted` in the shipped extension; kept as a field so the
 * popup status contract stays stable.
 */
let currentAuthProfile: AssistantAuthProfile | null = null;

let sseConnection: SseConnection | null = null;
/** JWT obtained from POST /v1/pair. Used as Bearer on the SSE + callback POSTs. */
let selfHostedPairToken: string | null = null;
let shouldConnect = false;

// ── Host browser dispatcher ────────────────────────────────────────
//
// `host_browser_request` / `host_browser_cancel` envelopes arriving on
// the SSE stream are routed into the CDP proxy dispatcher, which drives
// a chrome.debugger session and POSTs a result envelope back to the
// gateway's `/v1/host-browser-result` endpoint.

async function resolveHostBrowserTarget(
  cdpSessionId: string | undefined,
): Promise<{ tabId?: number; targetId?: string }> {
  if (cdpSessionId) {
    // Chrome tab IDs are positive integers. CDP targetIds are opaque
    // non-numeric strings (hex, UUIDs, etc.). Route canonical decimal
    // digit strings as tabId for chrome.debugger.attach({ tabId });
    // route everything else as targetId. The regex guard rejects hex
    // literals ("0x10"), exponential notation ("1e3"), and whitespace-
    // padded values that Number() would silently coerce to integers.
    if (/^\d+$/.test(cdpSessionId)) {
      const asNumber = Number(cdpSessionId);
      if (asNumber > 0 && Number.isSafeInteger(asNumber)) {
        return { tabId: asNumber };
      }
    }
    return { targetId: cdpSessionId };
  }
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (activeTab?.id === undefined) {
    throw new Error("No active tab available to resolve host_browser target");
  }
  return { tabId: activeTab.id };
}

/**
 * POST a host_browser result back to the gateway via HTTP.
 *
 * The SSE stream delivers inbound requests; results go back via HTTP POST
 * to `${gatewayUrl}/v1/host-browser-result` with the pair token as Bearer.
 */
async function dispatchHostBrowserResult(
  result: HostBrowserResultEnvelope,
): Promise<void> {
  appendEvent("outbound", "host_browser_result", {
    summary: `${result.requestId.slice(0, 8)}${result.isError ? " (error)" : ""}`,
    isError: result.isError,
  });
  recordResponse(result.requestId, {
    isError: result.isError,
    responseContent: result.content,
  });

  if (sseConnection && sseConnection.isOpen()) {
    const mode = sseConnection.getMode();
    const baseUrl = mode.runtimeUrl.replace(/\/$/, "");
    const url = `${baseUrl}/v1/host-browser-result`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Identifies this extension to the daemon's actor-binding check.
      // The daemon validates this matches the client recorded at request
      // time before resolving the pending host_browser interaction.
      "X-Vellum-Client-Id": await getClientId(),
    };
    if (selfHostedPairToken) {
      headers["authorization"] = `Bearer ${selfHostedPairToken}`;
    }
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(result),
        credentials: "omit",
      });
      if (!resp.ok) {
        const body = await safeReadBody(resp);
        recordCallbackFailure(result.requestId, resp.status, body);
        console.warn(
          "[cue] host-browser-result POST failed",
          resp.status,
          body,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordCallbackFailure(result.requestId, 0, `fetch threw: ${msg}`);
      console.warn("[cue] host-browser-result POST threw", err);
    }
    return;
  }

  // Fallback: no active SSE connection but we can still try POSTing
  // directly to the stored gateway URL.
  const gatewayUrl = await getStoredGatewayUrl();
  try {
    const fallbackHeaders: Record<string, string> = {
      "content-type": "application/json",
      "X-Vellum-Client-Id": await getClientId(),
    };
    if (selfHostedPairToken) {
      fallbackHeaders["authorization"] = `Bearer ${selfHostedPairToken}`;
    }
    const resp = await fetch(
      `${gatewayUrl.replace(/\/$/, "")}/v1/host-browser-result`,
      {
        method: "POST",
        headers: fallbackHeaders,
        body: JSON.stringify(result),
      },
    );
    if (!resp.ok) {
      const body = await safeReadBody(resp);
      recordCallbackFailure(result.requestId, resp.status, `fallback: ${body}`);
      console.warn(
        "[cue] host-browser-result fallback POST failed",
        resp.status,
        body,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordCallbackFailure(result.requestId, 0, `fallback fetch threw: ${msg}`);
    console.warn("[cue] host-browser-result fallback POST threw", err);
  }
}

/**
 * Read a `Response` body as text without ever throwing — defaults to an
 * empty string when the body has already been consumed or the read
 * fails. Bounded to keep oversized error payloads from blowing up the
 * operations ring buffer (the {@link recordCallbackFailure} helper
 * applies its own cap as the second line of defense).
 */
async function safeReadBody(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > 4096 ? text.slice(0, 4096) + "…[truncated]" : text;
  } catch {
    return "";
  }
}

/**
 * Forward a `host_browser_event` envelope to the gateway via HTTP POST.
 *
 * CDP events are fire-and-forget — if the POST fails the envelope is
 * silently dropped. Chrome will emit many more events before the next
 * retry, so queueing during an outage would just pile up stale
 * notifications that the runtime cannot act on.
 */
function dispatchHostBrowserEvent(envelope: HostBrowserEventEnvelope): void {
  if (!sseConnection || !sseConnection.isOpen()) return;
  const mode = sseConnection.getMode();
  const baseUrl = mode.runtimeUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/host-browser-event`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (selfHostedPairToken) {
    headers["authorization"] = `Bearer ${selfHostedPairToken}`;
  }
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    credentials: "omit",
  }).catch(() => {
    /* fire and forget */
  });
}

/**
 * Forward a `host_browser_session_invalidated` envelope to the gateway.
 * Same fire-and-forget semantics as {@link dispatchHostBrowserEvent}.
 */
function dispatchHostBrowserSessionInvalidated(
  envelope: HostBrowserSessionInvalidatedEnvelope,
): void {
  if (!sseConnection || !sseConnection.isOpen()) return;
  const mode = sseConnection.getMode();
  const baseUrl = mode.runtimeUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/host-browser-session-invalidated`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (selfHostedPairToken) {
    headers["authorization"] = `Bearer ${selfHostedPairToken}`;
  }
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    credentials: "omit",
  }).catch(() => {
    /* fire and forget */
  });
}

const hostBrowserDispatcher: HostBrowserDispatcher =
  createHostBrowserDispatcher({
    resolveTarget: resolveHostBrowserTarget,
    async createTab() {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      const newTab = await chrome.tabs.create({
        url: 'about:blank',
        active: true,
        windowId: activeTab?.windowId,
      });
      if (newTab.id === undefined) {
        throw new Error(
          'Failed to create a new tab for navigation (active tab was on a privileged URL)',
        );
      }
      return { tabId: newTab.id };
    },
    postResult: dispatchHostBrowserResult,
    forwardCdpEvent: dispatchHostBrowserEvent,
    forwardSessionInvalidated: (envelope) => {
      // Enrich the invalidation envelope with the extension's clientId so
      // the runtime can scope pin-store eviction to this specific install.
      void (async () => {
        let clientId: string | undefined;
        try {
          clientId = await getClientId();
        } catch {
          /* best effort */
        }
        dispatchHostBrowserSessionInvalidated(
          clientId ? { ...envelope, clientId } : envelope,
        );
      })();
    },
    getClientId,
  });

// ── Storage helpers ─────────────────────────────────────────────────

/**
 * Storage key recording whether the user has completed the connect flow.
 * A single value ("self-hosted") in the shipped extension; retained so
 * the popup can skip the welcome screen for returning users.
 */
const USER_MODE_KEY = "vellum.userMode";

async function getStoredUserMode(): Promise<"self-hosted" | null> {
  try {
    const result = await chrome.storage.local.get(USER_MODE_KEY);
    const stored = result[USER_MODE_KEY];
    if (stored === "self-hosted") return stored;
  } catch {
    /* best-effort */
  }
  return null;
}

async function setStoredUserMode(mode: "self-hosted"): Promise<void> {
  await chrome.storage.local.set({ [USER_MODE_KEY]: mode });
}

async function clearStoredUserMode(): Promise<void> {
  await chrome.storage.local.remove(USER_MODE_KEY);
}

// ── SSE connection lifecycle ─────────────────────────────────────────

/**
 * Wire an SseConnection up with the worker's message/open/close callbacks.
 */
function createSseConnection(mode: SseMode): SseConnection {
  return new SseConnection({
    mode,
    onOpen: () => {
      console.log(`[cue-sse] Connected (self-hosted)`);
      setConnectionHealth("connected");
      void clearRelayAuthError();
    },
    onMessage: (data) => {
      void handleSseMessage(data).catch((err) => {
        console.warn("[cue-sse] handleSseMessage failed", err);
      });
    },
    onClose: (authError) => {
      console.log(
        `[cue-sse] Disconnected${authError ? ` (auth: ${authError})` : ""}`,
      );
      if (authError) {
        shouldConnect = false;
        // Auth-required is a hard stop: no automatic reconnect will
        // succeed until the user re-pairs, so let the worker idle out
        // instead of waking every 30 s.
        void clearKeepaliveAlarm();
        setConnectionHealth("auth_required", {
          lastErrorMessage: authError,
        });
        void setRelayAuthError({
          message: authError,
          mode: "self-hosted",
          at: Date.now(),
        });
        sseConnection = null;
      } else if (shouldConnect) {
        setConnectionHealth("reconnecting");
      }
    },
  });
}

/**
 * Handle an incoming SSE event payload from the gateway. The /events
 * endpoint emits AssistantEvent envelopes; the `host_browser_request` /
 * `host_browser_cancel` events are dispatched to the CDP proxy dispatcher.
 */
async function handleSseMessage(data: unknown): Promise<void> {
  if (!data || typeof data !== "object") return;

  // The /events SSE endpoint wraps messages in an AssistantEvent envelope:
  // { id, assistantId, message: { type, ... } }
  const envelope = data as { message?: unknown };
  const message = envelope.message;
  if (!message || typeof message !== "object") return;

  const typed = message as { type?: unknown };
  if (typeof typed.type !== "string") return;

  if (typed.type === "host_browser_request") {
    const req = message as HostBrowserRequestEnvelope;
    appendEvent("inbound", "host_browser_request", {
      summary: `${req.cdpMethod} (${req.requestId.slice(0, 8)})`,
    });
    recordRequest(req.requestId, req.cdpMethod, {
      cdpMethod: req.cdpMethod,
      cdpParams: req.cdpParams,
      cdpSessionId: req.cdpSessionId,
      conversationId: req.conversationId,
    });
    await hostBrowserDispatcher.handle(req);
    return;
  }
  if (typed.type === "host_browser_cancel") {
    const cancel = message as HostBrowserCancelEnvelope;
    appendEvent("inbound", "host_browser_cancel", {
      summary: cancel.requestId.slice(0, 8),
    });
    hostBrowserDispatcher.cancel(cancel);
    return;
  }

  // Other event types (text deltas, tool calls, etc.) are not handled
  // by the extension — they're consumed by the chat UI clients.
}

/**
 * Thrown by `connect()` when pairing yields no usable token or the
 * topology is unsupported. Callers surface the message verbatim so the
 * user can re-pair via the Troubleshooting controls.
 */
class MissingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTokenError";
  }
}

//
// Threading an explicit `interactive` flag through the connect flow
// lets the serialization lock decide whether a new call should supersede
// an in-flight attempt (user-initiated Connect supersedes auto-connect).

interface ConnectOptions {
  interactive: boolean;
}

// Serialization lock: if a connect is already in progress, subsequent
// callers await the existing attempt rather than launching a concurrent
// preflight. This prevents duplicate pair flows when multiple connect
// calls arrive before the first socket opens.
//
// Exception: an interactive connect (user-initiated) always supersedes a
// non-interactive one (bootstrap).
let connectInFlight: Promise<void> | null = null;
let connectInFlightInteractive = false;

async function connect(
  options: ConnectOptions = { interactive: false },
): Promise<void> {
  if (connectInFlight && (connectInFlightInteractive || !options.interactive)) {
    return connectInFlight;
  }
  connectInFlightInteractive = !!options.interactive;
  connectInFlight = doConnect(options);
  try {
    await connectInFlight;
  } finally {
    connectInFlight = null;
    connectInFlightInteractive = false;
  }
}

/**
 * Helper: is the SSE connection currently open?
 */
function isAnyConnectionOpen(): boolean {
  return sseConnection !== null && sseConnection.isOpen();
}

async function doConnect(_options: ConnectOptions): Promise<void> {
  if (isAnyConnectionOpen()) return;
  setConnectionHealth("connecting");

  // A fresh connect attempt supersedes any previously persisted
  // auth-error — the user is explicitly retrying.
  await clearRelayAuthError();

  // Tear down any stale connections before constructing new ones.
  teardownConnections();

  currentAuthProfile = "self-hosted";
  const gatewayUrl = await getStoredGatewayUrl();

  // Bail if the user disconnected while we were awaiting above.
  if (!shouldConnect) return;

  // Best-effort pair — if pairing fails the SSE connection will be rejected
  // by the gateway with a 401. The worker will surface the auth error and
  // stop reconnecting until the user re-pairs.
  try {
    const pairResp = await fetch(
      `${gatewayUrl.replace(/\/$/, "")}/v1/pair`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vellum-interface-id": "chrome-extension",
        },
      },
    );
    if (pairResp.ok) {
      const body = (await pairResp.json()) as { token?: string };
      selfHostedPairToken = body.token ?? null;
    } else {
      console.warn("[cue] pair failed:", pairResp.status);
    }
  } catch (err) {
    console.warn("[cue] pair request error:", err);
  }

  if (!shouldConnect) return;
  sseConnection = createSseConnection({
    kind: "self-hosted",
    runtimeUrl: gatewayUrl,
    token: selfHostedPairToken,
  });
  sseConnection.start();
}

/**
 * Tear down all active connections without resetting `shouldConnect`.
 * Used by `doConnect` to clean up stale instances before constructing
 * a new connection.
 */
function teardownConnections(): void {
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
  selfHostedPairToken = null;
}

function disconnect(): void {
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
}

// ── Keep-alive (MV3 service-worker liveness) ─────────────────────────

const KEEPALIVE_ALARM_NAME = "vellum-relay-keepalive";
const KEEPALIVE_PERIOD_MIN = 0.5;

async function ensureKeepaliveAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM_NAME);
  if (existing) return;
  await chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
    periodInMinutes: KEEPALIVE_PERIOD_MIN,
  });
}

async function clearKeepaliveAlarm(): Promise<void> {
  await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
  if (shouldConnect && !(sseConnection?.isOpen() ?? false)) {
    void connect({ interactive: false }).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[cue-relay] Keepalive reconnect failed: ${detail}`);
    });
  }
});

// Notify the runtime whenever a browser tab is closed so it can evict
// any pinned-tab entry pointing at the closed tab. This fires for all
// tab closes — user-initiated, extension-initiated, and crash-induced —
// giving the runtime a chance to clear stale pins before the next CDP
// command routes to a dead tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  // Use the same forwardSessionInvalidated pattern as the debugger
  // onDetach path: enrich with clientId and fire-and-forget.
  void (async () => {
    let clientId: string | undefined;
    try {
      clientId = await getClientId();
    } catch {
      /* best effort */
    }
    const envelope: HostBrowserSessionInvalidatedEnvelope = {
      type: 'host_browser_session_invalidated',
      targetId: String(tabId),
      reason: 'tab_closed',
      ...(clientId ? { clientId } : {}),
    };
    dispatchHostBrowserSessionInvalidated(envelope);
  })();
});

// On install/update, only register the alarm if we already have an
// active auto-connect intent (e.g. an update installing over a
// connected install). For a fresh install with no prior connect,
// the alarm is created when the user first presses Connect — that
// avoids burning a wake-up every 30 s on installs that never connect.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get(AUTO_CONNECT_KEY).then((result) => {
    if (result[AUTO_CONNECT_KEY] === true) {
      void ensureKeepaliveAlarm();
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.storage.local.get(AUTO_CONNECT_KEY).then((result) => {
    if (result[AUTO_CONNECT_KEY] === true) {
      void ensureKeepaliveAlarm();
    }
  });
});

// ── Extension message listener (from popup) ─────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponseFn) => {
  if (message.type === "connect") {
    shouldConnect = true;
    // User-initiated Connect is interactive: the worker will auto-pair
    // rather than requiring the popup to pre-check credentials.
    connect({ interactive: true })
      .then(async () => {
        // Guard: skip if the user paused/disconnected while the connect
        // was in-flight — their pause intent takes precedence.
        if (shouldConnect) {
          await setStoredUserMode("self-hosted");
          await setAutoConnect(true);
          await ensureKeepaliveAlarm();
        }
        sendResponseFn({ ok: true });
      })
      .catch(async (err) => {
        // Reset shouldConnect so a subsequent storage change or
        // bootstrap doesn't silently retry a doomed connect.
        shouldConnect = false;
        await setAutoConnect(false);
        await clearKeepaliveAlarm();
        const serializedError = serializeWorkerError(err);
        const errorMessage = serializedError.error;
        if (err instanceof MissingTokenError) {
          setConnectionHealth("auth_required", {
            lastErrorMessage: errorMessage,
          });
        } else {
          setConnectionHealth("error", {
            lastErrorMessage: errorMessage,
          });
        }
        sendResponseFn({ ok: false, ...serializedError });
      });
    return true; // async
  }
  // `pause` is the canonical user-level stop action: it clears the
  // sticky auto-connect flag so the extension does not reconnect on
  // the next startup, then tears down the SSE connection.
  // `disconnect` is kept as a backward-compatible alias.
  if (message.type === "pause" || message.type === "disconnect") {
    shouldConnect = false;
    setConnectionHealth("paused");
    void clearKeepaliveAlarm();
    // Await the storage write so MV3 can't terminate the worker before
    // the autoConnect flag is persisted to false.
    setAutoConnect(false)
      .then(() => {
        disconnect();
        sendResponseFn({ ok: true });
      })
      .catch(() => {
        disconnect();
        sendResponseFn({ ok: true });
      });
    return true; // async
  }
  if (message.type === "get_status") {
    sendResponseFn({
      connected: isAnyConnectionOpen(),
      authProfile: currentAuthProfile,
      health: connectionHealth,
      healthDetail: connectionHealthDetail,
    });
    return false;
  }
  if (message.type === "gateway-url-get") {
    getStoredGatewayUrl()
      .then((gatewayUrl) => sendResponseFn({ ok: true, gatewayUrl }))
      .catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true; // async
  }
  if (message.type === "gateway-url-set") {
    const url =
      typeof message.gatewayUrl === "string" ? message.gatewayUrl.trim() : null;
    if (!url) {
      sendResponseFn({ ok: false, error: "gatewayUrl is required" });
      return false;
    }
    (async () => {
      await setStoredGatewayUrl(url);

      // When connected, tear down and reconnect to the new gateway.
      if (shouldConnect && sseConnection) {
        disconnect();
        try {
          await connect({ interactive: true });
        } catch (err) {
          shouldConnect = false;
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.warn(
            `[cue-relay] Gateway URL switch left disconnected: ${errorMessage}`,
          );
          if (err instanceof MissingTokenError) {
            setConnectionHealth("auth_required", {
              lastErrorMessage: errorMessage,
            });
          } else {
            setConnectionHealth("error", {
              lastErrorMessage: errorMessage,
            });
          }
        }
      }

      sendResponseFn({ ok: true, gatewayUrl: url });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }
  if (message.type === "self-hosted-pair") {
    // The popup calls this when the user clicks "Pair". We attempt
    // /v1/pair so the popup gets early feedback, and store the JWT so
    // callbacks work immediately when the popup follows up with "connect".
    (async () => {
      const gatewayUrl = await getStoredGatewayUrl();
      await setStoredUserMode("self-hosted");
      const pairResp = await fetch(
        `${gatewayUrl.replace(/\/$/, "")}/v1/pair`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vellum-interface-id": "chrome-extension",
          },
        },
      );
      if (!pairResp.ok) {
        throw new Error(`Pair failed (${pairResp.status})`);
      }
      const body = (await pairResp.json()) as { token?: string };
      selfHostedPairToken = body.token ?? null;
      sendResponseFn({ ok: true });
    })()
      .catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true; // async
  }
  if (message.type === "environment-get") {
    // Returns the effective environment and its components so the popup
    // can display which environment is active and whether an override is
    // in effect.
    Promise.all([getEffectiveEnvironment(), getOverrideEnvironment()])
      .then(([effectiveEnvironment, overrideEnvironment]) => {
        sendResponseFn({
          ok: true,
          effectiveEnvironment,
          overrideEnvironment,
          buildDefaultEnvironment: resolveBuildDefaultEnvironment(),
        });
      })
      .catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true; // async
  }
  if (message.type === "environment-set") {
    // Validates and persists an environment override. Pass
    // `environment: null` to clear the override and revert to the
    // build default. The caller (popup) is responsible for orchestrating
    // disconnect/reconnect after receiving the response.
    const rawEnv = message.environment;
    if (rawEnv === null || rawEnv === undefined) {
      (async () => {
        const previousEnv = await getEffectiveEnvironment();
        await setOverrideEnvironment(null);
        const effectiveEnvironment = await getEffectiveEnvironment();
        if (effectiveEnvironment !== previousEnv) {
          await invalidateAuthTokens();
          void updateExtensionIcon(effectiveEnvironment);
        }
        sendResponseFn({
          ok: true,
          effectiveEnvironment,
          overrideEnvironment: null,
          buildDefaultEnvironment: resolveBuildDefaultEnvironment(),
        });
      })().catch((err) =>
        sendResponseFn({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return true; // async
    }
    if (typeof rawEnv !== "string") {
      sendResponseFn({
        ok: false,
        error: "environment must be a string or null",
      });
      return false;
    }
    const parsed = parseExtensionEnvironment(rawEnv);
    if (!parsed) {
      sendResponseFn({
        ok: false,
        error: `Invalid environment: "${rawEnv}". Must be one of: local, dev, staging, production`,
      });
      return false;
    }
    (async () => {
      const previousEnv = await getEffectiveEnvironment();
      await setOverrideEnvironment(parsed);
      const effectiveEnvironment = await getEffectiveEnvironment();
      if (effectiveEnvironment !== previousEnv) {
        await invalidateAuthTokens();
        void updateExtensionIcon(effectiveEnvironment);
      }
      sendResponseFn({
        ok: true,
        effectiveEnvironment,
        overrideEnvironment: parsed,
        buildDefaultEnvironment: resolveBuildDefaultEnvironment(),
      });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }

  // ── Onboarding / session messages ─────────────────────────────────

  if (message.type === "get-session") {
    (async () => {
      const session = await getStoredSession();
      const selectedAssistant = await getSelectedAssistant();
      let mode = await getStoredUserMode();

      // Backward compatibility: existing users who connected before the
      // onboarding flow was added will have autoConnect=true but no
      // userMode. Infer self-hosted so they skip the welcome screen.
      if (!mode) {
        const autoConnectResult =
          await chrome.storage.local.get(AUTO_CONNECT_KEY);
        if (autoConnectResult[AUTO_CONNECT_KEY] === true) {
          mode = "self-hosted";
          await setStoredUserMode("self-hosted");
        }
      }

      // Self-hosted is always "paired" once a connect has completed —
      // the gateway pairing is transparent. The popup uses this to skip
      // the pairing screen for returning users.
      const selfHostedPaired = mode === "self-hosted";

      sendResponseFn({
        ok: true,
        mode,
        session: session ? { email: session.email } : null,
        selectedAssistant,
        selfHostedPaired,
      });
    })().catch(() => sendResponseFn({ ok: false, mode: null }));
    return true; // async
  }

  if (message.type === "set-mode") {
    (async () => {
      await setStoredUserMode("self-hosted");
      sendResponseFn({ ok: true });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true; // async
  }

  if (message.type === "self-hosted-disconnect") {
    (async () => {
      shouldConnect = false;
      disconnect();
      setConnectionHealth("paused");
      clearEventLog();
      await clearKeepaliveAlarm();
      await setAutoConnect(false);
      await clearSession();
      await clearSelectedAssistant();
      await clearStoredUserMode();
      sendResponseFn({ ok: true });
    })().catch(() => sendResponseFn({ ok: true }));
    return true; // async
  }

  if (message.type === "get-event-log") {
    sendResponseFn({ ok: true, entries: getEventLog() });
    return false; // synchronous
  }

  if (message.type === "get-operations") {
    sendResponseFn({ ok: true, operations: getOperations() });
    return false;
  }

  if (message.type === "get-operation-detail") {
    const op = getOperationById(message.operationId as number);
    sendResponseFn({ ok: !!op, operation: op ?? null });
    return false;
  }

  if (message.type === "submit-feedback") {
    (async () => {
      const form = message.form as FeedbackFormData | undefined;
      if (!form || typeof form.message !== "string" || form.message.trim().length === 0) {
        sendResponseFn({ ok: false, error: "Message is required" });
        return;
      }
      const env = await resolveEnvContext();
      const mode = await getStoredUserMode();
      const bundle = form.includeDiagnostics
        ? await collectDiagnosticBundle({
            env,
            mode,
            sseState: connectionHealth,
            sseDetail: connectionHealthDetail as unknown as Record<string, unknown>,
          })
        : null;
      await submitFeedback(form, bundle, env);
      sendResponseFn({ ok: true });
    })().catch((err) =>
      sendResponseFn({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true;
  }

  // Unknown message type — let Chrome close the port naturally.
  return false;
});

/**
 * Build the environment context used by the Share Feedback flow.
 *
 * Combines the popup-persisted environment override (if any) with the
 * build-time default and the static URL mapping.
 */
async function resolveEnvContext(): Promise<{
  environment: ExtensionEnvironment;
  apiBaseUrl: string;
}> {
  const environment = await getEffectiveEnvironment();
  const { apiBaseUrl } = cloudUrlsForEnvironment(environment);
  return { environment, apiBaseUrl };
}

// Auto-connect on service worker start if previously connected.
// Only fires when the sticky `autoConnect` flag is `true` (set by a
// prior successful user-initiated Connect). Bootstrap uses a non-
// interactive connect so it never pops up auth UIs.
async function bootstrap(): Promise<void> {
  // Set the toolbar icon to match the current environment on every
  // service-worker startup, regardless of auto-connect state.
  void updateExtensionIcon(await getEffectiveEnvironment());

  const result = await chrome.storage.local.get(AUTO_CONNECT_KEY);
  if (result[AUTO_CONNECT_KEY] !== true) return;
  shouldConnect = true;
  await ensureKeepaliveAlarm();
  try {
    await connect({ interactive: false });
  } catch (err) {
    // A missing token at auto-connect time is not a hard failure — the
    // user will see the disconnected state in the popup and can re-pair.
    shouldConnect = false;
    void clearKeepaliveAlarm();
    if (err instanceof MissingTokenError) {
      console.warn(`[cue-relay] Skipping auto-connect: ${err.message}`);
      setConnectionHealth("auth_required", {
        lastErrorMessage: err.message,
      });
      void setRelayAuthError({
        message: err.message,
        mode: "self-hosted",
        at: Date.now(),
      });
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[cue-relay] Auto-connect failed: ${detail}`);
    setConnectionHealth("error", {
      lastErrorMessage: detail,
    });
    void setRelayAuthError({
      message: detail,
      mode: "self-hosted",
      at: Date.now(),
    });
  }
}

bootstrap();
