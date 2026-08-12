/**
 * Browser live-voice channel client (WebSocket transport).
 *
 * Web-app counterpart to the macOS `LiveVoiceChannelClient`
 * (`clients/shared/Network/LiveVoiceChannelClient.swift`). One instance drives
 * one live-voice session: it resolves the transport URL (cloud velay token or
 * self-hosted gateway + actor token, via {@link resolveLiveVoiceWsUrl}), opens
 * the WebSocket, sends the `start` frame on open, streams microphone PCM as
 * binary frames, and dispatches parsed server frames as typed events.
 *
 * Wire contract (see `protocol.ts`, ported from
 * `assistant/src/live-voice/protocol.ts`):
 * - `start` / `ptt_release` / `interrupt` / `end` go out as JSON **text** frames.
 * - Audio chunks go out as raw **binary** frames (PCM bytes) — there is no
 *   `audio` client frame on the web side.
 * - Every inbound server frame is JSON text and is parsed via
 *   {@link parseServerFrame}.
 *
 * Connection handshake mirrors the macOS client: a ~10s connect timeout fails
 * the session if no `ready` frame arrives, and a server `busy` frame is handled
 * distinctly from `error`.
 */

import { resolveLiveVoiceWsUrl } from "@/domains/chat/voice/live-voice/connection";
import {
  type LiveVoiceApprovalPendingServerFrame,
  type LiveVoiceApprovalResolvedServerFrame,
  type LiveVoiceArchivedServerFrame,
  type LiveVoiceAssistantTextDeltaServerFrame,
  type LiveVoiceBusyServerFrame,
  type LiveVoiceCardServerFrame,
  type LiveVoiceClientStartFrame,
  type LiveVoiceClientUpdateConfigFrame,
  LIVE_VOICE_AUDIO_FORMAT,
  type LiveVoiceMetricsServerFrame,
  type LiveVoiceMinimizeRoomServerFrame,
  type LiveVoiceReadyServerFrame,
  type LiveVoiceSpeechStartedServerFrame,
  type LiveVoiceSttFinalServerFrame,
  type LiveVoiceSttPartialServerFrame,
  type LiveVoiceThinkingServerFrame,
  type LiveVoiceToolActivityServerFrame,
  type LiveVoiceTtsAudioServerFrame,
  type LiveVoiceTtsDoneServerFrame,
  type LiveVoiceTurnCancelledServerFrame,
  type LiveVoiceTurnDetectionMode,
  type LiveVoiceUtteranceEndServerFrame,
  parseServerFrame,
} from "@/domains/chat/voice/live-voice/protocol";

/** Fail the session if no `ready` frame arrives within this window. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Reason a live-voice session failed, surfaced via the `error` event. */
export type LiveVoiceClientErrorReason =
  "connection-failed" | "protocol-error" | "timeout";

export interface LiveVoiceClientError {
  readonly reason: LiveVoiceClientErrorReason;
  /** Protocol error code from the server `error` frame, when applicable. */
  readonly code?: string;
  readonly message: string;
  /**
   * Whether the session is over. `false` only for a server `error` frame the
   * daemon explicitly marked non-terminal (`fatal: false`) — the socket is
   * still live and the conversation continues; the client has NOT torn down.
   */
  readonly fatal: boolean;
}

/**
 * Why a mid-call photo the transport had already accepted was refused by the
 * daemon:
 * - `unsupported`: the daemon predates the `attach_image` frame entirely
 *   (should be unreachable — the camera is gated on the ready frame's
 *   `attachImage` advertise — but reported honestly if it happens).
 * - `failed`: the daemon knows the frame but could not store the photo.
 */
export interface LiveVoiceAttachImageRejected {
  readonly reason: "unsupported" | "failed";
  readonly message: string;
}

/**
 * Typed event payloads. Names map 1:1 to the server frame types (camelCased),
 * plus `closed` for transport teardown. Frame `seq` is preserved so consumers
 * can order or dedupe.
 */
export interface LiveVoiceClientEventMap {
  ready: LiveVoiceReadyServerFrame;
  /**
   * Server VAD heard the user start speaking. Only ever fires on sessions
   * that connected with `turnDetection: "server_vad"`.
   */
  speechStarted: LiveVoiceSpeechStartedServerFrame;
  /**
   * Server VAD closed the utterance (the hands-free analog of the client's
   * own ptt_release). Only ever fires on `server_vad` sessions.
   */
  utteranceEnd: LiveVoiceUtteranceEndServerFrame;
  /**
   * Server-side barge-in cancelled the in-flight assistant turn: flush any
   * queued/playing TTS — no `tts_done` follows. Only ever fires on
   * `server_vad` sessions.
   */
  turnCancelled: LiveVoiceTurnCancelledServerFrame;
  sttPartial: LiveVoiceSttPartialServerFrame;
  sttFinal: LiveVoiceSttFinalServerFrame;
  thinking: LiveVoiceThinkingServerFrame;
  assistantTextDelta: LiveVoiceAssistantTextDeltaServerFrame;
  ttsAudio: LiveVoiceTtsAudioServerFrame;
  ttsDone: LiveVoiceTtsDoneServerFrame;
  metrics: LiveVoiceMetricsServerFrame;
  archived: LiveVoiceArchivedServerFrame;
  /** Visual result card lifecycle (op: show/update/dismiss). */
  card: LiveVoiceCardServerFrame;
  /**
   * The daemon asked the client to demote the call room so the screen behind
   * it (a revealed surface) is visible. Only ever fires on `server_vad`
   * sessions; for a reveal it arrives strictly after the turn's `tts_done`.
   */
  minimizeRoom: LiveVoiceMinimizeRoomServerFrame;
  /**
   * A mid-call turn left an approval pending for the user — demote the room
   * immediately and render the approval card in the conversation view. Only
   * ever fires on `server_vad` sessions.
   */
  approvalPending: LiveVoiceApprovalPendingServerFrame;
  /**
   * A pending mid-call approval stopped being the call's featured moment
   * (decided / presentation-expired / superseded). Only ever fires on
   * `server_vad` sessions.
   */
  approvalResolved: LiveVoiceApprovalResolvedServerFrame;
  /**
   * A tool the current turn has started executing, named verbatim. Only ever
   * fires because {@link LiveVoiceChannelClient} asked for it on the `start`
   * frame — see the note there.
   */
  toolActivity: LiveVoiceToolActivityServerFrame;
  /**
   * A photo was accepted by the transport but refused by the daemon, so it
   * will never reach the conversation. Distinct from `attachImage` returning
   * false, which is the socket declining to send at all: this one fails
   * after the client believed it had succeeded, and is the only signal the
   * room gets to retract the thumbnail it already showed.
   */
  attachImageRejected: LiveVoiceAttachImageRejected;
  busy: LiveVoiceBusyServerFrame;
  error: LiveVoiceClientError;
  /** Fired exactly once when the transport closes (clean or otherwise). */
  closed: void;
}

export type LiveVoiceClientEventName = keyof LiveVoiceClientEventMap;

export type LiveVoiceClientEventHandler<E extends LiveVoiceClientEventName> = (
  payload: LiveVoiceClientEventMap[E],
) => void;

export interface LiveVoiceConnectArgs {
  assistantId: string;
  /** Optional conversation to attach the session to. */
  conversationId?: string;
  /**
   * Opt into continuous full-duplex mode (default `false`). When set, the
   * daemon keeps the session open across turns instead of closing after
   * `tts_done`, and accepts audio after `ptt_release` for the next utterance.
   */
  fullDuplex?: boolean;
  /**
   * Which server voice engine to use. `"cascade"` (default) is the
   * STT → agent-loop → TTS pipeline; `"gemini-live"` routes to the speech-native
   * Gemini Live realtime engine. Opt-in so the new engine stays dormant.
   */
  engine?: "cascade" | "gemini-live";
  /**
   * Conversation persona/mode ("companion" | "reflective" | "cofounder").
   * Absent → the daemon defaults to companion. Shapes tone only.
   */
  persona?: string;
  /**
   * Turn-detection mode. `"server_vad"` opts into server-side utterance
   * boundaries (`speech_started` / `utterance_end` frames); absent/`"manual"`
   * keeps push-to-talk semantics. The `ready` frame echoes the mode the
   * daemon actually runs — callers must fall back when the echo is missing.
   */
  turnDetection?: LiveVoiceTurnDetectionMode;
  /**
   * Capability flag: this client's TTS playback is echo-cancellable (see
   * `LiveVoiceAudioPlayer.echoSafe`), so the daemon may run interruption at
   * normal sensitivity for this session instead of its echo-safe stopgaps.
   */
  echoSafePlayback?: boolean;
}

/** Factory so tests can inject a mock WebSocket. Defaults to the global. */
export type WebSocketFactory = (url: string) => WebSocket;

export interface LiveVoiceChannelClientOptions {
  /** Override the WebSocket constructor (tests). */
  webSocketFactory?: WebSocketFactory;
  /** Override the connect timeout (tests). */
  connectTimeoutMs?: number;
}

type SessionState = "idle" | "connecting" | "active" | "closed";

/**
 * Browser live-voice WebSocket client. Create one instance per session; after
 * `close()`/`end()`/failure the instance is terminal and must not be reused.
 */
export class LiveVoiceChannelClient {
  private readonly webSocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;

  private state: SessionState = "idle";
  private ws: WebSocket | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private conversationId: string | undefined;
  private fullDuplex = false;
  private engine: "cascade" | "gemini-live" = "cascade";
  private persona: string | undefined;
  private turnDetection: LiveVoiceTurnDetectionMode | undefined;
  private echoSafePlayback = false;
  private attachImageSupported = false;

  private readonly listeners: {
    [E in LiveVoiceClientEventName]: Set<LiveVoiceClientEventHandler<E>>;
  } = {
    ready: new Set(),
    speechStarted: new Set(),
    utteranceEnd: new Set(),
    turnCancelled: new Set(),
    sttPartial: new Set(),
    sttFinal: new Set(),
    thinking: new Set(),
    assistantTextDelta: new Set(),
    ttsAudio: new Set(),
    ttsDone: new Set(),
    metrics: new Set(),
    archived: new Set(),
    card: new Set(),
    minimizeRoom: new Set(),
    approvalPending: new Set(),
    approvalResolved: new Set(),
    toolActivity: new Set(),
    attachImageRejected: new Set(),
    busy: new Set(),
    error: new Set(),
    closed: new Set(),
  };

  constructor(options: LiveVoiceChannelClientOptions = {}) {
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  /**
   * Subscribe to a typed event. Returns an unsubscribe function.
   */
  on<E extends LiveVoiceClientEventName>(
    event: E,
    handler: LiveVoiceClientEventHandler<E>,
  ): () => void {
    this.listeners[event].add(handler);
    return () => {
      this.listeners[event].delete(handler);
    };
  }

  private emit<E extends LiveVoiceClientEventName>(
    event: E,
    payload: LiveVoiceClientEventMap[E],
  ): void {
    for (const handler of this.listeners[event]) {
      handler(payload);
    }
  }

  /**
   * Resolve the transport URL (cloud velay token or self-hosted gateway +
   * actor token), open the WebSocket, and send the `start` frame on open.
   * Resolves once the socket is opening; session readiness is signalled via the
   * `ready` event (or `error` / `busy` if it never arrives).
   */
  async connect({
    assistantId,
    conversationId,
    fullDuplex,
    engine,
    persona,
    turnDetection,
    echoSafePlayback,
  }: LiveVoiceConnectArgs): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "connecting";
    this.conversationId = conversationId;
    this.fullDuplex = fullDuplex === true;
    this.engine = engine === "gemini-live" ? "gemini-live" : "cascade";
    this.persona = persona;
    this.turnDetection = turnDetection;
    this.echoSafePlayback = echoSafePlayback === true;

    let url: string;
    try {
      url = await resolveLiveVoiceWsUrl({ assistantId, conversationId });
    } catch (err) {
      this.fail(
        "connection-failed",
        messageOf(err, "Failed to start live-voice session"),
      );
      return;
    }
    // A late close()/end() during the await must abort the connect.
    if (this.state !== "connecting") return;

    let ws: WebSocket;
    try {
      ws = this.webSocketFactory(url);
    } catch (err) {
      this.fail(
        "connection-failed",
        messageOf(err, "Failed to open live-voice WebSocket"),
      );
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => this.handleOpen();
    ws.onmessage = (event) => this.handleMessage(event);
    ws.onerror = () =>
      this.fail("connection-failed", "Live-voice WebSocket error");
    ws.onclose = () => this.handleClose();

    this.connectTimeout = setTimeout(() => {
      if (this.state === "connecting") {
        this.fail(
          "timeout",
          `Live-voice connection timed out after ${this.connectTimeoutMs}ms`,
        );
      }
    }, this.connectTimeoutMs);
  }

  /** Send a binary PCM audio frame. No-op unless the session is active. */
  sendAudio(pcm: ArrayBuffer): void {
    if (this.state !== "active") return;
    this.trySend(pcm);
  }

  /**
   * Whether the session's `ready` frame advertised the `attach_image`
   * capability. `false` until `ready` arrives, and stays `false` against a
   * daemon that predates the frame — the camera UI must not render then.
   */
  get supportsAttachImage(): boolean {
    return this.attachImageSupported;
  }

  /**
   * Tell the session about a photo the user just took, by the id its upload
   * already returned. The daemon persists it into the conversation as its
   * own user message and runs no turn.
   *
   * Returns whether the frame actually went out. A session that is
   * connecting or reconnecting cannot take it, and the caller has to know:
   * the photo was uploaded and the shutter has already animated, so a silent
   * false start would leave the user believing the assistant can see
   * something it cannot.
   *
   * Refuses to send when the daemon never advertised `attachImage` on
   * `ready`: an old daemon rejects the frame with an unattributed
   * `unknown_type`, which this client treats as session-fatal — losing a
   * photo must never also hang up the call.
   */
  attachImage(attachmentId: string): boolean {
    if (this.state !== "active" || !this.attachImageSupported) {
      return false;
    }
    return this.trySend(JSON.stringify({ type: "attach_image", attachmentId }));
  }

  /** Mark the current push-to-talk segment as released. */
  pttRelease(): void {
    this.sendControlFrame("ptt_release");
  }

  /**
   * Retune the running server_vad session's "pause before reply" /
   * "interrupt sensitivity" without reconnecting. No-op unless the session is
   * active; the daemon ignores it on manual sessions.
   */
  updateConfig(config: {
    silenceThresholdMs?: number;
    bargeInMinSpeechMs?: number;
  }): void {
    if (this.state !== "active") return;
    const frame: LiveVoiceClientUpdateConfigFrame = {
      type: "update_config",
      ...(config.silenceThresholdMs !== undefined
        ? { silenceThresholdMs: config.silenceThresholdMs }
        : {}),
      ...(config.bargeInMinSpeechMs !== undefined
        ? { bargeInMinSpeechMs: config.bargeInMinSpeechMs }
        : {}),
    };
    this.trySend(JSON.stringify(frame));
  }

  /** Interrupt assistant speech for barge-in. */
  interrupt(): void {
    this.sendControlFrame("interrupt");
  }

  /**
   * End the session gracefully: best-effort send `end`, then always close the
   * socket. A quick-cancel while still CONNECTING simply skips the (impossible)
   * `end` send and resolves as a clean close rather than a timeout failure.
   */
  end(): void {
    if (this.state !== "connecting" && this.state !== "active") return;
    // Only the `end` frame is meaningful here, and it's strictly best-effort:
    // trySend() no-ops unless the socket is OPEN, so this never throws while the
    // socket is still CONNECTING. close() is reached unconditionally below.
    this.trySend(JSON.stringify({ type: "end" }));
    this.close();
  }

  /** Close the WebSocket immediately. Idempotent. */
  close(): void {
    if (this.state === "closed") return;
    this.teardown();
    this.emit("closed", undefined);
  }

  private handleOpen(): void {
    if (this.state !== "connecting" || !this.ws) return;
    const browserTimezone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
      } catch {
        return undefined;
      }
    })();
    const startFrame: LiveVoiceClientStartFrame = {
      type: "start",
      audio: LIVE_VOICE_AUDIO_FORMAT,
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      ...(this.fullDuplex ? { fullDuplex: true } : {}),
      ...(this.engine === "gemini-live" ? { engine: "gemini-live" } : {}),
      ...(browserTimezone ? { timezone: browserTimezone } : {}),
      ...(this.persona ? { persona: this.persona } : {}),
      // Ask for `tool_activity`. The daemon sends the frame ONLY to clients
      // that ask, because a client which has never heard of a frame type
      // parses it as `invalid_json` and treats that as fatal — so an
      // unconditional broadcast would kill calls on every already-shipped
      // client. Asking is the handshake that makes the new frame safe.
      toolActivity: true,
      // Same capability-flag convention: asking for server_vad is what makes
      // it safe for the daemon to emit `speech_started` / `utterance_end`.
      ...(this.turnDetection === "server_vad"
        ? { turnDetection: "server_vad" as const }
        : {}),
      // Capability flag: playback on this client is echo-cancellable, so the
      // daemon can run interruption at normal sensitivity for this session.
      ...(this.echoSafePlayback ? { echoSafePlayback: true } : {}),
    };
    this.trySend(JSON.stringify(startFrame));
  }

  private handleMessage(event: MessageEvent): void {
    if (this.state === "closed") return;
    // Inbound audio (if any) arrives as binary; the wire protocol carries all
    // server payloads as JSON text, so binary frames are not expected. Ignore
    // them rather than mis-parsing bytes as JSON.
    if (typeof event.data !== "string") return;

    const frame = parseServerFrame(event.data);
    switch (frame.type) {
      case "ready":
        if (this.state !== "connecting") return;
        this.clearConnectTimeout();
        this.state = "active";
        // The daemon's capability advertise, tracked here so `attachImage`
        // can refuse to send against a daemon that would fatally reject it.
        this.attachImageSupported = frame.attachImage === true;
        this.emit("ready", frame);
        return;
      case "busy":
        this.emit("busy", frame);
        this.close();
        return;
      case "speech_started":
        this.emit("speechStarted", frame);
        return;
      case "utterance_end":
        this.emit("utteranceEnd", frame);
        return;
      case "turn_cancelled":
        this.emit("turnCancelled", frame);
        return;
      case "unknown_frame":
        // A newer daemon sent a frame type this client version does not
        // know. Ignorable by contract — treating it as fatal is how live
        // calls used to die on protocol additions.
        return;
      case "stt_partial":
        this.emit("sttPartial", frame);
        return;
      case "stt_final":
        this.emit("sttFinal", frame);
        return;
      case "thinking":
        this.emit("thinking", frame);
        return;
      case "assistant_text_delta":
        this.emit("assistantTextDelta", frame);
        return;
      case "tts_audio":
        this.emit("ttsAudio", frame);
        return;
      case "tts_done":
        this.emit("ttsDone", frame);
        return;
      case "metrics":
        this.emit("metrics", frame);
        return;
      case "archived":
        this.emit("archived", frame);
        return;
      case "card":
        this.emit("card", frame);
        return;
      case "minimize_room":
        this.emit("minimizeRoom", frame);
        return;
      case "approval_pending":
        this.emit("approvalPending", frame);
        return;
      case "approval_resolved":
        this.emit("approvalResolved", frame);
        return;
      case "tool_activity":
        this.emit("toolActivity", frame);
        return;
      case "error":
        // `frameType` names what the error is about, which is what keeps a
        // failed photo out of the buckets it would otherwise land in: a
        // daemon that could not store the photo answers with a non-fatal
        // error, which would otherwise be filed with the transient
        // transcriber/TTS blips that share `fatal: false` — leaving the user
        // believing the assistant can see something it never received.
        if ("frameType" in frame && frame.frameType === "attach_image") {
          console.warn(`live-voice: photo not attached: ${frame.message}`);
          this.emit("attachImageRejected", {
            reason: frame.code === "unknown_type" ? "unsupported" : "failed",
            message: frame.message,
          });
          return;
        }
        if (frame.fatal === false) {
          // The daemon absorbed this one and kept the session running (e.g. a
          // transcriber's transient poll error). Surface it, keep the socket.
          this.emit("error", {
            reason: "protocol-error",
            message: frame.message,
            fatal: false,
            ...(frame.code ? { code: frame.code } : {}),
          });
          return;
        }
        this.fail("protocol-error", frame.message, frame.code);
        return;
    }
  }

  private handleClose(): void {
    if (this.state === "closed") return;
    // An unexpected transport close before `ready` is a connection failure;
    // otherwise it's a clean teardown.
    if (this.state === "connecting") {
      this.fail(
        "connection-failed",
        "Live-voice WebSocket closed before ready",
      );
      return;
    }
    this.teardown();
    this.emit("closed", undefined);
  }

  private sendControlFrame(type: "ptt_release" | "interrupt"): void {
    if (this.state !== "active") return;
    this.trySend(JSON.stringify({ type }));
  }

  /**
   * Best-effort send: only writes to the socket when it is actually OPEN.
   * Calling `send()` on a CONNECTING (or CLOSING/CLOSED) WebSocket throws
   * `InvalidStateError` in browsers, so guarding on `readyState` keeps a
   * quick-cancel during connect (and any late send) from throwing.
   *
   * Returns whether the write actually happened, for the callers that must
   * not fail silently (`attachImage`: the shutter already animated).
   */
  private trySend(data: string | ArrayBuffer): boolean {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      return true;
    }
    return false;
  }

  private fail(
    reason: LiveVoiceClientErrorReason,
    message: string,
    code?: string,
  ): void {
    if (this.state === "closed") return;
    this.teardown();
    this.emit("error", {
      reason,
      message,
      fatal: true,
      ...(code ? { code } : {}),
    });
    this.emit("closed", undefined);
  }

  private teardown(): void {
    this.state = "closed";
    this.clearConnectTimeout();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout !== null) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
