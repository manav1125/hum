/**
 * Live-voice WebSocket wire protocol.
 *
 * Web-app port of the runtime contract defined in
 * `assistant/src/live-voice/protocol.ts`. Field names and shapes mirror that
 * module exactly so the browser client and daemon agree on the wire format.
 *
 * Pure module: no DOM / WebSocket imports.
 *
 * ## Framing
 *
 * - Client control frames ({@link LiveVoiceClientFrame}) are sent as JSON text
 *   frames.
 * - Audio chunks are sent as raw BINARY WebSocket frames (PCM bytes), NOT as
 *   JSON — there is no `audio` client frame on the web side.
 * - Every server frame ({@link LiveVoiceServerFrame}) is JSON text and carries a
 *   monotonically increasing `seq` number.
 */

// ---------------------------------------------------------------------------
// Client frames (text/JSON control frames; audio goes over binary frames)
// ---------------------------------------------------------------------------

export interface LiveVoiceAudioConfig {
  readonly mimeType: "audio/pcm";
  readonly sampleRate: number;
  readonly channels: 1;
}

/**
 * Canonical client capture/upload audio contract — the single source of truth
 * shared by the capture pipeline (`pcm-capture.ts`) and the `start` frame's
 * `audio` config (`live-voice-client.ts`). Mirrors the runtime contract in
 * `assistant/src/live-voice/protocol.ts`.
 *
 * The AudioWorklet (`pcm-downsample-worklet.ts`) cannot import app modules
 * (audio-thread isolation), so it hardcodes the same `16000` — keep its
 * `TARGET_SAMPLE_RATE` in sync with this.
 */
export const LIVE_VOICE_AUDIO_FORMAT: LiveVoiceAudioConfig = {
  mimeType: "audio/pcm",
  sampleRate: 16000,
  channels: 1,
};

export type LiveVoiceTurnDetectionMode = "manual" | "server_vad";

export interface LiveVoiceClientStartFrame {
  readonly type: "start";
  readonly conversationId?: string;
  readonly audio: LiveVoiceAudioConfig;
  /**
   * Opt-in continuous full-duplex mode. When absent/`false` (the default), the
   * session is single-turn: it closes after `tts_done` and the daemon rejects
   * post-`ptt_release` audio. When `true`, the daemon loops back to listening
   * after each `tts_done` so the same socket serves multiple turns. Mirrors the
   * runtime contract in `assistant/src/live-voice/protocol.ts`.
   */
  readonly fullDuplex?: boolean;
  /**
   * Which server voice engine handles this session. Absent/`"cascade"` is the
   * STT → agent-loop → TTS pipeline; `"gemini-live"` routes to the speech-native
   * Gemini Live realtime engine. Mirrors the runtime contract in
   * `assistant/src/live-voice/protocol.ts`.
   */
  readonly engine?: "cascade" | "gemini-live";
  /**
   * IANA timezone from the browser (`Intl.DateTimeFormat().resolvedOptions()
   * .timeZone`) so the assistant grounds "now" in the user's local time instead
   * of defaulting to UTC. Mirrors the runtime contract in
   * `assistant/src/live-voice/protocol.ts`.
   */
  readonly timezone?: string;
  /**
   * Selected conversation persona/mode ("companion" | "reflective" |
   * "cofounder"). Absent/unknown → the default companion. Shapes tone only.
   * Mirrors the runtime contract in `assistant/src/live-voice/protocol.ts`.
   */
  readonly persona?: string;
  /**
   * Opt in to `tool_activity` server frames — the raw name of each tool the
   * turn actually invokes. Mirrors the runtime contract in
   * `assistant/src/live-voice/protocol.ts`.
   *
   * It is a capability flag, not a preference: an older client has never heard
   * of `tool_activity`, and {@link parseServerFrame} classifies an unknown type
   * as a fatal `invalid_json`. Asking for the frame is what makes it safe for
   * the daemon to send it, so a shipped client that never asks keeps exactly
   * today's behaviour.
   */
  readonly toolActivity?: boolean;
  /**
   * Turn-detection mode for the session. Absent means "manual" (push-to-talk).
   * "server_vad" opts into server-side utterance boundaries: the daemon emits
   * `speech_started` / `utterance_end` frames and runs repeated
   * utterance→turn cycles. Like `toolActivity`, it is a capability flag —
   * the daemon sends the new frame types ONLY to sessions that asked. Mirrors
   * the runtime contract in `assistant/src/live-voice/protocol.ts`.
   */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
  /**
   * Per-session override for the trailing-silence duration (ms) that ends the
   * user's turn — the "pause before reply" voice setting. Absent lets the
   * daemon use its configured default. Only meaningful for `server_vad`.
   */
  readonly silenceThresholdMs?: number;
  /**
   * Per-session override for the sustained speech (ms) required to interrupt
   * the assistant mid-reply — the "interrupt sensitivity" voice setting
   * (higher = harder to interrupt; 0 = instant barge-in). Absent lets the
   * daemon use its configured default.
   */
  readonly bargeInMinSpeechMs?: number;
  /**
   * Capability flag: this client's TTS playback is covered by browser echo
   * cancellation (media-element routing — see `tts-playback.ts`), so the
   * assistant's own voice does not loop back through the mic. The daemon uses
   * it to run interruption at normal sensitivity for this session instead of
   * its echo-safe stopgaps (mic gating on the realtime engine, a very high
   * barge-in guard on the cascade). Mirrors the runtime contract in
   * `assistant/src/live-voice/protocol.ts`.
   */
  readonly echoSafePlayback?: boolean;
}

/**
 * Mid-session tuning update — retunes "pause before reply" / "interrupt
 * sensitivity" on the running server_vad session without reconnecting. Each
 * field is optional; the daemon applies changes from the next utterance.
 */
export interface LiveVoiceClientUpdateConfigFrame {
  readonly type: "update_config";
  readonly silenceThresholdMs?: number;
  readonly bargeInMinSpeechMs?: number;
}

/**
 * A photo the user took mid-call, by the id its upload already returned (the
 * composer's own `uploadChatAttachment` path). The daemon persists it into
 * the conversation as its own user message immediately and RUNS NO TURN, so
 * whatever the user says next — before or after the shutter — is answered by
 * a model whose history already has the image. Mirrors the runtime contract
 * in `assistant/src/live-voice/protocol.ts`.
 *
 * MUST NOT be sent unless the session's `ready` frame advertised
 * `attachImage`: an older daemon rejects the frame with a session-fatal
 * `unknown_type`, which would both lose the photo and kill the call.
 */
export interface LiveVoiceClientAttachImageFrame {
  readonly type: "attach_image";
  readonly attachmentId: string;
}

export interface LiveVoiceClientPttReleaseFrame {
  readonly type: "ptt_release";
}

export interface LiveVoiceClientInterruptFrame {
  readonly type: "interrupt";
}

export interface LiveVoiceClientEndFrame {
  readonly type: "end";
}

export type LiveVoiceClientFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame
  | LiveVoiceClientUpdateConfigFrame
  | LiveVoiceClientAttachImageFrame;

// ---------------------------------------------------------------------------
// Server frames (text/JSON; every frame carries `seq`)
// ---------------------------------------------------------------------------

const LIVE_VOICE_SERVER_FRAME_TYPES = [
  "ready",
  "busy",
  "speech_started",
  "utterance_end",
  "turn_cancelled",
  "stt_partial",
  "stt_final",
  "thinking",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "metrics",
  "archived",
  "card",
  "tool_activity",
  "minimize_room",
  "approval_pending",
  "approval_resolved",
  "error",
] as const;

type LiveVoiceServerFrameType = (typeof LIVE_VOICE_SERVER_FRAME_TYPES)[number];

interface LiveVoiceServerFrameBase {
  readonly type: LiveVoiceServerFrameType;
  readonly seq: number;
}

export interface LiveVoiceReadyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "ready";
  readonly sessionId: string;
  readonly conversationId: string;
  /**
   * Echoes the turn-detection mode the session is actually running. Absent
   * (older daemons that ignore the start frame's `turnDetection`) means
   * "manual" — hands-free callers must fall back accordingly.
   */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
  /**
   * Capability advertise: this daemon accepts the `attach_image` client
   * frame (mid-call camera photos). The camera UI renders ONLY when this
   * arrived — an older daemon answers the frame with a session-fatal
   * `unknown_type`, so sending it ungated would lose the photo AND kill the
   * call. Absent (older daemons) means "no camera". Mirrors the runtime
   * contract in `assistant/src/live-voice/protocol.ts`.
   */
  readonly attachImage?: boolean;
}

export interface LiveVoiceBusyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "busy";
  readonly activeSessionId: string;
}

/**
 * Emitted when the server VAD detects user speech. Arrives only on sessions
 * that opted in via `turnDetection: "server_vad"`. Barge-in is
 * server-detected: this frame is the flush-tail-playback signal — the client
 * must stop local TTS playback immediately (even mid-`thinking`) and return
 * to listening. During assistant playback the daemon defers it behind its
 * sustained-speech guard, so a cough or echo blip never flushes a reply.
 */
export interface LiveVoiceSpeechStartedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "speech_started";
}

/**
 * Emitted when the server VAD closes the utterance and the turn's
 * transcription begins (plays the role ptt_release plays in manual mode).
 * Arrives only on sessions that opted in via `turnDetection: "server_vad"`.
 */
export interface LiveVoiceUtteranceEndServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "utterance_end";
  readonly reason: "silence" | "max-duration";
}

/**
 * Emitted when server-side barge-in cancels an in-flight assistant turn:
 * sustained user speech aborted the reply (whether still thinking or already
 * speaking). The client must flush any queued/playing TTS for the turn — no
 * `tts_done` follows a cancelled turn. Always preceded by the barge-in's
 * `speech_started`. Arrives only on sessions that opted in via
 * `turnDetection: "server_vad"`.
 */
export interface LiveVoiceTurnCancelledServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "turn_cancelled";
  readonly turnId: string;
}

export interface LiveVoiceSttPartialServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "stt_partial";
  readonly text: string;
}

export interface LiveVoiceSttFinalServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "stt_final";
  readonly text: string;
}

export interface LiveVoiceThinkingServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "thinking";
  readonly turnId: string;
}

export interface LiveVoiceAssistantTextDeltaServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "assistant_text_delta";
  readonly text: string;
}

export interface LiveVoiceTtsAudioServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "tts_audio";
  readonly mimeType: string;
  readonly sampleRate: number;
  readonly dataBase64: string;
}

export interface LiveVoiceTtsDoneServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "tts_done";
  readonly turnId: string;
}

export interface LiveVoiceMetricsServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "metrics";
  /** Turn-detection mode the session is running; absent on older daemons. */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
  readonly turnId: string;
  readonly sttMs: number | null;
  readonly llmFirstDeltaMs: number | null;
  /**
   * Dispatch-anchored felt latency (assistant-leg dispatch → first delta /
   * first TTS audio). Additive-optional: absent on frames from older daemons.
   */
  readonly dispatchToFirstDeltaMs?: number | null;
  readonly dispatchToFirstAudioMs?: number | null;
  readonly ttsFirstAudioMs: number | null;
  readonly totalMs: number | null;
  /**
   * Unified front-door endpointing figures. Present only on turns the front
   * door actually judged.
   */
  readonly endpointHoldCount?: number;
  readonly endpointDecisionMaxLatencyMs?: number;
}

export interface LiveVoiceArchivedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "archived";
  readonly conversationId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly role?: "user" | "assistant";
  readonly attachmentId?: string;
  readonly attachmentIds?: string[];
  readonly warning?: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * Visual result card produced during a live-voice turn. Port of the runtime
 * contract in `assistant/src/live-voice/protocol.ts` — carries a `ui_surface_*`
 * event's payload verbatim across the socket so the client can build a
 * `Surface` and hand it straight to `SurfaceRouter` with zero translation.
 *
 * `op` collapses the three source events (`ui_surface_{show,update,dismiss}`)
 * into one frame type; `surfaceId` is the shared correlation key across them.
 */
export interface LiveVoiceCardServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "card";
  /** Lifecycle op — mirrors ui_surface_{show,update,dismiss}. */
  readonly op: "show" | "update" | "dismiss";
  /** Stable correlation key across op=show/update/dismiss (the surfaceId). */
  readonly surfaceId: string;
  /** Present for op=show|update. Absent for op=dismiss. */
  readonly surfaceType?: string;
  readonly title?: string;
  readonly data?: Record<string, unknown>;
  readonly actions?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly style?: "primary" | "secondary" | "destructive";
    readonly data?: Record<string, unknown>;
  }>;
  /** The turn this card belongs to (so the client can clear stale cards on a new turn). */
  readonly turnId?: string;
}

/**
 * The tool the current turn has just started executing, by its REAL registered
 * name. Port of the runtime contract in `assistant/src/live-voice/protocol.ts`.
 *
 * Arrives only when the `start` frame set `toolActivity`, and only on the
 * cascade engine — the realtime engine runs its function calls inside the
 * provider session and never reaches this path. `toolName` is untranslated on
 * purpose: turning it into words a person reads is the surface's job, and a
 * surface that has no words for a tool must say something honest rather than
 * let the daemon invent a phrase for it.
 */
export interface LiveVoiceToolActivityServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "tool_activity";
  readonly turnId: string;
  /** Registered tool name, verbatim (`web_search`, `ui_show`, …). */
  readonly toolName: string;
}

/**
 * Ask the client to demote the call room so the screen behind it is visible
 * while the call continues. Port of the runtime contract in
 * `assistant/src/live-voice/protocol.ts` (design v37 §W2, "voice announces,
 * screen follows"): for a revealed surface the daemon sends this strictly
 * AFTER the announcing reply's `tts_done`, never mid-sentence; a pending
 * approval opens the room through `approval_pending` instead. Arrives only
 * on sessions that opted in via `turnDetection: "server_vad"`.
 */
export interface LiveVoiceMinimizeRoomServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "minimize_room";
  readonly turnId: string;
}

/**
 * How a mid-call approval left the voice surface's featured moment. Port of
 * the runtime contract: `expired` means the 45 s presentation window elapsed
 * — the confirmation is STILL pending on the chat path (the chat card stays
 * answerable); `superseded` means the turn ended before a decision.
 */
export type LiveVoiceApprovalOutcome =
  "approved" | "denied" | "expired" | "superseded";

/**
 * A mid-call turn left a confirmation pending for the user (design v37 §W2
 * mid-call approval). The client demotes the room IMMEDIATELY — approval ≠
 * reveal, there is no sentence to wait for — and renders the approval card
 * in the conversation view. Resolution rides the ordinary `POST /v1/confirm`
 * path; the voice socket only presents. Arrives only on sessions that opted
 * in via `turnDetection: "server_vad"`.
 */
export interface LiveVoiceApprovalPendingServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "approval_pending";
  /** The confirmation's requestId — the `POST /v1/confirm` correlation key. */
  readonly requestId: string;
  readonly turnId: string;
  /** Registered tool name, verbatim (presentation is the surface's job). */
  readonly toolName: string;
  /** Short human summary of what the tool is about to do, when derivable. */
  readonly summary?: string;
  readonly riskLevel?: string;
  /** The one line of trust language the card renders, verbatim. */
  readonly trustLine?: string;
}

/**
 * A previously announced `approval_pending` stopped being the call's
 * featured moment (see {@link LiveVoiceApprovalOutcome}). The client
 * dismisses the voice approval card and promotes the room back to the rung
 * it held before the approval. Arrives only on `server_vad` sessions.
 */
export interface LiveVoiceApprovalResolvedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "approval_resolved";
  readonly requestId: string;
  readonly turnId: string;
  readonly outcome: LiveVoiceApprovalOutcome;
}

export interface LiveVoiceErrorServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  /**
   * Whether this error ends the session. Absent → `true` (the historical
   * meaning, and what every older daemon sends).
   *
   * The daemon reports some conditions that it explicitly recovers from — a
   * streaming transcriber emitting a transient poll error and continuing, for
   * instance — over the same frame. With no severity on the wire the client
   * had to treat those as terminal, so a healthy conversation could be torn
   * down mid-sentence by a hiccup the server had already absorbed.
   */
  readonly fatal?: boolean;
  /**
   * The client frame this error is about (e.g. `"attach_image"`), when it
   * concerns one. What lets a failed photo be filed with the shutter that
   * took it — retracting the thumbnail already shown — instead of with the
   * transient transcriber/TTS blips that share `fatal: false`. Absent on
   * errors that are not about a specific frame.
   */
  readonly frameType?: string;
}

export type LiveVoiceServerFrame =
  | LiveVoiceReadyServerFrame
  | LiveVoiceBusyServerFrame
  | LiveVoiceSpeechStartedServerFrame
  | LiveVoiceUtteranceEndServerFrame
  | LiveVoiceTurnCancelledServerFrame
  | LiveVoiceSttPartialServerFrame
  | LiveVoiceSttFinalServerFrame
  | LiveVoiceThinkingServerFrame
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceMetricsServerFrame
  | LiveVoiceArchivedServerFrame
  | LiveVoiceCardServerFrame
  | LiveVoiceToolActivityServerFrame
  | LiveVoiceMinimizeRoomServerFrame
  | LiveVoiceApprovalPendingServerFrame
  | LiveVoiceApprovalResolvedServerFrame
  | LiveVoiceErrorServerFrame;

/**
 * Error frame returned by {@link parseServerFrame} when the raw payload cannot
 * be JSON-parsed or lacks a `type` discriminator.
 */
export interface LiveVoiceInvalidJsonFrame {
  readonly type: "error";
  readonly code: "invalid_json";
  readonly message: string;
  /** Always fatal — a frame we cannot parse is not a condition to continue on. */
  readonly fatal?: true;
}

/**
 * Result returned by {@link parseServerFrame} for a structurally valid frame
 * whose `type` is not in this client's allowlist. Newer daemons may emit frame
 * types this client version does not know; callers must ignore these rather
 * than treat them as protocol errors — an unknown frame killing the call is
 * exactly the compatibility failure the capability-flag convention exists to
 * prevent.
 */
export interface LiveVoiceUnknownServerFrame {
  readonly type: "unknown_frame";
  /** The wire `type` this client does not recognize. */
  readonly frameType: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isLiveVoiceServerFrameType(
  value: unknown,
): value is LiveVoiceServerFrameType {
  return (
    typeof value === "string" &&
    (LIVE_VOICE_SERVER_FRAME_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Parse a raw text frame received from the server into a typed
 * {@link LiveVoiceServerFrame}.
 *
 * Returns a {@link LiveVoiceInvalidJsonFrame} (`code: "invalid_json"`) when the
 * payload is not valid JSON, is not an object, or lacks a string `type`
 * discriminator. A well-formed frame whose `type` is not in this client's
 * allowlist parses to a {@link LiveVoiceUnknownServerFrame} instead, so future
 * protocol additions are ignorable rather than session-fatal.
 */
export function parseServerFrame(
  raw: string,
):
  | LiveVoiceServerFrame
  | LiveVoiceInvalidJsonFrame
  | LiveVoiceUnknownServerFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      type: "error",
      code: "invalid_json",
      message: "Live voice server frame is not valid JSON",
    };
  }

  const frameType =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { type?: unknown }).type
      : undefined;
  if (typeof frameType !== "string") {
    return {
      type: "error",
      code: "invalid_json",
      message: "Live voice server frame has a missing or non-string type",
    };
  }

  if (!isLiveVoiceServerFrameType(frameType)) {
    return { type: "unknown_frame", frameType };
  }

  return parsed as LiveVoiceServerFrame;
}
