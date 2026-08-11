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

import {
  projectSkillTools,
  resetSkillToolProjection,
} from "../daemon/conversation-skill-tools.js";
import { formatTurnTimestamp } from "../daemon/date-context.js";
import { buildLiveBriefing } from "../live-voice/build-live-briefing.js";
import type {
  LiveVoiceSession,
  LiveVoiceSessionCloseReason,
  LiveVoiceSessionFactoryContext,
} from "../live-voice/live-voice-session-manager.js";
import { LiveVoiceSessionStartupError } from "../live-voice/live-voice-session-manager.js";
import {
  ensureLiveVoiceThread,
  finalizeLiveVoiceThread,
  persistLiveVoiceTurn,
} from "../live-voice/live-voice-thread.js";
import { synthesizeLiveVoiceSession } from "../live-voice/synthesize-live-voice-session.js";
import { resolveVoicePersona } from "../live-voice/voice-personas.js";
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
  resolveGeminiLiveLanguage,
  resolveGeminiLiveModel,
  resolveGeminiLiveVoice,
} from "./gemini-live-client.js";
import {
  executeGeminiLiveFunctionCall,
  GEMINI_LIVE_FUNCTION_DECLARATIONS,
  GEMINI_LIVE_VOICE_SKILLS,
} from "./gemini-live-tools.js";

const log = getLogger("gemini-live-session");

/**
 * Post-playback margin for the echo gate: covers client buffering/network
 * jitter between "we sent the last audio chunk" and "the speaker went quiet",
 * so trailing echo cannot open a phantom user turn.
 */
const ECHO_GATE_MARGIN_MS = 400;

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
function buildSystemInstruction(
  timezone?: string,
  opts?: { personaFragment?: string; briefing?: string },
): string {
  const hasTz = typeof timezone === "string" && timezone.trim().length > 0;
  const timeLine = hasTz
    ? `The current date and time in the user's timezone is ${formatTurnTimestamp({ clientTimezone: timezone })}. That is their local time — use it for anything time-related and never quote UTC unless they ask.`
    : `The current date and time is ${formatTurnTimestamp()} (UTC). You do NOT know the user's local timezone yet, so do not assume it is UTC when you speak — if the time of day matters, briefly ask what timezone they're in, or take their word if they tell you their local time.`;
  const persona = opts?.personaFragment?.trim();
  const base = [
    "You are Cue, your user's personal AI chief-of-staff, in a live spoken voice conversation with them right now.",
    "Your name is Cue. Never say you are 'a large language model', never say you were 'trained by Google', and never mention Google or Gemini. If asked what you are, say you are Cue, their AI chief-of-staff. Stay in character as Cue at all times.",
    "You are speaking with your own owner, who has authorized you. Be warm, concise, and natural — usually one or two sentences.",
    // The selected conversation mode shapes tone (companion / reflective /
    // co-founder). Empty → the base warm-chief-of-staff default.
    ...(persona ? [persona] : []),
    timeLine,
    "You can take real actions and pull the user's real data with your tools. Quick to-do → add_task. Substantive work (research, drafting, multi-step) → run_deep_task, then tell them you're on it. What's on their plate → get_open_tasks. Current facts, news, or weather → web_search. Anything about the user's own life, work, files, or past conversations → recall_memory before you say you don't know. A lasting fact or preference they just told you → remember. Reminders and automations Cue set → get_schedule; setting one → set_reminder. What's on their Google Calendar — meetings, events, their day or week → get_calendar (get_schedule does NOT show their calendar). Who someone is or how to reach them → find_contact. Replies they're waiting on → get_followups. Their email or messages → check_inbox, then read_messages for one conversation. Never read ids, email addresses, or raw data aloud — speak the human part.",
    "When a result is something to LOOK at — options, search results, a list, a table — announce it aloud first in one short sentence (for example: Here's what I found), then call ui_show to put it on screen, and give a one- or two-sentence spoken summary. The card is seen, not spoken: never read it item by item.",
    "For any calendar question, always call get_calendar and answer ONLY from its result — their calendar events are not in your briefing, memory, or messages, and answering from those is making things up. Announce aloud, put the events on screen with ui_show as a list, then give a short spoken summary. If get_calendar says their calendar isn't connected, tell them exactly that and that they can link Google Calendar in Settings → Connectors — never improvise a calendar answer from anything else.",
    "Never claim you have done something unless you actually called the tool for it and it succeeded. If a tool fails, say so in one short sentence and offer a next step. If a tool says it needs approval or isn't permitted, tell them briefly that this one needs their okay in the app — never pretend it happened and never work around it.",
    "When you add a to-do, say simply that you saved it to their task list — do NOT invent specific screen names like 'My Day' or claim it's in a particular place you can't verify. When run_deep_task finishes, its result appears in their Review area; only mention Review for run_deep_task work, never for a plain reminder.",
    "Do not spell things out letter by letter or read punctuation, tool names, or code aloud. Just speak like a helpful person.",
    "The user speaks English. Always understand their speech as English and reply in English, even if a word is unclear.",
  ].join(" ");
  // Append the session-start context briefing (who the user is + their current
  // work) so the speech-native model opens the conversation already knowing
  // them. Empty on a fresh workspace, in which case nothing is appended.
  const briefing = opts?.briefing?.trim();
  if (briefing) {
    return `${base}\n\n${briefing}`;
  }
  return base;
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
  // Turn transcript accumulation, flushed to the saved thread on turnComplete.
  private pendingUserText = "";
  private pendingAssistantText = "";
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
        { personaFragment: persona.promptFragment, briefing },
      ),
      tools: GEMINI_LIVE_FUNCTION_DECLARATIONS,
      inputSampleRate: this.inputSampleRate,
      language: resolveGeminiLiveLanguage(),
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
          this.pendingUserText += text;
          void this.context.sendFrame({ type: "stt_final", text });
        },
        onToolCall: (calls) => void this.onToolCall(calls),
        onTurnComplete: () => this.onTurnComplete(),
        onInterrupted: () => {
          // The user barged in; Gemini stops generating server-side. We simply
          // stop emitting audio for the interrupted turn.
          this.currentTurnId = null;
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

    await this.context.sendFrame({
      type: "ready",
      sessionId: this.context.sessionId,
      conversationId: this.conversationId,
    });
    log.info(
      { sessionId: this.context.sessionId, model: resolveGeminiLiveModel() },
      "gemini-live session started",
    );
  }

  handleClientFrame(frame: { type: string; dataBase64?: string }): void {
    if (!this.client) return;
    switch (frame.type) {
      case "audio":
        if (frame.dataBase64) {
          this.client.sendAudio(
            this.gateEcho(Buffer.from(frame.dataBase64, "base64")),
          );
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
      // "end" → the manager calls close().
    }
  }

  handleBinaryAudio(chunk: Uint8Array): void {
    this.client?.sendAudio(this.gateEcho(chunk));
  }

  /**
   * Half-duplex echo gate: while the assistant's own audio is (estimated to
   * be) playing on the client, replace mic input with equal-length silence
   * before it reaches Gemini.
   *
   * Real-device evidence (2026-08-11): echo cancellation does not cover
   * WebAudio playback in the packaged desktop app, so the reply loops back
   * through the mic and Gemini's activity detection reads it as the user —
   * interrupting the reply with its own echo on every turn. Desensitizing
   * detection (START_SENSITIVITY_LOW) traded that for the opposite failure:
   * relaxed, quieter follow-ups stopped opening turns and the session
   * "stopped engaging" a few exchanges in. Gating removes the echo at the
   * source instead, so detection can stay at full sensitivity. Silence (not
   * dropped frames) keeps the input stream continuous for Gemini's VAD. The
   * cost is no mid-reply barge-in on this engine for now — the same stopgap
   * the cascade engine currently runs.
   */
  private gateEcho(chunk: Uint8Array): Uint8Array {
    // A client whose playback is echo-cancellable (media-element routing,
    // declared via the start frame's `echoSafePlayback` capability flag)
    // never loops the reply back through its mic — pass its audio through
    // untouched so the user can interrupt mid-reply at full sensitivity.
    if (this.context.startFrame.echoSafePlayback === true) return chunk;
    if (Date.now() < this.playbackTailUntilMs + ECHO_GATE_MARGIN_MS) {
      return SILENCE_CHUNKS.get(chunk.length) ?? new Uint8Array(chunk.length);
    }
    return chunk;
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
    void this.context.sendFrame({ type: "thinking", turnId });
    return turnId;
  }

  private onModelAudio(pcm: Buffer): void {
    if (this.closed) return;
    this.beginTurn();
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
    this.client?.sendToolResponse(responses);
  }

  close(_reason: LiveVoiceSessionCloseReason): void {
    this.closed = true;
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
