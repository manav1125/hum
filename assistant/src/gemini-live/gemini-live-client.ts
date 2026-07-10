/**
 * Low-level client for Google's Gemini Live (`BidiGenerateContent`) WebSocket —
 * the speech-native realtime API. This wraps the raw protocol (setup →
 * setupComplete → streamed audio + tool calls) behind typed callbacks so the
 * session layer can bridge it to Cue's live-voice client protocol.
 *
 * This is the "Tier 1" realtime engine (see docs/cue-voice-architecture-review.md):
 * it handles the live conversation and quick function calls with ~sub-3s
 * latency, in contrast to the cascade (STT → full agent loop → TTS) which stays
 * as the deep-work tier reached via the `run_deep_task` function.
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("gemini-live-client");

const GEMINI_LIVE_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Half-cascade "live" model — the right default for a tool-heavy assistant.
 * The native-audio dialog models (e.g. gemini-2.5-flash-native-audio-*) sound
 * more expressive but have flaky function-call support: they 1007-close
 * ("audio content type not supported for this model configuration") when they
 * speak a preamble, call a tool, then try to speak the result. Cue's whole value
 * is taking actions, so we default to the tool-robust live-preview class.
 * Override per-instance with `CUE_GEMINI_LIVE_MODEL`.
 */
export const DEFAULT_GEMINI_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

/** Gemini Live streams output audio as 24kHz 16-bit mono PCM. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24000;

export function resolveGeminiLiveModel(): string {
  const override = process.env.CUE_GEMINI_LIVE_MODEL?.trim();
  const model = override || DEFAULT_GEMINI_LIVE_MODEL;
  // The API wants a fully-qualified `models/...` resource name.
  return model.startsWith("models/") ? model : `models/${model}`;
}

/**
 * BCP-47 language for speech recognition + synthesis. Without a pinned language
 * Gemini Live auto-detects, and on a short/quiet first utterance it can guess
 * wrong (e.g. transcribe English as Japanese), derailing the whole turn.
 * Override with `CUE_GEMINI_LIVE_LANGUAGE`.
 */
export function resolveGeminiLiveLanguage(): string {
  return process.env.CUE_GEMINI_LIVE_LANGUAGE?.trim() || "en-US";
}

/**
 * Gemini Live prebuilt voice name. Gemini Live speaks with its OWN voices (not
 * the cascade's ElevenLabs voice), so we pick a warm female voice by default to
 * match Cue's prior persona. Female options include Aoede, Kore, Leda, Zephyr;
 * male include Puck, Charon, Fenrir, Orus. Override with `CUE_GEMINI_LIVE_VOICE`.
 */
export function resolveGeminiLiveVoice(): string {
  return process.env.CUE_GEMINI_LIVE_VOICE?.trim() || "Aoede";
}

/**
 * Resolve the Gemini API key for the realtime voice engine.
 *
 * A dedicated Gemini key ALWAYS wins: `GEMINI_API_KEY` / `CUE_GEMINI_API_KEY`
 * env, then a `gemini` credential. Only if none is set do we fall back to the
 * shared `openrouter` credential (used when the brain also runs on Gemini via
 * the masquerade). This ordering keeps voice on the real Gemini key even when
 * the brain's `openrouter` credential/key points at a DIFFERENT provider (e.g.
 * DeepSeek via OpenRouter) — otherwise voice would grab the OpenRouter key and
 * fail with "API key not valid".
 */
export async function resolveGeminiLiveApiKey(): Promise<string | null> {
  const fromEnv =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.CUE_GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromGeminiStore = await getSecureKeyAsync(
    credentialKey("gemini", "api_key"),
  );
  if (fromGeminiStore) return fromGeminiStore;
  const fromOpenrouterStore = await getSecureKeyAsync(
    credentialKey("openrouter", "api_key"),
  );
  return fromOpenrouterStore || null;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiLiveToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiLiveClientCallbacks {
  /** A chunk of output audio (raw PCM, 24kHz 16-bit mono). */
  onAudio?: (pcm: Buffer) => void;
  /** Server transcription of the model's spoken output (if enabled). */
  onOutputText?: (text: string) => void;
  /** Server transcription of the user's input audio (if enabled). */
  onInputText?: (text: string) => void;
  /** The model wants to call one or more functions. */
  onToolCall?: (calls: GeminiLiveToolCall[]) => void;
  /** The model finished its turn (generation complete). */
  onTurnComplete?: () => void;
  /** The user barged in — the model's output was interrupted server-side. */
  onInterrupted?: () => void;
  onError?: (message: string) => void;
  onClose?: (code: number, reason: string) => void;
}

export interface GeminiLiveConnectOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  tools?: GeminiFunctionDeclaration[];
  /** Sample rate of the audio the client will stream in (usually 16000). */
  inputSampleRate: number;
  /** BCP-47 language pinned for recognition + synthesis (e.g. "en-US"). */
  language?: string;
  /** Prebuilt Gemini voice name (e.g. "Aoede"). */
  voice?: string;
  callbacks: GeminiLiveClientCallbacks;
}

/**
 * A single Gemini Live session. Construct, `connect()` (resolves once the
 * server acknowledges setup), then stream audio and relay tool responses.
 */
export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private readonly opts: GeminiLiveConnectOptions;
  private readonly inputMimeType: string;
  private closed = false;

  constructor(opts: GeminiLiveConnectOptions) {
    this.opts = opts;
    this.inputMimeType = `audio/pcm;rate=${opts.inputSampleRate}`;
  }

  /** Open the socket and complete setup. Resolves on `setupComplete`. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_LIVE_WS_BASE}?key=${encodeURIComponent(this.opts.apiKey)}`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let setupDone = false;

      ws.onopen = () => {
        const generationConfig: Record<string, unknown> = {
          responseModalities: ["AUDIO"],
        };
        // Pin recognition + synthesis language + voice so a short first utterance
        // can't be auto-detected as the wrong language, and Cue keeps a stable
        // (female, by default) voice.
        if (this.opts.language || this.opts.voice) {
          const speechConfig: Record<string, unknown> = {};
          if (this.opts.language)
            speechConfig.languageCode = this.opts.language;
          if (this.opts.voice) {
            speechConfig.voiceConfig = {
              prebuiltVoiceConfig: { voiceName: this.opts.voice },
            };
          }
          generationConfig.speechConfig = speechConfig;
        }
        const setup: Record<string, unknown> = {
          model: this.opts.model,
          generationConfig,
          systemInstruction: {
            parts: [{ text: this.opts.systemInstruction }],
          },
          // Server-side transcription so we can surface user + assistant text
          // frames on the existing protocol (nice-to-have; audio is the product).
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        };
        if (this.opts.tools && this.opts.tools.length > 0) {
          setup.tools = [{ functionDeclarations: this.opts.tools }];
        }
        this.send({ setup });
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
          const raw =
            typeof ev.data === "string"
              ? ev.data
              : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (!setupDone && "setupComplete" in msg) {
          setupDone = true;
          resolve();
          return;
        }
        try {
          this.handleServerMessage(msg);
        } catch (err) {
          log.warn({ err }, "gemini-live: error handling server message");
        }
      };

      ws.onerror = () => {
        const message = "Gemini Live socket error";
        if (!setupDone) reject(new Error(message));
        this.opts.callbacks.onError?.(message);
      };

      ws.onclose = (ev: CloseEvent) => {
        if (!setupDone) {
          reject(
            new Error(
              `Gemini Live closed before setup (code=${ev.code} ${ev.reason || ""})`,
            ),
          );
        }
        this.opts.callbacks.onClose?.(ev.code, ev.reason || "");
      };
    });
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    const cb = this.opts.callbacks;

    const toolCall = msg.toolCall as
      | { functionCalls?: GeminiLiveToolCall[] }
      | undefined;
    if (toolCall?.functionCalls?.length) {
      cb.onToolCall?.(toolCall.functionCalls);
      return;
    }

    const sc = msg.serverContent as
      | {
          modelTurn?: { parts?: Array<Record<string, unknown>> };
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          turnComplete?: boolean;
          interrupted?: boolean;
        }
      | undefined;
    if (!sc) return;

    if (sc.interrupted) cb.onInterrupted?.();
    if (sc.inputTranscription?.text)
      cb.onInputText?.(sc.inputTranscription.text);
    if (sc.outputTranscription?.text)
      cb.onOutputText?.(sc.outputTranscription.text);

    for (const part of sc.modelTurn?.parts ?? []) {
      const inlineData = part.inlineData as
        | { data?: string; mimeType?: string }
        | undefined;
      if (inlineData?.data) {
        cb.onAudio?.(Buffer.from(inlineData.data, "base64"));
      }
    }

    if (sc.turnComplete) cb.onTurnComplete?.();
  }

  /** Stream a chunk of input audio (raw PCM at `inputSampleRate`). */
  sendAudio(pcm: Uint8Array): void {
    this.send({
      realtimeInput: {
        audio: {
          data: Buffer.from(pcm).toString("base64"),
          mimeType: this.inputMimeType,
        },
      },
    });
  }

  /** Signal end-of-input so server VAD closes the turn promptly. */
  sendAudioStreamEnd(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** Return a function result for a tool the model called. */
  sendToolResponse(
    responses: Array<{ id?: string; name: string; response: unknown }>,
  ): void {
    this.send({ toolResponse: { functionResponses: responses } });
  }

  private send(payload: unknown): void {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // best-effort
    }
    this.ws = null;
  }
}
