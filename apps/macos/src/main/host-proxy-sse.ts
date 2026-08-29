/**
 * SSE client for the host proxy subsystem in the Electron main process.
 *
 * Connects to an events endpoint, parses SSE frames (`data: <json>\n\n`
 * for messages, `: <comment>\n` for heartbeats), and emits parsed JSON
 * payloads via a callback. Reconnects automatically with exponential
 * backoff and detects stale connections via an idle watchdog.
 *
 * Supports both local gateway connections and cloud/platform connections
 * — the caller provides the full events URL and an auth-headers builder.
 */

import { hostname } from "node:os";

import { getDeviceId } from "./device-id";

export interface HostProxySseOptions {
  /** Full URL for the events endpoint. */
  eventsUrl: string;
  /** Called on every connect attempt to build auth headers. */
  authHeaders: () => Record<string, string>;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override idle timeout for testing. */
  idleTimeoutMs?: number;
  /** Override idle check interval for testing. */
  idleCheckIntervalMs?: number;
  /** Called before each reconnect — return a fresh token or null. */
  onRefreshToken?: () => Promise<string | null>;
  /**
   * The instance rejected this device's credential and retrying cannot fix it.
   *
   * Separate from the ordinary reconnect path because it is not a connection
   * problem: no number of attempts turns a token signed with a retired key
   * into a valid one. See {@link HostProxySseClient.handleResponse}.
   */
  onAuthRejected?: () => void;
}

export interface HostProxySseMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageCallback = (message: HostProxySseMessage) => void;

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const IDLE_TIMEOUT_MS = 30_000;
const IDLE_CHECK_INTERVAL_MS = 10_000;

export class HostProxySseClient {
  private readonly eventsUrl: string;
  private readonly authHeaders: () => Record<string, string>;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly idleTimeoutMs: number;
  private readonly idleCheckIntervalMs: number;
  private readonly onRefreshToken: (() => Promise<string | null>) | null;
  private readonly onAuthRejected: (() => void) | null;
  private onMessage: MessageCallback | null = null;

  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private lastTrafficAt = 0;
  private _connected = false;
  private shouldReconnect = false;
  /** Consecutive auth rejections. One is a stale cache; two is the credential. */
  private authRejections = 0;

  constructor(options: HostProxySseOptions) {
    this.eventsUrl = options.eventsUrl;
    this.authHeaders = options.authHeaders;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_CHECK_INTERVAL_MS;
    this.onRefreshToken = options.onRefreshToken ?? null;
    this.onAuthRejected = options.onAuthRejected ?? null;
  }

  /** Register a callback for parsed SSE messages. */
  setMessageCallback(cb: MessageCallback): void {
    this.onMessage = cb;
  }

  /** Whether the client currently has an active SSE stream. */
  get isConnected(): boolean {
    return this._connected;
  }

  /** Open the SSE connection. Safe to call multiple times. */
  connect(): void {
    if (this.abortController) return;
    this.shouldReconnect = true;
    this.authRejections = 0;
    this.startStream();
  }

  /** Close the SSE connection and cancel all pending timers. */
  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearIdleWatchdog();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._connected = false;
  }

  // -- Stream lifecycle ---------------------------------------------------

  private startStream(): void {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    const headers: Record<string, string> = {
      Accept: "text/event-stream, application/json",
      "X-Vellum-Client-Id": getDeviceId(),
      "X-Vellum-Interface-Id": "macos",
      "X-Vellum-Machine-Name": hostname(),
      // Capabilities this BUILD can service that its interface type does not
      // already imply. The daemon unions these with the interface-derived set
      // (see `resolveClientCapabilities`), so a build that omits the header —
      // every desktop shipped before screen observation — is simply never
      // asked to observe, instead of being asked and timing out.
      "X-Vellum-Host-Capabilities": "host_observe",
      ...this.authHeaders(),
    };

    this.fetchFn(this.eventsUrl, { headers, signal: controller.signal })
      .then((response) => this.handleResponse(response))
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        this._connected = false;
        this.scheduleReconnect();
      });
  }

  private async handleResponse(response: Response): Promise<void> {
    /**
     * **An auth rejection is the one failure that must not be retried.**
     *
     * Every other non-OK response is a connection problem and backing off is
     * right. A 401 is not: reopening cannot mint a valid credential, and every
     * attempt records another auth failure against this IP in the gateway's
     * limiter — ten in sixty seconds blocks it. So the retry that looks like
     * resilience is the thing that locks the owner out of their own instance.
     *
     * This looped for weeks. The desktop app hit the instance every thirty
     * seconds — `MAX_RECONNECT_DELAY_MS`, visible as an exact cadence in the
     * gateway log — with a token signed by a signing key the instance had
     * since replaced, so it could never come good. The renderer's own stream
     * has had this give-up all along, with this reason written beside it; the
     * main process simply never grew one, because `handleResponse` never
     * looked at the status.
     *
     * One refresh first, because the cache genuinely can be stale — a new
     * connect link re-seeds the token while the app runs. A second rejection
     * is the credential itself, and that is somebody's to fix, not a timer's.
     */
    if (response.status === 401 || response.status === 403) {
      this._connected = false;
      this.authRejections += 1;
      if (this.authRejections === 1 && this.onRefreshToken) {
        this.scheduleReconnect();
        return;
      }
      this.shouldReconnect = false;
      this.clearReconnectTimer();
      this.clearIdleWatchdog();
      this.onAuthRejected?.();
      return;
    }

    if (!response.ok || !response.body) {
      this._connected = false;
      this.scheduleReconnect();
      return;
    }

    this._connected = true;
    this.authRejections = 0;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.lastTrafficAt = Date.now();
    this.startIdleWatchdog();

    try {
      await this.readStream(response.body);
    } catch (err: unknown) {
      if (isAbortError(err)) return;
    }

    this._connected = false;
    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        this.lastTrafficAt = Date.now();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.processLine(line);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private processLine(line: string): void {
    // Heartbeat comment — no payload; liveness already tracked by readStream
    if (line.startsWith(":")) return;

    if (!line.startsWith("data: ")) return;

    const payload = line.slice(6);
    if (!payload) return;

    try {
      const parsed = JSON.parse(payload);
      // The daemon's /v1/events endpoint wraps messages in an AssistantEvent
      // envelope: { id, ..., message: { type, ... } }. Unwrap if present.
      const msg: HostProxySseMessage =
        parsed.message != null &&
        typeof parsed.message === "object" &&
        typeof parsed.message.type === "string"
          ? parsed.message
          : parsed;
      this.onMessage?.(msg);
    } catch {
      // Malformed JSON — skip
    }
  }

  // -- Reconnect ----------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.clearReconnectTimer();
    this.clearIdleWatchdog();

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      if (this.onRefreshToken) {
        try {
          await this.onRefreshToken();
        } catch {
          // Token refresh failed — reconnect with existing headers
        }
      }
      this.startStream();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -- Idle watchdog ------------------------------------------------------

  private startIdleWatchdog(): void {
    this.clearIdleWatchdog();
    this.lastTrafficAt = Date.now();

    this.idleWatchdogTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastTrafficAt;
      if (elapsed >= this.idleTimeoutMs) {
        this.clearIdleWatchdog();
        // Force-close the current stream so reconnect kicks in
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = null;
        }
        this._connected = false;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.scheduleReconnect();
      }
    }, this.idleCheckIntervalMs);
  }

  private clearIdleWatchdog(): void {
    if (this.idleWatchdogTimer !== null) {
      clearInterval(this.idleWatchdogTimer);
      this.idleWatchdogTimer = null;
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
