/**
 * Low-level client for Google's Gemini Live (`BidiGenerateContent`) WebSocket —
 * the speech-native realtime API. This wraps the raw protocol (setup →
 * setupComplete → streamed audio + tool calls) behind typed callbacks so the
 * session layer can bridge it to Cue's live-voice client protocol.
 *
 * This is the "Tier 1" realtime engine (see docs/cue-voice-architecture-review.md):
 * it handles the live conversation and quick function calls with ~sub-3s
 * latency, in contrast to the cascade (STT → full agent loop → TTS) which stays
 * as the deep-work tier reached via the `run_deep_task` function.
 *
 * ## Session lifecycle (H-3 hardening)
 *
 * Real use showed conversations dropping after ~20s–a few minutes. The drop
 * classes this client now survives, each of which used to be terminal:
 *
 * 1. **Unexpected upstream close** (1011 internal error, transient network,
 *    proxy idle cuts). The old handler surfaced every close as a fatal error
 *    frame and the call died. Now: bounded reconnect with backoff, resuming
 *    the SAME server-side session via a session-resumption handle when the
 *    server has granted one, else a fresh session (see `reconnect()`).
 * 2. **Server-scheduled disconnects.** Gemini Live sends `goAway` shortly
 *    before it tears a connection down (connection lifetime limits). It was
 *    silently ignored, so the follow-up close looked like a random drop. Now:
 *    proactive migration onto a new socket the moment `goAway` arrives.
 * 3. **Context-window exhaustion.** Without `contextWindowCompression` the
 *    server ends the session outright when the model's context fills — a hard
 *    ceiling on conversation length no reconnect can fix (resuming restores
 *    the same full context). Setup now requests sliding-window compression.
 * 4. **Idle starvation.** Hands-free clients stream continuous mic PCM
 *    (silence included), but push-to-talk clients stop sending between turns
 *    and a long think-pause sends nothing upstream. A silence keepalive frame
 *    now goes up whenever the send path has been quiet too long.
 * 5. **Setup rejects** (1007: invalid config). Seen before with persona voice
 *    fields. Setup is retried once with optional fields stripped
 *    (voice/language/transcription/compression) before failing honestly.
 *
 * A tool response produced while the socket is down (the model called a
 * function, then the socket dropped mid-execution) is queued and delivered
 * after a RESUMED reconnect — the resumption handle preserves the pending
 * call server-side. After a fresh (non-resumed) reconnect the queue is
 * dropped: the new session never issued those calls, and replaying them would
 * be answering questions nobody asked.
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("gemini-live-client");

const GEMINI_LIVE_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Half-cascade "live" model — the right default for a tool-heavy assistant.
 * The native-audio dialog models (e.g. gemini-2.5-flash-native-audio-*) sound
 * more expressive but have flaky function-call support: they 1007-close
 * ("audio content type not supported for this model configuration") when they
 * speak a preamble, call a tool, then try to speak the result. Cue's whole value
 * is taking actions, so we default to the tool-robust live-preview class.
 * Override per-instance with `CUE_GEMINI_LIVE_MODEL`.
 */
export const DEFAULT_GEMINI_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

/** Gemini Live streams output audio as 24kHz 16-bit mono PCM. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24000;

export function resolveGeminiLiveModel(): string {
  const override = process.env.CUE_GEMINI_LIVE_MODEL?.trim();
  const model = override || DEFAULT_GEMINI_LIVE_MODEL;
  // The API wants a fully-qualified `models/...` resource name.
  return model.startsWith("models/") ? model : `models/${model}`;
}

/**
 * BCP-47 language for speech recognition + synthesis. Without a pinned language
 * Gemini Live auto-detects, and on a short/quiet first utterance it can guess
 * wrong (e.g. transcribe English as Japanese), derailing the whole turn.
 * Override with `CUE_GEMINI_LIVE_LANGUAGE`.
 */
export function resolveGeminiLiveLanguage(): string {
  return process.env.CUE_GEMINI_LIVE_LANGUAGE?.trim() || "en-US";
}

/**
 * Gemini Live prebuilt voice name. Gemini Live speaks with its OWN voices (not
 * the cascade's ElevenLabs voice), so we pick a warm female voice by default to
 * match Cue's prior persona. Female options include Aoede, Kore, Leda, Zephyr;
 * male include Puck, Charon, Fenrir, Orus. Override with `CUE_GEMINI_LIVE_VOICE`.
 */
export function resolveGeminiLiveVoice(): string {
  return process.env.CUE_GEMINI_LIVE_VOICE?.trim() || "Aoede";
}

/**
 * Resolve the Gemini API key for the realtime voice engine.
 *
 * A dedicated Gemini key ALWAYS wins: `GEMINI_API_KEY` / `CUE_GEMINI_API_KEY`
 * env, then a `gemini` credential. Only if none is set do we fall back to the
 * shared `openrouter` credential (used when the brain also runs on Gemini via
 * the masquerade). This ordering keeps voice on the real Gemini key even when
 * the brain's `openrouter` credential/key points at a DIFFERENT provider (e.g.
 * DeepSeek via OpenRouter) — otherwise voice would grab the OpenRouter key and
 * fail with "API key not valid".
 */
export async function resolveGeminiLiveApiKey(): Promise<string | null> {
  const fromEnv =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.CUE_GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromGeminiStore = await getSecureKeyAsync(
    credentialKey("gemini", "api_key"),
  );
  if (fromGeminiStore) return fromGeminiStore;
  const fromOpenrouterStore = await getSecureKeyAsync(
    credentialKey("openrouter", "api_key"),
  );
  return fromOpenrouterStore || null;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiLiveToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The subset of the WebSocket surface this client drives. Matches the global
 * `WebSocket` (Bun/browser shape with handler properties), and lets tests
 * inject a scripted fake via {@link GeminiLiveConnectOptions.createSocket}.
 */
export interface GeminiLiveSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
}

export interface GeminiLiveClientCallbacks {
  /** A chunk of output audio (raw PCM, 24kHz 16-bit mono). */
  onAudio?: (pcm: Buffer) => void;
  /** Server transcription of the model's spoken output (if enabled). */
  onOutputText?: (text: string) => void;
  /** Server transcription of the user's input audio (if enabled). */
  onInputText?: (text: string) => void;
  /** The model wants to call one or more functions. */
  onToolCall?: (calls: GeminiLiveToolCall[]) => void;
  /** The model finished its turn (generation complete). */
  onTurnComplete?: () => void;
  /** The user barged in — the model's output was interrupted server-side. */
  onInterrupted?: () => void;
  /**
   * A recoverable hiccup the client is handling itself (steady-state socket
   * error, a message it could not process). The session may surface it as a
   * non-fatal error frame; it must NOT tear anything down — the close/reconnect
   * path owns recovery.
   */
  onError?: (message: string) => void;
  /**
   * The server announced it will drop this connection soon (connection
   * lifetime limit). Informational — the client migrates proactively on its
   * own. `timeLeftMs` is null when the server's duration was unparseable.
   */
  onGoAway?: (timeLeftMs: number | null) => void;
  /**
   * The upstream connection dropped (or is being proactively migrated) and a
   * bounded reconnect sequence is starting. Fired once per outage, not per
   * attempt. The user-facing session stays alive throughout.
   */
  onReconnecting?: (info: { reason: string }) => void;
  /**
   * A reconnect succeeded. `resumed: true` → the same server-side session
   * continues via its resumption handle (full context intact, pending tool
   * calls preserved). `resumed: false` → a brand-new session with only the
   * replayed setup (system instruction + briefing); the conversation turns
   * are NOT in its context — the session layer injects a recap note.
   */
  onReconnected?: (info: { resumed: boolean }) => void;
  /**
   * TERMINAL: the upstream session is over and could not be (or will not be)
   * recovered — reconnect attempts exhausted. Not fired for closes the client
   * recovers from, and not fired for a locally requested `close()`.
   */
  onClose?: (code: number, reason: string) => void;
}

/** Reconnect tuning (test seam; production uses the defaults). */
export interface GeminiLiveReconnectOptions {
  /** Reconnect attempts per outage before giving up. Default 3. */
  maxAttempts?: number;
  /** Delay before attempt N (1-based). Default 250ms · 2^(N−1). */
  backoffMs?: (attempt: number) => number;
}

export interface GeminiLiveConnectOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  tools?: GeminiFunctionDeclaration[];
  /** Sample rate of the audio the client will stream in (usually 16000). */
  inputSampleRate: number;
  /** BCP-47 language pinned for recognition + synthesis (e.g. "en-US"). */
  language?: string;
  /** Prebuilt Gemini voice name (e.g. "Aoede"). */
  voice?: string;
  callbacks: GeminiLiveClientCallbacks;
  /** Test seam: socket factory. Default: `new WebSocket(url)`. */
  createSocket?: (url: string) => GeminiLiveSocket;
  reconnect?: GeminiLiveReconnectOptions;
  /**
   * Send a short frame of silence upstream when nothing has been sent for
   * this long, so an idle send path (push-to-talk between turns, a muted
   * pause) cannot idle-out the upstream socket. 0 disables. Default 10s.
   */
  keepaliveIntervalMs?: number;
  /** Max wait for `setupComplete` per socket attempt. Default 15s. */
  setupTimeoutMs?: number;
}

const DEFAULT_RECONNECT_MAX_ATTEMPTS = 3;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000;
const DEFAULT_SETUP_TIMEOUT_MS = 15_000;
/** Queued-while-disconnected tool responses beyond this are dropped (oldest first). */
const MAX_PENDING_TOOL_RESPONSES = 32;

function defaultBackoffMs(attempt: number): number {
  return 250 * 2 ** (attempt - 1);
}

/**
 * Close codes that mean "the server rejected what we sent" (config/payload),
 * where retrying the same setup verbatim cannot succeed. 1007 is the one
 * observed in the field (invalid setup payload — historically a persona voice
 * field); 1002/1003 are the protocol/data equivalents.
 */
const SETUP_REJECT_CODES = new Set([1002, 1003, 1007]);

/** A close that arrived before `setupComplete` — carries the close code. */
class GeminiLiveSetupCloseError extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(code: number, reason: string) {
    super(`Gemini Live closed before setup (code=${code} ${reason})`);
    this.name = "GeminiLiveSetupCloseError";
    this.code = code;
    this.reason = reason;
  }
}

/** Parse a protobuf JSON Duration ("9.5s") into milliseconds; null if odd. */
function parseDurationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value.trim());
  if (!match) return null;
  return Math.round(Number(match[1]) * 1000);
}

/**
 * A single logical Gemini Live session. Construct, `connect()` (resolves once
 * the server acknowledges setup), then stream audio and relay tool responses.
 * One or more physical sockets may serve the session over its lifetime — the
 * client reconnects across drops (resuming server-side state when the server
 * granted a resumption handle) without the caller changing anything.
 */
export class GeminiLiveClient {
  private ws: GeminiLiveSocket | null = null;
  private readonly opts: GeminiLiveConnectOptions;
  private readonly inputMimeType: string;
  private closed = false;
  /** True while a reconnect sequence is in flight (suppresses re-entry). */
  private reconnecting = false;
  /**
   * Latest session-resumption handle granted by the server (via
   * `sessionResumptionUpdate` messages). Present → an unexpected drop can
   * reattach to the SAME server-side session, context and pending tool calls
   * intact. Absent (server never granted one, or it was consumed by a failed
   * resume) → reconnects fall back to a fresh session.
   */
  private resumptionHandle: string | null = null;
  /**
   * Sticky "the server 1007-rejected our full setup" latch: once set, every
   * subsequent setup (initial retry AND reconnects) is sent without the
   * optional fields, so a config the server hates is never replayed.
   */
  private minimalSetup = false;
  /** Tool responses produced while the socket was down; see class docs. */
  private readonly pendingToolResponses: Array<{
    id?: string;
    name: string;
    response: unknown;
  }> = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastSendAt = 0;

  constructor(opts: GeminiLiveConnectOptions) {
    this.opts = opts;
    this.inputMimeType = `audio/pcm;rate=${opts.inputSampleRate}`;
  }

  /**
   * Open the socket and complete setup. Resolves on `setupComplete`.
   *
   * Config-reject hardening: if the server closes with a setup-reject code
   * (1007 class) before acknowledging setup, the offending config is logged
   * and setup is retried ONCE with the optional fields stripped (voice,
   * language, transcription, context compression) — the past 1007 incident
   * was an optional persona-voice field. A second rejection surfaces honestly.
   */
  async connect(): Promise<void> {
    try {
      await this.openSocket({ resumeHandle: null });
    } catch (err) {
      const rejected =
        err instanceof GeminiLiveSetupCloseError &&
        SETUP_REJECT_CODES.has(err.code);
      if (!rejected || this.minimalSetup || this.closed) throw err;
      log.error(
        {
          code: (err as GeminiLiveSetupCloseError).code,
          reason: (err as GeminiLiveSetupCloseError).reason,
          model: this.opts.model,
          voice: this.opts.voice ?? null,
          language: this.opts.language ?? null,
          toolCount: this.opts.tools?.length ?? 0,
          setup: this.buildSetup(null),
        },
        "gemini-live: setup rejected; retrying once without optional fields",
      );
      this.minimalSetup = true;
      await this.openSocket({ resumeHandle: null });
    }
    this.startKeepalive();
  }

  /** Build the `setup` payload (initial connect and reconnect replays). */
  private buildSetup(resumeHandle: string | null): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {
      responseModalities: ["AUDIO"],
    };
    const setup: Record<string, unknown> = {
      model: this.opts.model,
      generationConfig,
      systemInstruction: {
        parts: [{ text: this.opts.systemInstruction }],
      },
      // Ask the server to mint resumption handles for this session. With a
      // handle, an unexpected drop reattaches to the same server-side session
      // (context + pending tool calls intact) instead of starting over.
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    };
    if (this.opts.tools && this.opts.tools.length > 0) {
      setup.tools = [{ functionDeclarations: this.opts.tools }];
    }
    if (this.minimalSetup) return setup;
    // ── Optional fields below: everything stripped by the 1007 fallback ──
    // Pin recognition + synthesis language + voice so a short first utterance
    // can't be auto-detected as the wrong language, and Cue keeps a stable
    // (female, by default) voice.
    if (this.opts.language || this.opts.voice) {
      const speechConfig: Record<string, unknown> = {};
      if (this.opts.language) speechConfig.languageCode = this.opts.language;
      if (this.opts.voice) {
        speechConfig.voiceConfig = {
          prebuiltVoiceConfig: { voiceName: this.opts.voice },
        };
      }
      generationConfig.speechConfig = speechConfig;
    }
    // Server-side transcription so we can surface user + assistant text
    // frames on the existing protocol (nice-to-have; audio is the product).
    setup.inputAudioTranscription = {};
    setup.outputAudioTranscription = {};
    // Sliding-window context compression: without it the server ENDS the
    // session when the model's context window fills, which is a hard cap on
    // conversation length that no amount of reconnecting fixes (resumption
    // restores the same full context). With it, old turns are compressed away
    // and the session can run indefinitely.
    setup.contextWindowCompression = { slidingWindow: {} };
    return setup;
  }

  /**
   * Open one physical socket and run setup on it. Resolves on
   * `setupComplete`; rejects if the socket errors, closes, or stalls past the
   * setup timeout first (a wedged attempt that neither completes nor closes
   * would otherwise hang the reconnect loop forever — a silent freeze, the one
   * failure shape this file exists to eliminate). After setup, server messages
   * flow to the callbacks and an unexpected close routes to {@link reconnect}.
   */
  private openSocket(opts: { resumeHandle: string | null }): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_LIVE_WS_BASE}?key=${encodeURIComponent(this.opts.apiKey)}`;
      const create =
        this.opts.createSocket ??
        ((u: string) => new WebSocket(u) as unknown as GeminiLiveSocket);
      let ws: GeminiLiveSocket;
      try {
        ws = create(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let setupDone = false;

      const setupTimer = setTimeout(() => {
        if (setupDone) return;
        // Abandon the wedged socket entirely: detach handlers so a late
        // setupComplete can't revive an attempt the loop already gave up on.
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // best-effort
        }
        reject(new Error("Gemini Live setup timed out"));
      }, this.opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS);
      (setupTimer as { unref?: () => void }).unref?.();

      ws.onopen = () => {
        try {
          ws.send(
            JSON.stringify({ setup: this.buildSetup(opts.resumeHandle) }),
          );
        } catch (err) {
          log.warn({ err }, "gemini-live: failed to send setup");
        }
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
          const raw =
            typeof ev.data === "string"
              ? ev.data
              : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (!setupDone && "setupComplete" in msg) {
          setupDone = true;
          clearTimeout(setupTimer);
          resolve();
          return;
        }
        try {
          this.handleServerMessage(msg);
        } catch (err) {
          log.warn({ err }, "gemini-live: error handling server message");
          this.opts.callbacks.onError?.(
            "Gemini Live message handling error (recovered)",
          );
        }
      };

      ws.onerror = () => {
        if (!setupDone) {
          clearTimeout(setupTimer);
          reject(new Error("Gemini Live socket error during setup"));
          return;
        }
        // Steady-state socket errors are always followed by a close event,
        // and the close handler owns recovery — reporting here would
        // double-count every outage. Log only.
        log.warn("gemini-live: socket error (close handler will recover)");
      };

      ws.onclose = (ev: CloseEvent) => {
        // A superseded socket (we already moved this.ws to a replacement
        // during goAway migration or reconnect) has nothing to say.
        if (this.ws !== ws) return;
        if (!setupDone) {
          clearTimeout(setupTimer);
          reject(new GeminiLiveSetupCloseError(ev.code, ev.reason || ""));
          return;
        }
        if (this.closed) return;
        // DROP CLASS 1: any post-setup close used to be terminal — the old
        // handler surfaced it as a fatal error frame and the call ended.
        void this.reconnect(
          `close_${ev.code}${ev.reason ? `:${ev.reason}` : ""}`,
        );
      };
    });
  }

  /**
   * Bounded reconnect after an unexpected drop (or a `goAway` migration).
   *
   * Strategy: prefer resuming the same server-side session via the latest
   * resumption handle; if a resume attempt is itself rejected at setup, the
   * handle is considered spent and the next attempt starts a fresh session
   * (the caller learns which happened via `onReconnected.resumed` and can
   * compensate — e.g. inject a transcript recap). Attempts are capped and
   * backed off; exhausting them fires the terminal `onClose` exactly once.
   */
  private async reconnect(reason: string): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    log.warn({ reason }, "gemini-live: upstream dropped; reconnecting");
    this.opts.callbacks.onReconnecting?.({ reason });

    const maxAttempts =
      this.opts.reconnect?.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS;
    const backoffMs = this.opts.reconnect?.backoffMs ?? defaultBackoffMs;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sleep(backoffMs(attempt));
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      const handle = this.resumptionHandle;
      try {
        await this.openSocket({ resumeHandle: handle });
        this.reconnecting = false;
        const resumed = handle !== null;
        if (resumed) {
          this.flushPendingToolResponses();
        } else {
          // A fresh session never issued the calls these answer; replaying
          // them would inject responses to function calls it never made.
          this.pendingToolResponses.length = 0;
        }
        log.info({ attempt, resumed }, "gemini-live: reconnected");
        this.opts.callbacks.onReconnected?.({ resumed });
        return;
      } catch (err) {
        lastError = err;
        log.warn(
          { attempt, err, resumed: handle !== null },
          "gemini-live: reconnect attempt failed",
        );
        if (handle !== null && err instanceof GeminiLiveSetupCloseError) {
          // The server rejected the resume — the handle is stale/expired.
          // Fall back to a fresh session on the next attempt rather than
          // burning the remaining attempts on a dead handle.
          this.resumptionHandle = null;
        }
      }
    }

    this.reconnecting = false;
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    this.ws = null;
    const code =
      lastError instanceof GeminiLiveSetupCloseError ? lastError.code : 1006;
    const detail =
      lastError instanceof Error ? lastError.message : String(lastError ?? "");
    log.error({ reason, code, detail }, "gemini-live: reconnect exhausted");
    this.opts.callbacks.onClose?.(code, detail || reason);
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    const cb = this.opts.callbacks;

    // DROP CLASS 2: the server warns before it tears a connection down
    // (connection lifetime limits) via `goAway`. Ignoring it made the
    // follow-up close look like a random mid-conversation drop. Migrate
    // proactively: the server is committed to closing this socket, and
    // reconnecting NOW (with the resumption handle) makes the gap as small
    // as we can make it. If the model was mid-utterance the tail of that
    // reply is clipped either way — the server is taking the socket down.
    const goAway = msg.goAway as { timeLeft?: unknown } | undefined;
    if (goAway) {
      const timeLeftMs = parseDurationMs(goAway.timeLeft);
      log.info({ timeLeftMs }, "gemini-live: goAway received; migrating");
      cb.onGoAway?.(timeLeftMs);
      this.migrateSocket();
      return;
    }

    // Resumption-handle refresh. The server periodically mints a new handle
    // for the current point in the session; only `resumable` handles are
    // kept (a non-resumable update means "you cannot reattach here").
    const resumptionUpdate = msg.sessionResumptionUpdate as
      | { newHandle?: string; resumable?: boolean }
      | undefined;
    if (resumptionUpdate) {
      if (resumptionUpdate.resumable && resumptionUpdate.newHandle) {
        this.resumptionHandle = resumptionUpdate.newHandle;
      }
      return;
    }

    const toolCall = msg.toolCall as
      | { functionCalls?: GeminiLiveToolCall[] }
      | undefined;
    if (toolCall?.functionCalls?.length) {
      cb.onToolCall?.(toolCall.functionCalls);
      return;
    }

    const sc = msg.serverContent as
      | {
          modelTurn?: { parts?: Array<Record<string, unknown>> };
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          turnComplete?: boolean;
          interrupted?: boolean;
        }
      | undefined;
    if (!sc) return;

    if (sc.interrupted) cb.onInterrupted?.();
    if (sc.inputTranscription?.text)
      cb.onInputText?.(sc.inputTranscription.text);
    if (sc.outputTranscription?.text)
      cb.onOutputText?.(sc.outputTranscription.text);

    for (const part of sc.modelTurn?.parts ?? []) {
      const inlineData = part.inlineData as
        | { data?: string; mimeType?: string }
        | undefined;
      if (inlineData?.data) {
        cb.onAudio?.(Buffer.from(inlineData.data, "base64"));
      }
    }

    if (sc.turnComplete) cb.onTurnComplete?.();
  }

  /**
   * Proactive migration (goAway): retire the current socket and reconnect.
   * The old socket is detached from `this.ws` FIRST so its close event (which
   * the server will deliver imminently) cannot trigger a second, competing
   * reconnect.
   */
  private migrateSocket(): void {
    if (this.closed || this.reconnecting) return;
    const old = this.ws;
    this.ws = null;
    try {
      old?.close();
    } catch {
      // best-effort
    }
    void this.reconnect("goAway");
  }

  // ── Keepalive ──────────────────────────────────────────────────────

  /**
   * DROP CLASS 4: idle starvation. Hands-free browser sessions stream mic PCM
   * continuously (a muted/silent mic still yields zero-frames — see
   * pcm-capture.ts `setMuted`), which doubles as upstream keepalive. But
   * push-to-talk sessions close their forwarding gate between turns, sending
   * NOTHING upstream while the user reads/thinks — and an idle realtime
   * socket gets culled (by the server or any middlebox on the path). A short
   * frame of silence at the input sample rate goes up whenever the send path
   * has been quiet for a full interval; all-zero PCM cannot trip the server
   * VAD, so it never fakes speech.
   */
  private startKeepalive(): void {
    const interval =
      this.opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    if (interval <= 0 || this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      if (this.closed) return;
      if (!this.ws || this.ws.readyState !== 1) return;
      if (Date.now() - this.lastSendAt < interval) return;
      // 20ms of 16-bit mono silence at the negotiated input rate.
      const samples = Math.max(1, Math.round(this.opts.inputSampleRate * 0.02));
      this.sendAudio(new Uint8Array(samples * 2));
    }, interval);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────

  /** Stream a chunk of input audio (raw PCM at `inputSampleRate`). */
  sendAudio(pcm: Uint8Array): void {
    // During a reconnect gap audio drops silently: realtime audio delivered
    // late is worse than a brief hole, and server VAD re-syncs on live input.
    this.send({
      realtimeInput: {
        audio: {
          data: Buffer.from(pcm).toString("base64"),
          mimeType: this.inputMimeType,
        },
      },
    });
  }

  /** Signal end-of-input so server VAD closes the turn promptly. */
  sendAudioStreamEnd(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /**
   * Inject a text-only user context note (no audio; by default no turn
   * trigger). Used by the session layer after a NON-resumed reconnect to hand
   * the fresh session a recap of the conversation it never saw.
   *
   * `triggerTurn: true` closes the client turn (`turnComplete`), which makes
   * the model respond to the note NOW instead of waiting for the user's next
   * utterance. Used by the deep-task completion path: a finished background
   * task must be announced into the open call, not parked until the user
   * happens to speak again.
   */
  sendUserText(text: string, opts?: { triggerTurn?: boolean }): void {
    this.send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: opts?.triggerTurn === true,
      },
    });
  }

  /**
   * Return function results for tools the model called. If the socket is down
   * (dropped mid tool round-trip — DROP CLASS: the model would wait forever
   * on a response that silently went nowhere), the responses are queued and
   * flushed after a resumed reconnect; a fresh session discards them.
   */
  sendToolResponse(
    responses: Array<{ id?: string; name: string; response: unknown }>,
  ): void {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState !== 1) {
      for (const response of responses) {
        this.pendingToolResponses.push(response);
      }
      while (this.pendingToolResponses.length > MAX_PENDING_TOOL_RESPONSES) {
        this.pendingToolResponses.shift();
      }
      return;
    }
    this.send({ toolResponse: { functionResponses: responses } });
  }

  private flushPendingToolResponses(): void {
    if (this.pendingToolResponses.length === 0) return;
    const responses = this.pendingToolResponses.splice(0);
    log.info(
      { count: responses.length },
      "gemini-live: delivering tool responses queued across reconnect",
    );
    this.send({ toolResponse: { functionResponses: responses } });
  }

  private send(payload: unknown): void {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    this.lastSendAt = Date.now();
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    this.closed = true;
    this.stopKeepalive();
    try {
      this.ws?.close();
    } catch {
      // best-effort
    }
    this.ws = null;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
