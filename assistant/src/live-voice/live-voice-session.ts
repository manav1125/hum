import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  MediaTurnDetector,
  type TurnDetectorConfig,
} from "../calls/media-turn-detector.js";
import { sanitizeForTts } from "../calls/tts-text-sanitizer.js";
import type {
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../calls/voice-session-bridge.js";
import { getConfig } from "../config/loader.js";
import type {
  LiveVoiceConfig,
  LiveVoiceFrontModelConfig,
} from "../config/schemas/live-voice.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import {
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";

/**
 * System prompt for a local live-voice turn. The owner is speaking to their own
 * Cue, so it must (a) keep its full identity + capabilities (not collapse into a
 * generic "text assistant"), (b) actually USE its tools rather than refuse, and
 * (c) speak briefly in plain, TTS-safe prose.
 */
const LIVE_VOICE_CONTROL_PROMPT = [
  "You are Cue, your user's personal AI chief-of-staff, in a live spoken voice conversation with them right now.",
  "You have the SAME full capabilities as in chat: your tools, connected apps (email, calendar, Slack, Notion, GitHub, and more), memory of past conversations, tasks, projects, and workspace files.",
  "Act on requests directly by using your tools. Do NOT claim you lack access, tools, or permissions, and never say you are 'just a text-based assistant' — you can take real actions, and you are speaking with your own owner who has already authorized you.",
  // Anti-hallucination: the #1 failure mode is the model narrating an action as
  // done without actually emitting the tool call. In a spoken turn the user
  // can't see the tool ran, so a false "done" is invisible and corrosive.
  "CRITICAL: Never tell the user you have done something (added a task, sent a message, scheduled an event, saved a note) unless you have ACTUALLY called the tool to do it in THIS turn and it succeeded. If a request needs an action, call the tool FIRST, then confirm in past tense only after it returns. If you are only about to do it, say 'let me do that' — do not say it is already done.",
  // Anti-fabrication for LOOKUPS specifically: the model tends to say "let me
  // check" and then invent results (a restaurant's menu, current hours, prices,
  // news, weather) from memory instead of calling web_search. Fabricated facts
  // spoken aloud are indistinguishable from real ones to the user.
  "The SAME rule applies to looking things up: for anything external or current — a place's menu/hours/prices, a search, today's news or weather, live data — you MUST call the `web_search` tool and use its actual results. NEVER describe search results, a menu, or current facts you have not fetched this turn, and never say 'I'm checking now' or 'looks like they have…' unless you actually called `web_search` and it returned. If you cannot look it up, say so in one sentence.",
  // Anti-ramble on failure: TTS reads everything aloud, so a stalled tool
  // search or a missing capability must never become a monologue.
  "If a tool fails or a capability is genuinely unavailable, say ONE short sentence about it and offer a next step or ask a question. Never read tool names, error text, or function names aloud, never apologize repeatedly, and never narrate your internal troubleshooting. Do not try to reconnect apps or manage connections during a voice call.",
  "Speak naturally and briefly, like a real conversation — usually one or two sentences, never more than three. If you need a moment to do something, say so in a few words and then do it.",
  // Visual result cards (the "GPT Live" pattern): the user is looking at a
  // screen, so viewable results should appear as a card, not be narrated or
  // punted. The plain-text rule below governs the SPOKEN reply only.
  "You are on a screen the user can see. When you produce results the user would want to LOOK at — a list of options, search results, a comparison, a table, an image — show them as a visual card using the `ui_show` tool (surfaceType `list`, `table`, or `card`), then give a short one- or two-sentence spoken summary. The card is seen, not spoken, so your spoken reply must NOT read the items one by one — summarize it (e.g. 'Here are five late-night spots in Berawa — the top one's Luigi's Hot Pizza') and let the card carry the detail.",
  "Do NOT offload viewable results to the Review lane just because this is a voice conversation. The Review lane is for background work you'll finish later, not for results you already have right now — when you have the result, show it as a card and summarize it aloud.",
  "Your SPOKEN reply is read aloud by a text-to-speech engine: write plain conversational text ONLY — no markdown, asterisks, headings, bullet points, code blocks, links, or emojis in what you say. This applies to your spoken words, not to the visual card, which may be a structured list or table.",
].join(" ");

/**
 * Skills preactivated on every live-voice turn so their tools are available
 * immediately (no `skill_load` round-trip — better capability AND lower
 * latency). Covers the common spoken requests; the model can still `skill_load`
 * anything else it needs.
 */
const LIVE_VOICE_PREACTIVATED_SKILLS = [
  "tasks",
  "schedule",
  "contacts",
  "messaging",
  "followups",
];
import {
  listProviderIds,
  supportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import type { ResolveStreamingTranscriberOptions } from "../providers/speech-to-text/resolve.js";
import { detectPcm16SpeechActivity } from "../stt/speech-energy.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";
import { extractSpeakableSegments } from "../tts/speakable-segments.js";
import { pickAckPhrase } from "./ack-phrases.js";
import {
  createVoiceFrontDecider,
  type VoiceFrontDecider,
} from "./front-decision.js";
import type {
  LiveVoiceAudioArchiveResult,
  LiveVoiceAudioArchiveRole,
} from "./live-voice-archive.js";
import {
  type LiveVoiceCredentialReadiness,
  resolveLiveVoiceCredentialReadiness,
} from "./live-voice-credential-preflight.js";
import {
  getLiveVoiceMetricsAggregateFields,
  type LiveVoiceMetricsClock,
  LiveVoiceMetricsCollector,
  type LiveVoiceMetricsEvent,
  type LiveVoiceSpokenAckKind,
} from "./live-voice-metrics.js";
import {
  type LiveVoiceSession as LiveVoiceSessionContract,
  type LiveVoiceSessionCloseReason,
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionStartupError,
} from "./live-voice-session-manager.js";
import { finalizeLiveVoiceThread } from "./live-voice-thread.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "./live-voice-tts.js";
import { pickProgressPhrase } from "./progress-phrases.js";
import {
  type LiveVoiceClientFrame,
  type LiveVoiceClientUpdateConfigFrame,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
  type LiveVoiceSpeechStartedServerFrame,
  type LiveVoiceTurnDetectionMode,
  type LiveVoiceUtteranceEndServerFrame,
} from "./protocol.js";
import { synthesizeLiveVoiceSession } from "./synthesize-live-voice-session.js";
import { resolveVoicePersona } from "./voice-personas.js";

type LiveVoiceSessionState =
  | "initializing"
  | "active"
  | "utterance_released"
  | "transcriber_closed"
  | "interrupted"
  | "failed"
  | "closed";

/**
 * TTS synthesis prefetch depth: while one segment's audio is being emitted to
 * the client, at most one more segment's provider stream is already running
 * with its chunks buffering in memory. Emission order is still strictly the
 * segment order (the `ttsQueue` promise chain), so prefetch overlaps the next
 * segment's provider first-chunk latency with the current segment's playback
 * without ever reordering audio.
 */
const TTS_MAX_OPEN_SYNTHESIS_JOBS = 2;

interface TtsSegmentJob {
  readonly text: string;
  // The provider stream was started (the job holds an open-job slot).
  started: boolean;
  // Emission finished; the slot is free for the next queued segment.
  settled: boolean;
  // The job owns the emission slot: provider chunks forward to the client
  // live instead of buffering.
  emitting: boolean;
  // Chunks received while prefetching, flushed in order on promotion.
  // Dropped with the turn on cancellation.
  bufferedChunks: LiveVoiceTtsAudioChunk[];
  // Settles when the provider stream ends; rejects on synthesis failure.
  synthesis: Promise<void> | null;
  // Ordered tts_audio frame writes for this job.
  frames: Promise<void>;
}

// One tool operation observed on a turn. Our bridge forwards `tool_use_start`
// only (no tool_result callback), so `completedAtMs` is inferred: the voice
// agent loop runs tools sequentially, so the next tool starting means the
// previous op returned. `isError`/`resultPreview` are carried in the shape for
// parity with upstream's decider contract but stay unset until the bridge
// grows a structured tool-result callback.
interface TurnProgressOp {
  toolName: string;
  toolUseId?: string;
  startedAtMs: number;
  completedAtMs?: number;
  isError?: boolean;
  resultPreview?: string;
}

// Per-turn tool-activity log and narration cadence state for spoken progress
// updates (liveVoice.frontModel.progress).
interface TurnProgressState {
  ops: TurnProgressOp[];
  // Tool starts since the last narration; the `ops` trigger threshold.
  opsSinceNarration: number;
  // Bumped on every observable tool event; the idle trigger narrates only
  // when it has moved past `narratedEpoch` (or the maxSilenceMs heartbeat).
  stateEpoch: number;
  narratedEpoch: number;
  // 1-based count of narrations actually spoken this turn (prompt context).
  updatesSpoken: number;
  // When the last spoken floor-holder (ack or narration) enqueued; the
  // progress.minGapMs spacing guard. Null until something speaks.
  lastFloorHolderAtMs: number | null;
  // When the turn's TTS last finished emitting a segment — with the
  // playback-tail estimate, the anchor for measuring audible silence.
  lastAudibleAtMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // A narration generation is awaiting the decider; at most one at a time.
  narrationInFlight: boolean;
}

// Newest-first scan for an op that has not completed, optionally filtered by
// tool name (parallel same-name ops resolve newest-first).
function findLastIncompleteOp(
  ops: TurnProgressOp[],
  toolName?: string,
): TurnProgressOp | undefined {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (!op || op.completedAtMs !== undefined) continue;
    if (toolName !== undefined && op.toolName !== toolName) continue;
    return op;
  }
  return undefined;
}

/**
 * Full-duplex sessions stay open across turns, so — unlike single-turn sessions
 * that self-terminate after one `tts_done` — they need an inactivity bound so an
 * abandoned socket doesn't hold a transcriber and turn resources forever. Reset
 * on every inbound client frame; on expiry the session fails and closes.
 */
const LIVE_VOICE_FULL_DUPLEX_IDLE_TIMEOUT_MS = 120_000;

/**
 * Idle-mic chunks retained while the server-VAD detector is idle; flushed on
 * speech onset so the transcriber gets leading context (~1.25 s at the web
 * client's 50 ms batching) without streaming an open quiet mic. The same
 * bounded ring parks speech that lands in the release→re-arm window so the
 * next armed utterance captures it from its onset.
 */
const SERVER_VAD_PRE_ROLL_MAX_CHUNKS = 25;

export type LiveVoiceStreamingTranscriberResolver = (
  options: ResolveStreamingTranscriberOptions,
) => Promise<StreamingTranscriber | null>;

export type LiveVoiceTurnStarter = (
  options: VoiceTurnOptions,
) => Promise<VoiceTurnHandle>;

export type LiveVoiceTtsStreamer = (
  options: LiveVoiceTtsOptions,
) => Promise<LiveVoiceTtsResult>;

export interface LiveVoiceSessionArchiveAudioInput {
  messageId?: string | null;
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
  mimeType: string;
  sampleRate?: number;
  durationMs?: number;
  audio: {
    type: "base64";
    dataBase64: string;
  };
}

export type LiveVoiceSessionAudioArchiver = (
  input: LiveVoiceSessionArchiveAudioInput,
) => LiveVoiceAudioArchiveResult | Promise<LiveVoiceAudioArchiveResult>;

export interface LiveVoiceSessionOptions {
  resolveTranscriber?: LiveVoiceStreamingTranscriberResolver;
  startVoiceTurn?: LiveVoiceTurnStarter;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  archiveAudio?: LiveVoiceSessionAudioArchiver | null;
  emitMetrics?: boolean;
  metricsClock?: LiveVoiceMetricsClock;
  createTurnId?: () => string;
  /**
   * Inactivity bound for full-duplex sessions (ms). Ignored for half-duplex
   * (single-turn) sessions, which self-terminate. Overridable for tests.
   */
  fullDuplexIdleTimeoutMs?: number;
  /**
   * Live-voice config block driving the credential preflight + front-model
   * presence layer. Defaults to `getConfig().liveVoice`; injectable so tests
   * can flip flags without touching global config.
   */
  liveVoiceConfig?: LiveVoiceConfig;
  /**
   * STT/TTS credential preflight resolver (WS-E). `undefined` → the real
   * resolver, gated by `liveVoiceConfig.credentialPreflight`. Pass `null` to
   * force the preflight off, or a stub to control the verdict in tests.
   */
  resolveCredentialReadiness?:
    | (() => Promise<LiveVoiceCredentialReadiness>)
    | null;
  /**
   * Front-model presence layer (semantic endpointing + LLM-phrased acks).
   * `undefined` → built from `liveVoiceConfig.frontModel` when a front-model
   * feature is enabled; injectable for tests. `null` forces static-only acks.
   */
  frontDecider?: VoiceFrontDecider | null;
  /**
   * Overrides the server-VAD turn detector thresholds (test hook). Unset
   * fields fall back to the start frame's per-session overrides, then the
   * `liveVoice.vad` config (whose schema carries the in-code defaults).
   */
  turnDetectorConfig?: TurnDetectorConfig;
  /**
   * Overrides the mean-amplitude energy gate that classifies a server-VAD
   * audio chunk as speech (test hook). Defaults to
   * `DEFAULT_SPEECH_ENERGY_THRESHOLD` in `stt/speech-energy.ts`.
   */
  speechEnergyThreshold?: number;
  /**
   * Overrides the sustained-speech barge-in guard duration (test hook).
   * Stored and retunable via `update_config` in this slice; the server-side
   * guard that consumes it lands with V-1b. Unset falls back to the start
   * frame, then `liveVoice.vad.bargeInMinSpeechMs` config.
   */
  bargeInMinSpeechMs?: number;
}

interface ActiveAssistantTurn {
  token: symbol;
  turnId: string;
  abortController: AbortController;
  handle: VoiceTurnHandle | null;
  /** Final transcript of the utterance this turn answers (filler prompts). */
  utteranceText: string;
  /** Wall-clock launch instant; narration reports elapsed time from it. */
  launchedAtMs: number;
  assistantCompleted: boolean;
  ttsDone: boolean;
  finalized: boolean;
  ttsBuffer: string;
  /**
   * A non-empty speakable segment from the model reached the TTS queue —
   * gates the eager first-segment flush that trades clause quality for
   * speech onset. Filler phrases (acks, narration) leave it untouched.
   */
  ttsSegmentEnqueued: boolean;
  /**
   * Ordered TTS segment jobs for the turn; synthesis runs ahead of emission
   * by at most one job (TTS_MAX_OPEN_SYNTHESIS_JOBS).
   */
  ttsJobs: TtsSegmentJob[];
  /**
   * Serial emission chain: one job's frames fully precede the next's, and
   * the tts_done finale runs only after every job has drained.
   */
  ttsQueue: Promise<void>;
  /** First tts_audio frame actually sent — latches the first-audio metric. */
  ttsAudioStarted: boolean;
  userMessageId: string | null;
  assistantMessageId: string | null;
  userAudioChunks: Buffer[];
  assistantAudioChunks: Buffer[];
  assistantAudioMimeType: string;
  assistantAudioSampleRate?: number;
  /**
   * Presence layer (WS-E): a `first_delta` spoken-ack timer armed when the
   * turn starts and cleared once the assistant produces its first spoken
   * delta (or the turn ends). `firstDeltaSeen` short-circuits the timer;
   * `ackFired` is the one-ack-per-turn budget shared by every ack trigger
   * (`first_delta` timer expiry and `tool_use`).
   */
  ackTimer: ReturnType<typeof setTimeout> | null;
  firstDeltaSeen: boolean;
  /**
   * Counts assistant text deltas seen this turn. A narration generation
   * captures it at launch and discards its result if it moved: text the
   * model produced mid-generation makes the narration stale, and proves the
   * model is alive — which is exactly what narration exists to paper over.
   */
  deltaEpoch: number;
  ackFired: boolean;
  /**
   * An ack generation is awaiting the decider. While true, the ack has not
   * yet stamped `lastFloorHolderAtMs`, so narration must treat it as a
   * floor-holder-in-waiting and stand down — otherwise a progress phrase
   * could land back-to-back with the ack.
   */
  ackGenerationPending: boolean;
  /** Narration cadence state (liveVoice.frontModel.progress). */
  progress: TurnProgressState;
}

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly resolveTranscriber: LiveVoiceStreamingTranscriberResolver;
  private readonly startVoiceTurn: LiveVoiceTurnStarter | null;
  private readonly streamTtsAudio: LiveVoiceTtsStreamer | null;
  private readonly archiveAudio: LiveVoiceSessionAudioArchiver | null;
  private readonly emitMetrics: boolean;
  private readonly metrics: LiveVoiceMetricsCollector;
  private readonly createTurnId: () => string;
  private readonly conversationId: string;
  private readonly fullDuplex: boolean;
  /**
   * Whether THIS client asked for `tool_activity` frames on the `start` frame.
   * Never assumed: a client that did not ask has never heard of the frame type
   * and would treat it as an unparseable — and therefore fatal — payload.
   */
  private readonly toolActivity: boolean;
  /** Base control prompt composed with the selected persona/mode (tone). */
  private readonly voiceControlPrompt: string;
  private readonly fullDuplexIdleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private state: LiveVoiceSessionState = "initializing";
  private transcriber: StreamingTranscriber | null = null;
  private readonly finalTranscriptSegments: string[] = [];
  private outboundFrames: Promise<void> = Promise.resolve();
  private pttReleased = false;
  private assistantTurnStarted = false;
  private activeAssistantTurn: ActiveAssistantTurn | null = null;
  private currentTurnId: string | null = null;
  private currentUserMessageId: string | null = null;
  private currentUserAudioChunks: Buffer[] = [];
  private metricsTurnStarted = false;
  private metricsTurnFinished = false;
  private sessionEndMetricsEmitted = false;
  private readonly options: LiveVoiceSessionOptions;
  /**
   * Effective live-voice config, resolved once at `start()` from
   * `options.liveVoiceConfig` or `getConfig().liveVoice`. Null until start.
   */
  private liveVoiceConfig: LiveVoiceConfig | null = null;
  /** Front-model presence layer, built at `start()` when a feature is on. */
  private frontDecider: VoiceFrontDecider | null = null;
  /** Rotates static ack phrases so consecutive acks vary. */
  private ackCounter = 0;
  /** Rotates the static progress fallbacks across the session's turns. */
  private progressPhraseCounter = 0;
  /**
   * Estimated wall-clock instant the client finishes playing the audio it has
   * been sent: every sent PCM chunk extends it by the chunk's duration
   * (chunks queue gaplessly client-side). Progress narration measures audible
   * silence against it so it never speaks over still-draining playback. Reset
   * on barge-in, when the client discards its queued audio. Barge-in itself
   * stays client-detected (`interrupt` frames) — this is an estimate the
   * daemon keeps, not a VAD.
   */
  private assistantPlaybackTailUntilMs = 0;
  /**
   * Server-side turn detector. Non-null iff the start frame requested
   * `turnDetection: "server_vad"` (built at `start()`, after config resolves).
   * Its presence IS the capability gate: `speech_started` / `utterance_end`
   * frames are only ever emitted through {@link sendServerVadFrame}, which
   * no-ops when this is null.
   */
  private turnDetector: MediaTurnDetector | null = null;
  /**
   * Energy gate for server-VAD speech classification; undefined defers to
   * `DEFAULT_SPEECH_ENERGY_THRESHOLD`.
   */
  private speechEnergyThreshold: number | undefined;
  /**
   * Effective trailing-silence threshold, mirroring the detector's private
   * copy (start seed + `update_config`).
   */
  private silenceThresholdMs = 0;
  /**
   * Sustained-speech barge-in guard duration (ms). Seeded at `start()` and
   * retunable via `update_config`; consumed by the V-1b server-side barge-in
   * guard (stored but not yet read in this slice).
   */
  private bargeInMinSpeechMs = 0;
  /**
   * Bounded ring of idle-mic chunks skipped while the VAD detector is idle,
   * flushed ahead of the first routed chunk on speech onset. Doubles as the
   * parking buffer for speech that lands while the session is between
   * utterances (release → turn → re-arm), flushed by
   * {@link deliverParkedVadSpeech} once listening re-arms.
   */
  private vadPreRollChunks: Buffer[] = [];
  /**
   * The ring holds speech parked during the release→re-arm window; protected
   * from silent-chunk eviction until it flushes.
   */
  private vadPreRollHasSpeech = false;
  /**
   * Detector turn-end that fired while its speech sat parked in the ring;
   * replayed once the parked speech flushes into the next listening turn.
   */
  private vadPendingTurnEnd: "silence" | "max-duration" | null = null;

  constructor(
    context: LiveVoiceSessionFactoryContext,
    options: LiveVoiceSessionOptions = {},
  ) {
    this.context = context;
    this.options = options;
    this.resolveTranscriber =
      options.resolveTranscriber ?? defaultResolveStreamingTranscriber;
    this.startVoiceTurn = options.startVoiceTurn ?? null;
    this.streamTtsAudio = options.streamTtsAudio ?? null;
    this.archiveAudio = options.archiveAudio ?? null;
    this.emitMetrics = options.emitMetrics ?? false;
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.conversationId =
      context.startFrame.conversationId ?? context.sessionId;
    this.fullDuplex = context.startFrame.fullDuplex === true;
    this.toolActivity = context.startFrame.toolActivity === true;
    // Compose the selected conversation mode (companion / reflective /
    // cofounder) onto the base control prompt. Absent/unknown → companion,
    // whose fragment is the base warm default, so behaviour is unchanged.
    const persona = resolveVoicePersona(context.startFrame.persona);
    this.voiceControlPrompt = [
      LIVE_VOICE_CONTROL_PROMPT,
      persona.promptFragment,
    ].join(" ");
    this.fullDuplexIdleTimeoutMs =
      options.fullDuplexIdleTimeoutMs ?? LIVE_VOICE_FULL_DUPLEX_IDLE_TIMEOUT_MS;
    this.metrics = new LiveVoiceMetricsCollector({
      sessionId: context.sessionId,
      conversationId: this.conversationId,
      ...(options.metricsClock ? { clock: options.metricsClock } : {}),
    });
  }

  /**
   * Resolve the effective live-voice config once per session and build the
   * front-model presence layer if any of its features are enabled. Reading
   * config here (not in the constructor) keeps construction side-effect-free
   * and lets tests that never call `start()` skip config entirely.
   */
  private resolveLiveVoiceSettings(): LiveVoiceConfig {
    if (this.liveVoiceConfig) return this.liveVoiceConfig;

    const config = this.options.liveVoiceConfig ?? getConfig().liveVoice;
    this.liveVoiceConfig = config;

    const front = config.frontModel;
    const wantsFrontModel =
      front.spokenAcks || front.semanticEndpointing || front.progress.enabled;
    if (this.options.frontDecider !== undefined) {
      this.frontDecider = this.options.frontDecider;
    } else if (wantsFrontModel) {
      this.frontDecider = createVoiceFrontDecider({ config: front });
    }
    return config;
  }

  private get frontModelConfig(): LiveVoiceFrontModelConfig | null {
    return this.liveVoiceConfig?.frontModel ?? null;
  }

  /**
   * The credential-preflight resolver to run at `start()`, or null to skip.
   * An explicit `options.resolveCredentialReadiness` always wins (including an
   * explicit `null` to force-disable). Otherwise the real resolver runs only
   * when `liveVoice.credentialPreflight` is on AND the session uses the real
   * (default) streaming-transcriber resolver: a caller that injects its own
   * transcriber has bypassed the real STT credential path (this is how the
   * unit tests drive sessions), so validating real credentials there would be
   * both meaningless and wrong. The daemon's `createLiveVoiceSession` injects
   * no transcriber, so production sessions always get the preflight.
   */
  private resolveCredentialPreflight(
    config: LiveVoiceConfig,
  ): (() => Promise<LiveVoiceCredentialReadiness>) | null {
    if (this.options.resolveCredentialReadiness !== undefined) {
      return this.options.resolveCredentialReadiness;
    }
    if (!config.credentialPreflight) return null;
    if (this.options.resolveTranscriber !== undefined) return null;
    return resolveLiveVoiceCredentialReadiness;
  }

  get finalTranscriptText(): string {
    return this.finalTranscriptSegments.join(" ");
  }

  async start(): Promise<void> {
    if (this.state !== "initializing") return;

    const liveVoiceConfig = this.resolveLiveVoiceSettings();
    this.configureTurnDetection(liveVoiceConfig);

    try {
      // Credential preflight (WS-E): reject the session at `start` when the STT
      // or TTS credentials it needs are missing or non-streaming, with a clear
      // message, instead of connecting a transcriber and then falling silent
      // mid-conversation. Fail-safe: any preflight error is swallowed and the
      // session proceeds to the existing transcriber-resolution path, which has
      // its own failure handling — the preflight can only ever add a clearer
      // early rejection, never block an otherwise-working stack.
      const preflight = this.resolveCredentialPreflight(liveVoiceConfig);
      if (preflight) {
        let readiness: LiveVoiceCredentialReadiness | null = null;
        try {
          readiness = await preflight();
        } catch {
          readiness = null;
        }
        if (this.isClosed) return;
        if (readiness?.status === "not-ready") {
          return await this.failStartup(
            readiness.userMessage,
            LiveVoiceProtocolErrorCode.CredentialsUnavailable,
          );
        }
      }

      // Ensure a persisted `conversations` row exists for the id this session
      // attaches turns to. A live-voice session opened without a conversationId
      // (e.g. the Voice surface with no active chat) falls back to the socket
      // session id, which has no row — so the first turn's user-message insert
      // fails its FOREIGN KEY to conversations ("assistant turn could not be
      // started: FOREIGN KEY constraint failed"). Chat never hits this because
      // it creates the row via the conversation-key path; voice must ensure it
      // here. Idempotent: a real conversationId from an existing chat already
      // has its row, so this is a no-op there.
      if (!getConversation(this.conversationId)) {
        createConversation({
          id: this.conversationId,
          conversationType: "standard",
          source: "live-voice",
        });
      }

      const transcriber = await this.resolveTranscriber({
        sampleRate: this.context.startFrame.audio.sampleRate,
      });

      if (this.isClosed) {
        stopTranscriberBestEffort(transcriber);
        return;
      }

      if (!transcriber) {
        return await this.failStartup(unavailableTranscriberMessage());
      }

      this.transcriber = transcriber;
      await transcriber.start((event) => {
        void this.handleTranscriberEvent(event);
      });

      if (this.isClosed) {
        stopTranscriberBestEffort(transcriber);
        this.transcriber = null;
        return;
      }

      this.state = "active";
      this.metrics.markReady();
      this.armIdleTimer();
      await this.sendFrame({
        type: "ready",
        sessionId: this.context.sessionId,
        conversationId: this.conversationId,
        // Echo the mode the session actually runs so a hands-free client can
        // detect a daemon that ignored its requested turnDetection and fall
        // back to client-side VAD. Additive-optional: old clients ignore it.
        turnDetection: this.turnDetection,
      });
    } catch (err) {
      if (err instanceof LiveVoiceSessionStartupError) {
        throw err;
      }

      stopTranscriberBestEffort(this.transcriber);
      this.transcriber = null;
      if (this.isClosed) return;

      await this.failStartup(
        `Live voice transcription could not be started: ${errorMessage(err)}`,
      );
    }
  }

  async handleClientFrame(frame: LiveVoiceClientFrame): Promise<void> {
    if (this.state === "closed" || this.state === "failed") return;

    this.armIdleTimer();

    switch (frame.type) {
      case "audio":
        await this.handleAudio(Buffer.from(frame.dataBase64, "base64"));
        return;
      case "ptt_release":
        await this.releaseFromClient();
        return;
      case "interrupt":
        await this.interrupt();
        return;
      case "end":
        return;
      case "start":
        return;
      case "update_config":
        this.applyConfigUpdate(frame);
        return;
    }
  }

  /**
   * Resolve the server-VAD tunables and build the turn detector when the
   * start frame opted into `turnDetection: "server_vad"`. Precedence for each
   * knob: per-session start-frame override (the client's user setting) >
   * `options` override (test hook) > daemon `liveVoice.vad` config (whose
   * schema defaults are the in-code defaults: 1200 ms silence, 250 ms
   * barge-in guard, 30 s hard cap).
   */
  private configureTurnDetection(config: LiveVoiceConfig): void {
    const vad = config.vad;
    this.speechEnergyThreshold = this.options.speechEnergyThreshold;
    this.bargeInMinSpeechMs =
      this.context.startFrame.bargeInMinSpeechMs ??
      this.options.bargeInMinSpeechMs ??
      vad.bargeInMinSpeechMs;
    this.silenceThresholdMs =
      this.context.startFrame.silenceThresholdMs ??
      this.options.turnDetectorConfig?.silenceThresholdMs ??
      vad.silenceThresholdMs;
    if (this.context.startFrame.turnDetection !== "server_vad") return;

    const detectorConfig: TurnDetectorConfig = {
      silenceThresholdMs: this.silenceThresholdMs,
      maxTurnDurationMs:
        this.options.turnDetectorConfig?.maxTurnDurationMs ??
        vad.maxTurnDurationMs,
    };
    this.turnDetector = new MediaTurnDetector(detectorConfig, {
      onTurnStart: () => this.handleVadSpeechStart(),
      onTurnEnd: (reason) => this.handleVadUtteranceEnd(reason),
    });
  }

  /** The turn-detection mode this session is actually running. */
  private get turnDetection(): LiveVoiceTurnDetectionMode {
    return this.turnDetector ? "server_vad" : "manual";
  }

  /**
   * Effective barge-in guard duration (start seed + `update_config`). The
   * V-1b server-side sustained-speech guard consumes this; exposed so tests
   * can assert the retune path until then.
   */
  get effectiveBargeInMinSpeechMs(): number {
    return this.bargeInMinSpeechMs;
  }

  /** Effective trailing-silence threshold (start seed + `update_config`). */
  get effectiveSilenceThresholdMs(): number {
    return this.silenceThresholdMs;
  }

  /**
   * Apply a mid-session `update_config` frame: retune the live turn
   * detector's pause ("pause before reply") and/or the barge-in guard
   * ("interrupt sensitivity") without reconnecting. Each field is optional
   * and independent; the detector applies threshold changes from the next
   * silence-timer arm. A no-op on manual (non-server_vad) sessions, which
   * have no turn detector.
   */
  private applyConfigUpdate(frame: LiveVoiceClientUpdateConfigFrame): void {
    if (!this.turnDetector) return;
    if (frame.silenceThresholdMs !== undefined) {
      this.turnDetector.setSilenceThresholdMs(frame.silenceThresholdMs);
      this.silenceThresholdMs = frame.silenceThresholdMs;
    }
    if (frame.bargeInMinSpeechMs !== undefined) {
      this.bargeInMinSpeechMs = frame.bargeInMinSpeechMs;
    }
  }

  async handleBinaryAudio(chunk: Uint8Array): Promise<void> {
    if (this.state === "closed" || this.state === "failed") return;
    this.armIdleTimer();
    await this.handleAudio(Buffer.from(chunk));
  }

  async close(_reason: LiveVoiceSessionCloseReason): Promise<void> {
    if (this.isClosed) return;

    const shouldEmitSessionEndMetrics = this.state !== "failed";
    this.state = "closed";
    this.clearIdleTimer();
    this.turnDetector?.dispose();
    stopTranscriberBestEffort(this.transcriber);
    this.transcriber = null;
    await this.cancelAssistantTurn("session_closed");
    if (shouldEmitSessionEndMetrics) {
      await this.emitSessionEndMetrics();
    }
    await this.drainOutboundFrames();

    // End-of-session synthesis + recap. The turn is already cancelled, so the
    // persisted thread is stable. Detached and best-effort: it must never delay
    // or fail the socket teardown. Parks residual to-dos, writes memory, and
    // writes a short first-person recap into the thread (the cascade otherwise
    // ends a call with no summary).
    const conversationId = this.conversationId;
    void (async () => {
      try {
        const synth = await synthesizeLiveVoiceSession(conversationId);
        await finalizeLiveVoiceThread(conversationId, {
          taskTitles: synth.newTaskTitles,
        });
      } catch {
        // Best-effort; a synthesis/recap failure never affects the ended call.
      }
    })();
  }

  private async handleAudio(chunk: Buffer): Promise<void> {
    const detector = this.turnDetector;
    if (detector) {
      await this.handleServerVadAudio(detector, chunk);
      return;
    }

    if (
      this.state === "utterance_released" ||
      this.state === "transcriber_closed"
    ) {
      // Full-duplex sessions loop back to `active` after `tts_done`, at which
      // point the next utterance's audio streams into a fresh transcriber.
      // Audio that arrives in the transient released/closed/turn-in-flight
      // window (before the loop-back) is not part of any live transcription —
      // barge-in is signalled explicitly via the `interrupt` frame — so drop it
      // silently rather than erroring. Legacy (half-duplex) sessions keep the
      // terminal `invalid_audio_payload` rejection.
      if (this.fullDuplex) return;
      await this.sendAudioAfterReleaseError();
      return;
    }

    if (this.state !== "active") return;

    this.collectUserAudio(chunk);
    try {
      this.transcriber?.sendAudio(
        chunk,
        this.context.startFrame.audio.mimeType,
      );
      await this.drainOutboundFrames();
    } catch (err) {
      // This transcriber is the thing that broke, so it cannot carry the next
      // utterance — drop it here and let the turn close resolve a fresh one.
      stopTranscriberBestEffort(this.transcriber);
      this.transcriber = null;
      await this.failTurnKeepingSession(
        `Live voice audio could not be sent to transcription: ${errorMessage(
          err,
        )}`,
        "audio_error",
        LiveVoiceProtocolErrorCode.InvalidAudioPayload,
      );
    }
  }

  /**
   * server_vad ingress: every chunk feeds the energy VAD (never an error
   * frame — audio is accepted in every non-terminal state). While listening,
   * chunks route to the live transcriber; idle silence is held in the bounded
   * pre-roll ring so an open quiet mic never reaches STT; speech that lands
   * in the release→turn→re-arm window parks in the same ring and flushes into
   * the next listening turn ({@link deliverParkedVadSpeech}).
   */
  private async handleServerVadAudio(
    detector: MediaTurnDetector,
    chunk: Buffer,
  ): Promise<void> {
    if (this.isTerminal || this.state === "initializing") return;

    const hasSpeech = detectPcm16SpeechActivity(
      chunk,
      this.speechEnergyThreshold,
    );
    // May fire onTurnStart (speech_started) / onTurnEnd synchronously.
    detector.onMediaChunk(hasSpeech);

    // Idle mic: hold silent chunks in the bounded pre-roll instead of
    // collecting or streaming them; flushed on speech onset so the
    // transcriber still gets leading context ahead of the first syllable.
    if (!hasSpeech && !detector.isActive) {
      this.pushVadPreRoll(chunk, false);
      return;
    }

    if (this.state !== "active") {
      // Between utterances (released / turn in flight / re-arming): park
      // speech so the next armed utterance captures it from onset. Silence
      // with no parked speech is droppable; silence behind parked speech is
      // utterance interior and must stay ordered with it.
      if (!hasSpeech && !this.vadPreRollHasSpeech) return;
      this.pushVadPreRoll(chunk, hasSpeech);
      return;
    }

    for (const preRollChunk of this.takeVadPreRoll()) {
      await this.routeVadAudio(preRollChunk);
    }
    await this.routeVadAudio(chunk);
  }

  /** Forward one server-VAD chunk into the live utterance (mirrors manual). */
  private async routeVadAudio(chunk: Buffer): Promise<void> {
    if (this.state !== "active") return;
    this.collectUserAudio(chunk);
    try {
      this.transcriber?.sendAudio(
        chunk,
        this.context.startFrame.audio.mimeType,
      );
      await this.drainOutboundFrames();
    } catch (err) {
      // Same recovery as the manual path: the broken transcriber cannot carry
      // the next utterance — drop it and let the turn close resolve a fresh one.
      stopTranscriberBestEffort(this.transcriber);
      this.transcriber = null;
      await this.failTurnKeepingSession(
        `Live voice audio could not be sent to transcription: ${errorMessage(
          err,
        )}`,
        "audio_error",
        LiveVoiceProtocolErrorCode.InvalidAudioPayload,
      );
    }
  }

  private pushVadPreRoll(chunk: Buffer, hasSpeech: boolean): void {
    // A full ring never lets idle silence evict parked speech.
    if (
      !hasSpeech &&
      this.vadPreRollHasSpeech &&
      this.vadPreRollChunks.length >= SERVER_VAD_PRE_ROLL_MAX_CHUNKS
    ) {
      return;
    }
    if (hasSpeech) {
      this.vadPreRollHasSpeech = true;
    }
    this.vadPreRollChunks.push(Buffer.from(chunk));
    while (this.vadPreRollChunks.length > SERVER_VAD_PRE_ROLL_MAX_CHUNKS) {
      this.vadPreRollChunks.shift();
    }
  }

  private takeVadPreRoll(): Buffer[] {
    this.vadPreRollHasSpeech = false;
    return this.vadPreRollChunks.splice(0);
  }

  /**
   * Re-arm-time flush: speech parked in the ring while the previous turn
   * wound down belongs to the freshly armed listening turn. Routes it into
   * the new transcriber and, when the detector already closed that parked
   * utterance ({@link vadPendingTurnEnd}), replays its boundary so it turns
   * without requiring more speech. A silence-only ring stays parked as
   * onset leading context. Called by `beginNextListeningTurn` once the
   * session is listening again.
   */
  private async deliverParkedVadSpeech(): Promise<void> {
    if (!this.turnDetector || this.state !== "active") return;
    if (!this.vadPreRollHasSpeech) return;
    const replayTurnEnd = this.vadPendingTurnEnd;
    this.vadPendingTurnEnd = null;
    for (const chunk of this.takeVadPreRoll()) {
      await this.routeVadAudio(chunk);
    }
    if (replayTurnEnd) {
      await this.sendServerVadFrame({
        type: "utterance_end",
        reason: replayTurnEnd,
      });
      await this.releaseUtterance();
    }
  }

  /**
   * VAD speech onset. In this slice the onset frame is unconditional — the
   * V-1b server-side barge-in guard (sustained-speech accumulation before
   * `speech_started` fires during assistant playback) is not here yet, and
   * the client keeps its own amplitude barge-in until it is.
   */
  private handleVadSpeechStart(): void {
    if (this.isTerminal) return;
    void this.sendServerVadFrame({ type: "speech_started" });
  }

  /**
   * VAD closed the utterance — the analog of ptt_release: emit
   * `utterance_end`, then run the standard release path (which stops the
   * transcriber and starts the assistant turn exactly as a client
   * `ptt_release` does today). A boundary that fires while the session is
   * between utterances belongs to speech parked in the pre-roll ring; it is
   * recorded and replayed once the next listening turn arms.
   */
  private handleVadUtteranceEnd(reason: "silence" | "max-duration"): void {
    void (async () => {
      if (this.isTerminal) return;
      if (this.state !== "active") {
        if (this.vadPreRollHasSpeech) {
          this.vadPendingTurnEnd = reason;
        }
        return;
      }
      await this.sendServerVadFrame({ type: "utterance_end", reason });
      await this.releaseUtterance();
    })().catch(() => {});
  }

  /**
   * Client `ptt_release` frame. In server_vad mode it still works as a manual
   * override: force the detector's utterance boundary so the release runs the
   * same `utterance_end` path; without an open detector turn, emit the frame
   * (the hands-free client only leaves `listening` on `utterance_end`) and
   * fall back to a plain release. Manual sessions keep today's behavior
   * byte-for-byte.
   */
  private async releaseFromClient(): Promise<void> {
    const detector = this.turnDetector;
    if (!detector) {
      await this.releaseUtterance();
      return;
    }
    if (detector.isActive) {
      // Fires handleVadUtteranceEnd synchronously, which emits utterance_end
      // (reason "silence" — the manual-release convention) and releases.
      detector.forceEnd();
      await this.drainOutboundFrames();
      return;
    }
    if (this.state === "active") {
      await this.sendServerVadFrame({
        type: "utterance_end",
        reason: "silence",
      });
    }
    await this.releaseUtterance();
  }

  /**
   * Emit a server-VAD protocol frame — but ONLY when this session opted into
   * `turnDetection: "server_vad"` on its start frame. This is the single
   * choke point for the new frame types: a client that never asked has never
   * heard of them and would treat them as fatal unparseable payloads (the
   * same compatibility rule as `tool_activity`).
   */
  private async sendServerVadFrame(
    frame:
      | Omit<LiveVoiceSpeechStartedServerFrame, "seq">
      | Omit<LiveVoiceUtteranceEndServerFrame, "seq">,
  ): Promise<void> {
    if (!this.turnDetector) return;
    await this.sendFrame(frame);
  }

  private async releaseUtterance(): Promise<void> {
    if (this.state === "utterance_released") {
      return;
    }

    if (this.state === "transcriber_closed") {
      this.pttReleased = true;
      this.markPushToTalkReleased();
      await this.startAssistantTurnIfReady();
      await this.drainOutboundFrames();
      return;
    }

    if (this.state !== "active") return;

    this.pttReleased = true;
    this.markPushToTalkReleased();
    this.state = "utterance_released";
    try {
      this.transcriber?.stop();
    } catch (err) {
      // Recovered from below (`transcriber_closed` lets the turn proceed), so
      // the client must keep the session up.
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice transcription could not be stopped: ${errorMessage(
          err,
        )}`,
        fatal: false,
      });
      this.state = "transcriber_closed";
    }
    await this.startAssistantTurnIfReady();
    await this.drainOutboundFrames();
  }

  private async handleTranscriberEvent(
    event: SttStreamServerEvent,
  ): Promise<void> {
    if (
      this.isClosed ||
      this.state === "failed" ||
      this.state === "interrupted"
    ) {
      return;
    }

    switch (event.type) {
      case "partial":
        this.markFirstPartial();
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      case "final": {
        const transcript = event.text.trim();
        if (transcript.length > 0) {
          this.finalTranscriptSegments.push(transcript);
        }
        this.markFinalTranscript();
        await this.sendFrame({ type: "stt_final", text: event.text });
        await this.startAssistantTurnIfReady();
        return;
      }
      case "error":
        // Non-terminal: providers like OpenAI Whisper emit `error` for
        // transient poll failures and continue streaming. Let `closed` /
        // `final` drive turn lifecycle so we don't drain audio buffers or
        // mark the turn cancelled prematurely. `fatal: false` says so on the
        // wire — otherwise the client ends the call on a hiccup we recovered
        // from, which is how live conversations dropped mid-sentence.
        await this.sendFrame({
          type: "error",
          code: LiveVoiceProtocolErrorCode.InvalidField,
          message: event.message,
          fatal: false,
        });
        return;
      case "closed":
        if (!this.isClosed) {
          this.state = "transcriber_closed";
          this.transcriber = null;
          await this.startAssistantTurnIfReady();
        }
        return;
    }
  }

  private async interrupt(): Promise<void> {
    if (this.isClosed || this.state === "failed") return;

    this.state = "interrupted";
    stopTranscriberBestEffort(this.transcriber);
    this.transcriber = null;
    // Barge-in: the client discards its queued audio, so the playback-tail
    // estimate is void. (The interrupt itself stays client-detected.)
    this.assistantPlaybackTailUntilMs = 0;
    await this.cancelAssistantTurn("interrupt");
    await this.drainOutboundFrames();

    // Full-duplex barge-in: cancelling the in-flight turn stops TTS (the abort
    // signal halts further audio); now re-arm listening on the same socket so
    // the user can immediately speak their interrupting utterance. Half-duplex
    // leaves the session terminal — the client reconnects for the next turn.
    if (this.fullDuplex) {
      await this.beginNextListeningTurn();
    }
  }

  /**
   * Full-duplex loop-back: reset all per-turn state and re-arm a fresh
   * transcriber so the session returns to `active` (listening) for the next
   * utterance. Called after `tts_done` and after a barge-in `interrupt`.
   *
   * Bounded and non-leaking:
   * - If the session has been closed/failed (explicit client close, transport
   *   disconnect, error), this is a no-op and holds no resources.
   * - The previous turn's transcriber was already stopped by `ptt_release` /
   *   `interrupt`; we resolve a brand-new one so no zombie transcriber lingers.
   * - Any transcriber resolved after a concurrent close is stopped immediately.
   */
  private async beginNextListeningTurn(): Promise<void> {
    if (this.isClosed || this.state === "failed") return;

    // Reset per-turn bookkeeping so the next exchange gets a fresh turnId and
    // clean metrics/transcript/audio buffers (no cross-turn attribution).
    this.finalTranscriptSegments.length = 0;
    this.pttReleased = false;
    this.assistantTurnStarted = false;
    this.activeAssistantTurn = null;
    this.currentTurnId = null;
    this.currentUserMessageId = null;
    this.currentUserAudioChunks = [];
    this.metricsTurnStarted = false;
    this.metricsTurnFinished = false;

    let transcriber: StreamingTranscriber | null;
    try {
      transcriber = await this.resolveTranscriber({
        sampleRate: this.context.startFrame.audio.sampleRate,
      });
    } catch (err) {
      if (this.isClosed) return;
      await this.failStartupSoft(
        `Live voice transcription could not be restarted: ${errorMessage(err)}`,
      );
      return;
    }

    if (this.isTerminal) {
      stopTranscriberBestEffort(transcriber);
      return;
    }

    if (!transcriber) {
      await this.failStartupSoft(unavailableTranscriberMessage());
      return;
    }

    try {
      this.transcriber = transcriber;
      await transcriber.start((event) => {
        void this.handleTranscriberEvent(event);
      });
    } catch (err) {
      stopTranscriberBestEffort(transcriber);
      this.transcriber = null;
      if (this.isClosed) return;
      await this.failStartupSoft(
        `Live voice transcription could not be restarted: ${errorMessage(err)}`,
      );
      return;
    }

    if (this.isTerminal) {
      stopTranscriberBestEffort(transcriber);
      this.transcriber = null;
      return;
    }

    this.state = "active";

    // Speech that landed while the previous turn wound down sits parked in
    // the server-VAD pre-roll ring; it belongs to this fresh listening turn.
    await this.deliverParkedVadSpeech();
  }

  /**
   * Fail the session without throwing (mid-session variant of `failStartup`).
   * Used by the full-duplex loop-back where there is no manager `start()` frame
   * on the stack to propagate a startup error to.
   */
  private async failStartupSoft(message: string): Promise<void> {
    if (this.isClosed || this.state === "failed") return;
    this.state = "failed";
    this.clearIdleTimer();
    stopTranscriberBestEffort(this.transcriber);
    this.transcriber = null;
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidField,
      message,
    });
  }

  /**
   * (Re)arm the inactivity bound for full-duplex sessions. No-op for half-duplex
   * sessions (they self-terminate after one turn) and once the session is
   * closed/failed. Reset on every inbound client frame and after `ready`.
   */
  private armIdleTimer(): void {
    if (!this.fullDuplex) return;
    if (this.isClosed || this.state === "failed") return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.handleIdleTimeout();
    }, this.fullDuplexIdleTimeoutMs);
    // Do not keep the process alive solely for this timer.
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Inactivity expiry: tear down turn resources and fail the session so it does
   * not hold a transcriber / assistant turn open indefinitely. The client (or
   * the WebSocket close) then releases the session via the manager.
   */
  private async handleIdleTimeout(): Promise<void> {
    if (this.isClosed || this.state === "failed") return;
    await this.cancelAssistantTurn("idle_timeout");
    await this.failStartupSoft(
      "Live voice session closed after inactivity timeout.",
    );
  }

  private async startAssistantTurnIfReady(): Promise<void> {
    if (
      !this.pttReleased ||
      this.assistantTurnStarted ||
      this.isClosed ||
      this.state === "failed"
    ) {
      return;
    }
    if (this.state !== "transcriber_closed") {
      return;
    }
    if (!this.startVoiceTurn) return;

    const content = this.finalTranscriptText.trim();
    if (content.length === 0) {
      // Nothing to answer — a cough, a door, background noise that tripped the
      // client's automatic push-to-talk release. There is no assistant turn to
      // run, but the utterance still has to be CLOSED: the transcriber was
      // stopped by `ptt_release`, so a full-duplex session that just returns
      // here is alive on the socket and permanently deaf — it never sends
      // `tts_done`, never re-arms, and the call silently stops working until
      // the inactivity timeout eventually kills it minutes later. Close the
      // turn and loop back to listening exactly as a completed turn does.
      //
      // Latch first: `ptt_release` and the transcriber's `closed` event both
      // reach here for the same utterance, so without it the empty turn would
      // be closed — and listening re-armed — twice.
      this.assistantTurnStarted = true;
      await this.endTurnWithoutAnswer("empty_transcript");
      return;
    }

    this.assistantTurnStarted = true;
    const token = Symbol("live-voice-assistant-turn");
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    const abortController = new AbortController();
    const newTurn: ActiveAssistantTurn = {
      token,
      turnId,
      abortController,
      handle: null,
      utteranceText: content,
      launchedAtMs: Date.now(),
      assistantCompleted: false,
      ttsDone: false,
      finalized: false,
      ttsBuffer: "",
      ttsSegmentEnqueued: false,
      ttsJobs: [],
      ttsQueue: Promise.resolve(),
      ttsAudioStarted: false,
      userMessageId: this.currentUserMessageId,
      assistantMessageId: null,
      userAudioChunks: this.currentUserAudioChunks,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
      ackTimer: null,
      firstDeltaSeen: false,
      deltaEpoch: 0,
      ackFired: false,
      ackGenerationPending: false,
      progress: {
        ops: [],
        opsSinceNarration: 0,
        // Equal epochs at launch: a turn that has done nothing observable yet
        // has nothing to narrate, so the idle trigger waits for tool activity
        // or the maxSilenceMs heartbeat.
        stateEpoch: 0,
        narratedEpoch: 0,
        updatesSpoken: 0,
        lastFloorHolderAtMs: null,
        lastAudibleAtMs: Date.now(),
        idleTimer: null,
        narrationInFlight: false,
      },
    };
    this.activeAssistantTurn = newTurn;

    await this.sendFrame({ type: "thinking", turnId });
    if (!this.isActiveAssistantTurn(token)) return;

    // Presence layer (WS-E): arm a floor-holding spoken-ack timer. If the
    // assistant is slow to produce its first spoken delta, a short "one sec"
    // is spoken so a slow turn feels responsive instead of dead-silent.
    // Cleared the moment the first delta arrives (or the turn ends).
    this.armFirstDeltaAckTimer(token, turnId, content);

    // Progress narration speaks into the turn's audible dead air on a
    // cadence, wherever in the turn it occurs; without TTS or a decider
    // there is nothing to speak (the idle trigger's static fallback still
    // needs a generation attempt to fall back from).
    if (
      this.frontModelConfig?.progress.enabled &&
      this.streamTtsAudio &&
      this.frontDecider
    ) {
      this.armProgressIdleTimer(newTurn);
    }

    try {
      const handle = await this.startVoiceTurn({
        conversationId: this.conversationId,
        voiceSessionId: this.context.sessionId,
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
        userMessageInterface: "macos",
        assistantMessageInterface: "macos",
        voiceControlPrompt: this.voiceControlPrompt,
        // The live-voice socket is authenticated as the instance owner, who is
        // the guardian. Without this the turn runs as a non-guardian caller and
        // the bridge strips every side-effect tool ("this action requires
        // guardian-level access"), so the assistant refuses tasks it can do.
        trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
        // Give the assistant its common capabilities up front — otherwise a
        // fresh voice conversation only has core tools and cannot add a task,
        // schedule, etc. until it discovers and `skill_load`s them.
        preactivatedSkillIds: LIVE_VOICE_PREACTIVATED_SKILLS,
        approvalMode: "local-live-voice",
        content,
        isInbound: true,
        signal: abortController.signal,
        callbacks: {
          assistant_text_delta: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            this.noteFirstAssistantDelta(token);
            this.markFirstAssistantDelta(turnId);
            void this.sendFrame({
              type: "assistant_text_delta",
              text: msg.text,
            });
            this.bufferAssistantTextForTts(token, msg.text);
          },
          message_complete: (msg) => {
            const activeTurn = this.activeAssistantTurn;
            if (
              activeTurn?.token !== token ||
              activeTurn.assistantCompleted ||
              this.isClosed
            ) {
              return;
            }
            activeTurn.assistantCompleted = true;
            if (msg.type === "generation_cancelled") {
              // A cancelled generation is the quietest way a call died: no
              // error frame at all, no `tts_done`, no re-arm — the session just
              // stopped hearing, mid-conversation, with nothing on screen to
              // say so. Close the turn so the floor comes back to the user.
              void (async () => {
                await this.finalizeAssistantTurn(
                  activeTurn,
                  "cancelled",
                  "generation_cancelled",
                );
                if (this.isTerminal) return;
                await this.endTurnWithoutAnswer("generation_cancelled");
              })();
              return;
            }
            activeTurn.assistantMessageId = msg.messageId ?? null;
            this.completeTtsForTurn(token);
          },
          persisted_user_message_id: (messageId) => {
            const activeTurn = this.activeAssistantTurn;
            if (activeTurn?.token !== token) return;
            activeTurn.userMessageId = messageId;
            this.currentUserMessageId = messageId;
          },
          persisted_assistant_message_id: (messageId) => {
            const activeTurn = this.activeAssistantTurn;
            if (activeTurn?.token !== token) return;
            activeTurn.assistantMessageId = messageId;
          },
          // Visual result cards: forward the agent loop's `ui_surface_*` events
          // across the socket as `card` frames so lists/tables/etc. render inline
          // above the orb. Gated by the same forwarding guard as text deltas so a
          // barged-in / finalized turn doesn't leak stale cards.
          ui_surface_show: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            void this.sendFrame({
              type: "card",
              op: "show",
              surfaceId: msg.surfaceId,
              surfaceType: msg.surfaceType,
              title: msg.title,
              data: msg.data as Record<string, unknown>,
              actions: msg.actions,
              turnId,
            });
          },
          ui_surface_update: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            void this.sendFrame({
              type: "card",
              op: "update",
              surfaceId: msg.surfaceId,
              data: msg.data as Record<string, unknown>,
              turnId,
            });
          },
          ui_surface_dismiss: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            void this.sendFrame({
              type: "card",
              op: "dismiss",
              surfaceId: msg.surfaceId,
              turnId,
            });
          },
          // The tool this turn is actually touching, by its real name, so the
          // call screen can say what it is doing while it thinks instead of
          // showing an unattributed wait. Gated on the client having asked for
          // the frame type (see `toolActivity` on the start frame) and on the
          // same forwarding guard as the text deltas, so a barged-in turn
          // cannot leave a stale activity on screen.
          tool_use_start: (msg) => {
            // Progress + spoken-ack bookkeeping first: it is daemon-internal,
            // so it is NOT gated on the client having asked for
            // `tool_activity` frames.
            if (this.isForwardingAssistantText(token)) {
              const current = this.activeAssistantTurn;
              if (current?.token === token) {
                this.recordToolUseStart(
                  current,
                  msg.toolName,
                  typeof msg.toolUseId === "string" ? msg.toolUseId : undefined,
                );
              }
            }
            if (!this.toolActivity) return;
            if (!this.isForwardingAssistantText(token)) return;
            void this.sendFrame({
              type: "tool_activity",
              turnId,
              toolName: msg.toolName,
            });
          },
        },
        onError: (message) => {
          const activeTurn = this.activeAssistantTurn;
          if (
            !this.isActiveAssistantTurn(token) ||
            activeTurn?.assistantCompleted
          ) {
            return;
          }
          void (async () => {
            const currentTurn = this.activeAssistantTurn;
            if (currentTurn?.token === token) {
              await this.finalizeAssistantTurn(
                currentTurn,
                "cancelled",
                "error",
              );
            }
            // The brain failed this ONE turn. Say so, then hand the floor back
            // — killing the whole call over a single bad turn is what the user
            // experiences as the conversation dropping out.
            await this.failTurnKeepingSession(message, "error");
          })();
        },
      });

      const activeTurn = this.activeAssistantTurn;
      if (activeTurn?.token !== token) {
        handle.abort();
        return;
      }
      if (activeTurn.finalized) {
        this.activeAssistantTurn = null;
        return;
      }

      activeTurn.handle = handle;
    } catch (err) {
      if (!this.isActiveAssistantTurn(token)) return;

      this.activeAssistantTurn = null;
      await this.failTurnKeepingSession(
        `Live voice assistant turn could not be started: ${errorMessage(err)}`,
        "assistant_start_error",
      );
    }
  }

  private async cancelAssistantTurn(reason: string): Promise<void> {
    const turn = this.activeAssistantTurn;
    if (!turn) {
      await this.finalizePendingTurn(reason);
      return;
    }

    this.activeAssistantTurn = null;
    turn.abortController.abort();
    turn.handle?.abort();
    await this.finalizeAssistantTurn(turn, "cancelled", reason);
  }

  private isActiveAssistantTurn(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token && !activeTurn.finalized && !this.isClosed
    );
  }

  private isForwardingAssistantText(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.assistantCompleted &&
      !activeTurn.finalized &&
      !this.isClosed
    );
  }

  private isForwardingTts(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.ttsDone &&
      !activeTurn.finalized &&
      !activeTurn.abortController.signal.aborted &&
      !this.isClosed
    );
  }

  private bufferAssistantTextForTts(token: symbol, text: string): void {
    if (!this.streamTtsAudio || text.length === 0) return;

    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || activeTurn.assistantCompleted) return;

    activeTurn.ttsBuffer += text;
    this.flushTtsBuffer(token, false);
  }

  private completeTtsForTurn(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    this.clearFillerTimers(activeTurn);
    this.flushTtsBuffer(token, true);
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        const currentTurn = this.activeAssistantTurn;
        if (currentTurn?.token !== token || currentTurn.ttsDone) return;

        currentTurn.ttsDone = true;
        await this.finalizeAssistantTurn(
          currentTurn,
          "completed",
          "completed",
          {
            clearActive: false,
          },
        );
        await this.sendFrame(
          { type: "tts_done", turnId: currentTurn.turnId },
          () =>
            this.activeAssistantTurn?.token === token &&
            currentTurn.finalized &&
            !this.isClosed,
        );

        if (this.activeAssistantTurn?.token === token) {
          if (currentTurn.handle && currentTurn.finalized) {
            this.activeAssistantTurn = null;
          }
        }

        // Full-duplex: after the assistant finishes speaking, loop back to
        // listening for the next utterance instead of leaving the session idle
        // on a dead transcriber. Half-duplex sessions are left untouched — the
        // client closes them after `tts_done` (legacy single-turn behavior).
        if (this.fullDuplex) {
          await this.beginNextListeningTurn();
        }
      });
  }

  private flushTtsBuffer(token: symbol, force: boolean): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    if (!this.streamTtsAudio) {
      activeTurn.ttsBuffer = "";
      return;
    }

    const { segments, remainder } = extractSpeakableSegments(
      activeTurn.ttsBuffer,
      force,
      // Eager until the first segment is enqueued: the opening clause flushes
      // early so speech onset does not wait for a full sentence.
      { eager: !activeTurn.ttsSegmentEnqueued },
    );
    activeTurn.ttsBuffer = remainder;

    for (const segment of segments) {
      // Sanitized per segment (not per delta) so markdown spanning deltas is
      // stripped; assistant_text_delta frames keep the raw text.
      const speakable = sanitizeForTts(segment).trim();
      if (speakable.length === 0) continue;
      this.enqueueTtsSegment(token, speakable);
    }
  }

  private enqueueTtsSegment(
    token: symbol,
    segment: string,
    options: { countsAsFirstSegment?: boolean } = {},
  ): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || !this.streamTtsAudio) return;

    // A spoken filler (countsAsFirstSegment: false) leaves the eager
    // first-clause flush available for the model's real first segment.
    if (options.countsAsFirstSegment ?? true) {
      activeTurn.ttsSegmentEnqueued = true;
    }
    const job: TtsSegmentJob = {
      text: segment,
      started: false,
      settled: false,
      emitting: false,
      bufferedChunks: [],
      synthesis: null,
      frames: Promise.resolve(),
    };
    activeTurn.ttsJobs.push(job);
    this.pumpTtsSynthesis(token);
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(() => this.emitTtsJob(token, job));
  }

  /**
   * Starts provider streams for queued jobs, in list order, while an
   * open-job slot is free. The prefetching job's chunks buffer in memory
   * until the emission chain promotes it, so the next segment's provider
   * first-chunk latency overlaps the current segment's playback.
   */
  private pumpTtsSynthesis(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    const streamTtsAudio = this.streamTtsAudio;
    if (
      activeTurn?.token !== token ||
      !streamTtsAudio ||
      activeTurn.abortController.signal.aborted ||
      this.isClosed
    ) {
      return;
    }

    while (
      activeTurn.ttsJobs.filter((job) => job.started && !job.settled).length <
      TTS_MAX_OPEN_SYNTHESIS_JOBS
    ) {
      const job = activeTurn.ttsJobs.find((candidate) => !candidate.started);
      if (!job) return;
      job.started = true;
      let synthesis: Promise<void>;
      try {
        synthesis = streamTtsAudio({
          text: job.text,
          signal: activeTurn.abortController.signal,
          outputFormat: "pcm",
          sampleRate: this.context.startFrame.audio.sampleRate,
          onAudioChunk: (chunk) => {
            if (!this.isForwardingTts(token)) return;
            if (job.emitting) {
              this.forwardTtsChunk(token, job, chunk);
            } else {
              job.bufferedChunks.push(chunk);
            }
          },
        }).then(() => undefined);
      } catch (err) {
        synthesis = Promise.reject(err);
      }
      // The job's emission step observes the rejection; this handler only
      // keeps a failure on an already-cancelled turn from surfacing as an
      // unhandled rejection.
      synthesis.catch(() => {});
      job.synthesis = synthesis;
    }
  }

  /**
   * Emission slot for one job, run in strict segment order on the turn's
   * ttsQueue chain: promotes the job from prefetch to live, flushes what it
   * buffered, and returns only once every frame write for the job is ordered
   * ahead of the next segment's.
   */
  private async emitTtsJob(token: symbol, job: TtsSegmentJob): Promise<void> {
    try {
      const currentTurn = this.activeAssistantTurn;
      if (
        currentTurn?.token !== token ||
        currentTurn.abortController.signal.aborted
      ) {
        // The turn is gone: release the prefetched audio immediately rather
        // than holding it until the turn object drops.
        job.bufferedChunks.length = 0;
        return;
      }

      // Both slots can be busy when a job is enqueued; every earlier job has
      // settled once it reaches the head of the chain, so a slot is free.
      if (!job.started) {
        this.pumpTtsSynthesis(token);
      }

      // Promote synchronously: no provider callback can land between the
      // flag flip and the buffered flush, so flushed and live chunks stay in
      // provider order on the job's frame chain.
      job.emitting = true;
      for (const chunk of job.bufferedChunks.splice(0)) {
        this.forwardTtsChunk(token, job, chunk);
      }

      let failed = false;
      let synthesisError: unknown;
      try {
        await job.synthesis;
      } catch (err) {
        failed = true;
        synthesisError = err;
      }
      // The provider stream has settled, so the frame chain is complete;
      // awaiting it puts every frame of this segment ahead of the next.
      await job.frames;

      if (failed && this.isForwardingTts(token)) {
        // Already recovered from, right here: this segment's failure is
        // reported non-fatally, so `completeTtsForTurn` — chained onto the
        // same queue — still finalizes the turn, still sends `tts_done`, and
        // still re-arms listening.
        await this.sendFrame(
          {
            type: "error",
            code: LiveVoiceProtocolErrorCode.InvalidField,
            message: `Live voice TTS failed: ${errorMessage(synthesisError)}`,
            fatal: false,
          },
          () => this.isForwardingTts(token),
        );
      }
    } finally {
      job.settled = true;
      const settledTurn = this.activeAssistantTurn;
      if (settledTurn?.token === token) {
        // Anchor the dead-air countdown to the end of emission; the playback
        // -tail estimate covers any client-side buffer still draining.
        settledTurn.progress.lastAudibleAtMs = Date.now();
      }
      this.pumpTtsSynthesis(token);
    }
  }

  private forwardTtsChunk(
    token: symbol,
    job: TtsSegmentJob,
    chunk: LiveVoiceTtsAudioChunk,
  ): void {
    if (!this.isForwardingTts(token)) return;
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;
    activeTurn.assistantAudioChunks.push(
      Buffer.from(chunk.dataBase64, "base64"),
    );
    activeTurn.assistantAudioMimeType = chunk.contentType;
    activeTurn.assistantAudioSampleRate = chunk.sampleRate;
    job.frames = job.frames.then(async () => {
      const sent = await this.sendFrame(
        {
          type: "tts_audio",
          mimeType: chunk.contentType,
          sampleRate: chunk.sampleRate,
          dataBase64: chunk.dataBase64,
        },
        () => this.isForwardingTts(token),
      );
      // Skip a frame that wasn't actually written — a suppressed send never
      // reached the client, so it must not extend the playback-tail estimate
      // or latch first-audio state.
      if (!sent) return;
      // Extend the client playback-tail estimate by this chunk's PCM
      // duration (chunks queue gaplessly client-side, so the tail grows
      // from whichever is later: now or the current estimate). Non-PCM
      // chunk formats are skipped — their byte length is not a duration —
      // and the per-job `lastAudibleAtMs` stamp still anchors silence.
      const chunkMs = estimatePcmDurationMs({
        byteLength: Buffer.byteLength(chunk.dataBase64, "base64"),
        mimeType: chunk.contentType,
        sampleRate: chunk.sampleRate,
      });
      if (chunkMs !== undefined && chunkMs > 0) {
        const now = Date.now();
        this.assistantPlaybackTailUntilMs =
          Math.max(now, this.assistantPlaybackTailUntilMs) + chunkMs;
      }
      const turnAfterSend = this.activeAssistantTurn;
      if (turnAfterSend?.token !== token || turnAfterSend.ttsAudioStarted) {
        return;
      }
      turnAfterSend.ttsAudioStarted = true;
      this.metrics.markFirstTtsAudio(turnAfterSend.turnId);
    });
  }

  /**
   * Arm the floor-holding spoken-ack timer for a turn (WS-E presence layer).
   * No-op unless `liveVoice.frontModel.spokenAcks` is on and the session can
   * actually speak (a TTS streamer is wired). On expiry — i.e. the assistant
   * has produced no spoken delta within `ackFirstDeltaTimeoutMs` — a short
   * ack is spoken so the wait doesn't feel like the assistant stopped
   * responding.
   */
  private armFirstDeltaAckTimer(
    token: symbol,
    turnId: string,
    content: string,
  ): void {
    const front = this.frontModelConfig;
    if (!front?.spokenAcks || !this.streamTtsAudio) return;

    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || activeTurn.firstDeltaSeen) return;

    const timer = setTimeout(() => {
      void this.fireSpokenAck(token, turnId, content);
    }, front.ackFirstDeltaTimeoutMs);
    // Don't let a pending ack timer hold the process open (mirrors the idle
    // timer). `unref` is present on the Node/Bun timer handle.
    (timer as { unref?: () => void }).unref?.();
    activeTurn.ackTimer = timer;
  }

  /**
   * Record that a turn produced its first spoken delta: cancel any pending
   * ack timer so no floor-holder speaks over a reply that already started.
   */
  private noteFirstAssistantDelta(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;
    activeTurn.firstDeltaSeen = true;
    // Every delta bumps the epoch: an in-flight narration generation captures
    // it at launch and discards its (now stale) text if it moved. The
    // narration idle timer stays armed — the dead air it fills is almost
    // always MID-turn, so it keeps watching after the model speaks.
    activeTurn.deltaEpoch += 1;
    this.clearAckTimer(activeTurn);
  }

  private clearAckTimer(turn: ActiveAssistantTurn): void {
    if (turn.ackTimer !== null) {
      clearTimeout(turn.ackTimer);
      turn.ackTimer = null;
    }
  }

  /**
   * Speak one short floor-holding acknowledgement for a still-silent turn.
   * Both triggers land here — the `first_delta` timer expiry and a
   * `tool_use` start (a guaranteed-slow turn) — and share the one-ack-per-turn
   * `ackFired` budget. Picks an LLM-phrased ack when `llmAckText` is on and
   * the front decider is available (falling back to the kind's static
   * rotation phrase), then queues it on the turn's TTS queue ahead of the
   * eventual reply audio. Re-checks every guard after the (possibly awaited)
   * ack-text step so a turn that produced its first delta or ended in the
   * meantime never gets an ack spoken over it — and releases the budget when
   * the ack turned out moot so a later trigger this turn can still speak.
   */
  private async fireSpokenAck(
    token: symbol,
    turnId: string,
    content: string,
    kind: LiveVoiceSpokenAckKind = "first_delta",
    toolName?: string,
  ): Promise<void> {
    const front = this.frontModelConfig;
    if (!front?.spokenAcks || !this.streamTtsAudio) return;
    if (!this.canFireAck(token)) return;

    const activeTurn = this.activeAssistantTurn;
    if (!activeTurn || activeTurn.ackFired) return;
    activeTurn.ackFired = true;

    let ackText: string | null = null;
    if (front.llmAckText && this.frontDecider) {
      // While the generation is pending the ack has not yet stamped
      // `lastFloorHolderAtMs`; narration reads this flag and stands down so
      // a progress phrase never lands back-to-back with the ack.
      activeTurn.ackGenerationPending = true;
      try {
        ackText = await this.frontDecider.generateAckText(
          {
            transcriptSoFar: content,
            ...(toolName !== undefined ? { toolName } : {}),
          },
          activeTurn.abortController.signal,
        );
      } finally {
        activeTurn.ackGenerationPending = false;
      }
    }
    if (!ackText) {
      ackText = pickAckPhrase(kind, this.ackCounter);
      this.ackCounter += 1;
    }

    // The ack-text step may have awaited: re-verify the turn is still silent
    // and live before speaking, so we never talk over a reply that started.
    // A moot ack releases the one-per-turn budget.
    if (!this.canFireAck(token)) {
      activeTurn.ackFired = false;
      return;
    }

    if (!this.enqueueFillerPhrase(activeTurn, ackText)) {
      activeTurn.ackFired = false;
      return;
    }
    this.metrics.markSpokenAck(kind, turnId);
  }

  /**
   * Whether a `first_delta` ack may still speak: the turn is the active one,
   * has produced no delta, has not already fired an ack, and is otherwise
   * live (not completed / finalized / aborted / closed).
   */
  private canFireAck(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.firstDeltaSeen &&
      !activeTurn.assistantCompleted &&
      !activeTurn.finalized &&
      !activeTurn.abortController.signal.aborted &&
      !this.isClosed
    );
  }

  /**
   * One tool start observed on the turn: feed the narration op log and, on
   * the first tool of a still-silent turn, speak the floor-holding ack NOW —
   * definitive tool use means the turn is guaranteed slow, so waiting out the
   * rest of the first-delta timer only adds dead air (same one-ack-per-turn
   * `ackFired` budget, gated on the same `spokenAcks` flag).
   *
   * Adaptation from upstream: our bridge has no structured tool_result
   * callback, so op completion is inferred — the voice agent loop runs tools
   * sequentially, so the next tool starting means the previous op returned.
   * A previous op that ran at least `longOpMs` narrates the moment it is
   * closed (`op_complete`), the beat the user has been waiting through.
   */
  private recordToolUseStart(
    turn: ActiveAssistantTurn,
    toolName: string,
    toolUseId?: string,
  ): void {
    const front = this.frontModelConfig;
    const { progress } = turn;

    let trigger: "ops" | "op_complete" = "ops";
    const previous = findLastIncompleteOp(progress.ops);
    if (previous) {
      previous.completedAtMs = Date.now();
      if (
        front &&
        previous.completedAtMs - previous.startedAtMs >= front.progress.longOpMs
      ) {
        trigger = "op_complete";
      }
    }

    // The op counts toward the narration threshold on start (not completion)
    // so a burst of slow tools still trips the ops trigger while they run.
    progress.ops.push({
      toolName,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      startedAtMs: Date.now(),
    });
    progress.opsSinceNarration += 1;
    progress.stateEpoch += 1;

    if (
      front?.spokenAcks &&
      this.streamTtsAudio &&
      !turn.firstDeltaSeen &&
      !turn.ackFired
    ) {
      this.clearAckTimer(turn);
      void this.fireSpokenAck(
        turn.token,
        turn.turnId,
        turn.utteranceText,
        "tool_use",
        toolName,
      );
    }

    this.maybeNarrateProgress(turn, trigger);
  }

  /**
   * Arms (or re-arms) the dead-air narration timer. The countdown measures
   * audible silence — time since the turn's audio last (estimatedly) reached
   * the user's ears — not time since launch, so it covers mid-turn silences
   * for the whole turn. On expiry with audio still pending, or with the
   * silence not yet a full interval old, it re-arms for the remainder; only a
   * full interval of audible silence reaches the narration gatekeeper. The
   * interval is a polling cadence, not a speaking cadence: most ticks find
   * nothing new to report and stay quiet, so what the user hears follows the
   * turn's tool activity (with `maxSilenceMs` as the heartbeat ceiling).
   */
  private armProgressIdleTimer(
    turn: ActiveAssistantTurn,
    delayMs?: number,
  ): void {
    const front = this.frontModelConfig;
    if (!front) return;
    const { token } = turn;
    this.clearProgressIdleTimer(turn);
    const timer = setTimeout(() => {
      turn.progress.idleTimer = null;
      if (!this.isActiveAssistantTurn(token) || turn.assistantCompleted) {
        return;
      }
      if (!this.turnAudioIdle(turn)) {
        // Audio is buffered, queued, or still playing: a fresh silence can
        // only be a full interval old one interval from now.
        this.armProgressIdleTimer(turn);
        return;
      }
      const remaining = this.progressIdleDeadlineMs(turn) - Date.now();
      if (remaining > 0) {
        this.armProgressIdleTimer(turn, remaining);
        return;
      }
      this.maybeNarrateProgress(turn, "idle");
      this.armProgressIdleTimer(turn);
    }, delayMs ?? front.progress.idleIntervalMs);
    // Don't let a pending narration timer hold the process open (mirrors the
    // idle + ack timers).
    (timer as { unref?: () => void }).unref?.();
    turn.progress.idleTimer = timer;
  }

  /** Wall-clock instant the current audible silence turns a full interval old. */
  private progressIdleDeadlineMs(turn: ActiveAssistantTurn): number {
    const front = this.frontModelConfig;
    return (
      this.progressSilenceSinceMs(turn) + (front?.progress.idleIntervalMs ?? 0)
    );
  }

  /**
   * When the turn's current audible silence began: the latest of the last
   * emitted segment, the estimated client playback end, and the last enqueued
   * filler.
   */
  private progressSilenceSinceMs(turn: ActiveAssistantTurn): number {
    return Math.max(
      turn.progress.lastAudibleAtMs,
      this.assistantPlaybackTailUntilMs,
      turn.progress.lastFloorHolderAtMs ?? 0,
    );
  }

  /**
   * No assistant audio is pending or (estimatedly) still playing: nothing
   * buffered toward the next sentence, every queued TTS segment fully
   * emitted, and the client-side playback-tail estimate expired.
   */
  private turnAudioIdle(turn: ActiveAssistantTurn): boolean {
    return (
      turn.ttsBuffer.length === 0 &&
      turn.ttsJobs.every((job) => job.settled) &&
      Date.now() >= this.assistantPlaybackTailUntilMs
    );
  }

  private clearProgressIdleTimer(turn: ActiveAssistantTurn): void {
    if (turn.progress.idleTimer !== null) {
      clearTimeout(turn.progress.idleTimer);
      turn.progress.idleTimer = null;
    }
  }

  /**
   * Clears the turn's filler timers (slow-first-delta ack, dead-air
   * narration) for events that end the current filler lifecycle: barge-in,
   * cancellation, tts-completion, finalize. Real output moots only the ack
   * (noteFirstAssistantDelta) — the narration timer keeps watching for
   * mid-turn dead air.
   */
  private clearFillerTimers(turn: ActiveAssistantTurn): void {
    this.clearAckTimer(turn);
    this.clearProgressIdleTimer(turn);
  }

  /**
   * Narration, unlike the ack, is not confined to the pre-first-delta window:
   * the dead air it exists to fill is almost always mid-turn, after the
   * model's opening words. It may speak whenever the live turn is audibly
   * silent right now — nothing streaming, queued, or still playing — and has
   * not completed. (Upstream also stands down while the turn awaits an
   * approval decision; our `local-live-voice` approval mode never parks a
   * turn awaiting approval, so that gate has no counterpart here.)
   */
  private turnCanNarrateProgress(turn: ActiveAssistantTurn): boolean {
    return (
      this.isActiveAssistantTurn(turn.token) &&
      !turn.assistantCompleted &&
      this.turnAudioIdle(turn)
    );
  }

  /**
   * The idle tick has something worth saying when the turn's tool activity
   * has moved since the last narration described it, or when the silence has
   * run past `maxSilenceMs` — the heartbeat ceiling that proves the assistant
   * is still alive on a turn with no observable activity at all. Every other
   * tick stays quiet, so the cadence follows the work rather than the clock.
   */
  private progressIdleHasSomethingToSay(turn: ActiveAssistantTurn): boolean {
    const front = this.frontModelConfig;
    if (!front) return false;
    const { progress } = turn;
    if (progress.stateEpoch !== progress.narratedEpoch) return true;
    const silentForMs = Date.now() - this.progressSilenceSinceMs(turn);
    return silentForMs >= front.progress.maxSilenceMs;
  }

  /**
   * Gatekeeper for spoken progress narration: it speaks only while the turn
   * is audibly silent, spaced `minGapMs` from any spoken floor-holder (ack or
   * narration), one generation at a time, and — per trigger — only once the
   * ops trigger has `opsThreshold` ops accumulated or the idle trigger has
   * something new to report. No per-turn count cap: the cadence guards bound
   * the rate, and going quiet deep into a long turn is the failure mode
   * narration exists to prevent. Every failing guard short-circuits silently;
   * a skipped ops trigger keeps its accumulated count, so the next tool event
   * or idle tick retries.
   */
  private maybeNarrateProgress(
    turn: ActiveAssistantTurn,
    trigger: "ops" | "idle" | "op_complete",
  ): void {
    const front = this.frontModelConfig;
    const frontDecider = this.frontDecider;
    if (!front) return;
    const cfg = front.progress;
    const { progress } = turn;
    if (
      !cfg.enabled ||
      !this.streamTtsAudio ||
      !frontDecider ||
      !this.turnCanNarrateProgress(turn) ||
      // A pending ack generation is a floor-holder-in-waiting: starting a
      // narration generation now would only be discarded by the post-await
      // re-check once the ack enqueues — a guaranteed wasted provider call.
      turn.ackGenerationPending ||
      progress.narrationInFlight ||
      (progress.lastFloorHolderAtMs !== null &&
        Date.now() - progress.lastFloorHolderAtMs < cfg.minGapMs) ||
      (trigger === "ops" && progress.opsSinceNarration < cfg.opsThreshold) ||
      (trigger === "idle" && !this.progressIdleHasSomethingToSay(turn))
    ) {
      return;
    }
    void this.speakProgressUpdate(turn, frontDecider, trigger);
  }

  /**
   * Generate and speak one progress narration. Like the ack, it is audio-only
   * — no assistant_text_delta frame, nothing persisted to the transcript —
   * and enqueues as a standalone sentence on the turn's ordered TTS queue.
   * The decider internally bounds the call by `progress.generationTimeoutMs`
   * and resolves null on every failure mode; on null the idle trigger falls
   * back to a static phrase (silence is actively harmful there) while the
   * tool-activity triggers stay silent — a generic filler is not worth it
   * when narration was merely opportunistic.
   */
  private async speakProgressUpdate(
    turn: ActiveAssistantTurn,
    frontDecider: VoiceFrontDecider,
    trigger: "ops" | "idle" | "op_complete",
  ): Promise<void> {
    const front = this.frontModelConfig;
    if (!front) return;
    const { progress } = turn;
    progress.narrationInFlight = true;
    // Any delta that lands while the decider call is in flight makes the
    // generated text stale — and proves the model is speaking again.
    const deltaEpochAtLaunch = turn.deltaEpoch;
    // The activity this update describes. Tool events that land
    // mid-generation are news the generated text cannot carry, so they must
    // leave the idle trigger armed rather than count as already narrated.
    const stateEpochAtLaunch = progress.stateEpoch;
    try {
      const now = Date.now();
      const currentOp = findLastIncompleteOp(progress.ops);
      const generated = await frontDecider
        .generateProgressText(
          {
            transcriptSoFar: turn.utteranceText,
            completedOps: progress.ops
              .filter(
                (op): op is TurnProgressOp & { completedAtMs: number } =>
                  op.completedAtMs !== undefined,
              )
              // `ops` is in start order; the decider contract wants
              // completion order.
              .sort((a, b) => a.completedAtMs - b.completedAtMs)
              .map((op) => ({
                toolName: op.toolName,
                ...(op.isError !== undefined ? { isError: op.isError } : {}),
                ...(op.resultPreview !== undefined
                  ? { resultPreview: op.resultPreview }
                  : {}),
              })),
            currentOp: currentOp
              ? {
                  toolName: currentOp.toolName,
                  elapsedMs: now - currentOp.startedAtMs,
                }
              : null,
            turnElapsedMs: now - turn.launchedAtMs,
            updateIndex: progress.updatesSpoken + 1,
          },
          turn.abortController.signal,
        )
        // The decider contract never rejects; belt-and-braces for a stub.
        .catch(() => null);
      // Liveness re-check after the await: any turnCanNarrateProgress
      // condition may have flipped while generating, a delta that landed
      // mid-generation (deltaEpoch moved) makes the text stale, an ack
      // generation that began mid-generation must not be stacked on, and the
      // minGap spacing must be re-applied from any floor-holder that spoke
      // meanwhile. A bail here is silent, exactly like the stale-turn bail.
      if (
        !this.turnCanNarrateProgress(turn) ||
        turn.deltaEpoch !== deltaEpochAtLaunch ||
        turn.ackGenerationPending ||
        (progress.lastFloorHolderAtMs !== null &&
          Date.now() - progress.lastFloorHolderAtMs < front.progress.minGapMs)
      ) {
        return;
      }
      let raw = generated;
      if (raw === null) {
        if (trigger !== "idle") return;
        raw = pickProgressPhrase(this.progressPhraseCounter++);
      }
      if (!this.enqueueFillerPhrase(turn, raw)) return;
      progress.opsSinceNarration = 0;
      progress.narratedEpoch = stateEpochAtLaunch;
      progress.updatesSpoken += 1;
      // Restart the dead-air countdown from this narration.
      this.armProgressIdleTimer(turn);
    } finally {
      progress.narrationInFlight = false;
    }
  }

  /**
   * Sanitize and enqueue one filler sentence (spoken ack or progress
   * narration) on the turn's ordered TTS queue — the shared tail of every
   * filler path. Audio-only by construction: the phrase reaches the TTS
   * queue and nothing else — no assistant_text_delta frame, no persisted
   * transcript text. Returns whether a phrase actually enqueued; per-kind
   * metric marks and bookkeeping are the caller's.
   */
  private enqueueFillerPhrase(turn: ActiveAssistantTurn, raw: string): boolean {
    const phrase = sanitizeForTts(raw).trim();
    if (phrase.length === 0) return false;
    this.enqueueTtsSegment(turn.token, phrase, {
      countsAsFirstSegment: false,
    });
    // A spoken filler holds the floor, so narration's minGapMs spaces from it.
    turn.progress.lastFloorHolderAtMs = Date.now();
    return true;
  }

  private collectUserAudio(chunk: Buffer): void {
    const turnId = this.ensureTurnId();
    this.currentUserAudioChunks.push(Buffer.from(chunk));
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFirstAudio(turnId);
  }

  private markPushToTalkReleased(): void {
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markPushToTalkRelease(turnId);
  }

  private markFirstPartial(): void {
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFirstPartial(turnId);
  }

  private markFinalTranscript(): void {
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFinalTranscript(turnId);
  }

  private markFirstAssistantDelta(turnId: string): void {
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFirstAssistantDelta(turnId);
  }

  private ensureTurnId(): string {
    if (!this.currentTurnId) {
      this.currentTurnId = this.createTurnId();
    }
    return this.currentTurnId;
  }

  private startMetricsTurnIfNeeded(turnId: string): void {
    if (this.metricsTurnStarted || this.metricsTurnFinished) return;
    this.metrics.startTurn(turnId);
    this.metricsTurnStarted = true;
  }

  /**
   * Close a turn that produced no spoken answer and, in full-duplex, re-arm
   * listening for the next utterance.
   *
   * `tts_done` is the client's "this turn is over" signal — the only thing that
   * moves it out of transcribing/thinking and re-opens its mic gate. A turn that
   * ends without one leaves both sides stuck: the daemon on a stopped
   * transcriber, the client waiting for an answer that will never come. Mirrors
   * the closing half of the success path (`completeTtsForTurn`).
   */
  private async endTurnWithoutAnswer(reason: string): Promise<void> {
    const turnId = this.ensureTurnId();
    await this.finalizePendingTurn(reason);
    await this.sendFrame({ type: "tts_done", turnId });
    if (this.fullDuplex) {
      await this.beginNextListeningTurn();
    }
  }

  /**
   * A TURN failed — the session did not. Report the failure and then close the
   * turn the way a completed one closes, so the call keeps its floor.
   *
   * Every turn-level failure used to end the whole conversation, twice over.
   * The `error` frame carried no severity, so the client tore the session down
   * on it; and even a client that ignored the frame was left deaf, because the
   * turn ended without a `tts_done` — the only signal that moves the client out
   * of transcribing/thinking and re-opens its mic gate — and without re-arming
   * the transcriber the daemon had already stopped at `ptt_release`. One bad
   * turn (the brain erroring, a run being cancelled, an assistant turn that
   * could not start) therefore read as "voice randomly drops out".
   *
   * `fatal: false` is honest here only BECAUSE of the close: {@link
   * beginNextListeningTurn} resolves a brand-new transcriber, so the session
   * genuinely can hear again — and when that re-arm itself fails it sends its
   * own fatal error via `failStartupSoft`. This is not a blanket downgrade of
   * error severity: a failure the daemon cannot recover from still says so.
   */
  private async failTurnKeepingSession(
    message: string,
    reason: string,
    code: LiveVoiceProtocolErrorCode = LiveVoiceProtocolErrorCode.InvalidField,
  ): Promise<void> {
    if (this.isTerminal) return;
    await this.sendFrame({ type: "error", code, message, fatal: false });
    await this.endTurnWithoutAnswer(reason);
  }

  private async finalizePendingTurn(reason: string): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId) return;

    await this.archiveBufferedAudio({
      turnId,
      userMessageId: this.currentUserMessageId,
      assistantMessageId: null,
      userAudioChunks: this.currentUserAudioChunks,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
    });
    await this.finishMetricsTurn("cancelled", reason, turnId);
  }

  private async finalizeAssistantTurn(
    turn: ActiveAssistantTurn,
    status: "completed" | "cancelled",
    reason = "completed",
    options: { clearActive?: boolean } = {},
  ): Promise<void> {
    if (turn.finalized) return;

    turn.finalized = true;
    this.clearFillerTimers(turn);
    await this.archiveBufferedAudio({
      turnId: turn.turnId,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      userAudioChunks: turn.userAudioChunks,
      assistantAudioChunks: turn.assistantAudioChunks,
      assistantAudioMimeType: turn.assistantAudioMimeType,
      ...(turn.assistantAudioSampleRate !== undefined
        ? { assistantAudioSampleRate: turn.assistantAudioSampleRate }
        : {}),
    });
    await this.finishMetricsTurn(status, reason, turn.turnId);

    if (
      (options.clearActive ?? true) &&
      this.activeAssistantTurn?.token === turn.token &&
      turn.handle
    ) {
      this.activeAssistantTurn = null;
    }
  }

  private async archiveBufferedAudio(input: {
    turnId: string;
    userMessageId: string | null;
    assistantMessageId: string | null;
    userAudioChunks: Buffer[];
    assistantAudioChunks: Buffer[];
    assistantAudioMimeType: string;
    assistantAudioSampleRate?: number;
  }): Promise<void> {
    const userAudio = takeBufferedAudio(input.userAudioChunks);
    if (userAudio) {
      await this.archiveBufferedRoleAudio({
        turnId: input.turnId,
        role: "user",
        messageId: input.userMessageId,
        mimeType: this.context.startFrame.audio.mimeType,
        sampleRate: this.context.startFrame.audio.sampleRate,
        audio: userAudio,
      });
    }

    const assistantAudio = takeBufferedAudio(input.assistantAudioChunks);
    if (assistantAudio) {
      const sampleRate =
        input.assistantAudioSampleRate ??
        this.context.startFrame.audio.sampleRate;
      await this.archiveBufferedRoleAudio({
        turnId: input.turnId,
        role: "assistant",
        messageId: input.assistantMessageId,
        mimeType: input.assistantAudioMimeType,
        sampleRate,
        audio: assistantAudio,
      });
    }
  }

  private async archiveBufferedRoleAudio(input: {
    turnId: string;
    role: LiveVoiceAudioArchiveRole;
    messageId: string | null;
    mimeType: string;
    sampleRate: number;
    audio: Buffer;
  }): Promise<void> {
    const archiveAudio = this.archiveAudio;
    if (!archiveAudio) return;

    const durationMs = estimatePcmDurationMs({
      byteLength: input.audio.byteLength,
      mimeType: input.mimeType,
      sampleRate: input.sampleRate,
    });
    let result: LiveVoiceAudioArchiveResult;
    try {
      result = await archiveAudio({
        messageId: input.messageId,
        sessionId: this.context.sessionId,
        turnId: input.turnId,
        role: input.role,
        mimeType: input.mimeType,
        sampleRate: input.sampleRate,
        ...(durationMs !== undefined ? { durationMs } : {}),
        audio: {
          type: "base64",
          dataBase64: input.audio.toString("base64"),
        },
      });
    } catch (err) {
      result = {
        type: "warning",
        warning: {
          code: "archive_failed",
          message: `Live voice audio archive failed without blocking the turn: ${errorMessage(
            err,
          )}`,
        },
      };
    }

    await this.sendArchiveFrame(input.turnId, input.role, result);
  }

  private async sendArchiveFrame(
    turnId: string,
    role: LiveVoiceAudioArchiveRole,
    result: LiveVoiceAudioArchiveResult,
  ): Promise<void> {
    const artifact =
      result.type === "archived" || result.type === "unlinked"
        ? result.artifact
        : undefined;
    const warning = result.type === "archived" ? undefined : result.warning;
    await this.sendFrame({
      type: "archived",
      conversationId: this.conversationId,
      sessionId: this.context.sessionId,
      turnId,
      role,
      ...(artifact
        ? {
            attachmentId: artifact.attachmentId,
            attachmentIds: [artifact.attachmentId],
          }
        : {}),
      ...(warning ? { warning } : {}),
    });
  }

  private async finishMetricsTurn(
    status: "completed" | "cancelled",
    reason: string,
    turnId: string,
  ): Promise<void> {
    if (!this.metricsTurnStarted || this.metricsTurnFinished) return;

    if (status === "completed") {
      this.metrics.completeTurn(turnId);
    } else {
      this.metrics.cancelTurn(reason, turnId);
    }
    this.metricsTurnFinished = true;

    if (!this.emitMetrics) return;
    await this.emitMetricsFrame(
      status === "completed" ? "turn_completed" : "turn_cancelled",
      turnId,
    );
  }

  private async emitSessionEndMetrics(): Promise<void> {
    if (!this.emitMetrics || this.sessionEndMetricsEmitted) return;

    this.sessionEndMetricsEmitted = true;
    await this.emitMetricsFrame("session_ended");
  }

  private async emitMetricsFrame(
    event: LiveVoiceMetricsEvent,
    turnId = this.currentTurnId ?? this.context.sessionId,
  ): Promise<void> {
    const metrics = this.metrics.getSnapshot();
    await this.sendFrame({
      type: "metrics",
      event,
      sessionId: this.context.sessionId,
      conversationId: this.conversationId,
      turnDetection: this.turnDetection,
      turnId,
      metrics,
      ...getLiveVoiceMetricsAggregateFields(metrics, turnId),
    });
  }

  private async failStartup(
    message: string,
    code: LiveVoiceProtocolErrorCode = LiveVoiceProtocolErrorCode.InvalidField,
  ): Promise<never> {
    this.state = "failed";
    this.clearIdleTimer();
    await this.sendFrame({
      type: "error",
      code,
      message,
    });
    throw new LiveVoiceSessionStartupError(message);
  }

  private async sendAudioAfterReleaseError(): Promise<void> {
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidAudioPayload,
      message: "Live voice audio received after push-to-talk release.",
    });
  }

  /**
   * Queue a frame on the ordered outbound chain. Resolves `true` only when
   * the frame was actually written (the `shouldSend` guard passed and the
   * transport did not throw) — TTS chunk accounting keys off that.
   */
  private async sendFrame(
    frame: LiveVoiceServerFramePayload,
    shouldSend: () => boolean = () => true,
  ): Promise<boolean> {
    let sent = false;
    this.outboundFrames = this.outboundFrames
      .catch(() => {})
      .then(async () => {
        if (!shouldSend()) return;
        await this.context.sendFrame(frame);
        sent = true;
      })
      .catch(() => {
        // Transport failures are handled by the WebSocket/session owner.
      });

    await this.outboundFrames;
    return sent;
  }

  private async drainOutboundFrames(): Promise<void> {
    await this.outboundFrames.catch(() => {});
  }

  private get isClosed(): boolean {
    return this.state === "closed";
  }

  /** True once the session is terminal (closed or failed). */
  private get isTerminal(): boolean {
    return this.state === "closed" || this.state === "failed";
  }
}

export function createLiveVoiceSession(
  context: LiveVoiceSessionFactoryContext,
  options: LiveVoiceSessionOptions = {},
): LiveVoiceSession {
  return new LiveVoiceSession(context, {
    ...options,
    startVoiceTurn: options.startVoiceTurn ?? defaultStartVoiceTurn,
    streamTtsAudio:
      options.streamTtsAudio === undefined
        ? defaultStreamLiveVoiceTtsAudio
        : options.streamTtsAudio,
    archiveAudio:
      options.archiveAudio === undefined
        ? defaultArchiveLiveVoiceAudio
        : options.archiveAudio,
    emitMetrics: options.emitMetrics ?? true,
  });
}

async function defaultResolveStreamingTranscriber(
  options: ResolveStreamingTranscriberOptions,
): Promise<StreamingTranscriber | null> {
  const { resolveStreamingTranscriber } =
    await import("../providers/speech-to-text/resolve.js");
  return resolveStreamingTranscriber(options);
}

async function defaultStartVoiceTurn(
  options: VoiceTurnOptions,
): Promise<VoiceTurnHandle> {
  const { startVoiceTurn } = await import("../calls/voice-session-bridge.js");
  return startVoiceTurn(options);
}

async function defaultStreamLiveVoiceTtsAudio(
  options: LiveVoiceTtsOptions,
): Promise<LiveVoiceTtsResult> {
  const { streamLiveVoiceTtsAudio } = await import("./live-voice-tts.js");
  return streamLiveVoiceTtsAudio(options);
}

async function defaultArchiveLiveVoiceAudio(
  input: LiveVoiceSessionArchiveAudioInput,
): Promise<LiveVoiceAudioArchiveResult> {
  const {
    linkLiveVoiceAssistantResponseAudioToMessage,
    linkLiveVoiceUserUtteranceAudioToMessage,
  } = await import("./live-voice-archive.js");
  return input.role === "user"
    ? linkLiveVoiceUserUtteranceAudioToMessage(input)
    : linkLiveVoiceAssistantResponseAudioToMessage(input);
}

function takeBufferedAudio(chunks: Buffer[]): Buffer | null {
  if (chunks.length === 0) return null;

  const audio = Buffer.concat(chunks);
  chunks.length = 0;
  return audio.byteLength > 0 ? audio : null;
}

function estimatePcmDurationMs(input: {
  byteLength: number;
  mimeType: string;
  sampleRate: number;
}): number | undefined {
  if (
    input.byteLength <= 0 ||
    input.sampleRate <= 0 ||
    input.mimeType.toLowerCase().split(";")[0]?.trim() !== "audio/pcm"
  ) {
    return undefined;
  }

  const bytesPerMonoSample = 2;
  return Math.round(
    (input.byteLength / (input.sampleRate * bytesPerMonoSample)) * 1000,
  );
}

function unavailableTranscriberMessage(): string {
  const supportedProviders = listProviderIds()
    .filter((id) => supportsBoundary(id, "daemon-streaming"))
    .join(", ");

  return `Live voice transcription is unavailable. Check that the configured STT provider supports streaming transcription and has credentials configured. Streaming-capable providers: ${supportedProviders}.`;
}

function stopTranscriberBestEffort(
  transcriber: StreamingTranscriber | null,
): void {
  if (!transcriber) return;

  try {
    transcriber.stop();
  } catch {
    // Best effort cleanup during failed startup or session close.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
