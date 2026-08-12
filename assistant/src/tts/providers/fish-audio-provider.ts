/**
 * Fish Audio TTS provider adapter.
 *
 * Wraps the shared {@link synthesizeWithFishAudio} HTTP client behind the
 * uniform {@link TtsProvider} interface, preserving its streaming chunk
 * callbacks for real-time playback (phone calls and live voice).
 *
 * Config comes from `services.tts.providers['fish-audio']`. The API key is
 * resolved via {@link resolveFishAudioApiKey}: secure credential store
 * (`fish-audio/api_key`) first, then the `FISH_AUDIO_API_KEY` process env —
 * the same two sources the live-voice credential preflight accepts, so a
 * session the preflight admits can never fail key resolution at synth time.
 *
 * Raw-PCM handling differs between the two entry points on purpose:
 *
 * - `synthesizeStream` + `outputFormat: "pcm"` requests Fish Audio's true
 *   raw-PCM format (44.1 kHz mono s16le, {@link FISH_AUDIO_PCM_SAMPLE_RATE_HZ})
 *   so live voice can play chunks as they arrive instead of buffering a whole
 *   WAV utterance.
 * - `synthesize` + `outputFormat: "pcm"` keeps the historical WAV override:
 *   the phone media-stream transport sniffs the returned container bytes
 *   (`audioBufferToFrames`) and relies on the RIFF header being present.
 */

import {
  FISH_AUDIO_PCM_SAMPLE_RATE_HZ,
  type FishAudioSynthesisConfig,
  resolveFishAudioApiKey,
  synthesizeWithFishAudio,
} from "../../calls/fish-audio-client.js";
import { getConfig } from "../../config/loader.js";
import type { TtsFishAudioProviderConfig } from "../../config/schemas/tts.js";
import { getLogger } from "../../util/logger.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";

const log = getLogger("tts:fish-audio");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type FishAudioTtsErrorCode =
  | "FISH_AUDIO_TTS_NO_API_KEY"
  | "FISH_AUDIO_TTS_NO_REFERENCE_ID"
  | "FISH_AUDIO_TTS_SYNTHESIS_FAILED";

export class FishAudioTtsError extends Error {
  readonly code: FishAudioTtsErrorCode;

  constructor(code: FishAudioTtsErrorCode, message: string) {
    super(message);
    this.name = "FishAudioTtsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map Fish Audio format names to MIME content types. */
const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  pcm: "audio/pcm",
};

// NOTE on `TtsSynthesisRequest.language`: the Fish Audio TTS API has no
// language parameter at all — the model infers the language from the text
// (and the reference voice). The request-level hint is therefore dropped
// silently here, exactly as the `language` field's contract allows; voice
// selection per language is the caller's job (there is deliberately no
// `languageVoices` map for fish-audio since a reference clone is already
// voice+language-specific).

/**
 * Resolve the effective reference ID.
 *
 * Priority: request-level `voiceId` > config `referenceId`.
 */
function resolveReferenceId(
  request: TtsSynthesisRequest,
  config: TtsFishAudioProviderConfig,
): string {
  const referenceId = request.voiceId?.trim() || config.referenceId;
  if (!referenceId) {
    throw new FishAudioTtsError(
      "FISH_AUDIO_TTS_NO_REFERENCE_ID",
      "No Fish Audio reference ID provided. " +
        "Set services.tts.providers.fish-audio.referenceId in config or pass voiceId in the request.",
    );
  }
  return referenceId;
}

/**
 * Resolve the API key via the shared client resolver (secure store →
 * `FISH_AUDIO_API_KEY` env), converting an absence into the adapter's typed
 * configuration error so callers (live voice, daemon routes) can classify
 * it as a credential gap rather than a generic synthesis failure.
 */
async function resolveApiKey(): Promise<string> {
  try {
    return await resolveFishAudioApiKey();
  } catch (err) {
    throw new FishAudioTtsError(
      "FISH_AUDIO_TTS_NO_API_KEY",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Wrap an `onChunk` callback so every emitted chunk of 16-bit PCM is
 * 2-byte aligned.
 *
 * The network can split a sample across chunk boundaries; emitting an
 * odd-length chunk shifts every subsequent sample by one byte on the
 * player → progressive static. Any trailing odd byte is carried into the
 * next chunk. Call the returned `flush` after the stream ends to emit a
 * final dangling byte (should not happen for well-formed s16le, but must
 * not be silently dropped).
 */
function makePcmAlignedChunkForwarder(onChunk: (chunk: Uint8Array) => void): {
  forward: (chunk: Uint8Array) => void;
  flush: () => void;
} {
  let carry: Buffer | null = null;
  return {
    forward: (chunk: Uint8Array): void => {
      if (chunk.byteLength === 0) return;
      let buf = Buffer.from(chunk);
      if (carry) {
        buf = Buffer.concat([carry, buf]);
        carry = null;
      }
      const evenLen = buf.length - (buf.length % 2);
      if (buf.length % 2 === 1) {
        carry = Buffer.from([buf[buf.length - 1]!]);
      }
      const aligned = buf.subarray(0, evenLen);
      if (aligned.length > 0) onChunk(aligned);
    },
    flush: (): void => {
      if (carry && carry.length > 0) {
        onChunk(carry);
        carry = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export function createFishAudioProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "opus", "pcm"],
    // Fish Audio's raw-PCM output is fixed at 44.1 kHz mono s16le; the API
    // offers no rate parameter. Consumers labeling PCM frames must use this.
    pcmSampleRateHz: FISH_AUDIO_PCM_SAMPLE_RATE_HZ,
  };

  return {
    id: "fish-audio",
    capabilities,

    async synthesize(
      request: TtsSynthesisRequest,
    ): Promise<TtsSynthesisResult> {
      const config = getConfig().services.tts.providers["fish-audio"];
      const referenceId = resolveReferenceId(request, config);
      const apiKey = await resolveApiKey();

      // When PCM output is requested on the buffer path, override to WAV.
      // The phone media-stream transport (audioBufferToFrames) extracts the
      // PCM from the RIFF container and relies on the header being present.
      const effectiveFormat: FishAudioSynthesisConfig["format"] =
        request.outputFormat === "pcm" ? "wav" : config.format;

      const effectiveConfig: FishAudioSynthesisConfig = {
        ...config,
        referenceId,
        format: effectiveFormat,
      };

      log.info(
        {
          referenceId,
          format: effectiveFormat,
          textLength: request.text.length,
        },
        "Starting Fish Audio TTS synthesis",
      );

      let audio: Buffer;
      try {
        audio = await synthesizeWithFishAudio(request.text, effectiveConfig, {
          apiKey,
          signal: request.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new FishAudioTtsError(
          "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
          `Fish Audio TTS synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[effectiveFormat] ?? "audio/mpeg";

      return { audio, contentType };
    },

    async synthesizeStream(
      request: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<TtsSynthesisResult> {
      const config = getConfig().services.tts.providers["fish-audio"];
      const referenceId = resolveReferenceId(request, config);
      const apiKey = await resolveApiKey();

      // Streaming raw PCM lets live voice play each chunk as it arrives.
      // A WAV container would force the consumer to buffer the utterance
      // (the header cannot be re-parsed per chunk), so honour the "pcm"
      // hint with Fish Audio's true raw-PCM format here.
      const isPcm = request.outputFormat === "pcm";
      const effectiveFormat: FishAudioSynthesisConfig["format"] = isPcm
        ? "pcm"
        : config.format;

      const effectiveConfig: FishAudioSynthesisConfig = {
        ...config,
        referenceId,
        format: effectiveFormat,
      };

      log.info(
        {
          referenceId,
          format: effectiveFormat,
          textLength: request.text.length,
        },
        "Starting Fish Audio TTS streaming synthesis",
      );

      const aligner = isPcm ? makePcmAlignedChunkForwarder(onChunk) : null;

      let audio: Buffer;
      try {
        audio = await synthesizeWithFishAudio(request.text, effectiveConfig, {
          apiKey,
          onChunk: aligner ? aligner.forward : onChunk,
          signal: request.signal,
        });
        aligner?.flush();
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new FishAudioTtsError(
          "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
          `Fish Audio TTS streaming synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const contentType = FORMAT_CONTENT_TYPE[effectiveFormat] ?? "audio/mpeg";

      return { audio, contentType };
    },
  };
}
