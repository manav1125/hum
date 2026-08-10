import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("fish-audio-client");

/** Timeout waiting for the first chunk from Fish Audio (ms). */
const FIRST_CHUNK_TIMEOUT_MS = 10_000;

/** Timeout waiting between consecutive chunks (ms). */
const IDLE_TIMEOUT_MS = 5_000;

/**
 * Default Fish Audio TTS model. Matches the model the phone-call path has
 * always requested — override per-workspace via
 * `services.tts.providers.fish-audio.model`.
 */
export const DEFAULT_FISH_AUDIO_MODEL = "s2-pro";

/**
 * Sample rate of Fish Audio raw-PCM output.
 *
 * Fish Audio's `format: "pcm"` is fixed by their API: 44.1 kHz, mono,
 * 16-bit signed little-endian. Consumers that label PCM frames (e.g. the
 * live-voice transport) must use this value — the API offers no way to
 * request a different rate.
 */
export const FISH_AUDIO_PCM_SAMPLE_RATE_HZ = 44_100;

/** Output formats accepted by the Fish Audio `/v1/tts` endpoint. */
export type FishAudioSynthesisFormat = "mp3" | "wav" | "opus" | "pcm";

/**
 * Synthesis parameters for {@link synthesizeWithFishAudio}.
 *
 * Structurally compatible with both the legacy `fishAudio.*` config block
 * (`FishAudioConfig`) and the canonical
 * `services.tts.providers.fish-audio` block — those declare a narrower
 * `format` union (no `"pcm"`; raw PCM is a runtime override used by the
 * live-voice transport, not a user-facing config value).
 */
export interface FishAudioSynthesisConfig {
  /** Fish Audio voice/clone reference ID. */
  referenceId: string;
  /** Text chunk size for streaming synthesis. */
  chunkLength: number;
  /** Output audio format. */
  format: FishAudioSynthesisFormat;
  /** Latency/quality tradeoff. */
  latency: "normal" | "balanced";
  /** Playback speed multiplier. */
  speed: number;
  /**
   * Fish Audio TTS model identifier (e.g. `"s2-pro"`, `"s1"`).
   * Defaults to {@link DEFAULT_FISH_AUDIO_MODEL} when absent/empty.
   */
  model?: string;
}

// ---------------------------------------------------------------------------
// API-key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Fish Audio API key: secure store first, then the
 * `FISH_AUDIO_API_KEY` process env (durable across restarts on containerized
 * self-host, where the credential store is wiped). Throws when absent.
 *
 * The env leg must stay in sync with the live-voice credential preflight
 * (`ttsSecretResolves`), which accepts either source — the preflight must
 * never pass a session that synthesis would then fail.
 */
export async function resolveFishAudioApiKey(): Promise<string> {
  const apiKey =
    (await getSecureKeyAsync(credentialKey("fish-audio", "api_key"))) ||
    process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Fish Audio API key not configured. Store it via: assistant credentials set --service fish-audio --field api_key <key>",
    );
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Fish Audio REST API (POST /v1/tts)
// ---------------------------------------------------------------------------

interface SynthesizeOptions {
  onChunk?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  /**
   * Pre-resolved API key. When absent the client resolves it itself via
   * {@link resolveFishAudioApiKey} (secure store → `FISH_AUDIO_API_KEY` env).
   */
  apiKey?: string;
}

/**
 * Synthesize text to audio using the Fish Audio REST API. Streams audio
 * chunks via the optional `onChunk` callback as they arrive from the
 * server's chunked transfer-encoded response. Returns the complete audio
 * buffer when the response finishes.
 *
 * Pass an `AbortSignal` to cancel in-flight synthesis (e.g. on barge-in).
 */
export async function synthesizeWithFishAudio(
  text: string,
  config: FishAudioSynthesisConfig,
  options?: SynthesizeOptions,
): Promise<Buffer> {
  const apiKey = options?.apiKey || (await resolveFishAudioApiKey());

  const body = {
    text,
    reference_id: config.referenceId || undefined,
    model: config.model?.trim() || DEFAULT_FISH_AUDIO_MODEL,
    format: config.format,
    mp3_bitrate: 192,
    chunk_length: config.chunkLength,
    normalize: true,
    latency: config.latency,
    temperature: 1.0,
    prosody: config.speed !== 1.0 ? { speed: config.speed } : undefined,
  };

  log.info(
    {
      referenceId: config.referenceId,
      model: body.model,
      format: config.format,
      textLength: text.length,
    },
    "Starting Fish Audio synthesis",
  );

  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fish Audio API error (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Fish Audio API returned no body");
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let isFirstChunk = true;

  try {
    while (true) {
      const timeoutMs = isFirstChunk ? FIRST_CHUNK_TIMEOUT_MS : IDLE_TIMEOUT_MS;
      let timerId: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () =>
            reject(new Error(`Fish Audio read timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await Promise.race([reader.read(), timeout]));
      } finally {
        clearTimeout(timerId!);
      }
      if (done) break;
      if (value) {
        isFirstChunk = false;
        chunks.push(value);
        options?.onChunk?.(value);
      }
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      /* Ignore cancellation errors */
    }
    throw err;
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  log.debug({ bytes: totalLength }, "Fish Audio synthesis complete");
  return Buffer.from(merged);
}
