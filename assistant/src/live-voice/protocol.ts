import { isVoicePersonaId } from "./voice-personas.js";

const LIVE_VOICE_CLIENT_FRAME_TYPES = [
  "start",
  "audio",
  "ptt_release",
  "interrupt",
  "end",
  "update_config",
] as const;

type LiveVoiceClientFrameType = (typeof LIVE_VOICE_CLIENT_FRAME_TYPES)[number];

const _LIVE_VOICE_SERVER_FRAME_TYPES = [
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

type LiveVoiceServerFrameType = (typeof _LIVE_VOICE_SERVER_FRAME_TYPES)[number];

export const LiveVoiceProtocolErrorCode = {
  InvalidJson: "invalid_json",
  InvalidFrame: "invalid_frame",
  UnknownType: "unknown_type",
  MissingRequiredField: "missing_required_field",
  InvalidField: "invalid_field",
  InvalidAudioPayload: "invalid_audio_payload",
  // The session cannot start because the STT/TTS credentials it needs are
  // missing or non-streaming (WS-E credential preflight). Distinct from
  // transport/field errors so clients can surface a "voice unavailable"
  // affordance instead of a generic error.
  CredentialsUnavailable: "credentials_unavailable",
} as const;

export type LiveVoiceProtocolErrorCode =
  (typeof LiveVoiceProtocolErrorCode)[keyof typeof LiveVoiceProtocolErrorCode];

export interface LiveVoiceProtocolError {
  readonly code: LiveVoiceProtocolErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly frameType?: string;
}

type LiveVoiceParseResult<T> =
  | { ok: true; frame: T }
  | { ok: false; error: LiveVoiceProtocolError };

export interface LiveVoiceAudioConfig {
  readonly mimeType: "audio/pcm";
  readonly sampleRate: number;
  readonly channels: 1;
}

const LIVE_VOICE_TURN_DETECTION_MODES = ["manual", "server_vad"] as const;

export type LiveVoiceTurnDetectionMode =
  (typeof LIVE_VOICE_TURN_DETECTION_MODES)[number];

/**
 * Bounds for the per-session turn-detection overrides carried on the start
 * frame. Kept deliberately wide — they only reject nonsensical values (a
 * sub-100 ms pause would end turns mid-word; a 10 s barge-in guard would make
 * the assistant uninterruptible). The daemon config defaults sit inside these.
 */
export const MIN_SILENCE_THRESHOLD_MS = 100;
export const MAX_SILENCE_THRESHOLD_MS = 5_000;
export const MIN_BARGE_IN_MIN_SPEECH_MS = 0;
export const MAX_BARGE_IN_MIN_SPEECH_MS = 3_000;

export interface LiveVoiceClientStartFrame {
  readonly type: "start";
  readonly conversationId?: string;
  readonly audio: LiveVoiceAudioConfig;
  /**
   * Opt-in continuous full-duplex mode. When absent or `false` (the default),
   * the session is single-utterance: it closes after `tts_done` and rejects any
   * audio received after `ptt_release` with `invalid_audio_payload`. Old clients
   * (which never send this flag) therefore see the exact legacy behavior.
   *
   * When `true`, the session loops back to listening after each `tts_done` so
   * the user can keep talking on the same socket, and post-release audio is
   * accepted as the start of the next utterance / a barge-in.
   */
  readonly fullDuplex?: boolean;
  /**
   * Which voice engine handles this session. `"cascade"` (default when absent)
   * is the STT → full-agent-loop → TTS pipeline. `"gemini-live"` routes to the
   * speech-native Gemini Live realtime engine. Opt-in so the new engine ships
   * dormant and old clients (which never send this) keep the cascade.
   */
  readonly engine?: "cascade" | "gemini-live";
  /**
   * IANA timezone reported by the client's browser (e.g. "Asia/Hong_Kong").
   * Used to ground the assistant's sense of "now" in the user's local time —
   * without it the realtime engine defaults to UTC and tells the user the wrong
   * time. Optional so old clients (which never send it) degrade to a UTC clock
   * plus a prompt to ask the user's timezone rather than assume.
   */
  readonly timezone?: string;
  /**
   * Selectable conversation persona/mode (see voice-personas.ts):
   * "companion" | "reflective" | "cofounder". Absent or unknown → the default
   * companion, so old clients keep today's behaviour. Shapes tone only, not
   * capabilities.
   */
  readonly persona?: string;
  /**
   * Opt in to `tool_activity` server frames — the raw name of each tool the
   * turn actually invokes, so a voice UI can say what it is doing in words
   * instead of showing an unattributed spinner.
   *
   * It is a CAPABILITY FLAG, not a preference, and the reason is compatibility
   * in the dangerous direction. A client that has never heard of a frame type
   * treats it as an unparseable frame, and the web client's `parseServerFrame`
   * classifies that as fatal — so a new daemon streaming a brand-new frame type
   * at an already-shipped client (the desktop app bundles its own web snapshot)
   * would kill live calls mid-sentence. Sending it only to clients that asked
   * makes that impossible: silence is the old behaviour, exactly.
   */
  readonly toolActivity?: boolean;
  /**
   * Turn-detection mode for the session. Absent means "manual" (push-to-talk,
   * exactly today's behavior). "server_vad" opts the session into server-side
   * utterance boundaries: the daemon detects speech onset and trailing
   * silence, emits `speech_started` / `utterance_end` frames, and runs
   * repeated utterance→turn cycles without `ptt_release` frames.
   *
   * Like `toolActivity`, this is a CAPABILITY FLAG: the `speech_started` and
   * `utterance_end` frames are sent ONLY to sessions that opted in, because a
   * client that has never heard of those frame types treats them as fatal
   * unparseable payloads. A client that never asks keeps the old protocol
   * exactly.
   */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
  /**
   * Per-session override for the trailing-silence duration (ms) that ends the
   * user's turn — the "pause before reply" the client exposes as a setting.
   * Absent falls back to the daemon `liveVoice.vad.silenceThresholdMs` config.
   * Only meaningful for `turnDetection: "server_vad"`. Bounded to
   * [{@link MIN_SILENCE_THRESHOLD_MS}, {@link MAX_SILENCE_THRESHOLD_MS}].
   */
  readonly silenceThresholdMs?: number;
  /**
   * Per-session override for the sustained speech (ms) required before the
   * user's speech interrupts the assistant mid-reply — the "interrupt
   * sensitivity" setting (higher = harder to interrupt; 0 disables the guard,
   * making barge-in instant). Absent falls back to the daemon
   * `liveVoice.vad.bargeInMinSpeechMs` config. Consumed by the server-side
   * sustained-speech barge-in guard. Bounded to
   * [{@link MIN_BARGE_IN_MIN_SPEECH_MS}, {@link MAX_BARGE_IN_MIN_SPEECH_MS}].
   */
  readonly bargeInMinSpeechMs?: number;
}

export interface LiveVoiceClientAudioFrame {
  readonly type: "audio";
  readonly dataBase64: string;
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

/**
 * Mid-session tuning update: applies the same turn-detection knobs the start
 * frame carries to the *running* session, so the client can retune "pause
 * before reply" / "interrupt sensitivity" without reconnecting. Each field is
 * optional and independently applied; the same bounds as the start frame apply.
 * Only meaningful for `server_vad` sessions (a no-op on manual sessions).
 */
export interface LiveVoiceClientUpdateConfigFrame {
  readonly type: "update_config";
  readonly silenceThresholdMs?: number;
  readonly bargeInMinSpeechMs?: number;
}

export type LiveVoiceClientFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientAudioFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame
  | LiveVoiceClientUpdateConfigFrame;

interface LiveVoiceBinaryAudioFrame {
  readonly type: "binary_audio";
  readonly data: Uint8Array;
}

interface LiveVoiceServerFrameBase {
  readonly type: LiveVoiceServerFrameType;
  readonly seq: number;
}

export interface LiveVoiceReadyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "ready";
  readonly sessionId: string;
  readonly conversationId: string;
  /**
   * Echoes the turn-detection mode the session is actually running, so
   * clients can detect a daemon that ignored a requested mode. Absent
   * (older daemons) means "manual" — hands-free clients must fall back to
   * their own client-side VAD accordingly.
   */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
}

export interface LiveVoiceBusyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "busy";
  readonly activeSessionId: string;
}

/**
 * Emitted when the server VAD detects user speech. The client MUST
 * immediately flush local TTS playback and return to listening — barge-in is
 * server-detected, and during assistant playback this frame only fires once
 * the sustained-speech guard is satisfied. Sent ONLY to sessions that opted
 * in via `turnDetection: "server_vad"` on the start frame.
 */
export interface LiveVoiceSpeechStartedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "speech_started";
}

/**
 * Emitted when the server VAD closes the utterance and the turn's
 * transcription begins (plays the role ptt_release plays in manual mode).
 * Sent ONLY to sessions that opted in via `turnDetection: "server_vad"` on
 * the start frame.
 */
export interface LiveVoiceUtteranceEndServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "utterance_end";
  readonly reason: "silence" | "max-duration";
}

/**
 * Emitted when server-side barge-in cancels an in-flight assistant turn:
 * sustained user speech aborted the reply (whether still thinking or already
 * speaking). The client MUST flush any queued/playing TTS for the turn — no
 * `tts_done` follows a cancelled turn. Always preceded by the barge-in's
 * `speech_started`. Sent ONLY to sessions that opted in via
 * `turnDetection: "server_vad"` on the start frame.
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
  readonly event?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  /**
   * Turn-detection mode the session is running ("manual" | "server_vad"), so
   * latency metrics can be segmented by endpointing mode. Additive-optional:
   * absent on frames from older daemons.
   */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
  readonly turnId: string;
  readonly metrics?: unknown;
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
   * door actually judged, so untouched turns stay byte-identical.
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
 * Visual result card produced during a live-voice turn. Carries a `ui_surface_*`
 * event's payload verbatim across the socket so the client can hand it straight
 * to `SurfaceRouter` (the same renderer chat uses) with zero translation.
 *
 * `op` collapses the three source events (`ui_surface_{show,update,dismiss}`)
 * into one frame type; `surfaceId` is the shared correlation key across them.
 * `data` is opaque on the wire (same contract as `ui_surface_show`, whose schema
 * treats `data` as `z.record`).
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
 * The tool this turn has just started executing, by its REAL registered name.
 *
 * Sent only to clients that set `toolActivity` on the `start` frame (see that
 * field), and only on the cascade engine, where the turn runs through the agent
 * loop and `tool_use_start` is a real event with a real name. The realtime
 * engine runs its own function calls inside the provider session and never
 * reaches this path, so it emits nothing — and a client that shows nothing is
 * correct there, because nothing is known.
 *
 * `toolName` is deliberately raw and untranslated. Turning `web_search` into
 * words a person reads is presentation, and it belongs to the surface drawing
 * it; a wire that carried prose would invite the daemon to invent a phrase for
 * a tool it does not have copy for, which is the exact failure this frame
 * exists to prevent.
 */
export interface LiveVoiceToolActivityServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "tool_activity";
  /** The turn this tool call belongs to. */
  readonly turnId: string;
  /** Registered tool name, verbatim (`web_search`, `ui_show`, …). */
  readonly toolName: string;
}

/**
 * Ask the client to demote the call room (the full-screen overlay) so the
 * screen behind it — a surface this turn showed, or a pending approval card —
 * is visible while the call continues.
 *
 * Two emitters, two timings (design v37 §W2):
 * - **Reveal** ("voice announces, screen follows"): the turn showed a surface
 *   (`ui_show`/`ui_update` rendered a card and no later `ui_dismiss` took it
 *   away). The frame is deferred to the announcing reply's TTS drain and goes
 *   out immediately AFTER that turn's `tts_done` — never mid-sentence, at most
 *   once per turn. Nothing the model says moves the room; the reveal is a
 *   consequence of showing a surface (the `[-1]` marker stays strip-only).
 * - A pending mid-call approval opens the room through its own
 *   `approval_pending` frame instead — immediately, because a blocked turn
 *   has no speech left to drain.
 *
 * Sent ONLY to sessions that opted in via `turnDetection: "server_vad"` on
 * the start frame (the shared capability-flag convention).
 */
export interface LiveVoiceMinimizeRoomServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "minimize_room";
  /** The turn whose reveal this is. */
  readonly turnId: string;
}

/**
 * How a mid-call approval left the voice surface's featured moment:
 * - `approved` / `denied` — the user decided (any surface: the voice card,
 *   the chat card, a channel bridge).
 * - `expired` — the voice presentation window (45 s) elapsed with no answer.
 *   The underlying confirmation is STILL pending on the normal chat path —
 *   its final consequence belongs to the chat-surface expiry machinery — but
 *   the call stops featuring it.
 * - `superseded` — the turn ended (barge-in, interrupt, call end) before a
 *   decision; the request resolves through the bridge's existing
 *   unresolved-turn semantics.
 */
export type LiveVoiceApprovalOutcome =
  | "approved"
  | "denied"
  | "expired"
  | "superseded";

/**
 * A mid-call turn left a confirmation pending for the user to answer (design
 * v37 §W2 mid-call approval). The client must demote the room IMMEDIATELY —
 * approval ≠ reveal, there is no sentence to wait for — and render the
 * approval card in the conversation view. Resolution rides the ordinary
 * `POST /v1/confirm` path; the voice socket only presents.
 *
 * Sent ONLY to sessions that opted in via `turnDetection: "server_vad"`.
 */
export interface LiveVoiceApprovalPendingServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "approval_pending";
  /** The confirmation's requestId — the `POST /v1/confirm` correlation key. */
  readonly requestId: string;
  /** The turn that is blocked on this decision. */
  readonly turnId: string;
  /** Registered tool name, verbatim (presentation is the surface's job). */
  readonly toolName: string;
  /** Short human summary of what the tool is about to do, when derivable. */
  readonly summary?: string;
  /** Risk level from the confirmation request (e.g. "low" | "medium" | "high"). */
  readonly riskLevel?: string;
  /**
   * The one line of trust language the card renders, verbatim (design v37:
   * "This is the part I can't do alone."). Carried on the wire so the copy
   * has a single owner.
   */
  readonly trustLine: string;
}

/**
 * A previously announced `approval_pending` stopped being the call's featured
 * moment — decided, presentation-expired, or superseded (see
 * {@link LiveVoiceApprovalOutcome}). The client dismisses the voice approval
 * card and promotes the room back to the rung it held before the approval.
 *
 * Sent ONLY to sessions that opted in via `turnDetection: "server_vad"`.
 */
export interface LiveVoiceApprovalResolvedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "approval_resolved";
  readonly requestId: string;
  readonly turnId: string;
  readonly outcome: LiveVoiceApprovalOutcome;
}

export interface LiveVoiceErrorServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "error";
  readonly code: LiveVoiceProtocolErrorCode;
  readonly message: string;
  /**
   * Whether this error ends the session. Omit (or `true`) for a terminal
   * failure; send `false` when the session is still running and the client
   * must NOT tear down.
   *
   * Several conditions here are reported but recovered from — a streaming
   * transcriber emitting a transient poll error and continuing, for instance.
   * Without this field the wire could not say so, so clients treated every
   * `error` frame as fatal and a healthy conversation died on a hiccup the
   * daemon had already absorbed. Optional so older clients (which ignore it)
   * keep exactly their current behaviour.
   */
  readonly fatal?: boolean;
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

type WithoutSeq<T extends LiveVoiceServerFrameBase> = Omit<T, "seq">;

export type LiveVoiceServerFramePayload =
  | WithoutSeq<LiveVoiceReadyServerFrame>
  | WithoutSeq<LiveVoiceBusyServerFrame>
  | WithoutSeq<LiveVoiceSpeechStartedServerFrame>
  | WithoutSeq<LiveVoiceUtteranceEndServerFrame>
  | WithoutSeq<LiveVoiceTurnCancelledServerFrame>
  | WithoutSeq<LiveVoiceSttPartialServerFrame>
  | WithoutSeq<LiveVoiceSttFinalServerFrame>
  | WithoutSeq<LiveVoiceThinkingServerFrame>
  | WithoutSeq<LiveVoiceAssistantTextDeltaServerFrame>
  | WithoutSeq<LiveVoiceTtsAudioServerFrame>
  | WithoutSeq<LiveVoiceTtsDoneServerFrame>
  | WithoutSeq<LiveVoiceMetricsServerFrame>
  | WithoutSeq<LiveVoiceArchivedServerFrame>
  | WithoutSeq<LiveVoiceCardServerFrame>
  | WithoutSeq<LiveVoiceToolActivityServerFrame>
  | WithoutSeq<LiveVoiceMinimizeRoomServerFrame>
  | WithoutSeq<LiveVoiceApprovalPendingServerFrame>
  | WithoutSeq<LiveVoiceApprovalResolvedServerFrame>
  | WithoutSeq<LiveVoiceErrorServerFrame>;

class LiveVoiceServerFrameSequencer {
  private seq: number;

  constructor(initialSeq = 0) {
    this.seq = initialSeq;
  }

  next(frame: LiveVoiceServerFramePayload): LiveVoiceServerFrame {
    this.seq += 1;
    return { ...frame, seq: this.seq } as LiveVoiceServerFrame;
  }

  get lastSeq(): number {
    return this.seq;
  }
}

export function createLiveVoiceServerFrameSequencer(
  initialSeq = 0,
): LiveVoiceServerFrameSequencer {
  return new LiveVoiceServerFrameSequencer(initialSeq);
}

export function parseLiveVoiceClientTextFrame(
  text: string,
): LiveVoiceParseResult<LiveVoiceClientFrame> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return protocolError("invalid_json", "Live voice frame is not valid JSON");
  }

  return validateLiveVoiceClientFrame(parsed);
}

export function validateLiveVoiceClientFrame(
  value: unknown,
): LiveVoiceParseResult<LiveVoiceClientFrame> {
  if (!isRecord(value)) {
    return protocolError(
      "invalid_frame",
      "Live voice frame must be a JSON object",
    );
  }

  if (!("type" in value)) {
    return protocolError(
      "missing_required_field",
      "Live voice frame is missing required field type",
      "type",
    );
  }

  if (typeof value.type !== "string") {
    return protocolError(
      "invalid_field",
      "Live voice frame field type must be a string",
      "type",
    );
  }

  if (!isLiveVoiceClientFrameType(value.type)) {
    return protocolError(
      "unknown_type",
      `Unknown live voice client frame type: ${value.type}`,
      "type",
      value.type,
    );
  }

  switch (value.type) {
    case "start":
      return validateStartFrame(value);
    case "audio":
      return validateAudioFrame(value);
    case "ptt_release":
      return { ok: true, frame: { type: "ptt_release" } };
    case "interrupt":
      return { ok: true, frame: { type: "interrupt" } };
    case "end":
      return { ok: true, frame: { type: "end" } };
    case "update_config":
      return validateUpdateConfigFrame(value);
  }
}

function validateUpdateConfigFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientUpdateConfigFrame> {
  if (
    "silenceThresholdMs" in value &&
    !isIntegerInRange(
      value.silenceThresholdMs,
      MIN_SILENCE_THRESHOLD_MS,
      MAX_SILENCE_THRESHOLD_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `update_config field silenceThresholdMs must be an integer in [${MIN_SILENCE_THRESHOLD_MS}, ${MAX_SILENCE_THRESHOLD_MS}]`,
      "silenceThresholdMs",
      "update_config",
    );
  }
  if (
    "bargeInMinSpeechMs" in value &&
    !isIntegerInRange(
      value.bargeInMinSpeechMs,
      MIN_BARGE_IN_MIN_SPEECH_MS,
      MAX_BARGE_IN_MIN_SPEECH_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `update_config field bargeInMinSpeechMs must be an integer in [${MIN_BARGE_IN_MIN_SPEECH_MS}, ${MAX_BARGE_IN_MIN_SPEECH_MS}]`,
      "bargeInMinSpeechMs",
      "update_config",
    );
  }
  return {
    ok: true,
    frame: {
      type: "update_config",
      ...(typeof value.silenceThresholdMs === "number"
        ? { silenceThresholdMs: value.silenceThresholdMs }
        : {}),
      ...(typeof value.bargeInMinSpeechMs === "number"
        ? { bargeInMinSpeechMs: value.bargeInMinSpeechMs }
        : {}),
    },
  };
}

export function parseLiveVoiceBinaryAudioFrame(
  data: unknown,
): LiveVoiceParseResult<LiveVoiceBinaryAudioFrame> {
  if (data instanceof ArrayBuffer) {
    if (data.byteLength === 0) {
      return invalidAudioPayload(
        "Binary audio frame is empty",
        "data",
        "binary_audio",
      );
    }
    return {
      ok: true,
      frame: { type: "binary_audio", data: new Uint8Array(data) },
    };
  }

  if (ArrayBuffer.isView(data)) {
    if (data.byteLength === 0) {
      return invalidAudioPayload(
        "Binary audio frame is empty",
        "data",
        "binary_audio",
      );
    }
    return {
      ok: true,
      frame: {
        type: "binary_audio",
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      },
    };
  }

  return invalidAudioPayload(
    "Binary audio frame must be ArrayBuffer data",
    "data",
    "binary_audio",
  );
}

function validateStartFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientStartFrame> {
  if (!("audio" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame is missing required field audio",
      "audio",
      "start",
    );
  }

  if (!isRecord(value.audio)) {
    return protocolError(
      "invalid_field",
      "start frame field audio must be an object",
      "audio",
      "start",
    );
  }

  const audio = value.audio;
  const audioConfig = validateAudioConfig(audio);
  if (!audioConfig.ok) return audioConfig;

  if ("conversationId" in value && !isNonEmptyString(value.conversationId)) {
    return protocolError(
      "invalid_field",
      "start frame field conversationId must be a non-empty string",
      "conversationId",
      "start",
    );
  }

  if ("fullDuplex" in value && typeof value.fullDuplex !== "boolean") {
    return protocolError(
      "invalid_field",
      "start frame field fullDuplex must be a boolean",
      "fullDuplex",
      "start",
    );
  }

  if (
    "engine" in value &&
    value.engine !== "cascade" &&
    value.engine !== "gemini-live"
  ) {
    return protocolError(
      "invalid_field",
      "start frame field engine must be 'cascade' or 'gemini-live'",
      "engine",
      "start",
    );
  }

  if ("timezone" in value && !isNonEmptyString(value.timezone)) {
    return protocolError(
      "invalid_field",
      "start frame field timezone must be a non-empty string",
      "timezone",
      "start",
    );
  }

  if ("toolActivity" in value && typeof value.toolActivity !== "boolean") {
    return protocolError(
      "invalid_field",
      "start frame field toolActivity must be a boolean",
      "toolActivity",
      "start",
    );
  }

  if (
    "turnDetection" in value &&
    !isLiveVoiceTurnDetectionMode(value.turnDetection)
  ) {
    return protocolError(
      "invalid_field",
      "start frame field turnDetection must be manual or server_vad",
      "turnDetection",
      "start",
    );
  }

  if (
    "silenceThresholdMs" in value &&
    !isIntegerInRange(
      value.silenceThresholdMs,
      MIN_SILENCE_THRESHOLD_MS,
      MAX_SILENCE_THRESHOLD_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `start frame field silenceThresholdMs must be an integer in [${MIN_SILENCE_THRESHOLD_MS}, ${MAX_SILENCE_THRESHOLD_MS}]`,
      "silenceThresholdMs",
      "start",
    );
  }

  if (
    "bargeInMinSpeechMs" in value &&
    !isIntegerInRange(
      value.bargeInMinSpeechMs,
      MIN_BARGE_IN_MIN_SPEECH_MS,
      MAX_BARGE_IN_MIN_SPEECH_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `start frame field bargeInMinSpeechMs must be an integer in [${MIN_BARGE_IN_MIN_SPEECH_MS}, ${MAX_BARGE_IN_MIN_SPEECH_MS}]`,
      "bargeInMinSpeechMs",
      "start",
    );
  }

  return {
    ok: true,
    frame: {
      type: "start",
      ...(typeof value.conversationId === "string"
        ? { conversationId: value.conversationId }
        : {}),
      ...(value.fullDuplex === true ? { fullDuplex: true } : {}),
      ...(value.engine === "gemini-live" || value.engine === "cascade"
        ? { engine: value.engine }
        : {}),
      ...(typeof value.timezone === "string" && value.timezone.trim()
        ? { timezone: value.timezone }
        : {}),
      // Persona is cosmetic (tone only): accept a valid id, silently drop
      // anything else to the default rather than rejecting the session.
      ...(isVoicePersonaId(value.persona) ? { persona: value.persona } : {}),
      ...(value.toolActivity === true ? { toolActivity: true } : {}),
      ...(isLiveVoiceTurnDetectionMode(value.turnDetection)
        ? { turnDetection: value.turnDetection }
        : {}),
      ...(typeof value.silenceThresholdMs === "number"
        ? { silenceThresholdMs: value.silenceThresholdMs }
        : {}),
      ...(typeof value.bargeInMinSpeechMs === "number"
        ? { bargeInMinSpeechMs: value.bargeInMinSpeechMs }
        : {}),
      audio: audioConfig.frame,
    },
  };
}

function validateAudioFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientAudioFrame> {
  if (!("dataBase64" in value)) {
    return protocolError(
      "missing_required_field",
      "audio frame is missing required field dataBase64",
      "dataBase64",
      "audio",
    );
  }

  if (typeof value.dataBase64 !== "string") {
    return invalidAudioPayload("audio frame dataBase64 must be a string");
  }

  if (!isValidBase64Payload(value.dataBase64)) {
    return invalidAudioPayload("audio frame dataBase64 is malformed");
  }

  return {
    ok: true,
    frame: { type: "audio", dataBase64: value.dataBase64 },
  };
}

function validateAudioConfig(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceAudioConfig> {
  if (!("mimeType" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame audio is missing required field mimeType",
      "audio.mimeType",
      "start",
    );
  }

  if (value.mimeType !== "audio/pcm") {
    return protocolError(
      "invalid_field",
      "start frame audio.mimeType must be audio/pcm",
      "audio.mimeType",
      "start",
    );
  }

  if (!("sampleRate" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame audio is missing required field sampleRate",
      "audio.sampleRate",
      "start",
    );
  }

  if (!isPositiveInteger(value.sampleRate)) {
    return protocolError(
      "invalid_field",
      "start frame audio.sampleRate must be a positive integer",
      "audio.sampleRate",
      "start",
    );
  }

  if (!("channels" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame audio is missing required field channels",
      "audio.channels",
      "start",
    );
  }

  if (value.channels !== 1) {
    return protocolError(
      "invalid_field",
      "start frame audio.channels must be 1",
      "audio.channels",
      "start",
    );
  }

  return {
    ok: true,
    frame: {
      mimeType: "audio/pcm",
      sampleRate: value.sampleRate,
      channels: 1,
    },
  };
}

function isLiveVoiceClientFrameType(
  value: string,
): value is LiveVoiceClientFrameType {
  return (LIVE_VOICE_CLIENT_FRAME_TYPES as readonly string[]).includes(value);
}

function isLiveVoiceTurnDetectionMode(
  value: unknown,
): value is LiveVoiceTurnDetectionMode {
  return (
    typeof value === "string" &&
    (LIVE_VOICE_TURN_DETECTION_MODES as readonly string[]).includes(value)
  );
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidBase64Payload(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value,
  );
}

function invalidAudioPayload(
  message: string,
  field = "dataBase64",
  frameType = "audio",
): LiveVoiceParseResult<never> {
  return protocolError("invalid_audio_payload", message, field, frameType);
}

function protocolError<T = never>(
  code: LiveVoiceProtocolErrorCode,
  message: string,
  field?: string,
  frameType?: string,
): LiveVoiceParseResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(field ? { field } : {}),
      ...(frameType ? { frameType } : {}),
    },
  };
}
