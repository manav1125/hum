import { resolveLanguageVoiceOverride } from "../tts/language-voices.js";
import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type {
  TtsProvider,
  TtsProviderId,
  TtsSynthesisRequest,
  TtsUseCase,
} from "../tts/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-voice:tts");

export const DEFAULT_LIVE_VOICE_TTS_SAMPLE_RATE = 24_000;

export type LiveVoiceTtsConfig = Parameters<typeof resolveTtsConfig>[0];

export interface LiveVoiceTtsAudioChunk {
  type: "tts_audio";
  contentType: string;
  sampleRate: number;
  dataBase64: string;
}

export interface LiveVoiceTtsOptions {
  text: string;
  voiceId?: string;
  signal?: AbortSignal;
  useCase?: TtsUseCase;
  outputFormat?: TtsSynthesisRequest["outputFormat"];
  sampleRate?: number;
  /**
   * The turn's spoken language as a lowercase base subtag, when known.
   * Selects the provider's configured per-language voice (`languageVoices`)
   * unless an explicit `voiceId` was requested, and rides the synthesis
   * request as a language-enforcement hint for providers that accept one.
   */
  language?: string;
  config?: LiveVoiceTtsConfig;
  onAudioChunk: (chunk: LiveVoiceTtsAudioChunk) => void;
}

export interface LiveVoiceTtsResult {
  provider: TtsProviderId;
  contentType: string;
  sampleRate: number;
  chunks: number;
  bytes: number;
}

export type LiveVoiceTtsErrorCode =
  | "LIVE_VOICE_TTS_PROVIDER_NOT_CONFIGURED"
  | "LIVE_VOICE_TTS_STREAMING_UNAVAILABLE"
  | "LIVE_VOICE_TTS_CONFIGURATION_ERROR"
  | "LIVE_VOICE_TTS_SYNTHESIS_FAILED";

export class LiveVoiceTtsError extends Error {
  readonly code: LiveVoiceTtsErrorCode;
  readonly provider?: TtsProviderId;
  override readonly cause?: unknown;

  constructor(
    code: LiveVoiceTtsErrorCode,
    message: string,
    options: { provider?: TtsProviderId; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LiveVoiceTtsError";
    this.code = code;
    this.provider = options.provider;
    this.cause = options.cause;
  }
}

interface ResolvedStreamingTtsProvider {
  provider: TtsProvider;
  providerId: TtsProviderId;
  providerConfig: Record<string, unknown>;
}

export async function streamLiveVoiceTtsAudio(
  options: LiveVoiceTtsOptions,
): Promise<LiveVoiceTtsResult> {
  const { provider, providerId, providerConfig } =
    await resolveLiveVoiceStreamingTtsProvider(options.config);
  // An explicit request voice wins outright; otherwise a language-known
  // turn may select the provider's configured per-language voice. The cast
  // recovers the schema-typed map that resolveTtsConfig's generic
  // provider-block lookup erases.
  const voiceId =
    options.voiceId ??
    resolveLanguageVoiceOverride(
      providerConfig.languageVoices as Record<string, string> | undefined,
      options.language,
    );
  const requestedSampleRate = resolveSampleRate(
    options.sampleRate,
    providerConfig,
  );
  const chunkContentType = resolveChunkContentType(
    provider,
    providerConfig,
    options.outputFormat,
  );
  const canStreamChunks = isRawPcmContentType(chunkContentType);

  // Honest sample-rate labeling: providers emit raw PCM at a fixed rate they
  // cannot change (ElevenLabs 16 kHz, Fish Audio 44.1 kHz). The client plays
  // exactly what each frame's label says, so when the provider declares its
  // fixed PCM rate it MUST win over the requested one — a mislabel plays the
  // audio at the wrong speed/pitch.
  const providerPcmSampleRate = provider.capabilities.pcmSampleRateHz;
  const sampleRate =
    canStreamChunks && isPositiveFiniteNumber(providerPcmSampleRate)
      ? providerPcmSampleRate
      : requestedSampleRate;
  if (sampleRate !== requestedSampleRate) {
    log.warn(
      {
        provider: providerId,
        requestedSampleRate,
        providerSampleRate: sampleRate,
      },
      "Live voice TTS provider emits raw PCM at a fixed sample rate; labeling frames with the provider's actual rate instead of the requested one",
    );
  }
  let chunks = 0;
  let bytes = 0;

  const emitAudioFrame = (contentType: string, audio: Uint8Array): void => {
    if (audio.byteLength === 0) return;

    chunks += 1;
    bytes += audio.byteLength;
    options.onAudioChunk({
      type: "tts_audio",
      contentType,
      sampleRate,
      dataBase64: Buffer.from(audio).toString("base64"),
    });
  };

  try {
    const result = await provider.synthesizeStream!(
      {
        text: options.text,
        useCase: options.useCase ?? "phone-call",
        voiceId,
        signal: options.signal,
        outputFormat: options.outputFormat,
        // Providers without a language parameter (Fish Audio) ignore this
        // silently — see TtsSynthesisRequest.language.
        language: options.language,
      },
      (audioChunk) => {
        if (canStreamChunks) {
          emitAudioFrame(chunkContentType, audioChunk);
        }
      },
    );
    const contentType = result.contentType || chunkContentType;

    if (!canStreamChunks) {
      emitAudioFrame(contentType, result.audio);
    }

    return {
      provider: providerId,
      contentType,
      sampleRate,
      chunks,
      bytes,
    };
  } catch (err) {
    throw normalizeProviderError(err, providerId);
  }
}

async function resolveLiveVoiceStreamingTtsProvider(
  configOverride?: LiveVoiceTtsConfig,
): Promise<ResolvedStreamingTtsProvider> {
  const config = configOverride ?? (await loadAssistantConfig());
  const { provider: providerId, providerConfig } = resolveTtsConfig(config);

  let provider: TtsProvider;
  try {
    provider = getTtsProvider(providerId);
  } catch (err) {
    throw new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_PROVIDER_NOT_CONFIGURED",
      `TTS provider "${providerId}" is not configured or registered.`,
      { provider: providerId, cause: err },
    );
  }

  if (
    !provider.capabilities.supportsStreaming ||
    typeof provider.synthesizeStream !== "function"
  ) {
    throw new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_STREAMING_UNAVAILABLE",
      `TTS provider "${providerId}" does not support streaming synthesis required by live voice.`,
      { provider: providerId },
    );
  }

  return { provider, providerId, providerConfig };
}

async function loadAssistantConfig(): Promise<LiveVoiceTtsConfig> {
  const { getConfig } = await import("../config/loader.js");
  return getConfig();
}

function normalizeProviderError(
  err: unknown,
  providerId: TtsProviderId,
): LiveVoiceTtsError {
  if (err instanceof LiveVoiceTtsError) return err;

  const message = err instanceof Error ? err.message : String(err);
  if (isProviderConfigurationError(err)) {
    return new LiveVoiceTtsError(
      "LIVE_VOICE_TTS_CONFIGURATION_ERROR",
      `Live voice TTS provider "${providerId}" is missing required configuration or credentials: ${message}`,
      { provider: providerId, cause: err },
    );
  }

  return new LiveVoiceTtsError(
    "LIVE_VOICE_TTS_SYNTHESIS_FAILED",
    `Live voice TTS synthesis failed (provider: ${providerId}): ${message}`,
    { provider: providerId, cause: err },
  );
}

function isProviderConfigurationError(err: unknown): boolean {
  const code =
    err instanceof Error && "code" in err
      ? String((err as Error & { code?: unknown }).code)
      : undefined;
  if (
    code?.endsWith("_NO_API_KEY") ||
    code?.endsWith("_NO_REFERENCE_ID") ||
    code?.endsWith("_NO_VOICE_ID")
  ) {
    return true;
  }

  const message = err instanceof Error ? err.message : String(err);
  return /(?:api key|credential|reference id|voice id).*not configured/i.test(
    message,
  );
}

function resolveChunkContentType(
  provider: TtsProvider,
  providerConfig: Record<string, unknown>,
  outputFormat: TtsSynthesisRequest["outputFormat"],
): string {
  if (outputFormat === "pcm") {
    if (provider.capabilities.supportedFormats.includes("pcm")) {
      return "audio/pcm";
    }
    if (provider.capabilities.supportedFormats.includes("wav")) {
      return "audio/wav";
    }
    return "audio/pcm";
  }

  const format =
    typeof providerConfig.format === "string" ? providerConfig.format : "mp3";
  switch (format) {
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "pcm":
      return "audio/pcm";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}

function resolveSampleRate(
  explicitSampleRate: number | undefined,
  providerConfig: Record<string, unknown>,
): number {
  if (isPositiveFiniteNumber(explicitSampleRate)) {
    return explicitSampleRate;
  }

  const configuredSampleRate = providerConfig.sampleRate;
  if (isPositiveFiniteNumber(configuredSampleRate)) {
    return configuredSampleRate;
  }

  return DEFAULT_LIVE_VOICE_TTS_SAMPLE_RATE;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRawPcmContentType(contentType: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "audio/pcm";
}
