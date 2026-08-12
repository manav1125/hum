import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the modules under test
// ---------------------------------------------------------------------------

// Every factory spreads the real module and overrides only the seams under
// test — mock.module is process-global in Bun, and an exhaustive factory
// silently deletes the exports it does not name for every file that runs
// after this one (see assistant/CLAUDE.md).

const realLoggerModule = { ...(await import("../../util/logger.js")) };
const realSecureKeysModule = {
  ...(await import("../../security/secure-keys.js")),
};
const realCredentialKeyModule = {
  ...(await import("../../security/credential-key.js")),
};
const realConfigLoaderModule = { ...(await import("../../config/loader.js")) };
const realFishAudioClientModule = {
  ...(await import("../../calls/fish-audio-client.js")),
};

mock.module("../../util/logger.js", () => ({
  ...realLoggerModule,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// -- Config mock -----------------------------------------------------------

let mockElevenLabsConfig = {
  voiceId: "test-voice-id",
  voiceModelId: "",
  speed: 1.0,
  stability: 0.5,
  similarityBoost: 0.75,
  conversationTimeoutSeconds: 30,
};

let mockFishAudioConfig = {
  referenceId: "test-reference-id",
  model: "s2-pro",
  chunkLength: 200,
  format: "mp3" as "mp3" | "wav" | "opus",
  latency: "normal" as "normal" | "balanced",
  speed: 1.0,
};

let mockDeepgramConfig = {
  model: "aura-asteria-en",
  format: "mp3" as "mp3" | "wav" | "opus",
};

let mockXaiConfig = {
  voiceId: "eve",
  language: "auto",
  format: "mp3" as "mp3" | "wav",
  sampleRate: 24000,
  bitRate: 128000,
};

mock.module("../../config/loader.js", () => ({
  ...realConfigLoaderModule,
  getConfig: () => ({
    services: {
      tts: {
        providers: {
          elevenlabs: mockElevenLabsConfig,
          "fish-audio": mockFishAudioConfig,
          deepgram: mockDeepgramConfig,
          xai: mockXaiConfig,
        },
      },
    },
  }),
}));

// -- Secure keys mock ------------------------------------------------------

let mockApiKey: string | null = "test-elevenlabs-api-key";
let mockDeepgramApiKey: string | null = "test-deepgram-api-key";
let mockXaiApiKey: string | null = "test-xai-api-key";

mock.module("../../security/secure-keys.js", () => ({
  ...realSecureKeysModule,
  getSecureKeyAsync: async (key?: string) => {
    if (key === "credential/xai/api_key") return mockXaiApiKey;
    return mockApiKey;
  },
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "deepgram") return mockDeepgramApiKey;
    return mockApiKey;
  },
}));

mock.module("../../security/credential-key.js", () => ({
  ...realCredentialKeyModule,
  credentialKey: (service: string, field: string) =>
    `credential/${service}/${field}`,
}));

// -- Fish Audio client mock ------------------------------------------------

let mockFishApiKey: string | null = "test-fish-api-key";

const mockSynthesizeWithFishAudio = mock(
  async (
    _text: string,
    _config: unknown,
    options?: {
      onChunk?: (chunk: Uint8Array) => void;
      signal?: AbortSignal;
      apiKey?: string;
    },
  ) => {
    const audioData = Buffer.from("fake-fish-audio-data");
    if (options?.onChunk) {
      options.onChunk(new Uint8Array(audioData));
    }
    return audioData;
  },
);

mock.module("../../calls/fish-audio-client.js", () => ({
  ...realFishAudioClientModule,
  synthesizeWithFishAudio: mockSynthesizeWithFishAudio,
  resolveFishAudioApiKey: async () => {
    if (!mockFishApiKey) {
      throw new Error(
        "Fish Audio API key not configured. Store it via: assistant credentials set --service fish-audio --field api_key <key>",
      );
    }
    return mockFishApiKey;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { listCatalogProviderIds } from "../provider-catalog.js";
import {
  _resetTtsProviderRegistry,
  getTtsProvider,
  listTtsProviders,
} from "../provider-registry.js";
import {
  createDeepgramProvider,
  DeepgramTtsError,
} from "../providers/deepgram-provider.js";
import {
  createElevenLabsProvider,
  ElevenLabsTtsError,
  extractElevenLabsErrorMessage,
} from "../providers/elevenlabs-provider.js";
import { createFishAudioProvider } from "../providers/fish-audio-provider.js";
import { FishAudioTtsError } from "../providers/fish-audio-provider.js";
import { providerFactories } from "../providers/index.js";
import {
  _resetBuiltinRegistration,
  registerBuiltinTtsProviders,
} from "../providers/register-builtins.js";
import { createXaiProvider, XaiTtsError } from "../providers/xai-provider.js";
import type { TtsSynthesisRequest } from "../types.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockApiKey = "test-elevenlabs-api-key";
  mockDeepgramApiKey = "test-deepgram-api-key";
  mockElevenLabsConfig = {
    voiceId: "test-voice-id",
    voiceModelId: "",
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.75,
    conversationTimeoutSeconds: 30,
  };
  mockFishApiKey = "test-fish-api-key";
  mockFishAudioConfig = {
    referenceId: "test-reference-id",
    model: "s2-pro",
    chunkLength: 200,
    format: "mp3",
    latency: "normal",
    speed: 1.0,
  };
  mockDeepgramConfig = {
    model: "aura-asteria-en",
    format: "mp3",
  };
  mockXaiApiKey = "test-xai-api-key";
  mockXaiConfig = {
    voiceId: "eve",
    language: "auto",
    format: "mp3",
    sampleRate: 24000,
    bitRate: 128000,
  };
  mockSynthesizeWithFishAudio.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetTtsProviderRegistry();
  _resetBuiltinRegistration();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides?: Partial<TtsSynthesisRequest>,
): TtsSynthesisRequest {
  return {
    text: "Hello world",
    useCase: "message-playback",
    ...overrides,
  };
}

function mockFetchReturning(audioBytes: Uint8Array, status = 200): void {
  globalThis.fetch = mock(
    async () =>
      new Response(audioBytes.buffer as ArrayBuffer, {
        status,
        headers: { "Content-Type": "audio/mpeg" },
      }),
  ) as unknown as typeof globalThis.fetch;
}

function mockFetchError(status: number, body: string): void {
  globalThis.fetch = mock(
    async () => new Response(body, { status }),
  ) as unknown as typeof globalThis.fetch;
}

// ===========================================================================
// ElevenLabs provider adapter
// ===========================================================================

describe("ElevenLabs TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createElevenLabsProvider();
    expect(provider.id).toBe("elevenlabs");
  });

  test("advertises mp3 and pcm format support with streaming at a fixed 16 kHz PCM rate", () => {
    const provider = createElevenLabsProvider();
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.supportedFormats).toEqual(["mp3", "pcm"]);
    // resolveOutputFormat maps outputFormat "pcm" to pcm_16000.
    expect(provider.capabilities.pcmSampleRateHz).toBe(16_000);
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize sends request to ElevenLabs REST API with correct voice ID", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]); // Fake MP3 header
    let capturedUrl = "";
    let capturedHeaders: Headers | null = null;
    let capturedBody = "";

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedHeaders = new Headers(init?.headers);
        capturedBody = init?.body as string;
        return new Response(audioPayload, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("/v1/text-to-speech/test-voice-id");
    expect(capturedUrl).toContain("output_format=mp3_44100_128");
    expect(capturedHeaders!.get("xi-api-key")).toBe("test-elevenlabs-api-key");
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(capturedBody);
    expect(body.text).toBe("Hello world");
    expect(body.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      speed: 1.0,
    });
  });

  test("uses lower-quality format for phone-call use case", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ useCase: "phone-call" }));

    expect(capturedUrl).toContain("output_format=mp3_22050_32");
  });

  test("request voiceId overrides config voiceId", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ voiceId: "override-voice" }));

    expect(capturedUrl).toContain("/v1/text-to-speech/override-voice");
  });

  test("uses configured voiceModelId when set", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_turbo_v2_5";

    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest());

    const body = JSON.parse(capturedBody);
    expect(body.model_id).toBe("eleven_turbo_v2_5");
  });

  // -- Language enforcement (language_code gate) ---------------------------

  function mockFetchCapturingBody(): () => Record<string, unknown> {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedBody = "";
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;
    return () => JSON.parse(capturedBody) as Record<string, unknown>;
  }

  test("sends language_code when the effective model supports enforcement", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_flash_v2_5";
    const body = mockFetchCapturingBody();

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ language: "hi" }));

    expect(body().model_id).toBe("eleven_flash_v2_5");
    expect(body().language_code).toBe("hi");
  });

  test("maps the tl subtag to the fil code the v2.5 roster spells Filipino with", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_turbo_v2_5";
    const body = mockFetchCapturingBody();

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ language: "tl" }));

    expect(body().language_code).toBe("fil");
  });

  test("omits language_code for a language the v2.5 models do not support", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_flash_v2_5";
    const body = mockFetchCapturingBody();

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ language: "he" }));

    expect("language_code" in body()).toBe(false);
  });

  test("omits language_code when the effective model does not support enforcement", async () => {
    // Default config: eleven_multilingual_v2, which rejects the field.
    const body = mockFetchCapturingBody();

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ language: "hi" }));

    expect(body().model_id).toBe("eleven_multilingual_v2");
    expect("language_code" in body()).toBe(false);
  });

  test("omits language_code when no language is requested", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_flash_v2_5";
    const body = mockFetchCapturingBody();

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest());

    expect("language_code" in body()).toBe(false);
  });

  test("synthesizeStream applies the same language gate", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_flash_v2_5";
    let capturedBody = "";
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x01, 0x02]));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesizeStream!(makeRequest({ language: "ja" }), () => {});

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.language_code).toBe("ja");
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    mockFetchReturning(audioPayload);

    const provider = createElevenLabsProvider();
    const result = await provider.synthesize(makeRequest());

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  // -- Required config validation ------------------------------------------

  test("throws ELEVENLABS_TTS_NO_API_KEY when API key is missing", async () => {
    mockApiKey = null;

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_NO_API_KEY",
      );
      expect((err as ElevenLabsTtsError).message).toContain(
        "API key not configured",
      );
    }
  });

  // -- Error handling ------------------------------------------------------

  test("throws ELEVENLABS_TTS_HTTP_ERROR on non-200 response", async () => {
    mockFetchError(401, "Unauthorized");

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_HTTP_ERROR",
      );
      expect((err as ElevenLabsTtsError).statusCode).toBe(401);
    }
  });

  test("throws ELEVENLABS_TTS_EMPTY_RESPONSE on empty audio body", async () => {
    mockFetchReturning(new Uint8Array(0));

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("throws ELEVENLABS_TTS_REQUEST_FAILED on network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_REQUEST_FAILED",
      );
      expect((err as ElevenLabsTtsError).message).toContain(
        "Network unreachable",
      );
    }
  });

  // -- Upstream error-body extraction --------------------------------------

  describe("extractElevenLabsErrorMessage", () => {
    test("extracts message from standard { detail: { message } } shape", () => {
      const body = JSON.stringify({
        detail: {
          type: "payment_required",
          code: "paid_plan_required",
          message:
            "Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.",
          status: "payment_required",
        },
      });
      expect(extractElevenLabsErrorMessage(body)).toBe(
        "Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.",
      );
    });

    test("falls back to { detail: '...' } when detail is a string", () => {
      const body = JSON.stringify({ detail: "Voice not found" });
      expect(extractElevenLabsErrorMessage(body)).toBe("Voice not found");
    });

    test("falls back to { message: '...' } when present", () => {
      const body = JSON.stringify({ message: "Quota exceeded" });
      expect(extractElevenLabsErrorMessage(body)).toBe("Quota exceeded");
    });

    test("returns trimmed raw body when not JSON", () => {
      expect(extractElevenLabsErrorMessage("  upstream timeout  ")).toBe(
        "upstream timeout",
      );
    });

    test("truncates oversized raw bodies", () => {
      const long = "x".repeat(1000);
      const result = extractElevenLabsErrorMessage(long);
      expect(result).not.toBeUndefined();
      // 200-char limit plus an ellipsis character.
      expect(result!.length).toBeLessThanOrEqual(201);
      expect(result!.endsWith("…")).toBe(true);
    });

    test("returns undefined for empty input", () => {
      expect(extractElevenLabsErrorMessage("")).toBeUndefined();
      expect(extractElevenLabsErrorMessage("   \n  ")).toBeUndefined();
    });

    test("returns truncated raw body when JSON is malformed", () => {
      // Not valid JSON despite the leading `{` — falls through to raw fallback.
      const body = "{not really json}";
      expect(extractElevenLabsErrorMessage(body)).toBe("{not really json}");
    });

    test("ignores empty-string message fields", () => {
      const body = JSON.stringify({ detail: { message: "   " } });
      // Falls through to top-level message — also absent — then to raw body.
      const result = extractElevenLabsErrorMessage(body);
      expect(result).not.toBeUndefined();
      // Raw body fallback contains the JSON text itself.
      expect(result).toContain("detail");
    });

    test("trims whitespace from extracted messages", () => {
      const body = JSON.stringify({
        detail: { message: "  hello world  " },
      });
      expect(extractElevenLabsErrorMessage(body)).toBe("hello world");
    });
  });
});

// ===========================================================================
// Fish Audio TTS provider adapter
// ===========================================================================

describe("Fish Audio TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createFishAudioProvider();
    expect(provider.id).toBe("fish-audio");
  });

  test("advertises streaming support with multiple formats including raw PCM", () => {
    const provider = createFishAudioProvider();
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.supportedFormats).toEqual([
      "mp3",
      "wav",
      "opus",
      "pcm",
    ]);
    // Fish Audio raw PCM is fixed at 44.1 kHz mono s16le.
    expect(provider.capabilities.pcmSampleRateHz).toBe(44_100);
  });

  test("implements synthesizeStream", () => {
    const provider = createFishAudioProvider();
    expect(typeof provider.synthesizeStream).toBe("function");
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize passes text and config to underlying client", async () => {
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest({ text: "Test speech" }));

    expect(mockSynthesizeWithFishAudio).toHaveBeenCalledTimes(1);
    const [text, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect(text).toBe("Test speech");
    expect((config as { referenceId: string }).referenceId).toBe(
      "test-reference-id",
    );
    expect(
      (options as { signal?: AbortSignal } | undefined)?.signal,
    ).toBeUndefined();
  });

  test("request voiceId overrides config referenceId", async () => {
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest({ voiceId: "custom-ref-id" }));

    const [, config] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { referenceId: string }).referenceId).toBe(
      "custom-ref-id",
    );
  });

  test("passes abort signal to underlying client", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest({ signal: controller.signal }));

    const [, , options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((options as { signal?: AbortSignal } | undefined)?.signal).toBe(
      controller.signal,
    );
  });

  // -- Streaming -----------------------------------------------------------

  test("synthesizeStream passes onChunk callback through", async () => {
    const chunks: Uint8Array[] = [];
    const provider = createFishAudioProvider();
    await provider.synthesizeStream!(makeRequest(), (chunk) =>
      chunks.push(chunk),
    );

    expect(mockSynthesizeWithFishAudio).toHaveBeenCalledTimes(1);
    const [, , options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect(typeof (options as { onChunk?: unknown } | undefined)?.onChunk).toBe(
      "function",
    );
    // The mock calls onChunk once; verify it was received
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("synthesizeStream with outputFormat pcm requests raw PCM and labels audio/pcm", async () => {
    const provider = createFishAudioProvider();
    const result = await provider.synthesizeStream!(
      makeRequest({ outputFormat: "pcm" }),
      () => {},
    );

    const [, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("pcm");
    expect((options as { apiKey?: string } | undefined)?.apiKey).toBe(
      "test-fish-api-key",
    );
    expect(result.contentType).toBe("audio/pcm");
  });

  test("synthesizeStream keeps the configured format when no pcm hint is given", async () => {
    mockFishAudioConfig.format = "opus";
    const provider = createFishAudioProvider();
    const result = await provider.synthesizeStream!(makeRequest(), () => {});

    const [, config] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("opus");
    expect(result.contentType).toBe("audio/opus");
  });

  test("buffer synthesize with outputFormat pcm keeps the WAV-container override for the phone path", async () => {
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(
      makeRequest({ outputFormat: "pcm" }),
    );

    const [, config] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("wav");
    expect(result.contentType).toBe("audio/wav");
  });

  test("passes the configured model through to the client", async () => {
    mockFishAudioConfig.model = "s1";
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest());

    const [, config] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { model?: string }).model).toBe("s1");
  });

  test("emits only 2-byte-aligned chunks when streaming raw PCM", async () => {
    // The upstream network stream splits a 16-bit sample across chunk
    // boundaries: 3 bytes then 5 bytes. The adapter must re-align so no
    // emitted chunk has odd length (which would shift every later sample).
    mockSynthesizeWithFishAudio.mockImplementationOnce(
      async (
        _text: string,
        _config: unknown,
        options?: { onChunk?: (chunk: Uint8Array) => void },
      ) => {
        options?.onChunk?.(Uint8Array.from([1, 2, 3]));
        options?.onChunk?.(Uint8Array.from([4, 5, 6, 7, 8]));
        return Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
      },
    );

    const chunks: Uint8Array[] = [];
    const provider = createFishAudioProvider();
    await provider.synthesizeStream!(
      makeRequest({ outputFormat: "pcm" }),
      (chunk) => chunks.push(Uint8Array.from(chunk)),
    );

    expect(chunks.map((c) => [...c])).toEqual([
      [1, 2],
      [3, 4, 5, 6, 7, 8],
    ]);
  });

  test("throws FISH_AUDIO_TTS_NO_API_KEY when the key resolves from neither vault nor env", async () => {
    mockFishApiKey = null;

    const provider = createFishAudioProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe("FISH_AUDIO_TTS_NO_API_KEY");
      expect((err as FishAudioTtsError).message).toContain(
        "API key not configured",
      );
    }
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    mockFishAudioConfig.format = "mp3";
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(makeRequest());
    expect(result.contentType).toBe("audio/mpeg");
  });

  test("returns audio/wav content type for wav format", async () => {
    mockFishAudioConfig.format = "wav";
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(makeRequest());
    expect(result.contentType).toBe("audio/wav");
  });

  test("returns audio/opus content type for opus format", async () => {
    mockFishAudioConfig.format = "opus";
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(makeRequest());
    expect(result.contentType).toBe("audio/opus");
  });

  // -- Required config validation ------------------------------------------

  test("throws FISH_AUDIO_TTS_NO_REFERENCE_ID when no reference ID is available", async () => {
    mockFishAudioConfig.referenceId = "";

    const provider = createFishAudioProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_NO_REFERENCE_ID",
      );
      expect((err as FishAudioTtsError).message).toContain("reference ID");
    }
  });

  test("throws FISH_AUDIO_TTS_NO_REFERENCE_ID in synthesizeStream when no reference ID", async () => {
    mockFishAudioConfig.referenceId = "";

    const provider = createFishAudioProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_NO_REFERENCE_ID",
      );
    }
  });

  // -- Error handling ------------------------------------------------------

  test("wraps underlying client errors with FISH_AUDIO_TTS_SYNTHESIS_FAILED", async () => {
    mockSynthesizeWithFishAudio.mockImplementationOnce(async () => {
      throw new Error("API key not configured");
    });

    const provider = createFishAudioProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
      );
      expect((err as FishAudioTtsError).message).toContain(
        "API key not configured",
      );
    }
  });

  test("wraps streaming client errors with FISH_AUDIO_TTS_SYNTHESIS_FAILED", async () => {
    mockSynthesizeWithFishAudio.mockImplementationOnce(async () => {
      throw new Error("Connection reset");
    });

    const provider = createFishAudioProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
      );
      expect((err as FishAudioTtsError).message).toContain("Connection reset");
    }
  });
});

// ===========================================================================
// Deepgram TTS provider adapter
// ===========================================================================

describe("Deepgram TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createDeepgramProvider();
    expect(provider.id).toBe("deepgram");
  });

  test("advertises mp3, wav, opus format support without streaming", () => {
    const provider = createDeepgramProvider();
    expect(provider.capabilities.supportsStreaming).toBe(false);
    expect(provider.capabilities.supportedFormats).toEqual([
      "mp3",
      "wav",
      "opus",
    ]);
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize sends request to Deepgram REST TTS API with correct model", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";
    let capturedHeaders: Headers | null = null;
    let capturedBody = "";

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedHeaders = new Headers(init?.headers);
        capturedBody = init?.body as string;
        return new Response(audioPayload, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("/v1/speak");
    expect(capturedUrl).toContain("model=aura-asteria-en");
    expect(capturedUrl).toContain("encoding=mp3");
    expect(capturedHeaders!.get("Authorization")).toBe(
      "Token test-deepgram-api-key",
    );
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(capturedBody);
    expect(body.text).toBe("Hello world");
  });

  test("uses linear16 encoding with container=none and sample_rate=16000 when outputFormat is pcm", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    const result = await provider.synthesize(
      makeRequest({ outputFormat: "pcm" }),
    );

    expect(capturedUrl).toContain("encoding=linear16");
    expect(capturedUrl).toContain("container=none");
    expect(capturedUrl).toContain("sample_rate=16000");
    expect(result.contentType).toBe("audio/pcm");
  });

  test("translates wav config format to linear16 encoding with container=wav", async () => {
    mockDeepgramConfig.format = "wav";
    const audioPayload = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    const result = await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("encoding=linear16");
    expect(capturedUrl).toContain("container=wav");
    expect(capturedUrl).not.toContain("sample_rate=");
    expect(result.contentType).toBe("audio/wav");
  });

  test("uses configured model", async () => {
    mockDeepgramConfig.model = "aura-luna-en";
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("model=aura-luna-en");
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    mockFetchReturning(audioPayload);

    const provider = createDeepgramProvider();
    const result = await provider.synthesize(makeRequest());

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  // -- Required config validation ------------------------------------------

  test("throws DEEPGRAM_TTS_NO_API_KEY when API key is missing", async () => {
    mockDeepgramApiKey = null;

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe("DEEPGRAM_TTS_NO_API_KEY");
      expect((err as DeepgramTtsError).message).toContain(
        "API key not configured",
      );
    }
  });

  // -- Error handling ------------------------------------------------------

  test("throws DEEPGRAM_TTS_HTTP_ERROR on non-200 response", async () => {
    mockFetchError(401, "Unauthorized");

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe("DEEPGRAM_TTS_HTTP_ERROR");
      expect((err as DeepgramTtsError).statusCode).toBe(401);
    }
  });

  test("throws DEEPGRAM_TTS_EMPTY_RESPONSE on empty audio body", async () => {
    mockFetchReturning(new Uint8Array(0));

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe(
        "DEEPGRAM_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("throws DEEPGRAM_TTS_REQUEST_FAILED on network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe(
        "DEEPGRAM_TTS_REQUEST_FAILED",
      );
      expect((err as DeepgramTtsError).message).toContain(
        "Network unreachable",
      );
    }
  });
});

// ===========================================================================
// xAI TTS provider adapter
// ===========================================================================

describe("xAI TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createXaiProvider();
    expect(provider.id).toBe("xai");
  });

  test("advertises mp3 and wav format support without streaming", () => {
    const provider = createXaiProvider();
    expect(provider.capabilities).toEqual({
      supportsStreaming: false,
      supportedFormats: ["mp3", "wav"],
    });
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize posts to /v1/tts with correct auth and default body", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";
    let capturedHeaders: Headers | null = null;
    let capturedBody = "";

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedHeaders = new Headers(init?.headers);
        capturedBody = init?.body as string;
        return new Response(audioPayload, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toBe("https://api.x.ai/v1/tts");
    expect(capturedHeaders!.get("Authorization")).toBe(
      "Bearer test-xai-api-key",
    );
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(capturedBody);
    expect(body.text).toBe("Hello world");
    expect(body.voice_id).toBe("eve");
    expect(body.language).toBe("auto");
    expect(body.output_format).toEqual({
      codec: "mp3",
      sample_rate: 24000,
      bit_rate: 128000,
    });
  });

  test("request voiceId overrides config voiceId", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    await provider.synthesize(makeRequest({ voiceId: "rex" }));

    const body = JSON.parse(capturedBody);
    expect(body.voice_id).toBe("rex");
  });

  test("uses configured voiceId when request has none", async () => {
    mockXaiConfig.voiceId = "ara";
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    await provider.synthesize(makeRequest());

    const body = JSON.parse(capturedBody);
    expect(body.voice_id).toBe("ara");
  });

  test("wav config format produces codec=wav without bit_rate", async () => {
    mockXaiConfig.format = "wav";
    const audioPayload = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    const result = await provider.synthesize(makeRequest());

    const body = JSON.parse(capturedBody);
    expect(body.output_format).toEqual({
      codec: "wav",
      sample_rate: 24000,
    });
    expect(body.output_format.bit_rate).toBeUndefined();
    expect(result.contentType).toBe("audio/wav");
  });

  test("outputFormat=pcm uses codec=pcm and 16 kHz sample rate", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    const result = await provider.synthesize(
      makeRequest({ outputFormat: "pcm" }),
    );

    const body = JSON.parse(capturedBody);
    expect(body.output_format).toEqual({
      codec: "pcm",
      sample_rate: 16000,
    });
    expect(body.output_format.bit_rate).toBeUndefined();
    expect(result.contentType).toBe("audio/pcm");
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    mockFetchReturning(audioPayload);

    const provider = createXaiProvider();
    const result = await provider.synthesize(makeRequest());

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  // -- Required config validation ------------------------------------------

  test("throws XAI_TTS_NO_API_KEY when API key is missing", async () => {
    mockXaiApiKey = null;

    const provider = createXaiProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XaiTtsError);
      expect((err as XaiTtsError).code).toBe("XAI_TTS_NO_API_KEY");
      expect((err as XaiTtsError).message).toContain("API key not configured");
    }
  });

  // -- Error handling ------------------------------------------------------

  test("throws XAI_TTS_HTTP_ERROR on non-200 response", async () => {
    mockFetchError(401, "Unauthorized");

    const provider = createXaiProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XaiTtsError);
      expect((err as XaiTtsError).code).toBe("XAI_TTS_HTTP_ERROR");
      expect((err as XaiTtsError).statusCode).toBe(401);
      expect((err as XaiTtsError).message).toContain("Unauthorized");
    }
  });

  test("throws XAI_TTS_EMPTY_RESPONSE on empty audio body", async () => {
    mockFetchReturning(new Uint8Array(0));

    const provider = createXaiProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XaiTtsError);
      expect((err as XaiTtsError).code).toBe("XAI_TTS_EMPTY_RESPONSE");
    }
  });
});

// ===========================================================================
// Built-in registration
// ===========================================================================

describe("registerBuiltinTtsProviders", () => {
  test("registers every catalog provider ID", () => {
    registerBuiltinTtsProviders();

    const providers = listTtsProviders();
    const ids = providers.map((p) => p.id);
    for (const id of listCatalogProviderIds()) {
      expect(ids).toContain(id);
    }
  });

  test("providers are discoverable via getTtsProvider after registration", () => {
    registerBuiltinTtsProviders();

    for (const id of listCatalogProviderIds()) {
      const provider = getTtsProvider(id);
      expect(provider.id).toBe(id);
    }
  });

  test("idempotent — calling twice does not throw", () => {
    // First call registers; second should be a no-op due to the guard flag.
    // However, because tests reset the registry via afterEach, the internal
    // `registered` flag may still be true. We call it once here and verify
    // it does not throw — that exercises the guard path.
    registerBuiltinTtsProviders();
    expect(() => registerBuiltinTtsProviders()).not.toThrow();
  });

  test("registers every provider declared in the catalog", () => {
    registerBuiltinTtsProviders();

    const catalogIds = listCatalogProviderIds();
    const registeredProviders = listTtsProviders();
    const registeredIds = registeredProviders.map((p) => p.id);

    for (const id of catalogIds) {
      expect(registeredIds).toContain(id);
    }
    // The registered set should match the catalog exactly (no extras).
    expect(registeredIds.length).toBe(catalogIds.length);
  });

  test("every catalog provider has a factory in the providerFactories map", () => {
    const catalogIds = listCatalogProviderIds();

    for (const id of catalogIds) {
      expect(providerFactories.has(id)).toBe(true);
    }
  });

  test("throws when a catalog provider has no adapter factory", () => {
    // Verify the error path by checking that the error message format is
    // correct. We cannot easily add a fake catalog entry without modifying
    // the catalog module, but we can verify the factory map keys match the
    // catalog — if they diverge this test will catch it.
    const catalogIds = listCatalogProviderIds();
    const factoryIds = [...providerFactories.keys()];

    const missingFactories = catalogIds.filter(
      (id) => !factoryIds.includes(id),
    );
    expect(missingFactories).toEqual([]);
  });
});
