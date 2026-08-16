import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  MediaTurnDetector,
  type TurnDetectorConfig,
} from "../calls/media-turn-detector.js";
import { sanitizeForTts } from "../calls/tts-text-sanitizer.js";
import { createControlMarkerHoldback } from "../calls/voice-control-protocol.js";
import type {
  VoiceApprovalOutcome,
  VoicePendingApprovalEvent,
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../calls/voice-session-bridge.js";
import {
  capEscalationBridge,
  classifyFrontDoorLeading,
  ESCALATE_VERDICT_TOKEN,
  ESCALATION_CONTINUATION_CONTENT,
  FALLBACK_ESCALATION_BRIDGE,
  isEscalationBridgeComplete,
  MIN_SPOKEN_BRIDGE_CHARS,
  type VoiceRoutingLeg,
} from "../calls/voice-triage-escalate.js";
import { getConfig } from "../config/loader.js";
import type {
  LiveVoiceConfig,
  LiveVoiceFrontDoorConfig,
  LiveVoiceFrontModelConfig,
} from "../config/schemas/live-voice.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import {
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";

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
  // Multilinguality: the STT layer follows the caller across languages
  // (nova-3 code-switching); the reply must follow them too, or a Hindi
  // question gets an English answer read aloud.
  "Reply in the language the caller is speaking; if they switch languages, switch with them.",
].join(" ");

/**
 * Screen-reveal teaching (design v37 §W2, "voice announces, screen follows"),
 * appended to every leg that can actually put something on screen — the main
 * leg and the escalated leg. The front-door (fast) leg never receives it:
 * that leg is toolless, so it has nothing to show, and its decision rule
 * promises that apart from a leading verdict token every character is spoken
 * verbatim.
 *
 * The model never asks for the minimize; it is told one is coming. The
 * session latches the reveal when a surface actually renders (the
 * `ui_surface_show`/`ui_update` card path, cleared by `ui_dismiss`) and the
 * room demotes after the reply's speech drains — so "did the user see it"
 * never depends on the model remembering a token, and a reply whose content
 * happens to contain "[-1]" cannot move the room (the marker stays
 * strip-only). What is left for the prompt is the part only the model can get
 * right: announcing the thing aloud first, and speaking as though it is
 * already in front of the user — because by the time it stops talking, it is.
 */
const LIVE_VOICE_SCREEN_REVEAL_TEACHING =
  "The call renders as a full-screen overlay covering the app. Whenever you show a card or put something on screen, announce it aloud first in a short sentence (for example: Here's the pricing table), and speak as if you are showing it to them right now — the overlay minimizes by itself as soon as you finish speaking, so the user is looking at what you made without doing anything. Never say you cannot show it, that this is a voice call, or that they should check it later. Never emit bracketed markers of any kind.";

// The FIXED spoken phrase for a turn that parks on a mid-call approval lives
// in progress-phrases.ts (`approvalPendingPhraseFor`, design v37 §W2 binding
// copy — Cue register, chosen over upstream's wording) alongside its
// per-language spellings. Fixed rather than generative on purpose: a
// sensitive moment is the wrong place for generative variety, and this is a
// statement about the system's state that has to be true every time.
// Enqueued through {@link LiveVoiceSession.enqueueFillerPhrase}, so it is
// audio-only by construction — never an `assistant_text_delta`, never
// persisted.

/**
 * The one line of trust language the approval card renders (design v37 §W2).
 * Carried verbatim on the `approval_pending` frame so the copy has a single
 * owner and every surface renders the same words. Lowercase on purpose — the
 * rendered frame composes it as the tail of the card's detail line
 * ("… · this is the part I can't do alone.").
 */
const VOICE_APPROVAL_TRUST_LINE = "this is the part I can't do alone.";

/**
 * How long the CALL features a pending approval before the voice surface
 * stands down (upstream's 45 s pending window). This bounds the presentation,
 * not the decision: on expiry the client gets `approval_resolved` with
 * outcome `expired` and the room promotes back, but the confirmation itself
 * stays pending on the normal chat path — deliberately, because "Ask me
 * after" (a first-class answer) is indistinguishable from silence on the
 * daemon, and the chat-surface expiry (`timeouts.permissionTimeoutSec`, whose
 * timeout resolves as a deny with nothing sent) remains the single owner of
 * the confirmation's final consequence. Auto-allowing on silence here would
 * execute a sensitive action nobody approved.
 */
const VOICE_APPROVAL_PRESENTATION_TIMEOUT_MS = 45_000;

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
  pinnedListeningLanguage,
  supportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import type { ResolveStreamingTranscriberOptions } from "../providers/speech-to-text/resolve.js";
import {
  dominantLanguageTag,
  voteDominantLanguage,
} from "../stt/language-metadata.js";
import {
  DEFAULT_SPEECH_ENERGY_THRESHOLD,
  pcm16MaxNormalizedCorrelation,
  pcm16MeanAmplitude,
} from "../stt/speech-energy.js";
import type {
  StreamingTranscriber,
  SttProviderId,
  SttStreamServerEvent,
} from "../stt/types.js";
import { ReasoningTagFilter } from "../tts/reasoning-tag-filter.js";
import { extractSpeakableSegments } from "../tts/speakable-segments.js";
import { hasLocalizedEntry } from "../util/language-subtag.js";
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
import { persistLiveVoicePhoto } from "./live-voice-photo.js";
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
import {
  APPROVAL_PENDING_PHRASE_BY_LANGUAGE,
  approvalPendingPhraseFor,
  pickProgressPhrase,
  PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
} from "./progress-phrases.js";
import {
  type LiveVoiceApprovalPendingServerFrame,
  type LiveVoiceApprovalResolvedServerFrame,
  type LiveVoiceClientAttachImageFrame,
  type LiveVoiceClientFrame,
  type LiveVoiceClientUpdateConfigFrame,
  type LiveVoiceMinimizeRoomServerFrame,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
  type LiveVoiceSpeechStartedServerFrame,
  type LiveVoiceTurnCancelledServerFrame,
  type LiveVoiceTurnDetectionMode,
  type LiveVoiceUtteranceEndServerFrame,
} from "./protocol.js";
import { synthesizeLiveVoiceSession } from "./synthesize-live-voice-session.js";
import { composeTurnActivityLabel } from "./turn-activity-label.js";
import { resolveVoicePersona } from "./voice-personas.js";

const log = getLogger("live-voice-session");

type LiveVoiceSessionState =
  | "initializing"
  | "active"
  | "utterance_released"
  | "transcriber_closed"
  | "interrupted"
  | "failed"
  | "closed";

// Longest continuous sub-threshold gap the sustained-speech barge-in run
// tolerates without resetting. A gap this short is a syllable boundary, or the
// choppy energy the browser's half-duplex echo canceller produces while the
// assistant is still playing (it ducks the user's near-end voice, so post-AEC
// user speech arrives as intermittent above-gate chunks) — so the run keeps
// accumulating across it and a barge-in during playback still lands. Only a
// longer continuous silence (a real end of speech, or an isolated cough)
// resets the run. The constant encodes the web client's 50 ms / 800-sample
// pcm-capture batching (V-1a aligned it): a run of ducked frames lands on the
// boundary exactly, so the per-gap check is strictly-greater.
const BARGE_IN_GAP_TOLERANCE_MS = 200;

// Ceiling on cumulative sub-threshold time across a whole barge-in run, as a
// multiple of bargeInMinSpeechMs. Per-gap tolerance alone lets sparse isolated
// blips (e.g. a 10 ms echo spike every 200 ms) each clear the consecutive-gap
// timer while retaining prior speech, so they would sum to the guard over
// several seconds and fire a barge-in with no sustained user speech. Capping
// the run's total tolerated silence imposes a minimum above-gate duty cycle
// (1 / (1 + ratio) ≈ 20%): once the run is mostly silence it resets, so
// genuine choppy speech still lands but periodic noise cannot accumulate into
// one.
const BARGE_IN_MAX_TOLERATED_SILENCE_RATIO = 4;

// System-level guidance appended to a barge-in turn's control prompt so the
// model treats the new utterance as a continuation of the request it was cut
// off answering, rather than a fresh follow-up. Reaches the model only; it is
// not a user message and never renders as a transcript bubble.
function buildInterruptionMergeNote(interruptedRequest: string): string {
  return `The user interrupted your previous, unfinished reply. Their earlier request was: "${interruptedRequest}". Treat their current message as a continuation of that request and address both together, or stay silent if they only want you to stop.`;
}

// Duration (ms) of PCM16 mono audio: 2 bytes per sample.
function pcm16DurationMs(byteLength: number, sampleRate: number): number {
  return (byteLength / 2 / sampleRate) * 1_000;
}

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
  // Per-segment language-hint override, preferred over the turn's language.
  // Set on fixed phrases whose localized table lacks the turn's language:
  // the English fallback text carries "en" so an enforcing provider never
  // renders English words as ar/ko/ta. Undefined means the turn language.
  readonly language: string | undefined;
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

/**
 * Schema-default barge-in guard (mirrors `liveVoice.vad.bargeInMinSpeechMs`'s
 * schema default). Used directly for echo-safe clients so a deployed config
 * that raises the guard as an echo stopgap never penalizes clients whose
 * playback cannot echo.
 */
const DEFAULT_BARGE_IN_MIN_SPEECH_MS = 250;

// The playback echo gate learns microphone energy while assistant audio is
// expected at the speaker. Input must rise above the learned level by this
// margin to count as user speech. (Ported from upstream 9eaee435d7; runs only
// for sessions withOUT `echoSafePlayback` — flagged clients' playback is
// covered by browser echo cancellation and skips the classifier entirely.)
const DEFAULT_ECHO_BARGE_IN_MARGIN = 1.5;
const DEFAULT_ECHO_EMA_HALF_LIFE_MS = 400;
// Before learning a microphone power baseline, compare a short input window
// with the PCM sent to the speaker. This keeps a user's first interruption
// from becoming its own echo threshold.
const ECHO_CORRELATION_PROBE_MS = 100;
const ECHO_CORRELATION_MIN_MS = 50;
const ECHO_CORRELATION_THRESHOLD = 0.65;
const ECHO_REFERENCE_MAX_MS = 10_000;
// Echo should reach the microphone near playback onset. If no signal arrives
// within this much input audio, the gate returns to the fixed base threshold.
// The same interval expires a learned reference after a real silent gap.
const ECHO_ONSET_ELIGIBILITY_MS = 300;
// Client buffering makes audible playback trail the server's send-time
// estimate. Keep the echo window open briefly past that estimate.
const DEFAULT_ECHO_DRAIN_SLACK_MS = 300;

type VadEnergyClassification = "speech" | "silence" | "echo";

interface VadClassifiedChunk {
  readonly chunk: Buffer;
  readonly classification: VadEnergyClassification;
}

/**
 * Re-arm transcriber connect attempts and the backoff between them. A fresh
 * streaming-STT connect is a network operation that fails transiently; one
 * blip must not end an otherwise healthy call.
 */
const TRANSCRIBER_REARM_ATTEMPTS = 3;
const TRANSCRIBER_REARM_BACKOFF_MS: readonly number[] = [750, 2000];

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
   * Consumed by the server-side barge-in guard; 0 disables the guard for
   * instant barge-in. Unset falls back to the start frame, then
   * `liveVoice.vad.bargeInMinSpeechMs` config.
   */
  bargeInMinSpeechMs?: number;
  /**
   * Multiplier over the learned playback echo level that input must exceed
   * to count as speech while assistant audio is playing. Values at or below
   * 1 disable adaptation for internal fixed-gate callers; workspace config
   * requires a value greater than 1. Unset falls back to
   * `liveVoice.vad.echoBargeInMargin`. Sessions whose start frame declares
   * `echoSafePlayback` skip the classifier regardless of this value.
   */
  echoBargeInMargin?: number;
  /** Half-life in milliseconds for the learned playback echo level. */
  echoEmaHalfLifeMs?: number;
  /** Extra time after the playback estimate during which echo is expected. */
  echoDrainSlackMs?: number;
  /**
   * Overrides how long the call features a pending mid-call approval before
   * the voice surface stands down (test hook). Defaults to
   * {@link VOICE_APPROVAL_PRESENTATION_TIMEOUT_MS}.
   */
  approvalPresentationTimeoutMs?: number;
}

interface ActiveAssistantTurn {
  token: symbol;
  turnId: string;
  /**
   * The caller's spoken language for this turn as a lowercase base subtag
   * (see turnLanguageFor): the dominant STT-detected language, else a
   * monolingual services.stt.language pin. Undefined when unknown, which
   * disables every language-aware path (prompt note, TTS hint, localized
   * fallbacks). Re-resolved when a speculative turn commits, since finals
   * can land between dispatch and verdict.
   */
  language: string | undefined;
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
   * Per-turn state for stripping leaked `<think>` spans from the speech feed.
   * Scoped to the turn so an unclosed span can never mute the next one. Only
   * TTS is filtered — `assistant_text_delta` frames, the transcript and
   * persistence all keep the raw text.
   */
  ttsReasoningFilter: ReasoningTagFilter;
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
  /**
   * When this turn started from a barge-in, the interrupted request's
   * transcript. Appended to the turn's control prompt (both legs) so the
   * model merges it with this turn's utterance instead of treating that
   * utterance as a fresh follow-up. Null for an ordinary turn.
   */
  interruptedRequest: string | null;
  /**
   * Unified front-door speculative dispatch: the leg is in flight but its
   * leading verdict (hold vs commit) has not arrived. The utterance_end and
   * thinking frames, ack timer, and progress timer are deferred to commit; a
   * hold verdict discards the leg and rolls back its persisted user message.
   */
  speculativePending: boolean;
  /**
   * vadSpeechGeneration at dispatch — a mismatch at verdict time means
   * speech resumed mid-flight, so the leg is discarded, never committed.
   */
  speculativeGeneration: number;
  /**
   * The dispatched (pre-finalize) transcript, kept until the final
   * transcript lands so divergence can be logged (see
   * startAssistantTurnIfReady). Null once checked or for normal turns.
   */
  speculativeContent: string | null;
  speculativeDispatchedAtMs: number;
  /**
   * Whether this speculative leg may hold: true only on an utterance's FIRST
   * dispatch. An extension replay already held once — a second silence means
   * the caller is done, so the replay leg is not taught the hold token and
   * its leading tokens can only escalate or answer.
   */
  speculativeHoldAllowed: boolean;
  /**
   * Verdict-deadline fail-open: if a speculative leg produces no verdict
   * within the endpoint budget, the turn commits anyway (thinking frame +
   * ack timer arm) so a provider TTFT tail is bounded dead air instead of
   * unbounded structural silence. Null once fired, cleared, or committed.
   */
  verdictDeadlineTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The turn was discarded before its bridge handle resolved (speech can
   * resume while startVoiceTurn is still persisting). The handle's arrival
   * must complete the rollback via discard(), not a plain abort — otherwise
   * the discarded pause's user row leaks into history.
   */
  discardRequested: boolean;
  /**
   * Accumulates a non-front-door speculative leg's deltas until the verdict
   * resolves (whitespace-only prefixes carry no verdict).
   */
  speculativeBuffer: string;
  /**
   * Triage-and-escalate: the front-door leg gave the escalate verdict and
   * the strong "escalated" leg has taken over this same turn. Guards the
   * front-door leg's trailing completion from finalizing the turn, and
   * makes the hand-off idempotent.
   */
  escalationHandedOff: boolean;
  /**
   * Latched when the turn puts something on screen (a `ui_surface_show` /
   * `ui_update` rendered a card), cleared by `ui_surface_dismiss` — last
   * write wins, which is the right reading of "what did this turn leave on
   * screen" without tracking surfaces individually. Consumed once at TTS
   * drain, where the `minimize_room` frame goes out after `tts_done` (never
   * mid-sentence — "voice announces, screen follows"). Never set from
   * anything the model says: the reveal is a consequence of showing a
   * surface, not a token the model has to remember (`[-1]` stays
   * strip-only).
   */
  minimizeRequested: boolean;
  /**
   * Confirmations this turn has left pending for the user (mid-call
   * approvals). Non-empty ⇒ the turn is blocked on a decision: progress
   * narration stands down (its whole vocabulary — "still on it", "almost
   * there" — describes work in flight and would be false), and the fixed
   * approval phrase has already been spoken once for this wait.
   */
  pendingApprovalIds: Set<string>;
  /**
   * Per-request presentation timers: after
   * {@link VOICE_APPROVAL_PRESENTATION_TIMEOUT_MS} an unanswered approval
   * stops being the call's featured moment (`approval_resolved` outcome
   * `expired`) while the confirmation itself stays pending on the chat path.
   * Cleared on real resolution and on turn finalize.
   */
  pendingApprovalTimers: Map<string, ReturnType<typeof setTimeout>>;
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
  /**
   * Whether THIS client asked for `activity` frames — the model-authored
   * label for surfaces the OS draws (Lock Screen, Dynamic Island). Separate
   * from {@link toolActivity} because they are different contracts; see the
   * `activity` field on the start frame.
   */
  private readonly activityLabels: boolean;
  /** Base control prompt composed with the selected persona/mode (tone). */
  private readonly voiceControlPrompt: string;
  private readonly fullDuplexIdleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private state: LiveVoiceSessionState = "initializing";
  private transcriber: StreamingTranscriber | null = null;
  /** Single-flight guard for {@link beginNextListeningTurn}. */
  private rearmInFlight: Promise<void> | null = null;
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
  /**
   * The turn the client has been told to wait for and has not been released
   * from: set when a `thinking` frame goes out, cleared by the `tts_done` or
   * `turn_cancelled` that closes it. Maintained inside {@link sendFrame} on
   * purpose — the frames that open and close a turn are written from half a
   * dozen call sites, and a flag maintained at those call sites is a flag that
   * drifts. What it exists for is the one question teardown has to be able to
   * answer: is there a caller sitting on "Thinking…" right now?
   */
  private turnAwaitingRelease: string | null = null;
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
   * silence against it so it never speaks over still-draining playback, and
   * the server-side barge-in guard covers this drain window too — the server
   * clears the turn right after tts_done while the client keeps playing the
   * buffered tail, and a noise blip must not clip the reply's last words.
   * Zeroed whenever the client flushes playback (speech_started barge-in,
   * turn_cancelled, interrupt, close).
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
   * Base energy gate for server-VAD speech classification; undefined defers
   * to `DEFAULT_SPEECH_ENERGY_THRESHOLD`. During estimated playback,
   * {@link classifyVadEnergy} raises the effective gate above the learned
   * echo level (unflagged sessions only).
   */
  private speechEnergyThreshold: number | undefined;
  /**
   * True iff the playback echo classifier runs for this session: the start
   * frame did NOT declare `echoSafePlayback` (an echo-safe client's playback
   * is covered by browser echo cancellation, so its mic audio is already
   * clean and the whole path is skipped — zero overhead) and the margin
   * enables adaptation. Resolved in {@link configureTurnDetection}.
   */
  private echoClassifierEnabled = false;
  private echoBargeInMargin = DEFAULT_ECHO_BARGE_IN_MARGIN;
  private echoEmaHalfLifeMs = DEFAULT_ECHO_EMA_HALF_LIFE_MS;
  private echoDrainSlackMs = DEFAULT_ECHO_DRAIN_SLACK_MS;
  // Learned microphone energy attributable to assistant playback.
  private echoEnergyEma = 0;
  // Signal-bearing microphone audio held until it can be compared with the
  // assistant PCM. A nonmatch is replayed through VAD in original order.
  private echoProbeChunks: Buffer[] = [];
  // Recent raw assistant PCM from the current playback burst.
  private echoReferenceAudio = Buffer.alloc(0);
  private echoWindowTotalAudioMs = 0;
  // Consecutive sub-base input expires a reference that can no longer
  // describe audible playback.
  private echoSubBaseRunMs = 0;
  // Once onset eligibility lapses, later user speech cannot seed a new echo
  // reference in the same playback window.
  private echoOnsetLapsed = false;
  // A live speech run that predates playback belongs to the user and bypasses
  // echo warm-up until that run genuinely resets.
  private echoWindowGuardCarryover = false;
  /**
   * Effective trailing-silence threshold, mirroring the detector's private
   * copy (start seed + `update_config`).
   */
  private silenceThresholdMs = 0;
  /**
   * Sustained-speech barge-in guard duration (ms). Seeded at `start()` and
   * retunable via `update_config`; consumed by the server-side barge-in
   * guard ({@link trackBargeInGuard}). 0 disables the guard (instant
   * barge-in).
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
  /**
   * Guards the idle-wedge re-arm below against re-entry: chunks keep arriving
   * every ~50ms while `beginNextListeningTurn` is still resolving the fresh
   * transcriber, and each of them sees `state === "transcriber_closed"`.
   */
  private vadRearmInFlight = false;
  /**
   * Sustained-speech barge-in guard, armed at speech onset while the
   * assistant turn is in flight or its playback tail is still (estimatedly)
   * audible: above-gate speech-chunk duration accumulates until it reaches
   * bargeInMinSpeechMs, then the deferred speech_started + barge-in fire (at
   * most once per onset). Brief sub-threshold gaps are tolerated (see
   * BARGE_IN_GAP_TOLERANCE_MS); the run resets on a single longer continuous
   * silence, or once cumulative tolerated silence exceeds the duty-cycle
   * ceiling (BARGE_IN_MAX_TOLERATED_SILENCE_RATIO). The detector's utterance
   * end discards the guard.
   */
  private pendingBargeIn: {
    // Null when guarding only the post-tts_done drain window (the turn is
    // already finalized but the client is still playing its tail).
    turn: ActiveAssistantTurn | null;
    speechMs: number;
    // Consecutive sub-threshold (non-speech) time since the last speech
    // chunk; resets speechMs once it exceeds BARGE_IN_GAP_TOLERANCE_MS.
    silenceMs: number;
    // Cumulative sub-threshold time over the whole run (not reset by speech
    // chunks); resets speechMs once it exceeds the duty-cycle ceiling so
    // sparse periodic blips cannot sum into a barge-in.
    toleratedSilenceMs: number;
  } | null = null;
  /**
   * Set when barge-in cancels an in-flight turn: the interrupted request's
   * transcript, carried into the next turn so the model merges the two.
   * Consumed (and cleared) when that turn launches; cleared if the barge-in
   * utterance is discarded, so it can never attach to a later, unrelated
   * turn.
   */
  private pendingInterruptedRequest: string | null = null;
  /** Latest non-final STT partial trailing the finals (speculative content). */
  private latestPartialText: string | null = null;
  /**
   * Count per detected-language base subtag (see voteDominantLanguage)
   * across the current utterance's final transcript events. Resolves the
   * turn's spoken language (see turnLanguageFor); empty when the provider
   * tags nothing. Reset with the rest of the per-utterance state on re-arm.
   */
  private readonly languageTally = new Map<string, number>();
  /**
   * Detected languages of the most recent partial that carried any, already
   * normalized, dominance order. Speculative turns dispatch from partials
   * before the first tagged final lands, so turnLanguageFor falls back to
   * this when the final tally is still empty. Not cleared by tag-less
   * partials: the tally outranks it once finals arrive, and a revising
   * partial without tags must not wipe an earlier partial's detection.
   */
  private latestPartialLanguages: readonly string[] | null = null;
  /**
   * Consecutive front-door "hold" extensions the current utterance has
   * consumed, bounded by `liveVoice.frontDoor.endpointMaxExtensions`.
   */
  private endpointExtensionCount = 0;
  /**
   * The transcript the most recent hold verdict judged. A final segment
   * arriving during the extension window that extends this text replays the
   * boundary immediately — the hold was judged on stale text, so waiting out
   * the extension only adds silence.
   */
  private heldSpeculativeContent: string | null = null;
  /**
   * Pending replay of a held silence boundary. The detector cannot extend an
   * in-flight countdown, so this timer IS the extension mechanism: on expiry
   * it replays handleVadUtteranceEnd("silence") iff the held utterance is
   * still open and speech has not resumed.
   */
  private endpointExtensionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every VAD speech onset so a speculative verdict that resolves
   * after speech resumed is discarded instead of committing a turn the user
   * is still adding to.
   */
  private vadSpeechGeneration = 0;
  /**
   * Latched by releaseFromClient just before it forces the detector's
   * turn-end. The forced boundary shares the "silence" reason with genuine
   * VAD silences, but an explicit client release must never be second-guessed
   * by the speculative front door. forceEnd fires its turn-end callback
   * synchronously, so the very next handleVadUtteranceEnd consumes the latch.
   */
  private manualReleaseForced = false;

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
    this.activityLabels = context.startFrame.activity === true;
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
    const wantsFrontModel = front.spokenAcks || front.progress.enabled;
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

  private get frontDoorConfig(): LiveVoiceFrontDoorConfig | null {
    return this.liveVoiceConfig?.frontDoor ?? null;
  }

  /**
   * Whether unified front-door routing (speculative dispatch + verdict-first
   * triage) is live for this session: server_vad sessions only, behind the
   * `liveVoice.frontDoor.enabled` flag. With it off — and on every manual
   * session — turns run the single-leg path exactly as before.
   */
  private get frontDoorRoutingActive(): boolean {
    return (
      this.turnDetector !== null &&
      this.frontDoorConfig?.enabled === true &&
      this.startVoiceTurn !== null
    );
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
        // Capability advertise: this daemon accepts `attach_image` (mid-call
        // camera photos). The client renders its camera only on this flag —
        // an older daemon rejects the frame with a session-fatal
        // `unknown_type`, so silence here keeps the camera hidden.
        attachImage: true,
        // Capability advertise: this daemon can send `activity` frames. It
        // still only sends them to a client that asked on the start frame —
        // this tells a client the frame exists at all, so "this daemon is too
        // old" is distinguishable from "this turn had nothing to say".
        activity: true,
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
      case "attach_image":
        this.persistPhoto(frame);
        return;
    }
  }

  /**
   * Persist a photo taken mid-call into the conversation, running no turn.
   *
   * Fire-and-forget on purpose: the persist waits out any in-flight turn, and
   * the socket must keep pumping audio meanwhile. The client already showed a
   * thumbnail from the local frame, so nothing on screen is waiting on this.
   *
   * The photo becomes its own user message rather than riding the next spoken
   * turn, which is what makes shutter-then-speak and speak-then-shutter
   * behave the same: either way the model's history has the image by the time
   * it answers. See `live-voice-photo.ts` for the full reasoning.
   */
  private persistPhoto(frame: LiveVoiceClientAttachImageFrame): void {
    void persistLiveVoicePhoto(this.conversationId, frame.attachmentId).then(
      (result) => {
        if (!result.ok && !this.isClosed) {
          void this.sendFrame({
            type: "error",
            code: LiveVoiceProtocolErrorCode.InvalidFrame,
            message: "Could not attach that photo to the conversation.",
            // Names the photo as the casualty so the client can retract the
            // thumbnail it already showed, rather than filing this with the
            // transient transcriber and TTS blips that share `fatal: false`.
            frameType: "attach_image",
            // The session is fine; only this photo failed.
            fatal: false,
          });
        }
      },
    );
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
      // An echo-safe client (media-element playback covered by browser echo
      // cancellation, declared via `echoSafePlayback`) cannot loop the reply
      // back through its mic, so it gets the schema-default guard even when
      // the deployed config raises `vad.bargeInMinSpeechMs` as an echo
      // stopgap for older clients — that stopgap is scoped to the clients
      // that need it.
      (this.context.startFrame.echoSafePlayback === true
        ? DEFAULT_BARGE_IN_MIN_SPEECH_MS
        : vad.bargeInMinSpeechMs);
    this.echoBargeInMargin =
      this.options.echoBargeInMargin ?? vad.echoBargeInMargin;
    this.echoEmaHalfLifeMs =
      this.options.echoEmaHalfLifeMs ?? vad.echoEmaHalfLifeMs;
    this.echoDrainSlackMs =
      this.options.echoDrainSlackMs ?? vad.echoDrainSlackMs;
    // Scoped to the clients that need it: an echo-safe client's playback
    // cannot loop back through its mic, so it keeps the plain fixed-threshold
    // gate with zero classifier overhead.
    this.echoClassifierEnabled =
      this.context.startFrame.echoSafePlayback !== true &&
      this.echoBargeInMargin > 1;
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
   * Effective barge-in guard duration (start seed + `update_config`),
   * consumed by the server-side sustained-speech guard. Exposed for tests.
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
    // Fail-open: whatever killed the turn, the caller must not be left on a
    // spinner by it. Runs AFTER the cancel so the turn's own archive frames
    // are already out, and before the queue drains below so it makes the
    // socket.
    await this.releaseWaitingTurnAtTeardown();
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

    for (const classified of this.classifyVadEnergy(chunk)) {
      await this.handleClassifiedVadAudio(detector, classified);
    }
  }

  private async handleClassifiedVadAudio(
    detector: MediaTurnDetector,
    classified: VadClassifiedChunk,
  ): Promise<void> {
    const { chunk, classification: energyClassification } = classified;
    const hasSpeech = energyClassification === "speech";
    // May fire onTurnStart (speech_started) / onTurnEnd synchronously.
    detector.onMediaChunk(hasSpeech);
    this.trackBargeInGuard(energyClassification, chunk);

    // Playback echo is neither user audio nor useful pre-roll. Dropping it
    // prevents the assistant's reply from reaching transcription as a ghost
    // follow-up turn.
    if (energyClassification === "echo") {
      return;
    }

    // Idle mic: hold silent chunks in the bounded pre-roll instead of
    // collecting or streaming them; flushed on speech onset so the
    // transcriber still gets leading context ahead of the first syllable.
    if (!hasSpeech && !detector.isActive) {
      this.pushVadPreRoll(chunk, false);
      return;
    }

    // A transcriber idle-close (Deepgram drops its realtime socket after
    // ~30s without audio — routine between exchanges, since idle silence
    // never reaches STT here) parks the session in "transcriber_closed".
    // That is the right idle posture, but new speech must re-arm listening
    // itself: the only other re-arm runs at assistant-turn end, and no turn
    // is running — without this, the utterance and its boundary park forever
    // and the room goes permanently deaf ("voice drops after two exchanges").
    // `beginNextListeningTurn` resolves a fresh transcriber, returns the
    // session to "active", and flushes the parked ring — including this
    // chunk, parked first so the utterance keeps its onset.
    if (
      hasSpeech &&
      this.state === "transcriber_closed" &&
      !this.activeAssistantTurn &&
      !this.vadRearmInFlight
    ) {
      this.pushVadPreRoll(chunk, true);
      this.vadRearmInFlight = true;
      try {
        await this.beginNextListeningTurn();
      } finally {
        this.vadRearmInFlight = false;
      }
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

  /**
   * Classify microphone energy while keeping assistant playback echo out of
   * barge-in, turn detection, pre-roll, and transcription.
   *
   * A short onset probe must correlate with PCM sent to the speaker before its
   * microphone power can seed the adaptive threshold. Nonmatching probe audio
   * is replayed through VAD in original order, so a user who talks at playback
   * onset is neither learned as echo nor lost. Once seeded, the EMA follows
   * confirmed echo while speech above the learned margin remains frozen out.
   *
   * Runs only for sessions withOUT `echoSafePlayback` — a flagged client's
   * audio is already echo-cancelled, so it takes the fixed-threshold path
   * unconditionally (identical to the pre-classifier behavior).
   */
  private classifyVadEnergy(chunk: Buffer): VadClassifiedChunk[] {
    const baseThreshold =
      this.speechEnergyThreshold ?? DEFAULT_SPEECH_ENERGY_THRESHOLD;
    const meanAmplitude = pcm16MeanAmplitude(chunk);
    if (
      !this.echoClassifierEnabled ||
      !this.isAssistantPlaybackEchoPossible()
    ) {
      this.resetEchoReference();
      return [
        this.classifyAtFixedThreshold(chunk, baseThreshold, meanAmplitude),
      ];
    }

    if (this.echoWindowTotalAudioMs === 0) {
      this.echoWindowGuardCarryover =
        this.pendingBargeIn !== null && this.pendingBargeIn.speechMs > 0;
    } else if (this.pendingBargeIn === null) {
      this.echoWindowGuardCarryover = false;
    }

    const chunkMs = pcm16DurationMs(
      chunk.byteLength,
      this.context.startFrame.audio.sampleRate,
    );
    const onsetWasEligible =
      !this.echoOnsetLapsed &&
      this.echoWindowTotalAudioMs < ECHO_ONSET_ELIGIBILITY_MS;
    this.echoWindowTotalAudioMs += chunkMs;

    if (this.echoProbeChunks.length > 0) {
      this.echoProbeChunks.push(Buffer.from(chunk));
      return this.resolveEchoProbe(baseThreshold);
    }

    if (meanAmplitude <= baseThreshold) {
      this.echoSubBaseRunMs += chunkMs;
      if (this.echoSubBaseRunMs >= ECHO_ONSET_ELIGIBILITY_MS) {
        this.echoEnergyEma = 0;
        this.echoOnsetLapsed = true;
      }
      return [{ chunk, classification: "silence" }];
    }

    this.echoSubBaseRunMs = 0;
    if (
      this.echoEnergyEma === 0 &&
      onsetWasEligible &&
      !this.echoWindowGuardCarryover
    ) {
      this.echoProbeChunks.push(Buffer.from(chunk));
      return this.resolveEchoProbe(baseThreshold);
    }

    if (this.echoEnergyEma === 0) {
      this.echoOnsetLapsed = true;
      return [{ chunk, classification: "speech" }];
    }

    const speechThreshold = Math.max(
      baseThreshold,
      this.echoBargeInMargin * this.echoEnergyEma,
    );
    if (meanAmplitude > speechThreshold) {
      const guardHasSpeech =
        this.pendingBargeIn !== null && this.pendingBargeIn.speechMs > 0;
      if (!guardHasSpeech && this.echoMatchesAssistant(chunk)) {
        this.updateEchoEnergy(meanAmplitude, chunkMs);
        return [{ chunk, classification: "echo" }];
      }
      return [{ chunk, classification: "speech" }];
    }

    this.updateEchoEnergy(meanAmplitude, chunkMs);
    return [{ chunk, classification: "echo" }];
  }

  private resolveEchoProbe(baseThreshold: number): VadClassifiedChunk[] {
    const probe = Buffer.concat(this.echoProbeChunks);
    const probeAudioMs = pcm16DurationMs(
      probe.byteLength,
      this.context.startFrame.audio.sampleRate,
    );
    if (
      probeAudioMs >= ECHO_CORRELATION_MIN_MS &&
      this.echoMatchesAssistant(probe)
    ) {
      this.echoEnergyEma = Math.max(baseThreshold, pcm16MeanAmplitude(probe));
      const chunks = this.echoProbeChunks.splice(0);
      return chunks.map((chunk) => ({ chunk, classification: "echo" }));
    }
    if (probeAudioMs < ECHO_CORRELATION_PROBE_MS) {
      return [];
    }

    this.echoOnsetLapsed = true;
    const chunks = this.echoProbeChunks.splice(0);
    return chunks.map((chunk) =>
      this.classifyAtFixedThreshold(chunk, baseThreshold),
    );
  }

  private echoMatchesAssistant(chunk: Buffer): boolean {
    const sampleRate = this.context.startFrame.audio.sampleRate;
    const minimumBytes = Math.ceil(
      (sampleRate * ECHO_CORRELATION_MIN_MS * 2) / 1_000,
    );
    if (
      chunk.byteLength < minimumBytes ||
      this.echoReferenceAudio.byteLength < minimumBytes
    ) {
      return false;
    }
    const probeByteLength = Math.min(
      chunk.byteLength,
      Math.ceil((sampleRate * ECHO_CORRELATION_PROBE_MS * 2) / 1_000),
    );
    return (
      pcm16MaxNormalizedCorrelation(
        chunk.subarray(0, probeByteLength),
        this.echoReferenceAudio,
      ) >= ECHO_CORRELATION_THRESHOLD
    );
  }

  private updateEchoEnergy(meanAmplitude: number, chunkMs: number): void {
    const alpha = 1 - 0.5 ** (chunkMs / this.echoEmaHalfLifeMs);
    this.echoEnergyEma =
      alpha * meanAmplitude + (1 - alpha) * this.echoEnergyEma;
  }

  private classifyAtFixedThreshold(
    chunk: Buffer,
    baseThreshold: number,
    meanAmplitude = pcm16MeanAmplitude(chunk),
  ): VadClassifiedChunk {
    return {
      chunk,
      classification: meanAmplitude > baseThreshold ? "speech" : "silence",
    };
  }

  private isAssistantPlaybackEchoPossible(): boolean {
    return (
      Date.now() < this.assistantPlaybackTailUntilMs + this.echoDrainSlackMs
    );
  }

  private resetEchoReference(): void {
    this.echoEnergyEma = 0;
    this.echoProbeChunks = [];
    this.echoReferenceAudio = Buffer.alloc(0);
    this.echoWindowTotalAudioMs = 0;
    this.echoSubBaseRunMs = 0;
    this.echoOnsetLapsed = false;
    this.echoWindowGuardCarryover = false;
  }

  private appendEchoReference(chunk: LiveVoiceTtsAudioChunk): void {
    if (
      chunk.contentType.split(";", 1)[0]?.trim().toLowerCase() !==
        "audio/pcm" ||
      chunk.sampleRate !== this.context.startFrame.audio.sampleRate
    ) {
      return;
    }
    const audio = Buffer.from(chunk.dataBase64, "base64");
    const maxBytes = Math.ceil(
      (chunk.sampleRate * ECHO_REFERENCE_MAX_MS * 2) / 1_000,
    );
    const combined = Buffer.concat([this.echoReferenceAudio, audio]);
    this.echoReferenceAudio =
      combined.byteLength > maxBytes
        ? combined.subarray(combined.byteLength - maxBytes)
        : combined;
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
   * VAD speech onset. Contract: `speech_started` tells the client to flush
   * tail playback immediately; barge-in then cancels any in-flight,
   * non-finalized turn — including a pre-TTS "thinking" turn whose reply is
   * still being generated, so a user can cut in before the assistant starts
   * talking. Speaking over a thinking or audibly speaking turn is deferred
   * behind the sustained-speech guard, so a cough or noise blip cannot kill
   * an unspoken reply or clip a spoken one; sustained speech aborts the
   * turn. Onset while listening keeps the instant `speech_started`
   * (turn-taking latency is untouched).
   */
  private handleVadSpeechStart(): void {
    if (this.isTerminal) return;

    // Speech resumed: a speculative verdict still in flight is stale (the
    // generation bump defers it), and a pending hold replay is moot — the
    // utterance keeps accumulating and the detector fires a fresh turn-end.
    this.vadSpeechGeneration += 1;
    this.clearEndpointExtensionTimer();

    // Speech resumed while a speculative leg was awaiting its verdict: the
    // pause was mid-thought after all. Discard silently (no frames were ever
    // sent for it) and let the utterance keep accumulating — this is the
    // hold outcome decided by the caller's own voice instead of the model.
    const speculative = this.activeAssistantTurn;
    if (speculative?.speculativePending) {
      this.discardSpeculativeTurn(speculative, "speech_resumed");
    }

    const turn = this.activeAssistantTurn;
    // Any in-flight, non-finalized turn is interruptible, whether it is
    // still "thinking" (pre-TTS) or audibly speaking.
    const bargeableTurn = turn && !turn.finalized ? turn : null;
    // The client can still be draining audible playback after tts_done (the
    // turn is already cleared server-side) — that tail deserves the same
    // guard, or a noise blip clips the reply's last words. The drain slack
    // keeps the guard aligned with the echo classifier's window.
    const drainingPlayback = this.isAssistantPlaybackEchoPossible();

    if ((bargeableTurn || drainingPlayback) && this.bargeInMinSpeechMs > 0) {
      // Onset audio keeps flowing into the pre-roll/utterance while the
      // guard accumulates (trackBargeInGuard), so no speech is lost.
      this.pendingBargeIn = {
        turn: bargeableTurn,
        speechMs: 0,
        silenceMs: 0,
        toleratedSilenceMs: 0,
      };
      return;
    }

    this.pendingBargeIn = null;
    this.assistantPlaybackTailUntilMs = 0;
    void this.sendServerVadFrame({ type: "speech_started" });
    if (bargeableTurn) {
      this.bargeIn(bargeableTurn);
    }
  }

  /**
   * Advance the sustained-speech barge-in guard by one server-VAD chunk:
   * above-gate speech accumulates toward bargeInMinSpeechMs while brief
   * true-silence gaps are tolerated (a single continuous silence longer
   * than BARGE_IN_GAP_TOLERANCE_MS, or cumulative tolerated silence past the
   * duty-cycle ceiling, zeroes the run), classified playback echo resets the
   * run immediately, and once met the deferred speech_started + barge-in
   * fire.
   */
  private trackBargeInGuard(
    classification: VadEnergyClassification,
    chunk: Buffer,
  ): void {
    const guard = this.pendingBargeIn;
    if (!guard) return;
    const chunkMs = pcm16DurationMs(
      chunk.byteLength,
      this.context.startFrame.audio.sampleRate,
    );
    if (classification === "echo") {
      this.resetBargeInGuardRun();
      return;
    }
    if (classification === "silence") {
      guard.silenceMs += chunkMs;
      guard.toleratedSilenceMs += chunkMs;
      // Strictly greater on the per-gap check: a gap of exactly
      // BARGE_IN_GAP_TOLERANCE_MS is still tolerated. The web client batches
      // PCM into 50 ms frames (pcm-capture, aligned in V-1a), so a run of
      // ducked frames lands on the boundary exactly (e.g. four frames =
      // 200 ms). The run also resets once its total tolerated silence
      // outweighs the speech by the duty-cycle ceiling, so sparse periodic
      // blips can never sum to the guard.
      if (
        guard.silenceMs > BARGE_IN_GAP_TOLERANCE_MS ||
        guard.toleratedSilenceMs >
          this.bargeInMinSpeechMs * BARGE_IN_MAX_TOLERATED_SILENCE_RATIO
      ) {
        this.resetBargeInGuardRun();
      }
      return;
    }
    guard.silenceMs = 0;
    guard.speechMs += chunkMs;
    if (guard.speechMs < this.bargeInMinSpeechMs) return;
    this.pendingBargeIn = null;
    this.assistantPlaybackTailUntilMs = 0;
    void this.sendServerVadFrame({ type: "speech_started" });
    const { turn } = guard;
    if (turn && turn === this.activeAssistantTurn && !turn.finalized) {
      this.bargeIn(turn);
    }
  }

  private resetBargeInGuardRun(): void {
    const guard = this.pendingBargeIn;
    if (!guard) {
      return;
    }
    guard.speechMs = 0;
    guard.silenceMs = 0;
    guard.toleratedSilenceMs = 0;
    if (this.echoWindowGuardCarryover) {
      this.echoWindowGuardCarryover = false;
      this.echoEnergyEma = 0;
      this.echoProbeChunks = [];
    }
  }

  /**
   * Server-side barge-in: sustained user speech aborted an in-flight turn.
   *
   * Teardown ordering is load-bearing (ported from upstream exactly): the
   * playback-tail estimate zeroes and the abort is SYNCHRONOUS, so no
   * tts_audio frame can follow `turn_cancelled` (every TTS send re-checks
   * the abort signal at write time); the interrupted request's transcript is
   * captured for the next turn's merge context; the async tail then sends
   * `turn_cancelled` (capability-gated — barge-in only exists on server_vad
   * sessions), finalizes the turn as cancelled, and re-arms listening so the
   * barge-in speech parked in the pre-roll ring flushes into a fresh
   * transcriber.
   */
  private bargeIn(turn: ActiveAssistantTurn): void {
    this.assistantPlaybackTailUntilMs = 0;
    // Carry the interrupted request into the next turn so it merges with the
    // barge-in utterance rather than being answered as a fresh follow-up.
    const interruptedRequest = turn.utteranceText.trim();
    this.pendingInterruptedRequest =
      interruptedRequest.length > 0 ? interruptedRequest : null;
    this.clearFillerTimers(turn);
    // Tagged reason: provider catch-sites classify untagged caller aborts as
    // retryable transport failures (ERROR log + futile retry against the
    // aborted signal). This signal reaches the brain leg and any in-flight
    // ack generation.
    turn.abortController.abort(
      createAbortReason("voice_session_aborted", "live-voice-barge-in"),
    );
    this.metrics.markBargeIn(turn.turnId);
    log.debug({ turnId: turn.turnId }, "Voice barge-in cancelled a turn");
    void (async () => {
      await this.sendServerVadFrame({
        type: "turn_cancelled",
        turnId: turn.turnId,
      });
      await this.cancelAssistantTurn("barge_in");
      // Hands-free rides full-duplex: re-arm listening so the barge-in
      // speech parked in the pre-roll ring flushes into a fresh transcriber
      // and the interrupting utterance is captured from its onset.
      await this.beginNextListeningTurn();
    })().catch(() => {});
  }

  /**
   * VAD closed the utterance — the analog of ptt_release: emit
   * `utterance_end`, then run the standard release path (which stops the
   * transcriber and starts the assistant turn exactly as a client
   * `ptt_release` does today). A boundary that fires while the session is
   * between utterances belongs to speech parked in the pre-roll ring; it is
   * recorded and replayed once the next listening turn arms.
   *
   * With the unified front door enabled, a detector-timer silence boundary
   * first tries the speculative dispatch: the answer leg launches with
   * nothing user-visible, and its leading verdict decides whether the
   * boundary commits (utterance_end + thinking at commit) or the pause was
   * mid-thought (hold: silent discard + bounded extension). A manual client
   * release (`manualReleaseForced`) and max-duration boundaries always
   * release — never second-guess the user or the hard cap.
   */
  private handleVadUtteranceEnd(reason: "silence" | "max-duration"): void {
    // Consume the manual-release latch before any async hop: it belongs to
    // exactly this boundary (forceEnd fired this callback synchronously),
    // and it must not leak into a later genuine silence even when the
    // early-exit guards below skip the release.
    const manualRelease = this.manualReleaseForced;
    this.manualReleaseForced = false;
    void (async () => {
      if (this.isTerminal) return;
      // The detector turn is over: an untripped guard was noise, not
      // barge-in — leave playback untouched.
      this.pendingBargeIn = null;
      if (reason === "max-duration") {
        // A max-duration boundary always releases: drop any pending hold
        // replay so it cannot re-fire a boundary this one already owns.
        this.clearEndpointExtensionTimer();
      }
      if (this.state !== "active") {
        if (this.vadPreRollHasSpeech) {
          this.vadPendingTurnEnd = reason;
        }
        return;
      }
      if (reason === "silence" && !manualRelease) {
        if (await this.launchSpeculativeAssistantTurn()) return;
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
      // Latch first: the forced boundary reports "silence", and this marks
      // it as a manual release the speculative front door must not
      // second-guess (see the manualReleaseForced field doc).
      this.manualReleaseForced = true;
      // Fires handleVadUtteranceEnd synchronously, which emits utterance_end
      // (reason "silence" — the manual-release convention) and releases.
      detector.forceEnd();
      await this.drainOutboundFrames();
      return;
    }
    if (this.state === "active") {
      // Server VAD with no active detector turn but a still-open utterance
      // is a held pause (a hold verdict suppressed the boundary) or a
      // speculative verdict window. The manual release supersedes both:
      // drop the pending hold replay and emit the boundary now — the
      // hands-free client only leaves `listening` on `utterance_end`.
      this.clearEndpointExtensionTimer();
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
      | Omit<LiveVoiceUtteranceEndServerFrame, "seq">
      | Omit<LiveVoiceTurnCancelledServerFrame, "seq">
      | Omit<LiveVoiceMinimizeRoomServerFrame, "seq">
      | Omit<LiveVoiceApprovalPendingServerFrame, "seq">
      | Omit<LiveVoiceApprovalResolvedServerFrame, "seq">,
    shouldSend?: () => boolean,
  ): Promise<void> {
    if (!this.turnDetector) return;
    await this.sendFrame(frame, shouldSend);
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
        this.latestPartialText = event.text;
        // The event contract (stt/types.ts) guarantees the tags arrive as
        // normalized base subtags in dominance order, so they are stored
        // as-is. Partials revise each other, so this overwrites rather than
        // tallies, and a tag-less partial keeps the previous value.
        if (event.languages && event.languages.length > 0) {
          this.latestPartialLanguages = event.languages;
        }
        this.markFirstPartial();
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      case "final": {
        const transcript = event.text.trim();
        if (transcript.length > 0) {
          this.finalTranscriptSegments.push(transcript);
          // Tally only finals that committed transcript: empty silence
          // frames can still carry container-level language tags describing
          // no emitted words, and counting those would let silence outvote
          // real speech.
          voteDominantLanguage(this.languageTally, event.languages);
        }
        // The final commits (and supersedes) whatever partial was trailing.
        this.latestPartialText = null;
        this.markFinalTranscript();
        await this.sendFrame({ type: "stt_final", text: event.text });
        // Fresh-final fast replay (unified front door): a hold judged on the
        // pre-finalize partial is stale the moment the finalized transcript
        // extends it — the caller already finished, so waiting out the
        // extension window only adds silence. Replay the silence boundary
        // now. Guards mirror the extension timer's own: the utterance still
        // open, and the detector quiet (speech resuming owns the boundary).
        if (
          this.endpointExtensionTimer !== null &&
          this.heldSpeculativeContent !== null &&
          this.state === "active" &&
          !this.pttReleased &&
          !this.turnDetector?.isActive
        ) {
          const contentNow = [
            this.finalTranscriptText.trim(),
            this.latestPartialText ?? "",
          ]
            .join(" ")
            .trim();
          if (
            contentNow.length > 0 &&
            contentNow !== this.heldSpeculativeContent
          ) {
            this.clearEndpointExtensionTimer();
            this.heldSpeculativeContent = null;
            this.handleVadUtteranceEnd("silence");
            return;
          }
        }
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
    // The client stopped its own playback, so the drain estimate resets.
    this.assistantPlaybackTailUntilMs = 0;
    // A client interrupt also discards speech parked in the pre-roll ring,
    // abandons any front-door hold still awaiting replay, and drops the
    // sustained-speech guard.
    this.takeVadPreRoll();
    this.vadPendingTurnEnd = null;
    this.clearEndpointExtensionTimer();
    this.heldSpeculativeContent = null;
    this.pendingBargeIn = null;
    // A client interrupt is a hard reset: any barge-in merge context waiting
    // for the next turn is now stale.
    this.pendingInterruptedRequest = null;
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
    // SINGLE-FLIGHT. Several paths re-arm listening — barge-in, the client
    // `interrupt` frame, TTS completion, endTurnWithoutAnswer, and the
    // idle-speech re-arm — and a barge-in makes two of them fire for the SAME
    // exchange (the barge-in handler, plus the cancelled turn's completion
    // continuation). Unguarded, both resolved a transcriber (observed live:
    // two Deepgram sessions opened 2ms apart); the loser became an orphan
    // that timed out 30s later and its close event scrambled the session
    // state machine — the "call goes deaf after a barge-in" failure class.
    if (this.rearmInFlight) return this.rearmInFlight;
    const run = this.beginNextListeningTurnInner().finally(() => {
      this.rearmInFlight = null;
    });
    this.rearmInFlight = run;
    return run;
  }

  private async beginNextListeningTurnInner(): Promise<void> {
    if (this.isClosed || this.state === "failed") return;

    // Already armed and listening with no turn in flight: a second re-arm
    // would replace a healthy live transcriber with a fresh connect for no
    // benefit. (Sequential double re-arm — e.g. TTS completion right after a
    // barge-in re-arm has finished.)
    if (
      this.state === "active" &&
      this.transcriber &&
      !this.activeAssistantTurn
    )
      return;

    // Never leave a previous transcriber running while arming a new one —
    // an orphaned realtime session keeps emitting events (idle timeout,
    // close) into this session's handler against the wrong turn.
    if (this.transcriber) {
      stopTranscriberBestEffort(this.transcriber);
      this.transcriber = null;
    }

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
    // Front-door per-utterance state: a fresh utterance gets its full hold
    // budget and a clean partial trail.
    this.latestPartialText = null;
    // Language detection is per-utterance: the next exchange's language is
    // resolved from its own speech, not the previous turn's.
    this.languageTally.clear();
    this.latestPartialLanguages = null;
    this.endpointExtensionCount = 0;
    this.heldSpeculativeContent = null;
    this.clearEndpointExtensionTimer();

    // A fresh transcriber connect can fail transiently (observed live: a
    // single Deepgram realtime connect timeout ended a healthy 4½-minute
    // call). One network blip must not kill the session: retry the
    // resolve+start pair with a short backoff and only fail the session
    // once the attempts are exhausted.
    let transcriber: StreamingTranscriber | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < TRANSCRIBER_REARM_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleepMs(TRANSCRIBER_REARM_BACKOFF_MS[attempt - 1] ?? 2000);
        if (this.isTerminal) return;
      }
      try {
        transcriber = await this.resolveTranscriber({
          sampleRate: this.context.startFrame.audio.sampleRate,
        });
      } catch (err) {
        lastErr = err;
        transcriber = null;
        continue;
      }
      if (this.isTerminal) {
        stopTranscriberBestEffort(transcriber);
        return;
      }
      if (!transcriber) break; // unavailable is a configuration state, not transient
      try {
        this.transcriber = transcriber;
        await transcriber.start((event) => {
          void this.handleTranscriberEvent(event);
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        stopTranscriberBestEffort(transcriber);
        this.transcriber = null;
        transcriber = null;
      }
    }

    if (this.isClosed) return;
    if (!transcriber && lastErr === null) {
      await this.failStartupSoft(unavailableTranscriberMessage());
      return;
    }
    if (!transcriber || lastErr !== null) {
      await this.failStartupSoft(
        `Live voice transcription could not be restarted: ${errorMessage(lastErr)}`,
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
    // A committed speculative turn answered the pre-finalize transcript;
    // once the finalized transcript lands, log if they diverged (finals
    // stream continuously, so divergence should be rare — this measures
    // whether that assumption holds in the field).
    const committed = this.activeAssistantTurn;
    if (
      this.assistantTurnStarted &&
      committed?.speculativeContent != null &&
      !committed.speculativePending &&
      this.state === "transcriber_closed"
    ) {
      const finalContent = this.finalTranscriptText.trim();
      if (
        finalContent.length > 0 &&
        finalContent !== committed.speculativeContent
      ) {
        log.warn(
          {
            turnId: committed.turnId,
            speculative: committed.speculativeContent,
            final: finalContent,
          },
          "Speculative voice turn content diverged from final transcript",
        );
      }
      committed.speculativeContent = null;
    }
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
    // One assistant turn at a time: a discarded speculative leg resets the
    // latch, but a still-active committed turn owns the session.
    if (this.activeAssistantTurn) {
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

    await this.launchAssistantTurn(content);
  }

  /**
   * Unified front door: dispatch the assistant turn speculatively at the
   * silence boundary, judging the transcript accumulated so far (finals plus
   * the trailing partial — the same text a released boundary would answer).
   * Returns false when speculation is inapplicable — the boundary then
   * releases exactly as before.
   */
  private async launchSpeculativeAssistantTurn(): Promise<boolean> {
    const front = this.frontDoorConfig;
    if (!this.frontDoorRoutingActive || !front) return false;
    if (
      this.endpointExtensionCount >= front.endpointMaxExtensions ||
      this.assistantTurnStarted ||
      this.activeAssistantTurn !== null ||
      this.pttReleased ||
      !this.startVoiceTurn
    ) {
      return false;
    }
    const content = [
      this.finalTranscriptText.trim(),
      this.latestPartialText ?? "",
    ]
      .join(" ")
      .trim();
    if (content.length === 0) return false;
    await this.launchAssistantTurn(content, { speculative: true });
    return true;
  }

  /**
   * Commit a speculative turn: the leg's leading tokens were a real answer
   * (or the escalate verdict), so the deferred boundary work happens now —
   * utterance_end + thinking frames, utterance release (which stops the
   * transcriber), and the floor-holding timers. Returns false when the world
   * moved on mid-flight (speech resumed, session moved on): the leg is
   * discarded and the caller must swallow the delta.
   */
  private commitSpeculativeTurn(turn: ActiveAssistantTurn): boolean {
    if (!turn.speculativePending) return true;
    if (
      turn.speculativeGeneration !== this.vadSpeechGeneration ||
      this.activeAssistantTurn?.token !== turn.token ||
      this.isTerminal ||
      this.state === "interrupted"
    ) {
      this.discardSpeculativeTurn(turn, "superseded");
      return false;
    }
    // An already-released utterance is NOT superseded: a manual release
    // during the verdict window (releaseFromClient) means the caller
    // explicitly asked to answer now — the verdict commits into the released
    // utterance instead of discarding the only in-flight turn. The manual
    // path already sent utterance_end and released, so those are skipped;
    // the thinking frame and timers still apply.
    const alreadyReleased = this.pttReleased;
    turn.speculativePending = false;
    // Fill the language only when dispatch had none: the model request was
    // already issued with the dispatch language, so overwriting here would
    // hint TTS (and any voice override) in a different language than the
    // reply is being generated in.
    turn.language ??= this.turnLanguageFor();
    if (turn.verdictDeadlineTimer !== null) {
      clearTimeout(turn.verdictDeadlineTimer);
      turn.verdictDeadlineTimer = null;
    }
    if (!alreadyReleased) {
      void this.sendServerVadFrame({
        type: "utterance_end",
        reason: "silence",
      });
    }
    void this.sendFrame({ type: "thinking", turnId: turn.turnId });
    if (!alreadyReleased) {
      void this.releaseUtterance();
    }
    this.armFirstDeltaAckTimer(turn.token, turn.turnId, turn.utteranceText);
    if (
      this.frontModelConfig?.progress.enabled &&
      this.streamTtsAudio &&
      this.frontDecider
    ) {
      this.armProgressIdleTimer(turn);
    }
    return true;
  }

  /**
   * Hold verdict on a speculative turn: the model judged the pause
   * mid-thought. Discard the leg (rolling back its persisted user message)
   * and extend the listening window — the extension timer replays the
   * silence boundary, which re-speculates.
   */
  private async holdSpeculativeTurn(turn: ActiveAssistantTurn): Promise<void> {
    if (
      this.activeAssistantTurn?.token !== turn.token ||
      !turn.speculativePending
    ) {
      return;
    }
    const decisionLatencyMs = Math.max(
      0,
      Date.now() - turn.speculativeDispatchedAtMs,
    );
    const generationAtDispatch = turn.speculativeGeneration;
    this.discardSpeculativeTurn(turn, "hold_verdict");
    if (
      this.isTerminal ||
      this.state === "interrupted" ||
      generationAtDispatch !== this.vadSpeechGeneration
    ) {
      // Speech resumed or the session moved on during the verdict: the
      // discard was the whole job; a fresh boundary owns the release.
      return;
    }
    if (this.pttReleased) {
      // Manual release during the verdict window: the caller explicitly
      // said they are done, so the hold is moot — but this leg's only
      // output was the hold token, so committing it would answer with
      // nothing. Discard it (done above; the turn-started latch is reset)
      // and start a fresh leg on the released utterance instead.
      void this.startAssistantTurnIfReady();
      return;
    }
    this.markEndpointDecision("hold", decisionLatencyMs);
    this.endpointExtensionCount += 1;
    // Remember what the hold judged: a final segment arriving during the
    // extension that extends this text replays the boundary immediately
    // (see the transcriber `final` handler).
    this.heldSpeculativeContent = turn.speculativeContent;
    this.armEndpointExtensionTimer();
  }

  /**
   * Abort a speculative leg and roll back everything it touched: the
   * persisted user message (via the handle's discard), the active-turn slot,
   * the consumed barge-in merge context, and the turn-started latch, so the
   * utterance can be re-dispatched (hold replay) or keep accumulating
   * (speech resumed). Nothing was ever user-visible — no frames were sent
   * for this turn.
   */
  private discardSpeculativeTurn(
    turn: ActiveAssistantTurn,
    reason: string,
  ): void {
    turn.speculativePending = false;
    // The dispatch is being unwound, so the barge-in merge note goes back to
    // the session — the turn that would have delivered it is gone. Anything
    // newer already in the slot wins.
    if (
      turn.interruptedRequest !== null &&
      this.pendingInterruptedRequest === null &&
      this.state !== "interrupted" &&
      !this.isClosed
    ) {
      this.pendingInterruptedRequest = turn.interruptedRequest;
    }
    turn.interruptedRequest = null;
    // Latched before the handle check: when the discard beats the bridge
    // handle's resolution (startVoiceTurn still persisting), the handle's
    // arrival in startAssistantLeg completes the rollback via discard().
    turn.discardRequested = true;
    if (this.activeAssistantTurn?.token === turn.token) {
      this.activeAssistantTurn = null;
    }
    this.clearFillerTimers(turn);
    turn.abortController.abort(
      createAbortReason("voice_session_aborted", `live-voice-${reason}`),
    );
    const handle = turn.handle;
    turn.handle = null;
    void handle?.discard?.().catch((err: unknown) => {
      log.warn(
        { err, turnId: turn.turnId, reason },
        "Speculative voice turn discard failed",
      );
    });
    this.assistantTurnStarted = false;
    log.info(
      { turnId: turn.turnId, reason },
      "Speculative voice turn discarded",
    );
  }

  /**
   * Arms the hold-extension replay: after `endpointExtensionMs` of continued
   * silence the deferred silence boundary re-fires (and a fresh front-door
   * leg judges it again, bounded by `endpointMaxExtensions`).
   */
  private armEndpointExtensionTimer(): void {
    this.clearEndpointExtensionTimer();
    const front = this.frontDoorConfig;
    if (!front) return;
    const timer = setTimeout(() => {
      this.endpointExtensionTimer = null;
      if (
        this.state !== "active" ||
        this.pttReleased ||
        this.assistantTurnStarted ||
        // Speech resumed (the detector owns the next boundary). Onset also
        // clears this timer, so this is a belt to that suspender.
        this.turnDetector?.isActive
      ) {
        return;
      }
      this.handleVadUtteranceEnd("silence");
    }, front.endpointExtensionMs);
    (timer as { unref?: () => void }).unref?.();
    this.endpointExtensionTimer = timer;
  }

  private clearEndpointExtensionTimer(): void {
    if (this.endpointExtensionTimer !== null) {
      clearTimeout(this.endpointExtensionTimer);
      this.endpointExtensionTimer = null;
    }
  }

  private markEndpointDecision(
    action: "release" | "hold",
    latencyMs: number,
  ): void {
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markEndpointDecision(turnId, { action, latencyMs });
  }

  /**
   * The caller's spoken language for a turn on the current utterance, as a
   * lowercase base subtag: the dominant tallied STT-detected language
   * (most final-event counts, ties by first appearance), else the latest
   * tagged partial's dominant language (speculative turns dispatch from
   * partials), else a monolingual `services.stt.language` pin (a pinned
   * language IS the spoken language), else undefined ("multi" with no tags,
   * non-tagging providers, silence).
   */
  private turnLanguageFor(): string | undefined {
    const dominant = dominantLanguageTag(this.languageTally);
    if (dominant !== undefined) {
      return dominant;
    }
    // No tagged final yet (speculative turns dispatch from partials): the
    // latest tagged partial is the best detection available and outranks a
    // static pin for the same reason the tally does.
    const partialDominant = this.latestPartialLanguages?.[0];
    if (partialDominant !== undefined) {
      return partialDominant;
    }
    // A persisted pin only counts when the provider that transcribed honors
    // manual language selection (the shared pinnedListeningLanguage gate).
    // The live transcriber's providerId is preferred when one is still
    // attached; our resolver never silently swaps providers, so the
    // configured provider is an equivalent last resort once the transcriber
    // reference has been dropped (state "transcriber_closed" at dispatch).
    const { language: configured, provider: sttProvider } =
      getConfig().services.stt;
    const dialedProvider =
      this.transcriber?.providerId ?? (sttProvider as SttProviderId);
    return pinnedListeningLanguage(dialedProvider, configured);
  }

  // The TTS hint override for a fixed phrase picked from a localized table:
  // "en" when the turn has a language the table does not cover (the picker
  // fell back to English text, which must not be synthesized under an
  // ar/ko/ta hint), undefined otherwise (the segment rides the turn's
  // language, or no hint at all when the language is unknown).
  private fixedPhraseLanguage(
    turn: ActiveAssistantTurn,
    table: Readonly<Record<string, unknown>>,
  ): string | undefined {
    return turn.language !== undefined &&
      !hasLocalizedEntry(table, turn.language)
      ? "en"
      : undefined;
  }

  /**
   * The per-turn control prompt: the session's persona-composed base, plus
   * the detected-language note when the turn's spoken language is known,
   * plus the barge-in merge note when this turn follows an interruption.
   * Reaches the model only; never renders as a transcript bubble.
   */
  private buildTurnControlPrompt(
    turn: ActiveAssistantTurn,
    opts?: { frontDoor?: boolean },
  ): string {
    let prompt = this.voiceControlPrompt;
    // Screen-reveal teaching for the legs that can actually put something on
    // screen (main + escalated). The toolless front-door leg has nothing to
    // show and is never told the screen will be revealed — and it must not
    // read "never emit bracketed markers" while its decision rule requires a
    // leading verdict token.
    if (opts?.frontDoor !== true) {
      prompt = `${prompt} ${LIVE_VOICE_SCREEN_REVEAL_TEACHING}`;
    }
    if (turn.language !== undefined) {
      prompt = `${prompt}\n\nThe caller has been speaking the language with code "${turn.language}" this turn. Reply in that language unless they clearly switch to another.`;
    }
    if (turn.interruptedRequest) {
      prompt = `${prompt}\n\n${buildInterruptionMergeNote(turn.interruptedRequest)}`;
    }
    return prompt;
  }

  /**
   * Build the ActiveAssistantTurn for the released (or, speculatively, still
   * open) utterance and drive its model leg. A speculative turn defers the
   * thinking frame and both floor-holding timers to commitSpeculativeTurn:
   * until the verdict arrives, the pause may still be mid-thought and
   * nothing must be user-visible.
   */
  private async launchAssistantTurn(
    content: string,
    opts?: { speculative?: boolean },
  ): Promise<void> {
    this.assistantTurnStarted = true;
    // Take the barge-in merge context for the turn being launched — it feeds
    // exactly the next launched turn. A rolled-back speculative dispatch
    // hands it back (discardSpeculativeTurn).
    const interruptedRequest = this.pendingInterruptedRequest;
    this.pendingInterruptedRequest = null;
    const token = Symbol("live-voice-assistant-turn");
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    // First-wins across an utterance's hold replays: the anchor stays at the
    // FIRST dispatch, so dispatch-anchored durations include the hold
    // pipeline the caller actually sat through.
    this.metrics.markAssistantDispatch(turnId);
    const abortController = new AbortController();
    const newTurn: ActiveAssistantTurn = {
      token,
      turnId,
      // Resolved once at dispatch: the model request, TTS hints, and
      // localized fallbacks must all agree on one language for the turn.
      // commitSpeculativeTurn refills it (??=) when dispatch had none.
      language: this.turnLanguageFor(),
      abortController,
      handle: null,
      utteranceText: content,
      launchedAtMs: Date.now(),
      assistantCompleted: false,
      ttsDone: false,
      finalized: false,
      ttsBuffer: "",
      ttsReasoningFilter: new ReasoningTagFilter(),
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
      interruptedRequest,
      speculativePending: opts?.speculative === true,
      speculativeGeneration: this.vadSpeechGeneration,
      speculativeContent: opts?.speculative === true ? content : null,
      speculativeDispatchedAtMs: Date.now(),
      speculativeHoldAllowed:
        opts?.speculative === true && this.endpointExtensionCount === 0,
      verdictDeadlineTimer: null,
      discardRequested: false,
      speculativeBuffer: "",
      escalationHandedOff: false,
      minimizeRequested: false,
      pendingApprovalIds: new Set(),
      pendingApprovalTimers: new Map(),
    };
    this.activeAssistantTurn = newTurn;

    if (!opts?.speculative) {
      await this.sendFrame({ type: "thinking", turnId });
      if (!this.isActiveAssistantTurn(token)) return;

      // Presence layer (WS-E): arm a floor-holding spoken-ack timer. If the
      // assistant is slow to produce its first spoken delta, a short "one
      // sec" is spoken so a slow turn feels responsive instead of
      // dead-silent. Cleared the moment the first delta arrives (or the
      // turn ends).
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
    } else {
      // Verdict-deadline fail-open: the deferred-everything window is only
      // safe while the verdict is fast. If the leg produces no verdict
      // within the endpoint budget (provider TTFT tail), commit anyway so
      // the thinking frame shows and the ack timer arms — bounded dead air
      // instead of unbounded structural silence. A verdict that arrives
      // after the commit still works: escalate hands off normally, and a
      // late hold token is stripped like any stray token (the utterance is
      // already released, so holding is no longer possible).
      const deadlineMs =
        this.frontDoorConfig?.endpointDecisionTimeoutMs ?? 1200;
      const deadlineTimer = setTimeout(() => {
        newTurn.verdictDeadlineTimer = null;
        if (
          this.activeAssistantTurn?.token !== token ||
          !newTurn.speculativePending
        ) {
          return;
        }
        log.info(
          { turnId, budgetMs: deadlineMs },
          "Speculative verdict deadline elapsed; committing turn (fail-open)",
        );
        this.commitSpeculativeTurn(newTurn);
      }, deadlineMs);
      (deadlineTimer as { unref?: () => void }).unref?.();
      newTurn.verdictDeadlineTimer = deadlineTimer;
    }

    await this.startAssistantLeg(newTurn, {
      content,
      ...(this.frontDoorRoutingActive
        ? { routingLeg: "front-door" as const, frontDoor: true }
        : {}),
    });
  }

  /**
   * Drive one model leg of an assistant turn through the session bridge,
   * streaming its deltas to the live-voice client and TTS.
   *
   * A turn runs one leg normally. Under front-door routing the front-door
   * leg (`frontDoor: true`) runs the verdict-first protocol: its leading
   * tokens classify as hold / escalate / answer before anything is spoken.
   * On the escalate verdict the post-verdict stream buffers into the capped
   * bridge and `escalateTurn` starts a second "escalated" leg that shares
   * this same ActiveAssistantTurn. The persisted assistant row is reduced to
   * the capped bridge by the bridge's teardown transcript-hygiene pass, and
   * the shared conversation-hub broadcast releases the same capped bridge
   * through the bridge's front-door stream gate, so no verdict token reaches
   * a hub subscriber (web chat, passive devices) mid-turn either.
   */
  private async startAssistantLeg(
    activeTurn: ActiveAssistantTurn,
    leg: {
      content: string;
      routingLeg?: VoiceRoutingLeg;
      frontDoor?: boolean;
      spokenEscalationBridge?: string;
    },
  ): Promise<void> {
    if (!this.startVoiceTurn) return;
    const { token, turnId } = activeTurn;

    // `rawText` accumulates this leg's full stream. A front-door leg starts
    // in `deciding` until its leading tokens classify as hold / escalate /
    // answer: an answer flushes through the shared marker holdback, while an
    // escalation buffers the post-verdict stream into `bridgeRaw` until the
    // bridge is complete, then hands off. An escalated leg flushes every
    // delta through the same holdback, so a stray control marker from the
    // main model is stripped instead of spoken. With routing off the plain
    // path forwards deltas verbatim, exactly as before.
    let rawText = "";
    let frontDoorStage: "deciding" | "answer" | "bridging" | "handedOff" =
      "deciding";
    let bridgeRaw = "";
    const useHoldback = this.frontDoorRoutingActive;

    const emitLegText = (chunk: string): void => {
      if (chunk.length === 0) return;
      this.noteFirstAssistantDelta(token);
      this.markFirstAssistantDelta(turnId);
      // Send-time abort gate: a delta queued behind a backed-up outbound
      // frame must not be written once barge-in aborts the turn, or the
      // cancelled reply's text leaks ahead of turn_cancelled. Keyed off this
      // turn's own abort signal — escalation aborts the front-door handle,
      // not this turn's controller, so legitimate front-door text still
      // sends.
      void this.sendFrame(
        { type: "assistant_text_delta", text: chunk },
        () => !activeTurn.abortController.signal.aborted && !this.isClosed,
      );
      this.bufferAssistantTextForTts(token, chunk);
    };

    const flushLegText = createControlMarkerHoldback(emitLegText);

    // Hand off once enough of the post-verdict stream has arrived to cap the
    // bridge (sentence terminator or hard cap). Until then nothing is spoken
    // — the bridge goes out in one piece at hand-off, so the audio, the
    // persisted row, and the phrase quoted to the escalated leg are all the
    // same capped text.
    const maybeHandOffBridge = (): void => {
      if (!isEscalationBridgeComplete(bridgeRaw)) return;
      frontDoorStage = "handedOff";
      this.escalateTurn(activeTurn, capEscalationBridge(bridgeRaw));
    };

    try {
      const handle = await this.startVoiceTurn({
        conversationId: this.conversationId,
        voiceSessionId: this.context.sessionId,
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
        userMessageInterface: "macos",
        assistantMessageInterface: "macos",
        voiceControlPrompt: this.buildTurnControlPrompt(activeTurn, {
          frontDoor: leg.frontDoor === true,
        }),
        // The live-voice socket is authenticated as the instance owner, who is
        // the guardian. Without this the turn runs as a non-guardian caller and
        // the bridge strips every side-effect tool ("this action requires
        // guardian-level access"), so the assistant refuses tasks it can do.
        trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
        // Give the assistant its common capabilities up front — otherwise a
        // fresh voice conversation only has core tools and cannot add a task,
        // schedule, etc. until it discovers and `skill_load`s them. The
        // front-door leg runs toolless regardless (the bridge's
        // toolsDisabledDepth bracket), so this only matters for answering
        // legs.
        preactivatedSkillIds: LIVE_VOICE_PREACTIVATED_SKILLS,
        approvalMode: "local-live-voice",
        content: leg.content,
        isInbound: true,
        signal: activeTurn.abortController.signal,
        ...(leg.routingLeg != null ? { routingLeg: leg.routingLeg } : {}),
        ...(leg.spokenEscalationBridge != null
          ? { spokenEscalationBridge: leg.spokenEscalationBridge }
          : {}),
        // A speculative front-door leg's decision rule includes the hold
        // branch so its leading tokens can be the hold verdict — but only on
        // the utterance's FIRST dispatch. Extension replays (the utterance
        // already held once) and non-speculative legs must never learn the
        // token, or a spoken answer could start with it / a second hold
        // could stack another silent extension.
        ...(activeTurn.speculativePending &&
        activeTurn.speculativeHoldAllowed &&
        leg.frontDoor
          ? { unifiedVerdict: true }
          : {}),
        callbacks: {
          assistant_text_delta: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            if (leg.frontDoor) {
              rawText += msg.text;
              if (frontDoorStage === "handedOff") return;
              if (frontDoorStage === "bridging") {
                bridgeRaw += msg.text;
                maybeHandOffBridge();
                return;
              }
              // Verdict-first: the leg's leading tokens decide the turn's
              // fate. Hold discards a speculative turn (mid-thought pause,
              // keep listening); escalate and answer both commit it —
              // utterance release, thinking frame, and timers all happen
              // inside commitSpeculativeTurn. The hold branch is only
              // classifiable while the leg is speculative (its decision rule
              // is the only one that teaches the hold token).
              if (frontDoorStage === "deciding") {
                const verdict = classifyFrontDoorLeading(
                  rawText.trimStart(),
                  activeTurn.speculativePending &&
                    activeTurn.speculativeHoldAllowed,
                );
                if (verdict === "pending") return;
                if (verdict === "hold") {
                  void this.holdSpeculativeTurn(activeTurn);
                  return;
                }
                if (
                  activeTurn.speculativePending &&
                  !this.commitSpeculativeTurn(activeTurn)
                ) {
                  return;
                }
                if (verdict === "escalate") {
                  frontDoorStage = "bridging";
                  bridgeRaw = rawText
                    .trimStart()
                    .slice(ESCALATE_VERDICT_TOKEN.length);
                  maybeHandOffBridge();
                  return;
                }
                frontDoorStage = "answer";
              }
              flushLegText(rawText);
              return;
            }
            // Defensive: speculative legs are always front-door today, but a
            // non-front-door speculative leg must still fail open to a
            // committed turn on its first delta rather than dangle.
            if (activeTurn.speculativePending) {
              activeTurn.speculativeBuffer += msg.text;
              if (activeTurn.speculativeBuffer.trimStart().length === 0) {
                return;
              }
              if (!this.commitSpeculativeTurn(activeTurn)) return;
            }
            rawText += msg.text;
            if (useHoldback) {
              // Escalated legs share the marker holdback so a stray control
              // marker from the main model is stripped instead of spoken.
              flushLegText(rawText);
              return;
            }
            // Routing off: today's plain path, byte-for-byte (plus the
            // send-time abort gate inside emitLegText).
            emitLegText(msg.text);
          },
          message_complete: (msg) => {
            const current = this.activeAssistantTurn;
            if (
              current?.token !== token ||
              current.assistantCompleted ||
              // A barged-in turn finalizes through cancelAssistantTurn.
              current.abortController.signal.aborted ||
              this.isClosed
            ) {
              return;
            }
            // A speculative leg that finished without a single delta (empty
            // output, provider hiccup) carries no verdict — fail open to a
            // committed turn so the utterance releases and finalizes like a
            // normal empty completion instead of dangling un-released.
            if (current.speculativePending) {
              this.commitSpeculativeTurn(current);
            }
            // A front-door leg that stopped mid-bridge (a bare escalate
            // verdict, or a holding phrase with no sentence terminator)
            // hands off now with whatever arrived; the canned fallback
            // covers an empty bridge. A cancellation mid-bridge falls
            // through to normal cancelled finalization instead — a dead
            // turn must not spawn an escalated leg.
            if (
              leg.frontDoor &&
              frontDoorStage === "bridging" &&
              msg.type === "message_complete" &&
              !current.escalationHandedOff
            ) {
              frontDoorStage = "handedOff";
              this.escalateTurn(current, capEscalationBridge(bridgeRaw));
              return;
            }
            // A front-door leg that handed off is finished; the escalated
            // leg drives completion. The front-door leg's own trailing
            // completion (including the generation_cancelled from its abort)
            // is a no-op.
            if (leg.frontDoor && current.escalationHandedOff) return;
            // A held "[…"-tail that never completed a marker is real text —
            // force-flush it before assistantCompleted closes the TTS buffer
            // so it is spoken and emitted rather than dropped. A front-door
            // leg qualifies only once its verdict resolved to `answer`: a leg
            // still `deciding` holds nothing but an unresolved verdict prefix
            // (never speech), and the bridging/handed-off stages returned
            // above. The hub gate's `finish()` releases on exactly this rule,
            // so the socket frames and the hub broadcast end on the same text.
            if (
              useHoldback &&
              (!leg.frontDoor || frontDoorStage === "answer") &&
              msg.type === "message_complete"
            ) {
              flushLegText(rawText, { force: true });
            }
            current.assistantCompleted = true;
            if (msg.type === "generation_cancelled") {
              // A cancelled generation is the quietest way a call died: no
              // error frame at all, no `tts_done`, no re-arm — the session just
              // stopped hearing, mid-conversation, with nothing on screen to
              // say so. Close the turn so the floor comes back to the user.
              void (async () => {
                await this.finalizeAssistantTurn(
                  current,
                  "cancelled",
                  "generation_cancelled",
                );
                if (this.isTerminal) return;
                await this.endTurnWithoutAnswer("generation_cancelled");
              })();
              return;
            }
            current.assistantMessageId = msg.messageId ?? null;
            this.completeTtsForTurn(token);
          },
          persisted_user_message_id: (messageId) => {
            const current = this.activeAssistantTurn;
            // Only the first leg's user row is the real caller utterance; the
            // escalated leg persists a hidden synthetic continuation prompt.
            if (current?.token !== token || leg.routingLeg === "escalated") {
              return;
            }
            current.userMessageId = messageId;
            this.currentUserMessageId = messageId;
          },
          persisted_assistant_message_id: (messageId) => {
            const current = this.activeAssistantTurn;
            if (current?.token !== token) return;
            current.assistantMessageId = messageId;
          },
          // Visual result cards: forward the agent loop's `ui_surface_*` events
          // across the socket as `card` frames so lists/tables/etc. render inline
          // above the orb. Gated by the same forwarding guard as text deltas so a
          // barged-in / finalized turn doesn't leak stale cards.
          // Showing a surface implies revealing it: the room is a full-screen
          // overlay, so a surface rendered behind it is a surface nobody
          // sees. The latch moves on the surface EVENTS (a card that actually
          // rendered), not on the tool attempt — a rejected `ui_show` (no
          // surface_type, an empty card) emits no `ui_surface_show`, so a
          // failed call never minimizes the room to show nothing at all. A
          // dismissal clears it again; last write wins. The frame itself is
          // deferred to the reply's TTS drain (see completeTtsForTurn) so the
          // reveal lands after the announcing sentence, never mid-word.
          ui_surface_show: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            if (this.activeAssistantTurn?.token === token) {
              this.activeAssistantTurn.minimizeRequested = true;
            }
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
            if (this.activeAssistantTurn?.token === token) {
              this.activeAssistantTurn.minimizeRequested = true;
            }
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
            // Revealing the screen to show the user something that is no
            // longer there is the opposite of the point.
            if (this.activeAssistantTurn?.token === token) {
              this.activeAssistantTurn.minimizeRequested = false;
            }
            void this.sendFrame({
              type: "card",
              op: "dismiss",
              surfaceId: msg.surfaceId,
              turnId,
            });
          },
          // What this turn is touching, in the two shapes different surfaces
          // need: `tool_activity` carries the real tool name for a surface
          // with its own copy table, `activity` carries the model's own label
          // for a surface the OS draws. Each is gated on the client having
          // asked for that frame type (see `toolActivity` and `activity` on
          // the start frame) and on the
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
            if (!this.isForwardingAssistantText(token)) return;
            if (this.toolActivity) {
              void this.sendFrame({
                type: "tool_activity",
                turnId,
                toolName: msg.toolName,
              });
            }
            // The model-authored label, for clients that asked for it. Sent
            // only when the model actually wrote one: no label is a truthful
            // answer, an invented one is not.
            if (this.activityLabels) {
              const text = composeTurnActivityLabel(msg.input);
              if (text !== undefined) {
                void this.sendFrame({ type: "activity", turnId, text });
              }
            }
          },
        },
        // Mid-call approvals (design v37 §W2): the bridge left a
        // confirmation pending for the user; the session presents the
        // moment and reports how it ended. Guarded on the turn token so a
        // late callback from a superseded leg cannot touch a newer turn.
        onApprovalPending: (approval) => {
          const current = this.activeAssistantTurn;
          if (current?.token !== token || current.finalized || this.isClosed) {
            return;
          }
          this.handleVoiceApprovalPending(current, approval);
        },
        onApprovalResolved: (requestId, outcome) => {
          const current = this.activeAssistantTurn;
          if (current?.token !== token) return;
          this.handleVoiceApprovalResolved(current, requestId, outcome);
        },
        onError: (message) => {
          const current = this.activeAssistantTurn;
          if (
            !this.isActiveAssistantTurn(token) ||
            current?.assistantCompleted
          ) {
            return;
          }
          // A front-door leg that handed off is done; the escalated leg owns
          // error reporting from here.
          if (leg.frontDoor && current?.escalationHandedOff) return;
          void (async () => {
            const currentTurn = this.activeAssistantTurn;
            if (currentTurn?.token === token) {
              // A speculative leg failing before its verdict fails OPEN: the
              // caller gets today's error path (utterance closed, listening
              // re-armed) instead of a silently dangling utterance.
              if (currentTurn.speculativePending) {
                this.commitSpeculativeTurn(currentTurn);
              }
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

      const current = this.activeAssistantTurn;
      if (current?.token !== token) {
        // A discard that beat this handle's resolution still owes the
        // rollback: a plain abort would leave the discarded pause's user
        // row in history.
        if (activeTurn.discardRequested && handle.discard) {
          void handle.discard().catch((err: unknown) => {
            log.warn(
              { err, turnId: activeTurn.turnId },
              "Late speculative voice turn discard failed",
            );
          });
        } else {
          handle.abort();
        }
        return;
      }
      if (current.finalized) {
        this.activeAssistantTurn = null;
        return;
      }
      // The front-door leg may have handed off before its handle resolved;
      // abort it rather than exposing it as the turn's live handle.
      if (leg.frontDoor && current.escalationHandedOff) {
        handle.abort();
        return;
      }

      current.handle = handle;
    } catch (err) {
      if (!this.isActiveAssistantTurn(token)) return;

      this.clearFillerTimers(activeTurn);
      // A speculative leg that never reached the bridge fails open: nothing
      // was persisted or spoken, so the consumed merge context goes back to
      // the session and the error path below closes the utterance normally.
      if (activeTurn.speculativePending) {
        activeTurn.speculativePending = false;
        if (
          activeTurn.interruptedRequest !== null &&
          this.pendingInterruptedRequest === null
        ) {
          this.pendingInterruptedRequest = activeTurn.interruptedRequest;
          activeTurn.interruptedRequest = null;
        }
      }
      this.activeAssistantTurn = null;
      await this.failTurnKeepingSession(
        `Live voice assistant turn could not be started: ${errorMessage(err)}`,
        "assistant_start_error",
      );
    }
  }

  /**
   * Hand the turn from the front-door leg to the strong "escalated" leg
   * after the escalate verdict. Speaks the capped bridge (the leg's own
   * post-verdict holding phrase, or the canned fallback when that was too
   * short) in one piece and force-flushes it so it plays during the strong
   * model's call, then starts the escalated leg on the same
   * ActiveAssistantTurn. Idempotent.
   */
  private escalateTurn(
    activeTurn: ActiveAssistantTurn,
    cappedBridge: string,
  ): void {
    if (activeTurn.escalationHandedOff || activeTurn.finalized) return;
    activeTurn.escalationHandedOff = true;
    // The escalation bridge below holds the floor, so a pending
    // slow-first-delta ack or progress narration would only stack a second
    // filler on top of it.
    this.clearFillerTimers(activeTurn);
    // Abort the front-door leg so a model that keeps generating past the
    // bridge cap adds no latency before the escalated leg starts.
    activeTurn.handle?.abort();
    activeTurn.handle = null;

    // Speak the bridge so the strong-model call has no dead air. The model's
    // own bridge is real assistant speech (captions + TTS); the canned
    // fallback stays audio-only, matching the persisted-row hygiene (a
    // deleted row for a bridge the model never produced).
    const usesFallbackBridge = cappedBridge.length < MIN_SPOKEN_BRIDGE_CHARS;
    const spokenBridge = usesFallbackBridge
      ? FALLBACK_ESCALATION_BRIDGE
      : cappedBridge;
    if (!usesFallbackBridge) {
      this.noteFirstAssistantDelta(activeTurn.token);
      this.markFirstAssistantDelta(activeTurn.turnId);
      void this.sendFrame(
        { type: "assistant_text_delta", text: spokenBridge },
        () => !activeTurn.abortController.signal.aborted && !this.isClosed,
      );
    } else {
      // Audio-only fallback still moots the pending ack — the bridge holds
      // the floor either way.
      this.noteFirstAssistantDelta(activeTurn.token);
    }
    this.bufferAssistantTextForTts(activeTurn.token, `${spokenBridge} `);
    // Force-flush now: an unpunctuated bridge would otherwise sit buffered
    // until a sentence boundary and leave the caller in silence during the
    // escalated model's call.
    this.flushTtsBuffer(activeTurn.token, true);

    // The escalated leg runs on the ordinary call-agent resolution — exactly
    // the model an un-routed voice turn would use. The bridge phrase the
    // caller just heard is handed along so the escalated continuation rule
    // can quote it and ban a re-announcing echo.
    void this.startAssistantLeg(activeTurn, {
      content: ESCALATION_CONTINUATION_CONTENT,
      routingLeg: "escalated",
      spokenEscalationBridge: spokenBridge,
    });

    // Escalated legs run the slowest work in the system (strong-model
    // thinking + tool loops), and the bridge only covers the first couple of
    // seconds of it — exactly the dead air progress narration exists for.
    // Re-arm the idle narration timer (cleared above with the ack).
    if (
      this.frontModelConfig?.progress.enabled &&
      this.streamTtsAudio &&
      this.frontDecider
    ) {
      this.armProgressIdleTimer(activeTurn);
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
      activeTurn?.token === token &&
      !activeTurn.finalized &&
      // Barge-in aborts synchronously but finalizes through an async
      // cancelAssistantTurn chain; the abort makes the turn dead at once so
      // a rejected startVoiceTurn or a trailing onError in that window does
      // not treat it as live (and emit a stray error frame or
      // double-finalize).
      !activeTurn.abortController.signal.aborted &&
      !this.isClosed
    );
  }

  private isForwardingAssistantText(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.assistantCompleted &&
      !activeTurn.finalized &&
      // Fence a late first assistant_text_delta once barge-in aborts a
      // pre-TTS turn, before its async teardown finalizes — mirrors
      // isForwardingTts so no cancelled-turn text leaks after
      // turn_cancelled.
      !activeTurn.abortController.signal.aborted &&
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

    const speakable = activeTurn.ttsReasoningFilter.push(text);
    if (speakable.length === 0) return;

    activeTurn.ttsBuffer += speakable;
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

        // The reveal ("voice announces, screen follows", v37 §W2): a turn
        // that left a surface on screen demotes the room now — strictly
        // AFTER its tts_done, so the announcing sentence finishes first, and
        // at most once per turn however many surfaces it touched. A pending
        // approval already opened the room and cleared the latch (see
        // handleVoiceApprovalPending), so this never double-minimizes.
        // Capability-gated like every server-VAD frame: a client that never
        // opted in has never heard of `minimize_room`.
        if (currentTurn.minimizeRequested) {
          currentTurn.minimizeRequested = false;
          await this.sendServerVadFrame(
            { type: "minimize_room", turnId: currentTurn.turnId },
            () => !this.isClosed,
          );
        }

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

    // A forced flush is a leg boundary (turn completion, or the escalation
    // hand-off): the stream that could have completed a held partial tag has
    // ended, so release it rather than strand it, and start the next leg with
    // a clean span state.
    if (force) activeTurn.ttsBuffer += activeTurn.ttsReasoningFilter.flush();

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
    options: { countsAsFirstSegment?: boolean; language?: string } = {},
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
      language: options.language,
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
      // The segment's own language override (fixed English fallback text)
      // wins over the turn's language.
      const language = job.language ?? activeTurn.language;
      let synthesis: Promise<void>;
      try {
        synthesis = streamTtsAudio({
          text: job.text,
          ...(language !== undefined ? { language } : {}),
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
      // Feed the echo classifier's reference with the PCM the client will
      // play (unflagged sessions only). A stale reference from a previous,
      // fully-drained playback burst is discarded first so the correlation
      // probe only ever matches audio that can still be audible.
      if (this.echoClassifierEnabled) {
        if (!this.isAssistantPlaybackEchoPossible()) {
          this.resetEchoReference();
        }
        this.appendEchoReference(chunk);
      }
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
    // Static ack phrases are fixed English copy, so they carry an explicit
    // "en" TTS hint on a non-English turn (see fixedPhraseLanguage's
    // rationale); a decider-generated ack is phrased from the caller's own
    // transcript and rides the turn's language.
    let ackLanguage: string | undefined;
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
      // The static rotation is English-only canned copy: label it "en" so
      // an enforcing TTS provider never renders English words under a
      // non-English turn hint.
      if (activeTurn.language !== undefined && activeTurn.language !== "en") {
        ackLanguage = "en";
      }
    }

    // The ack-text step may have awaited: re-verify the turn is still silent
    // and live before speaking, so we never talk over a reply that started.
    // A moot ack releases the one-per-turn budget.
    if (!this.canFireAck(token)) {
      activeTurn.ackFired = false;
      return;
    }

    if (!this.enqueueFillerPhrase(activeTurn, ackText, ackLanguage)) {
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
   * narration, verdict deadline) for events that end the current filler
   * lifecycle: escalation hand-off (which then re-arms narration for the
   * escalated leg), barge-in, cancellation, tts-completion, finalize. Real
   * output moots only the ack (noteFirstAssistantDelta) — the narration
   * timer keeps watching for mid-turn dead air.
   */
  private clearFillerTimers(turn: ActiveAssistantTurn): void {
    this.clearAckTimer(turn);
    this.clearProgressIdleTimer(turn);
    if (turn.verdictDeadlineTimer !== null) {
      clearTimeout(turn.verdictDeadlineTimer);
      turn.verdictDeadlineTimer = null;
    }
  }

  /**
   * Narration, unlike the ack, is not confined to the pre-first-delta window:
   * the dead air it exists to fill is almost always mid-turn, after the
   * model's opening words. It may speak whenever the live turn is audibly
   * silent right now — nothing streaming, queued, or still playing — and has
   * not completed. While the turn is parked on a mid-call approval it stands
   * down entirely: nothing is in flight, so every phrase narration has
   * ("still on it", "almost there") would be a lie about who the call is
   * waiting on. The turn says so once, when the wait starts (the fixed
   * approval phrase), and is quiet after that until a decision lands.
   */
  private turnCanNarrateProgress(turn: ActiveAssistantTurn): boolean {
    return (
      this.isActiveAssistantTurn(turn.token) &&
      !turn.assistantCompleted &&
      turn.pendingApprovalIds.size === 0 &&
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
            ...(turn.language !== undefined
              ? { languageHint: turn.language }
              : {}),
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
      // Generated text is in the turn's language; only the static fallback
      // comes from a localized table and may need the "en" override.
      let fillerLanguage: string | undefined;
      if (raw === null) {
        if (trigger !== "idle") return;
        raw = pickProgressPhrase(this.progressPhraseCounter++, turn.language);
        fillerLanguage = this.fixedPhraseLanguage(
          turn,
          PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
        );
      }
      if (!this.enqueueFillerPhrase(turn, raw, fillerLanguage)) return;
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
  private enqueueFillerPhrase(
    turn: ActiveAssistantTurn,
    raw: string,
    language?: string,
  ): boolean {
    const phrase = sanitizeForTts(raw).trim();
    if (phrase.length === 0) return false;
    this.enqueueTtsSegment(turn.token, phrase, {
      countsAsFirstSegment: false,
      ...(language !== undefined ? { language } : {}),
    });
    // A spoken filler holds the floor, so narration's minGapMs spaces from it.
    turn.progress.lastFloorHolderAtMs = Date.now();
    return true;
  }

  /**
   * A mid-call approval is waiting on the user (design v37 §W2).
   *
   * The approval card renders in the app, and the room covers the app, so
   * without this the turn simply goes quiet: nothing is spoken, nothing is
   * visible, and the only cue is a call that stopped talking. The
   * `approval_pending` frame goes out IMMEDIATELY — approval ≠ reveal; a
   * blocked turn has no speech left to drain, so there is no sentence to
   * wait for — and the client demotes the room on it.
   *
   * The fixed phrase is spoken once per wait (a turn waiting on two
   * decisions is still one wait), audio-only via the filler path: opening
   * the room only helps someone looking at the screen, and the case this
   * exists for is a phone that has been put down. The drain-latched reveal
   * is cleared so a turn that also showed a surface does not minimize twice
   * — the room is already open.
   *
   * Each request gets a bounded presentation window (see
   * {@link VOICE_APPROVAL_PRESENTATION_TIMEOUT_MS}): on expiry the client
   * gets `approval_resolved` outcome `expired` and stops featuring the card,
   * while the confirmation itself stays pending on the normal chat path —
   * indistinguishable, by design, from the user answering "Ask me after".
   */
  private handleVoiceApprovalPending(
    turn: ActiveAssistantTurn,
    approval: VoicePendingApprovalEvent,
  ): void {
    const firstOfWait = turn.pendingApprovalIds.size === 0;
    turn.pendingApprovalIds.add(approval.requestId);
    turn.minimizeRequested = false;
    void this.sendServerVadFrame(
      {
        type: "approval_pending",
        requestId: approval.requestId,
        turnId: turn.turnId,
        toolName: approval.toolName,
        ...(approval.summary.trim().length > 0
          ? { summary: approval.summary }
          : {}),
        riskLevel: approval.riskLevel,
        trustLine: VOICE_APPROVAL_TRUST_LINE,
      },
      () => !this.isClosed,
    );
    if (firstOfWait && this.streamTtsAudio) {
      // Spoken in the turn's language like every other filler phrase; the
      // English fallback text carries the "en" override when the table
      // lacks the turn's language.
      this.enqueueFillerPhrase(
        turn,
        approvalPendingPhraseFor(turn.language),
        this.fixedPhraseLanguage(turn, APPROVAL_PENDING_PHRASE_BY_LANGUAGE),
      );
    }
    const timeoutMs =
      this.options.approvalPresentationTimeoutMs ??
      VOICE_APPROVAL_PRESENTATION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      turn.pendingApprovalTimers.delete(approval.requestId);
      // Presentation only: the request is still pending on the chat path
      // (its final consequence belongs to the chat-surface expiry), and the
      // id stays in pendingApprovalIds so narration keeps standing down —
      // the turn genuinely is still waiting on the user.
      void this.sendServerVadFrame(
        {
          type: "approval_resolved",
          requestId: approval.requestId,
          turnId: turn.turnId,
          outcome: "expired",
        },
        () => !this.isClosed && !turn.finalized,
      );
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    turn.pendingApprovalTimers.set(approval.requestId, timer);
  }

  /**
   * A decision landed on a pending mid-call approval — the user answered
   * (any surface), the chat-surface expiry timed it out, or the request was
   * superseded. Tell the client (it promotes the room back to the rung it
   * held before the approval) and, once nothing is pending, stand progress
   * narration back up.
   */
  private handleVoiceApprovalResolved(
    turn: ActiveAssistantTurn,
    requestId: string,
    outcome: VoiceApprovalOutcome,
  ): void {
    if (!turn.pendingApprovalIds.delete(requestId)) return;
    const timer = turn.pendingApprovalTimers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      turn.pendingApprovalTimers.delete(requestId);
    }
    void this.sendServerVadFrame(
      {
        type: "approval_resolved",
        requestId,
        turnId: turn.turnId,
        outcome,
      },
      () => !this.isClosed,
    );
  }

  /**
   * Turn teardown for approvals still pending when the turn dies (barge-in,
   * interrupt, call end): clear the presentation timers and tell the client
   * each one is `superseded`, so the voice surface never keeps featuring a
   * decision whose turn no longer exists. The requests themselves resolve
   * through the bridge's existing unresolved-turn semantics — the turn's
   * abort reaches the prompter's signal listener, which resolves the
   * confirmation as a deny (nothing is sent), the same convention chat uses
   * when a new message supersedes a pending prompt.
   */
  private flushPendingVoiceApprovals(turn: ActiveAssistantTurn): void {
    for (const timer of turn.pendingApprovalTimers.values()) {
      clearTimeout(timer);
    }
    turn.pendingApprovalTimers.clear();
    for (const requestId of turn.pendingApprovalIds) {
      void this.sendServerVadFrame(
        {
          type: "approval_resolved",
          requestId,
          turnId: turn.turnId,
          outcome: "superseded",
        },
        () => !this.isClosed,
      );
    }
    turn.pendingApprovalIds.clear();
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
    // An utterance that finalizes here never became a turn (empty
    // transcript, client interrupt, transcriber close, error), so it ends
    // the window a barge-in's merge context was waiting to attach to. Drop
    // that context so it can't leak into a later, unrelated turn. A barged
    // turn itself finalizes through finalizeAssistantTurn, not here, so this
    // never clears a request the barge-in follow-up turn is about to
    // consume.
    this.pendingInterruptedRequest = null;
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
    this.flushPendingVoiceApprovals(turn);
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
        this.trackTurnRelease(frame);
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

  /** Keep {@link turnAwaitingRelease} in step with what actually went out. */
  private trackTurnRelease(frame: LiveVoiceServerFramePayload): void {
    if (frame.type === "thinking") {
      this.turnAwaitingRelease = frame.turnId;
      return;
    }
    if (frame.type !== "tts_done" && frame.type !== "turn_cancelled") return;
    if (this.turnAwaitingRelease === frame.turnId) {
      this.turnAwaitingRelease = null;
    }
  }

  /**
   * Release a caller who is still waiting on an answer as the session goes
   * down — a provider that rejected the turn, a session torn down mid-thought,
   * an idle timeout that landed between the question and the reply.
   *
   * The client leaves "Thinking…" on exactly one signal, `tts_done`, and
   * `close()` sent none: it cancelled the turn (internal bookkeeping, no
   * frames), drained the queue and closed the socket. So a turn that died at
   * teardown left the orb spinning with no error, no answer and no way back,
   * and the only thing left to do was abandon the call.
   *
   * Both frames are already in the client's vocabulary, so nothing new needs
   * advertising on `ready`: an unflagged frame type is session-fatal to the
   * shipped web client, which is exactly the trap this fix must not walk into.
   * The error is `fatal: false` because it is the TURN that died — the client
   * surfaces it and returns to Listening rather than reporting the call itself
   * as broken, and the socket close that follows is handled on its own terms.
   */
  private async releaseWaitingTurnAtTeardown(): Promise<void> {
    const turnId = this.turnAwaitingRelease;
    if (turnId === null) return;
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidField,
      message: "That turn didn't finish before the call ended. Ask me again.",
      fatal: false,
    });
    await this.sendFrame({ type: "tts_done", turnId });
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
