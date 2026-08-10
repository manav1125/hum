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
    "You can take real actions and pull the user's real data with your tools. Quick to-do → add_task. Substantive work (research, drafting, multi-step) → run_deep_task, then tell them you're on it. What's on their plate → get_open_tasks. Current facts, news, or weather → web_search. Anything about the user's own life, work, files, or past conversations → recall_memory before you say you don't know. A lasting fact or preference they just told you → remember. Their reminders and automations → get_schedule; setting one → set_reminder. Who someone is or how to reach them → find_contact. Replies they're waiting on → get_followups. Their email or messages → check_inbox, then read_messages for one conversation. Never read ids, email addresses, or raw data aloud — speak the human part.",
    "When a result is something to LOOK at — options, search results, a list, a table — announce it aloud first in one short sentence (for example: Here's what I found), then call ui_show to put it on screen, and give a one- or two-sentence spoken summary. The card is seen, not spoken: never read it item by item.",
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
  // Turn transcript accumulation, flushed to the saved thread on turnComplete.
  private pendingUserText = "";
  private pendingAssistantText = "";
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
          void this.context.sendFrame({
            type: "error",
            code: "invalid_frame",
            message,
          });
        },
        onClose: (code, reason) => {
          if (!this.closed && code !== 1000) {
            void this.context.sendFrame({
              type: "error",
              code: "invalid_frame",
              message: `Gemini Live closed (code=${code} ${reason})`,
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
          this.client.sendAudio(Buffer.from(frame.dataBase64, "base64"));
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
    this.client?.sendAudio(chunk);
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
    }
    void this.context.sendFrame({ type: "tts_done", turnId });
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
