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

import type {
  LiveVoiceSession,
  LiveVoiceSessionCloseReason,
  LiveVoiceSessionFactoryContext,
} from "../live-voice/live-voice-session-manager.js";
import { LiveVoiceSessionStartupError } from "../live-voice/live-voice-session-manager.js";
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
} from "./gemini-live-tools.js";

const log = getLogger("gemini-live-session");

/**
 * Cue's identity + voice etiquette for the realtime engine. Kept in sync in
 * spirit with the cascade's LIVE_VOICE_CONTROL_PROMPT: real capabilities, honest
 * about actions, brief and TTS-clean. Gemini Live speaks the audio itself, so
 * this shapes tone and tool discipline.
 */
function buildSystemInstruction(): string {
  return [
    "You are Cue, your user's personal AI chief-of-staff, in a live spoken voice conversation with them right now.",
    "Your name is Cue. Never say you are 'a large language model', never say you were 'trained by Google', and never mention Google or Gemini. If asked what you are, say you are Cue, their AI chief-of-staff. Stay in character as Cue at all times.",
    "You are speaking with your own owner, who has authorized you. Be warm, concise, and natural — usually one or two sentences.",
    "You can take real actions with your tools. To note a quick reminder or to-do, call add_task. For anything substantive that needs real work (research, drafting, multi-step tasks), call run_deep_task and tell them you're on it. To tell them what's on their plate, call get_open_tasks.",
    "Never claim you have done something unless you actually called the tool for it and it succeeded. If a tool fails, say so in one short sentence and offer a next step.",
    "When you add a to-do, say simply that you saved it to their task list — do NOT invent specific screen names like 'My Day' or claim it's in a particular place you can't verify. When run_deep_task finishes, its result appears in their Review area; only mention Review for run_deep_task work, never for a plain reminder.",
    "Do not spell things out letter by letter or read punctuation, tool names, or code aloud. Just speak like a helpful person.",
    "The user speaks English. Always understand their speech as English and reply in English, even if a word is unclear.",
  ].join(" ");
}

export class GeminiLiveSession implements LiveVoiceSession {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly conversationId: string;
  private readonly inputSampleRate: number;
  private client: GeminiLiveClient | null = null;
  private currentTurnId: string | null = null;
  private closed = false;

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

    const client = new GeminiLiveClient({
      apiKey,
      model: resolveGeminiLiveModel(),
      systemInstruction: buildSystemInstruction(),
      tools: GEMINI_LIVE_FUNCTION_DECLARATIONS,
      inputSampleRate: this.inputSampleRate,
      language: resolveGeminiLiveLanguage(),
      voice: resolveGeminiLiveVoice(),
      callbacks: {
        onAudio: (pcm) => this.onModelAudio(pcm),
        onOutputText: (text) => {
          void this.context.sendFrame({ type: "assistant_text_delta", text });
        },
        onInputText: (text) => {
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

  private onModelAudio(pcm: Buffer): void {
    if (this.closed) return;
    if (!this.currentTurnId) this.currentTurnId = randomUUID();
    void this.context.sendFrame({
      type: "tts_audio",
      mimeType: "audio/pcm",
      sampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
      dataBase64: pcm.toString("base64"),
    });
  }

  private onTurnComplete(): void {
    const turnId = this.currentTurnId ?? randomUUID();
    this.currentTurnId = null;
    void this.context.sendFrame({ type: "tts_done", turnId });
  }

  private async onToolCall(
    calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
  ): Promise<void> {
    const responses = await Promise.all(
      calls.map((call) =>
        executeGeminiLiveFunctionCall(call, {
          conversationId: this.conversationId,
        }),
      ),
    );
    this.client?.sendToolResponse(responses);
  }

  close(_reason: LiveVoiceSessionCloseReason): void {
    this.closed = true;
    this.client?.close();
    this.client = null;
  }
}

export function createGeminiLiveSession(
  context: LiveVoiceSessionFactoryContext,
): LiveVoiceSession {
  return new GeminiLiveSession(context);
}
