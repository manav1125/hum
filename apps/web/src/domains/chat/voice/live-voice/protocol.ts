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
  | LiveVoiceClientEndFrame;

// ---------------------------------------------------------------------------
// Server frames (text/JSON; every frame carries `seq`)
// ---------------------------------------------------------------------------

const LIVE_VOICE_SERVER_FRAME_TYPES = [
  "ready",
  "busy",
  "stt_partial",
  "stt_final",
  "thinking",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "metrics",
  "archived",
  "card",
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
}

export interface LiveVoiceBusyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "busy";
  readonly activeSessionId: string;
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
  readonly turnId: string;
  readonly sttMs: number | null;
  readonly llmFirstDeltaMs: number | null;
  readonly ttsFirstAudioMs: number | null;
  readonly totalMs: number | null;
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
}

export type LiveVoiceServerFrame =
  | LiveVoiceReadyServerFrame
  | LiveVoiceBusyServerFrame
  | LiveVoiceSttPartialServerFrame
  | LiveVoiceSttFinalServerFrame
  | LiveVoiceThinkingServerFrame
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceMetricsServerFrame
  | LiveVoiceArchivedServerFrame
  | LiveVoiceCardServerFrame
  | LiveVoiceErrorServerFrame;

/**
 * Error frame returned by {@link parseServerFrame} when the raw payload cannot
 * be JSON-parsed or lacks a recognized `type` discriminator.
 */
export interface LiveVoiceInvalidJsonFrame {
  readonly type: "error";
  readonly code: "invalid_json";
  readonly message: string;
  /** Always fatal — a frame we cannot parse is not a condition to continue on. */
  readonly fatal?: true;
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
 * payload is not valid JSON, is not an object, or carries an unknown/missing
 * `type` discriminator.
 */
export function parseServerFrame(
  raw: string,
): LiveVoiceServerFrame | LiveVoiceInvalidJsonFrame {
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

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isLiveVoiceServerFrameType((parsed as { type?: unknown }).type)
  ) {
    return {
      type: "error",
      code: "invalid_json",
      message: "Live voice server frame has missing or unknown type",
    };
  }

  return parsed as LiveVoiceServerFrame;
}
