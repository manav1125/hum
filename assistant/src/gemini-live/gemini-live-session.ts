/**
 * `GeminiLiveSession` — the realtime "Tier 1" voice engine, implementing the
 * same {@link LiveVoiceSession} contract as the cascade so it drops into the
 * existing `/v1/live-voice` WebSocket and the web orb UI unchanged. Selected per
 * connection via the start frame's `engine: "gemini-live"` (default stays the
 * cascade, so this ships dormant and cannot affect current voice).
 *
 * Flow: browser mic PCM → Gemini Live (speech-native) → audio back to the
 * browser, with the model's function calls executed against Cue's real stores
 * (see gemini-live-tools.ts). See docs/cue-voice-architecture-review.md.
 */

import { randomUUID } from "node:crypto";

import { getConfig } from "../config/loader.js";
import {
  projectSkillTools,
  resetSkillToolProjection,
} from "../daemon/conversation-skill-tools.js";
import { formatTurnTimestamp } from "../daemon/date-context.js";
import { buildLiveBriefing } from "../live-voice/build-live-briefing.js";
import { PlaybackEchoClassifier } from "../live-voice/echo-classifier.js";
import { persistLiveVoicePhoto } from "../live-voice/live-voice-photo.js";
import type {
  LiveVoiceSession,
  LiveVoiceSessionCloseReason,
  LiveVoiceSessionFactoryContext,
} from "../live-voice/live-voice-session-manager.js";
import { LiveVoiceSessionStartupError } from "../live-voice/live-voice-session-manager.js";
import {
  buildLiveVoiceThreadContext,
  ensureLiveVoiceThread,
  finalizeLiveVoiceThread,
  persistLiveVoiceTurn,
} from "../live-voice/live-voice-thread.js";
import { synthesizeLiveVoiceSession } from "../live-voice/synthesize-live-voice-session.js";
import { resolveVoicePersona } from "../live-voice/voice-personas.js";
import { getAttachmentsByIds } from "../memory/attachments-store.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  assistantEventHub,
  type AssistantEventSubscription,
} from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import {
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
  GeminiLiveClient,
  resolveGeminiLiveApiKey,
  resolveGeminiLiveModel,
  resolveGeminiLivePinnedSpeechLanguage,
  resolveGeminiLiveSpokenLanguage,
  resolveGeminiLiveVoice,
} from "./gemini-live-client.js";
import {
  executeGeminiLiveFunctionCall,
  GEMINI_LIVE_FUNCTION_DECLARATIONS,
  GEMINI_LIVE_VOICE_SKILLS,
} from "./gemini-live-tools.js";

const log = getLogger("gemini-live-session");

/**
 * Post-playback slack for the echo window: covers client buffering/network
 * jitter between "we sent the last audio chunk" and "the speaker went quiet",
 * so trailing echo cannot open a phantom user turn. Fallback when the
 * `liveVoice.vad.echoDrainSlackMs` config cannot be read.
 */
const DEFAULT_ECHO_DRAIN_SLACK_MS = 300;
const DEFAULT_ECHO_BARGE_IN_MARGIN = 1.5;
const DEFAULT_ECHO_EMA_HALF_LIFE_MS = 400;

/**
 * How often the turnless-gap probe reports while a call is open with no turn
 * running. Override with `CUE_GEMINI_LIVE_GAP_PROBE_MS` (0 disables); tests
 * shorten it so the probe is drivable in real time.
 *
 * ## Why this exists
 *
 * Every other line in this file is emitted by a turn. So the failure users
 * actually report — "it went to listening and got stuck" — is the one shape
 * the log could not describe: the session closes cleanly, `unfinishedTurn:
 * false`, no interruption pending, and the caller's next sentence simply
 * never opens a turn. Twenty-three seconds of that gap looked exactly like
 * twenty-three seconds of a caller thinking.
 *
 * The gap has three possible tenants and they need different fixes, so the
 * probe reports which one it is: the client stopped sending mic audio, the
 * echo gate substituted silence for all of it, or Gemini got real audio and
 * said nothing back. See {@link probeGap}.
 */
const DEFAULT_GAP_PROBE_INTERVAL_MS = 5_000;

function resolveGapProbeIntervalMs(): number {
  const raw = process.env.CUE_GEMINI_LIVE_GAP_PROBE_MS?.trim();
  if (!raw) return DEFAULT_GAP_PROBE_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_GAP_PROBE_INTERVAL_MS;
}

/** Lazily-cached silence buffers keyed by chunk length (mic chunks are uniform). */
const SILENCE_CHUNKS = {
  cache: new Map<number, Uint8Array>(),
  get(length: number): Uint8Array {
    let buf = this.cache.get(length);
    if (!buf) {
      buf = new Uint8Array(length);
      // Mic chunk sizes are client-fixed; keep the cache tiny regardless.
      if (this.cache.size < 8) this.cache.set(length, buf);
    }
    return buf;
  },
};

/**
 * Cap on the result summary a deep-task completion note injects back into the
 * live model (~1.5KB). The full result lives in Review; the model only needs
 * enough to speak one or two sentences, and an unbounded summary would bloat
 * the realtime session context for every remaining turn. Exported for tests.
 */
export const DEEP_TASK_SUMMARY_CLIP_CHARS = 1536;

function clipDeepTaskSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= DEEP_TASK_SUMMARY_CLIP_CHARS) return trimmed;
  return `${trimmed.slice(0, DEEP_TASK_SUMMARY_CLIP_CHARS)}… (truncated)`;
}

/**
 * Cue's identity + voice etiquette for the realtime engine. Kept in sync in
 * spirit with the cascade's LIVE_VOICE_CONTROL_PROMPT: real capabilities, honest
 * about actions, brief and TTS-clean. Gemini Live speaks the audio itself, so
 * this shapes tone and tool discipline.
 */
/**
 * The system-instruction lines governing spoken language — and, on the
 * native-audio model class Cue runs, the ONLY thing governing it.
 *
 * The previous wording told the model to follow the caller across language
 * switches while `speechConfig.languageCode` was omitted entirely, so nothing
 * fixed the output language at all: the spoken voice drifted locale mid-reply
 * (a single French "Oui." in an English call, replies arriving as bare
 * fragments). Google's documented remedy for these models is exactly this —
 * state the output language in the system instruction, in their recommended
 * emphatic form — and it is also the only place the real requirement can be
 * expressed: understand everything, speak one language, switch only if asked.
 */
function languageLine(): string {
  const { label, isDefault } = resolveGeminiLiveSpokenLanguage();
  return [
    `Speak ${label}. RESPOND IN ${label.toUpperCase()}. YOU MUST RESPOND UNMISTAKABLY IN ${label.toUpperCase()}, in a single consistent accent, for the whole of every reply — never drift into another language or accent partway through a sentence.`,
    `You understand every language fluently. If they speak to you in another language, or mix words or whole sentences of one into their ${label}, understand it completely and keep answering in ${label}.`,
    `The one exception: if they ASK you to speak another language, switch to it and stay there until they ask you to switch back.`,
    ...(isDefault
      ? []
      : [`${label} is their chosen language for these calls, so hold to it.`]),
  ].join(" ");
}

function buildSystemInstruction(
  timezone?: string,
  opts?: {
    personaFragment?: string;
    briefing?: string;
    /** Recent tail of the bound conversation; "" on a fresh thread. */
    threadContext?: string;
  },
): string {
  const hasTz = typeof timezone === "string" && timezone.trim().length > 0;
  const timeLine = hasTz
    ? `The current date and time in the user's timezone is ${formatTurnTimestamp({ clientTimezone: timezone })}. That is their local time — use it for anything time-related and never quote UTC unless they ask.`
    : `The current date and time is ${formatTurnTimestamp()} (UTC). You do NOT know the user's local timezone yet, so do not assume it is UTC when you speak — if the time of day matters, briefly ask what timezone they're in, or take their word if they tell you their local time.`;
  const persona = opts?.personaFragment?.trim();
  const base = [
    "You are Cue, your user's personal AI chief-of-staff, in a live spoken voice conversation with them right now.",
    "Your name is Cue. Never say you are 'a large language model', never say you were 'trained by Google', and never mention Google or Gemini. If asked what you are, say you are Cue, their AI chief-of-staff. Stay in character as Cue at all times.",
    "You ARE Cue, so always speak about yourself in the first person — never refer to Cue in the third person as if it were someone else. Say 'I'm digging into that', never 'I'm having Cue look into that'. Handing something to a background task is still you doing it, so say so as yourself.",
    "You are speaking with your own owner, who has authorized you. Be warm, concise, and natural — a sentence or two carries most exchanges. But when they ask you something that genuinely needs explaining, take the several sentences it needs and explain it properly. Short is the default, not a ceiling; a real question deserves a real answer, not a headline.",
    // The selected conversation mode shapes tone (companion / reflective /
    // co-founder). Empty → the base warm-chief-of-staff default.
    ...(persona ? [persona] : []),
    timeLine,
    "When they ASK you something, answer it — here, out loud, in the call. Gather what you need first (recall_memory for anything to do with their own life, work, or past conversations; web_search for current facts), then give them the actual answer and your read on it. A question is not a task: never file it away, never hand it off, and never reply that they should ask someone else instead of telling them what you know. If the honest answer is that they need a professional, say what you do know first and then say that too.",
    "You can take real actions and pull the user's real data with your tools. Quick to-do → add_task. Work they have asked you to DO — research a market, draft a document, run a multi-step job — → run_deep_task, then tell them you're on it. Never reach for run_deep_task to get out of answering a question; it is for doing work, not for deferring an answer. What's on their plate → get_open_tasks. Current facts, news, or weather → web_search. Anything about the user's own life, work, files, or past conversations → recall_memory before you say you don't know. A lasting fact or preference they just told you → remember. Reminders and automations you set for them → get_schedule; setting one → set_reminder. What's on their Google Calendar — meetings, events, their day or week → get_calendar (get_schedule does NOT show their calendar). Who someone is or how to reach them → find_contact. Replies they're waiting on → get_followups. Their email or messages → check_inbox, then read_messages for one conversation. Never read ids, email addresses, or raw data aloud — speak the human part.",
    "When a result is something to LOOK at — options, search results, a list, a table — announce it aloud first in one short sentence (for example: Here's what I found), then call ui_show to put it on screen, and give a one- or two-sentence spoken summary. The card is seen, not spoken: never read it item by item.",
    "For any calendar question, always call get_calendar and answer ONLY from its result — their calendar events are not in your briefing, memory, or messages, and answering from those is making things up. Announce aloud, put the events on screen with ui_show as a list, then give a short spoken summary. If get_calendar says their calendar isn't connected, tell them exactly that and that they can link Google Calendar in Settings → Connectors — never improvise a calendar answer from anything else.",
    // The calendar rule below is the one that demonstrably fires: asked about
    // his calendar, the model called get_calendar. Asked about his email in the
    // same call it called nothing and said "I've pulled up your message
    // inboxes… you're all caught up" — a completed action and a fact about his
    // inbox, both from nowhere. The general honesty rule was already present
    // and did not stop it; the difference between the two questions was that
    // one had a named, mandatory tool and the other did not. So mail gets one.
    "For any question about their email, messages or inbox, always call check_inbox first and answer ONLY from its result, then read_messages for a specific conversation. Never say what is or isn't in their inbox — including that they are 'all caught up' or have nothing unread — unless check_inbox actually returned that. If you did not call it, say you'll take a look rather than describing an inbox you have not seen.",
    "Never claim you have done something unless you actually called the tool for it and it succeeded. If a tool fails, say so in one short sentence and offer a next step. If a tool says it needs approval or isn't permitted, tell them briefly that this one needs their okay in the app — never pretend it happened and never work around it. This binds the words you SAY, not just the actions you take: 'I've pulled that up', 'I checked', 'I've had a look' are all claims that a tool ran, and saying one when no tool ran is a lie even when what follows sounds harmless. If you have not called the tool yet, say what you are about to do — never what you have already done.",
    "When you add a to-do, say simply that you saved it to their task list — do NOT invent specific screen names like 'My Day' or claim it's in a particular place you can't verify. When run_deep_task finishes, its result appears in their Review area; only mention Review for run_deep_task work, never for a plain reminder.",
    "Do not spell things out letter by letter or read punctuation, tool names, or code aloud. Just speak like a helpful person.",
    languageLine(),
  ].join(" ");
  // Append, in order: the session-start context briefing (who the user is +
  // their current work), then the recent tail of the conversation this call is
  // bound to. Both are empty-by-default (fresh workspace / fresh thread), in
  // which case nothing is appended. They live in the system instruction rather
  // than a post-connect injection because the client replays the instruction on
  // every reconnect — a mid-call drop must not cost the model the thread again.
  const sections = [base];
  const briefing = opts?.briefing?.trim();
  if (briefing) sections.push(briefing);
  const threadContext = opts?.threadContext?.trim();
  if (threadContext) sections.push(threadContext);
  return sections.join("\n\n");
}

export class GeminiLiveSession implements LiveVoiceSession {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly conversationId: string;
  private readonly inputSampleRate: number;
  private client: GeminiLiveClient | null = null;
  private currentTurnId: string | null = null;
  private closed = false;
  /** Estimated client playback end (epoch ms) of assistant audio sent so far. */
  private playbackTailUntilMs = 0;
  /**
   * Playback-echo classifier for sessions whose client playback is NOT
   * echo-cancelled (`echoSafePlayback` absent); null for flagged clients,
   * whose mic audio passes through untouched. See {@link gateEcho}.
   */
  private readonly echoClassifier: PlaybackEchoClassifier | null;
  /** Echo-window slack past the playback-tail estimate (config-tunable). */
  private readonly echoDrainSlackMs: number;
  // Turn transcript accumulation, flushed to the saved thread on turnComplete.
  private pendingUserText = "";
  private pendingAssistantText = "";
  /**
   * Per-turn telemetry. This engine logged ONE line for an entire call
   * ("session started"), so a caller reporting "it hung after ten seconds" left
   * nothing in the log to confirm or deny — no turn boundaries, no
   * interruptions, no audio. That absence is why the same symptom has been
   * diagnosed three times with three different real causes and still recurs.
   *
   * The signature worth catching: a self-barge (the assistant's own speaker
   * audio re-entering the mic and tripping interruption) shows up as turns
   * interrupted a second or two after their first audio, at clockwork
   * intervals, with an empty user transcript. `interrupted` + `sinceFirstAudioMs`
   * + `userChars` distinguish that from an ordinary caller barge-in, which
   * carries speech.
   *
   * Volume is one line per turn plus one per session, deliberately: this log is
   * already hard to read under the memory-v2 salvage warnings.
   */
  private turnSeq = 0;
  private turnStartedAtMs = 0;
  private turnFirstAudioAtMs = 0;
  private turnAudioBytes = 0;
  /**
   * Server-side input transcription arrival — the last moment the model had
   * heard the caller. Paired with the first audio out, it is the only
   * server-side handle on the latency the caller actually feels.
   *
   * It exists because the field that looks like that number is not:
   * `sinceFirstAudioMs` is measured AT turn end, so on a completed turn it is
   * the LENGTH of the spoken reply, not the wait before it. A 566 KB reply at
   * 24 kHz s16 is 11.8 s of speech and logged 11,955 ms — a number that reads
   * as a twelve-second stall and is nothing of the kind. See {@link logTurn}.
   */
  private lastInputTextAtMs = 0;
  /**
   * Wait from the last heard speech to this turn's first audio out. `null`
   * when there is nothing to measure from (no transcription yet, or no audio
   * yet) — deliberately not 0, which would read as "answered instantly".
   */
  private turnReplyLatencyMs: number | null = null;
  private turnMicChunks = 0;
  private turnEchoSuppressedChunks = 0;
  private sessionTurns = 0;
  private sessionInterruptions = 0;
  private readonly sessionStartedAtMs = Date.now();
  /**
   * Turnless-gap accounting — the silent half of the call, which until now
   * left no record at all. See {@link probeGap} for why.
   *
   * The three counters are per probe WINDOW (reset on every report), because
   * what matters is not how much audio a two-minute gap saw in total but
   * whether it is still seeing any right now: a gap that starts healthy and
   * goes deaf halfway is the exact shape being hunted, and cumulative totals
   * hide it behind the healthy prefix.
   */
  private readonly gapProbeIntervalMs = resolveGapProbeIntervalMs();
  private gapTimer: ReturnType<typeof setInterval> | null = null;
  private gapProbeSeq = 0;
  /** Wall clock at the last turn end (session start until the first turn). */
  private gapStartedAtMs = 0;
  /** Wall clock at the last probe report — the counters' window start. */
  private gapWindowStartedAtMs = 0;
  /** Mic chunks the CLIENT delivered in this window (0 ⇒ nothing arrived). */
  private gapMicChunks = 0;
  /** Of those, the ones whose real audio went upstream to Gemini. */
  private gapForwardedChunks = 0;
  /** Of those, the ones the echo gate replaced with silence. */
  private gapEchoSuppressedChunks = 0;
  /** Last mic chunk from the client, ever — not reset per window. */
  private lastMicChunkAtMs = 0;
  /** Last message from Gemini, ever, of any kind — not reset per window. */
  private lastUpstreamAtMs = 0;
  /** Top-level keys of that message, e.g. ["serverContent"]. */
  private lastUpstreamKinds: readonly string[] = [];
  /**
   * Rolling window of the most recent completed turns, kept so a NON-resumed
   * upstream reconnect (fresh Gemini session — no conversation context) can be
   * handed a recap instead of amnesia mid-call. Bounded; the saved thread is
   * the durable record, this is only the reconnect bridge.
   */
  private readonly recentTurns: Array<{ user: string; assistant: string }> = [];
  // Titles of tasks captured during the call, listed in the closing recap.
  private readonly capturedTaskTitles: string[] = [];
  /**
   * Skill-tool registrations held for this session (skillId → version hash),
   * fed to the shared projection machinery so the registry-backed voice tools
   * (schedule/contacts/messaging/followups) resolve for the session's
   * lifetime and are refcounted back out on close.
   */
  private readonly skillToolVersions = new Map<string, string>();
  /** Aborted on close so in-flight registry tool calls stop with the call. */
  private readonly toolAbort = new AbortController();
  /**
   * Deep tasks (`run_deep_task`) started from THIS call that have not reached
   * a terminal state yet: work-item id → spoken title. When one completes
   * while the call is still open, the session announces the result into the
   * live conversation (see {@link onDeepTaskCompleted}); after close the map
   * is moot — the result lands in Review as before.
   */
  private readonly pendingDeepTasks = new Map<string, string>();
  /**
   * Hub subscription watching for `work_item_completed` events on the tracked
   * deep tasks. Created lazily on the first `run_deep_task` of the call (a
   * call that never escalates registers no subscriber) and disposed on close.
   */
  private deepTaskSubscription: AssistantEventSubscription | null = null;

  constructor(context: LiveVoiceSessionFactoryContext) {
    this.context = context;
    this.conversationId =
      context.startFrame.conversationId ?? context.sessionId;
    this.inputSampleRate = context.startFrame.audio.sampleRate;

    // Echo classifier tuning shares the cascade's `liveVoice.vad` knobs.
    // Config is read best-effort: a failed read keeps the in-code defaults
    // rather than failing session construction.
    let margin = DEFAULT_ECHO_BARGE_IN_MARGIN;
    let emaHalfLifeMs = DEFAULT_ECHO_EMA_HALF_LIFE_MS;
    let drainSlackMs = DEFAULT_ECHO_DRAIN_SLACK_MS;
    try {
      const vad = getConfig().liveVoice.vad;
      margin = vad.echoBargeInMargin;
      emaHalfLifeMs = vad.echoEmaHalfLifeMs;
      drainSlackMs = vad.echoDrainSlackMs;
    } catch (err) {
      log.warn({ err }, "liveVoice.vad config unavailable; using defaults");
    }
    this.echoDrainSlackMs = drainSlackMs;
    // An echo-safe client (media-element playback covered by browser echo
    // cancellation, declared via the start frame's `echoSafePlayback` flag)
    // never loops the reply back through its mic: no classifier at all —
    // its audio passes through untouched (see gateEcho).
    this.echoClassifier =
      context.startFrame.echoSafePlayback === true
        ? null
        : new PlaybackEchoClassifier({
            inputSampleRate: this.inputSampleRate,
            referenceSampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
            margin,
            emaHalfLifeMs,
            // Conservative: when the classifier cannot decide (no usable
            // reference yet), keep the old blanket silence substitution for
            // the playback window instead of forwarding possible echo.
            undecidedIsEcho: true,
          });
  }

  async start(): Promise<void> {
    const apiKey = await resolveGeminiLiveApiKey();
    if (!apiKey) {
      throw new LiveVoiceSessionStartupError(
        "Gemini Live requires a Gemini API key (none configured).",
      );
    }

    // Assemble the context briefing once at session start (best-effort — never
    // blocks or fails the session; returns "" on a fresh workspace).
    let briefing = "";
    try {
      briefing = buildLiveBriefing();
    } catch (err) {
      log.warn({ err }, "live briefing assembly failed; continuing without it");
    }

    // Seed the recent tail of the conversation this call is bound to. Without
    // it a call opened inside an existing thread starts blind — the model has
    // the user's world but not the exchange it is standing in the middle of.
    // Same contract as the briefing: never throws, never blocks, "" on a fresh
    // voice-initiated thread.
    let threadContext = "";
    try {
      threadContext = buildLiveVoiceThreadContext(this.conversationId);
    } catch (err) {
      log.warn(
        { err },
        "thread context assembly failed; continuing without it",
      );
    }

    // Register the bundled skill tools the voice declarations dispatch to
    // (same projection machinery as the cascade's preactivation, refcounted).
    // Best-effort: a failed registration degrades those tools to clean
    // "not available" errors at call time; it must never block the call.
    try {
      projectSkillTools([], {
        preactivatedSkillIds: [...GEMINI_LIVE_VOICE_SKILLS],
        previouslyActiveSkillIds: this.skillToolVersions,
      });
    } catch (err) {
      log.warn({ err }, "voice skill tool registration failed; continuing");
    }

    // Resolve the selected conversation mode (defaults to companion).
    const persona = resolveVoicePersona(this.context.startFrame.persona);

    const client = new GeminiLiveClient({
      apiKey,
      model: resolveGeminiLiveModel(),
      systemInstruction: buildSystemInstruction(
        this.context.startFrame.timezone,
        { personaFragment: persona.promptFragment, briefing, threadContext },
      ),
      tools: GEMINI_LIVE_FUNCTION_DECLARATIONS,
      inputSampleRate: this.inputSampleRate,
      language: resolveGeminiLivePinnedSpeechLanguage(),
      voice: resolveGeminiLiveVoice(),
      callbacks: {
        onAudio: (pcm) => this.onModelAudio(pcm),
        onOutputText: (text) => {
          this.beginTurn();
          this.pendingAssistantText += text;
          void this.context.sendFrame({ type: "assistant_text_delta", text });
        },
        onInputText: (text) => {
          // First real speech → make sure the saved thread exists so the call
          // shows up in chat history from the start.
          ensureLiveVoiceThread(this.conversationId);
          this.lastInputTextAtMs = Date.now();
          this.pendingUserText += text;
          void this.context.sendFrame({ type: "stt_final", text });
        },
        onToolCall: (calls) => void this.onToolCall(calls),
        onUpstreamMessage: (kinds) => {
          this.lastUpstreamAtMs = Date.now();
          this.lastUpstreamKinds = kinds;
        },
        onGoAway: (timeLeftMs) => {
          // The client migrates on its own; this line is here because a
          // server-scheduled disconnect landing mid-gap is one of the few
          // upstream explanations for a call going quiet, and it must be
          // readable next to the gap probes rather than in the client's log.
          this.logTurn("go_away", { timeLeftMs });
        },
        onTurnComplete: () => this.onTurnComplete(),
        onInterrupted: () => {
          // The user barged in; Gemini stops generating server-side. We simply
          // stop emitting audio for the interrupted turn.
          this.sessionInterruptions += 1;
          // The one signal that separates a real barge-in from the assistant
          // interrupting ITSELF through the caller's speakers. Self-barge lands
          // a second or two into playback with no user speech to show for it;
          // a real barge-in carries a transcript. Logged at every interruption
          // because the interesting case is the one nobody was watching for.
          this.logTurn("interrupted", {
            interruptions: this.sessionInterruptions,
            userChars: this.pendingUserText.trim().length,
          });
          this.currentTurnId = null;
          // A barge-in opens a gap of its own: from here until the caller's
          // next utterance opens a turn, nothing else in this file speaks.
          this.beginGap();
        },
        onError: (message) => {
          // Recoverable by contract (the client's close/reconnect path owns
          // terminal outcomes), so the browser must NOT tear the call down.
          void this.context.sendFrame({
            type: "error",
            code: "invalid_field",
            message,
            fatal: false,
          });
        },
        onReconnecting: () => {
          // The upstream leg dropped and the client is reconnecting (with
          // session resume where the server granted a handle). OUR WebSocket
          // to the browser stays open the whole time — the user hears at most
          // a brief gap, so this frame is explicitly non-fatal: same
          // convention as the cascade's recovered-transcriber hiccups.
          if (this.closed) return;
          // A drop mid-model-turn strands the open turn: its remaining audio
          // and `turnComplete` died with the socket, and after a resume the
          // server does not replay them. Close the turn now (flushing its
          // transcript) so the client's per-turn state cannot wedge on a
          // turn that will never finish.
          if (this.currentTurnId) this.onTurnComplete();
          void this.context.sendFrame({
            type: "error",
            code: "invalid_field",
            message: "Voice link hiccup — reconnecting.",
            fatal: false,
          });
        },
        onReconnected: ({ resumed }) => {
          if (this.closed) return;
          // Resumed → the same server-side session continues, context intact:
          // nothing to repair. Fresh → the new session only got the replayed
          // setup (identity + briefing), NOT the conversation so far; hand it
          // an honest recap so it neither blanks on the call nor bluffs.
          if (!resumed) this.injectReconnectContext();
        },
        onClose: (code, reason) => {
          // TERMINAL by contract: reconnect attempts are exhausted. `fatal`
          // omitted → the client treats it as session-ending, which it is.
          if (!this.closed) {
            void this.context.sendFrame({
              type: "error",
              code: "invalid_frame",
              message: `Voice connection lost and could not be restored (code=${code}${reason ? ` ${reason}` : ""}). Please start a new call.`,
            });
          }
        },
      },
    });

    try {
      await client.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LiveVoiceSessionStartupError(
        `Failed to start Gemini Live: ${message}`,
      );
    }
    this.client = client;
    // The first gap runs from "connected" to the caller's first utterance —
    // a session that is deaf from the outset must be as visible as one that
    // goes deaf later.
    this.beginGap();
    this.startGapProbe();

    await this.context.sendFrame({
      type: "ready",
      sessionId: this.context.sessionId,
      conversationId: this.conversationId,
      // Capability advertise: this engine accepts `attach_image` (mid-call
      // camera photos) — same convention as the cascade's ready frame. The
      // client renders its camera only when this flag arrived.
      attachImage: true,
    });
    log.info(
      {
        sessionId: this.context.sessionId,
        model: resolveGeminiLiveModel(),
        // Prod-diagnosable: "voice had no idea what we were talking about" is
        // answerable from the log line instead of a repro.
        briefingChars: briefing.length,
        threadContextChars: threadContext.length,
      },
      "gemini-live session started",
    );
  }

  handleClientFrame(frame: {
    type: string;
    dataBase64?: string;
    attachmentId?: string;
  }): void {
    if (!this.client) return;
    switch (frame.type) {
      case "audio":
        if (frame.dataBase64) {
          for (const gated of this.gateEcho(
            Buffer.from(frame.dataBase64, "base64"),
          )) {
            this.client.sendAudio(gated);
          }
        }
        break;
      case "ptt_release":
        // Push-to-talk end: hint the server VAD to close the turn promptly.
        this.client.sendAudioStreamEnd();
        break;
      case "interrupt":
        // Handled server-side via incoming audio; nothing to forward.
        this.currentTurnId = null;
        break;
      case "attach_image":
        if (frame.attachmentId) this.attachImage(frame.attachmentId);
        break;
      // "end" → the manager calls close().
    }
  }

  /**
   * A photo taken mid-call. Two legs, both required:
   *
   * 1. **Show the model now** — hydrate the uploaded bytes and push them onto
   *    the live session's realtime video channel, so "what's this?" spoken a
   *    breath later is answered about the picture. Unlike the cascade, this
   *    engine's model never re-reads conversation history mid-call, so the
   *    persisted row alone would be invisible to it until the next call.
   * 2. **Persist it** — the same `persistLiveVoicePhoto` the cascade uses, so
   *    the photo lands in the transcript as its own user message (no turn)
   *    and survives the call.
   *
   * Fire-and-forget; a failure to store sends the same non-fatal
   * `attach_image` error frame the cascade sends, so the client's photo strip
   * can retract the thumbnail.
   */
  private attachImage(attachmentId: string): void {
    try {
      const [attachment] = getAttachmentsByIds([attachmentId], {
        hydrateFileData: true,
      });
      if (attachment?.dataBase64) {
        this.client?.sendImage(attachment.dataBase64, attachment.mimeType);
      } else {
        log.warn(
          { attachmentId },
          "gemini-live attach_image: attachment did not hydrate; persisting only",
        );
      }
    } catch (err) {
      log.warn(
        { err, attachmentId },
        "gemini-live attach_image: failed to forward image to the live session",
      );
    }

    void persistLiveVoicePhoto(this.conversationId, attachmentId).then(
      (result) => {
        if (!result.ok && !this.closed) {
          void this.context.sendFrame({
            type: "error",
            code: "invalid_frame",
            message: "Could not attach that photo to the conversation.",
            frameType: "attach_image",
            // The session is fine; only this photo failed.
            fatal: false,
          });
        }
      },
    );
  }

  handleBinaryAudio(chunk: Uint8Array): void {
    if (!this.client) return;
    for (const gated of this.gateEcho(chunk)) {
      this.client.sendAudio(gated);
    }
  }

  /**
   * Echo gate: while the assistant's own audio is (estimated to be) playing
   * on the client, run mic input through the waveform-correlation playback
   * echo classifier — audio that correlates with the PCM we sent (or sits at
   * the learned echo level) is replaced with equal-length silence before it
   * reaches Gemini; audio the classifier attributes to the user is forwarded
   * so mid-reply barge-in works again on this engine.
   *
   * Real-device evidence (2026-08-11): echo cancellation does not cover
   * WebAudio playback in the packaged desktop app, so the reply loops back
   * through the mic and Gemini's activity detection reads it as the user —
   * interrupting the reply with its own echo on every turn. Desensitizing
   * detection (START_SENSITIVITY_LOW) traded that for the opposite failure:
   * relaxed, quieter follow-ups stopped opening turns and the session
   * "stopped engaging" a few exchanges in. The classifier removes the echo
   * at the source — precisely, instead of the previous blanket half-duplex
   * silence substitution — so detection stays at full sensitivity AND the
   * user can interrupt. When the classifier cannot decide (no usable
   * reference yet), the blanket silence substitution remains the fallback
   * for the playback window. Silence (not dropped frames) keeps the input
   * stream continuous for Gemini's VAD.
   *
   * May return [] while a short onset probe is being held for correlation;
   * the held audio is released (forwarded or substituted) with a later
   * chunk, in original order.
   */
  private gateEcho(chunk: Uint8Array): Uint8Array[] {
    // A client whose playback is echo-cancellable (media-element routing,
    // declared via the start frame's `echoSafePlayback` capability flag)
    // never loops the reply back through its mic — pass its audio through
    // untouched so the user can interrupt mid-reply at full sensitivity.
    const classifier = this.echoClassifier;
    this.turnMicChunks += 1;
    this.gapMicChunks += 1;
    this.lastMicChunkAtMs = Date.now();
    if (!classifier) {
      this.gapForwardedChunks += 1;
      return [chunk];
    }
    if (Date.now() >= this.playbackTailUntilMs + this.echoDrainSlackMs) {
      // Outside the echo window: nothing we sent can still be audible.
      classifier.resetWindow();
      this.gapForwardedChunks += 1;
      return [chunk];
    }
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return classifier.classify(buffer).map((classified) => {
      if (classified.classification !== "echo") {
        this.gapForwardedChunks += 1;
        return classified.chunk;
      }
      // Counted, not logged per chunk: the useful number is the per-turn
      // proportion. A turn where most mic audio was suppressed as echo is a
      // caller who could not have been heard even if they did speak.
      this.turnEchoSuppressedChunks += 1;
      this.gapEchoSuppressedChunks += 1;
      return (
        SILENCE_CHUNKS.get(classified.chunk.length) ??
        new Uint8Array(classified.chunk.length)
      );
    });
  }

  // ── Turnless-gap probe ─────────────────────────────────────────────

  /** Open a fresh gap window: a turn just ended (or the call just connected). */
  private beginGap(): void {
    this.gapStartedAtMs = Date.now();
    this.gapWindowStartedAtMs = this.gapStartedAtMs;
    this.gapMicChunks = 0;
    this.gapForwardedChunks = 0;
    this.gapEchoSuppressedChunks = 0;
  }

  private startGapProbe(): void {
    if (this.gapTimer || this.gapProbeIntervalMs <= 0) return;
    this.gapTimer = setInterval(() => this.probeGap(), this.gapProbeIntervalMs);
    this.gapTimer.unref?.();
  }

  private stopGapProbe(): void {
    if (this.gapTimer) {
      clearInterval(this.gapTimer);
      this.gapTimer = null;
    }
  }

  /**
   * One line per interval of call time with NO turn open — the silence the
   * caller is sitting in, described well enough to say who is responsible
   * for it.
   *
   * `micReaching` is the whole point, and it is deliberately a statement
   * about where audio GOT TO, not about who is at fault:
   *
   * - `"nothing"` — the client sent no mic audio at all this window. The
   *   caller may well be talking; nothing left their machine. The break is
   *   client → daemon, and no amount of daemon-side work will hear them.
   * - `"gate"` — audio arrived and the echo gate replaced every chunk with
   *   silence (or is still holding it as a correlation probe). Gemini heard
   *   a silent room. The break is the gate.
   * - `"gemini"` — real mic audio went upstream and no turn opened anyway.
   *   The break is upstream; `sinceUpstreamMs` says whether the socket is
   *   still saying anything at all.
   *
   * A healthy pause between utterances also lands here, and reads as
   * `"gemini"` with a small `sinceUpstreamMs` — that is correct: the room is
   * being heard and nobody is speaking. Silence that is fine and silence
   * that is broken are the same experience from outside and must be told
   * apart from the inside.
   *
   * Volume: one line per interval per open call, only while no turn is
   * running, and never per chunk — this log is already hard to read.
   */
  private probeGap(): void {
    if (this.closed || this.currentTurnId !== null) return;
    const now = Date.now();
    const windowMs = now - this.gapWindowStartedAtMs;
    // A gap shorter than one interval is the tail of a turn that just ended.
    if (windowMs < this.gapProbeIntervalMs) return;
    this.gapProbeSeq += 1;
    const micReaching =
      this.gapMicChunks === 0
        ? "nothing"
        : this.gapForwardedChunks === 0
          ? "gate"
          : "gemini";
    log.info(
      {
        event: "gap",
        conversationId: this.conversationId,
        probe: this.gapProbeSeq,
        // Which turn the silence follows; 0 = the call has not had one yet.
        afterTurn: this.turnSeq,
        micReaching,
        // How long the caller has been sitting in this silence…
        sinceTurnEndMs: now - this.gapStartedAtMs,
        // …and the slice of it the counters below describe.
        windowMs,
        micChunks: this.gapMicChunks,
        forwardedChunks: this.gapForwardedChunks,
        echoSuppressedChunks: this.gapEchoSuppressedChunks,
        sinceLastMicChunkMs: this.lastMicChunkAtMs
          ? now - this.lastMicChunkAtMs
          : null,
        sinceUpstreamMs: this.lastUpstreamAtMs
          ? now - this.lastUpstreamAtMs
          : null,
        upstreamKinds: this.lastUpstreamKinds,
        // How much longer the echo gate still believes our own reply is
        // audible. A window left open long past the reply (a barge-in the
        // playback-tail estimate never learned about) is itself a cause of
        // `micReaching: "gate"`.
        echoWindowMs: Math.max(
          0,
          this.playbackTailUntilMs + this.echoDrainSlackMs - now,
        ),
        interruptions: this.sessionInterruptions,
        sessionMs: now - this.sessionStartedAtMs,
      },
      `gemini-live turnless gap (${micReaching})`,
    );
    // Per-window, not cumulative: the next line answers "is it STILL deaf".
    this.gapWindowStartedAtMs = now;
    this.gapMicChunks = 0;
    this.gapForwardedChunks = 0;
    this.gapEchoSuppressedChunks = 0;
  }

  /**
   * Open a model turn, announcing it with a `thinking` frame exactly once.
   *
   * `thinking` is the protocol's turn-start marker — clients reset their
   * per-turn display state on it (reply text, result cards). This engine never
   * sent one, so on the realtime path a client had no turn boundary at all and
   * each reply was appended to the last: answers ran together and a new turn
   * opened by repeating the answer to the previous question. Returns the turn
   * id so callers can attribute frames to it.
   */
  private beginTurn(): string {
    const existing = this.currentTurnId;
    if (existing) return existing;
    const turnId = randomUUID();
    this.currentTurnId = turnId;
    this.turnSeq += 1;
    this.sessionTurns += 1;
    this.turnStartedAtMs = Date.now();
    this.turnFirstAudioAtMs = 0;
    this.turnAudioBytes = 0;
    this.turnReplyLatencyMs = null;
    this.turnMicChunks = 0;
    this.turnEchoSuppressedChunks = 0;
    void this.context.sendFrame({ type: "thinking", turnId });
    return turnId;
  }

  /**
   * One structured line per turn-lifecycle event, carrying the timings that
   * make a reported hang diagnosable after the fact instead of only
   * reproducible in the moment. `sinceFirstAudioMs` is the discriminator: a
   * turn that dies shortly after audio begins is the assistant talking over
   * itself, not the caller interrupting.
   *
   * Read `sinceFirstAudioMs` for what it is — time ELAPSED since the reply
   * started, sampled at this event. On `interrupted` that is how far into
   * playback the cut landed (its purpose). On `complete` it is simply how long
   * the assistant spoke, and it has twice been mistaken for a stall. The wait
   * the caller actually feels is `replyLatencyMs`: last heard speech → first
   * audio out, null when nothing was transcribed to measure from.
   */
  private logTurn(event: string, extra?: Record<string, unknown>): void {
    const now = Date.now();
    log.info(
      {
        event,
        conversationId: this.conversationId,
        turn: this.turnSeq,
        sinceTurnStartMs: this.turnStartedAtMs ? now - this.turnStartedAtMs : 0,
        sinceFirstAudioMs: this.turnFirstAudioAtMs
          ? now - this.turnFirstAudioAtMs
          : null,
        replyLatencyMs: this.turnReplyLatencyMs,
        audioBytes: this.turnAudioBytes,
        micChunks: this.turnMicChunks,
        echoSuppressedChunks: this.turnEchoSuppressedChunks,
        sessionMs: now - this.sessionStartedAtMs,
        ...extra,
      },
      `gemini-live turn ${event}`,
    );
  }

  private onModelAudio(pcm: Buffer): void {
    if (this.closed) return;
    this.beginTurn();
    this.turnAudioBytes += pcm.length;
    if (this.turnFirstAudioAtMs === 0) {
      this.turnFirstAudioAtMs = Date.now();
      this.turnReplyLatencyMs = this.lastInputTextAtMs
        ? this.turnFirstAudioAtMs - this.lastInputTextAtMs
        : null;
    }
    // Feed the echo classifier's reference with the PCM the client will play
    // (unflagged sessions only). A reference left over from a previous,
    // fully-drained playback burst is stale — discard it so the correlation
    // probe only ever matches audio that can still be audible.
    if (this.echoClassifier) {
      if (Date.now() >= this.playbackTailUntilMs + this.echoDrainSlackMs) {
        this.echoClassifier.resetWindow();
      }
      this.echoClassifier.appendReference(pcm);
    }
    // Advance the playback-tail estimate: chunks queue on the client, so the
    // tail is cumulative from where playback currently stands (never behind
    // now). s16le mono at the output rate → duration = bytes / 2 / rate.
    const durationMs = (pcm.length / 2 / GEMINI_LIVE_OUTPUT_SAMPLE_RATE) * 1000;
    this.playbackTailUntilMs =
      Math.max(this.playbackTailUntilMs, Date.now()) + durationMs;
    void this.context.sendFrame({
      type: "tts_audio",
      mimeType: "audio/pcm",
      sampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
      dataBase64: pcm.toString("base64"),
    });
  }

  private onTurnComplete(): void {
    // A turn that produced no audio and no text still needs an id to close.
    const turnId = this.currentTurnId ?? randomUUID();
    this.currentTurnId = null;
    // Save this turn (user utterance + assistant reply) to the thread, then
    // reset the buffers for the next turn. Fire-and-forget; never blocks audio.
    const userText = this.pendingUserText;
    const assistantText = this.pendingAssistantText;
    this.pendingUserText = "";
    this.pendingAssistantText = "";
    if (userText.trim() || assistantText.trim()) {
      void persistLiveVoiceTurn(this.conversationId, userText, assistantText);
      // Keep a bounded recap window for non-resumed upstream reconnects.
      this.recentTurns.push({ user: userText, assistant: assistantText });
      if (this.recentTurns.length > 8) this.recentTurns.shift();
    }
    // A silent turn — no audio and no transcript — is itself the reported
    // symptom ("it stopped answering"), so it must be as visible as a good one.
    this.logTurn("complete", {
      userChars: userText.trim().length,
      assistantChars: assistantText.trim().length,
      silent: this.turnAudioBytes === 0 && assistantText.trim().length === 0,
    });
    // The turn is over; the gap the caller now sits in starts here.
    this.beginGap();
    void this.context.sendFrame({ type: "tts_done", turnId });
  }

  /**
   * After a fresh (non-resumed) upstream reconnect, the new Gemini session
   * knows the system instruction and briefing but none of THIS call's turns.
   * Feed it a compact transcript recap as a silent text note (no turn
   * trigger), plus an honesty instruction — the tradeoff of fast-reconnect
   * without a resumption handle is possible loss of detail, and the model
   * should ask rather than confabulate.
   */
  private injectReconnectContext(): void {
    const recap = this.recentTurns
      .map(({ user, assistant }) =>
        [
          user.trim() ? `User: ${user.trim()}` : null,
          assistant.trim() ? `You: ${assistant.trim()}` : null,
        ]
          .filter((line) => line !== null)
          .join("\n"),
      )
      .filter((turn) => turn.length > 0)
      .join("\n");
    const note = [
      "[Context note — not spoken by the user: the audio connection dropped briefly and was restored mid-call.",
      recap
        ? `The conversation so far:\n${recap}`
        : "Earlier parts of this call may be missing from your context.",
      "Continue the conversation naturally; do not mention the reconnect unless asked, and if you are unsure of an earlier detail, ask instead of guessing.]",
    ].join("\n");
    this.client?.sendUserText(note);
  }

  // ── Deep-task completion announce-back ───────────────────────────────

  /**
   * Register interest in a `run_deep_task` work item's completion. The
   * matching signal is the runner's `work_item_completed` broadcast (fired
   * exactly once per terminal transition, summary included), observed here
   * through an in-process hub subscription scoped to this session.
   */
  private trackDeepTask(workItem: { id: string; title: string }): void {
    if (this.closed) return;
    this.pendingDeepTasks.set(workItem.id, workItem.title);
    this.deepTaskSubscription ??= assistantEventHub.subscribe({
      type: "process",
      callback: (event) => this.onAssistantEvent(event),
    });
  }

  /** Hub callback: never throws (a bad event must not break hub fanout). */
  private onAssistantEvent(event: AssistantEvent): void {
    try {
      const msg = event.message;
      if (msg.type !== "work_item_completed") return;
      const title = this.pendingDeepTasks.get(msg.workItemId);
      if (title === undefined) return;
      this.pendingDeepTasks.delete(msg.workItemId);
      this.onDeepTaskCompleted(title, msg.status, msg.result.summary);
    } catch (err) {
      log.warn({ err }, "deep-task completion handling failed");
    }
  }

  /**
   * A deep task this call started just finished while the call is still open:
   * inject a silent context note (same mechanism as the reconnect recap —
   * proven safe mid-session) carrying the clipped result summary plus an
   * instruction to announce the outcome aloud NOW, with `triggerTurn` so the
   * model actually speaks instead of waiting for the user's next utterance.
   * This is the missing half of the escalation: without it the task finished
   * into Review while the user sat in a silent call and concluded voice hung.
   *
   * Failures are announced honestly — "hit a problem, it's in Review" — never
   * a fake result. `beginTurn()` opens the turn up front so the announcement's
   * audio, transcript, and any `ui_show` card attribute to a proper turn.
   */
  private onDeepTaskCompleted(
    title: string,
    status: "done" | "awaiting_review" | "failed",
    summary: string,
  ): void {
    if (this.closed || !this.client) return;
    const note =
      status === "failed"
        ? [
            `[Context note — not spoken by the user: the background task you started for them ("${title}") hit a problem and did not finish.`,
            "Tell them honestly, in one short sentence, that the task hit a problem and that it's in their Review area — do not invent a result and do not retry silently.]",
          ].join("\n")
        : [
            `[Context note — not spoken by the user: the background task you started for them ("${title}") just finished.`,
            `Result summary:\n${clipDeepTaskSummary(summary) || "(no summary was captured — the full result is in their Review area.)"}`,
            "Tell them the outcome aloud now in one or two sentences — natural, no ids or raw data, and mention the full result is in their Review area. If the result is something to LOOK at (options, a list, a table), you may show it with ui_show after announcing.]",
          ].join("\n");
    // Attribute the announcement (and any card it shows) to a real turn.
    this.beginTurn();
    this.client.sendUserText(note, { triggerTurn: true });
    log.info({ status }, "gemini-live deep-task completion announced");
  }

  private async onToolCall(
    calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
  ): Promise<void> {
    // Remember the human-readable title of each task captured, for the recap.
    for (const call of calls) {
      const label =
        typeof call.args.title === "string"
          ? call.args.title
          : typeof call.args.request === "string"
            ? call.args.request
            : null;
      if (label && call.name === "add_task") {
        this.capturedTaskTitles.push(label);
      } else if (label && call.name === "run_deep_task") {
        this.capturedTaskTitles.push(`${label} (working on it)`);
      }
    }
    // The one thing a transcript can never tell you: whether the model
    // actually called the tool it claims to have called. A prod call where the
    // assistant said "I've pulled up your inboxes" left NOTHING behind to
    // confirm or deny it. So the call is logged on receipt, and again with
    // each outcome, and "the model called no tools" becomes a fact instead of
    // an inference.
    //
    // These turn logs are the per-turn narrative; the durable record is the
    // `tool_invocations` row each registry-dispatched call now writes (see
    // `getAuditListener` in gemini-live-tools.ts). The two are complementary:
    // the log covers the whole bridge including the work-item fast path and
    // `ui_show`, the table covers every executor gate outcome including the
    // denials.
    const startedAtMs = Date.now();
    this.logTurn("tool_call", { tools: calls.map((call) => call.name) });
    const responses = await Promise.all(
      calls.map((call) =>
        executeGeminiLiveFunctionCall(call, {
          conversationId: this.conversationId,
          signal: this.toolAbort.signal,
          // Deep-task escalation return path: watch the spawned work item so
          // its completion is announced into the call if it's still open.
          onDeepTaskStarted: (workItem) => this.trackDeepTask(workItem),
          // `ui_show` tiles: the same `card` frame the cascade forwards from
          // `ui_surface_show`, so the client renders both engines' cards
          // through the same store. Attributed to the current turn (opening
          // one if the model called the tool before speaking).
          showCard: (card) => {
            if (this.closed) return;
            const turnId = this.beginTurn();
            void this.context.sendFrame({
              type: "card",
              op: "show",
              surfaceId: card.surfaceId,
              surfaceType: card.surfaceType,
              ...(card.title !== undefined ? { title: card.title } : {}),
              data: card.data,
              turnId,
            });
          },
        }),
      ),
    );
    this.logTurn("tool_result", {
      toolMs: Date.now() - startedAtMs,
      // `ok` is the bridge's own contract with the model (see
      // gemini-live-tools.ts): every response is `{ ok, … }`. A denial, a
      // dead connector and a real failure all arrive as `ok: false`, and the
      // error text is what the model then paraphrases out loud — which is
      // exactly the sentence a user reports as a lie.
      tools: responses.map((response) => ({
        name: response.name,
        ok:
          response.response !== null &&
          typeof response.response === "object" &&
          (response.response as { ok?: unknown }).ok === true,
      })),
    });
    this.client?.sendToolResponse(responses);
  }

  close(reason: LiveVoiceSessionCloseReason): void {
    // The call's epitaph, and the line to read first when someone says a call
    // ended on its own: how long it lasted, how many turns it managed, how many
    // of those were cut short, and whether it died with a turn still open.
    log.info(
      {
        event: "session_closed",
        conversationId: this.conversationId,
        reason,
        turns: this.sessionTurns,
        interruptions: this.sessionInterruptions,
        durationMs: Date.now() - this.sessionStartedAtMs,
        unfinishedTurn: this.currentTurnId !== null,
        // How the call ENDED, which "turns: 2, unfinishedTurn: false" cannot
        // say: a caller who hangs up after twenty seconds of a room that
        // stopped hearing him looks, on those fields alone, exactly like one
        // who got his answer and was done.
        endedInSilenceMs:
          this.currentTurnId === null && this.gapStartedAtMs
            ? Date.now() - this.gapStartedAtMs
            : null,
        sinceLastMicChunkMs: this.lastMicChunkAtMs
          ? Date.now() - this.lastMicChunkAtMs
          : null,
      },
      "gemini-live session closed",
    );
    // Fail-open, before anything else goes down: the client leaves
    // "Thinking…" on `tts_done` and nothing else, and a turn still open at
    // teardown never got one — the model was mid-answer when the session
    // died, so the orb spun until the caller gave up on it. Both frames are
    // already in the client's vocabulary, so neither needs advertising on
    // `ready` (an unflagged frame type is session-fatal to the shipped web
    // client). Non-fatal: the TURN died, and the socket close that follows is
    // reported on its own terms.
    const unfinishedTurnId = this.currentTurnId;
    this.currentTurnId = null;
    if (unfinishedTurnId) {
      void this.context.sendFrame({
        type: "error",
        code: "invalid_field",
        message: "That turn didn't finish before the call ended. Ask me again.",
        fatal: false,
      });
      void this.context.sendFrame({
        type: "tts_done",
        turnId: unfinishedTurnId,
      });
    }
    this.closed = true;
    this.stopGapProbe();
    this.toolAbort.abort();
    // Stop watching deep-task completions: a task that finishes after the
    // call ends lands in Review (existing behavior) with nothing announced,
    // and the session must not linger as a hub subscriber.
    this.deepTaskSubscription?.dispose();
    this.deepTaskSubscription = null;
    this.pendingDeepTasks.clear();
    // Release this session's skill-tool registrations (refcounted — other
    // sessions/conversations holding the same skills are unaffected).
    try {
      resetSkillToolProjection(this.skillToolVersions);
    } catch (err) {
      log.warn({ err }, "voice skill tool teardown failed");
    }
    this.client?.close();
    this.client = null;
    // Flush any un-flushed final turn, then write the recap + auto-title. All
    // best-effort and detached — the socket is already closing.
    const trailingUser = this.pendingUserText;
    const trailingAssistant = this.pendingAssistantText;
    this.pendingUserText = "";
    this.pendingAssistantText = "";
    void (async () => {
      try {
        if (trailingUser.trim() || trailingAssistant.trim()) {
          await persistLiveVoiceTurn(
            this.conversationId,
            trailingUser,
            trailingAssistant,
          );
        }
        // End-of-session synthesis: park any residual to-dos the user asked for
        // that weren't already captured mid-call, and write the conversation to
        // memory. Merge the new titles into the recap alongside the mid-call
        // tasks. Best-effort — never blocks the finalize.
        const synth = await synthesizeLiveVoiceSession(this.conversationId);
        await finalizeLiveVoiceThread(this.conversationId, {
          taskTitles: [...this.capturedTaskTitles, ...synth.newTaskTitles],
        });
      } catch (err) {
        log.warn({ err }, "gemini-live thread finalize failed");
      }
    })();
  }
}

export function createGeminiLiveSession(
  context: LiveVoiceSessionFactoryContext,
): LiveVoiceSession {
  return new GeminiLiveSession(context);
}
