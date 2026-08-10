/**
 * Tests for the Fish Audio HTTP client.
 *
 * Covers the live-voice-critical contract:
 * - API-key resolution order: secure store → `FISH_AUDIO_API_KEY` env →
 *   clear error (the preflight accepts both sources, so the client must too —
 *   a vault-only client passes preflight on env-only hosts and then fails at
 *   synth time, producing a mute session).
 * - Streaming: response-body chunks are forwarded to `onChunk` in arrival
 *   order and the returned buffer is their concatenation.
 * - Request body: model naming (default `s2-pro`, config override) and the
 *   raw-PCM format pass-through used by live voice.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real module and override only the seams under test —
// mock.module is process-global in Bun (see assistant/CLAUDE.md).
const realSecureKeysModule = {
  ...(await import("../../security/secure-keys.js")),
};

let mockVaultKey: string | null = null;

mock.module("../../security/secure-keys.js", () => ({
  ...realSecureKeysModule,
  getSecureKeyAsync: async (account?: string) => {
    if (account === "credential/fish-audio/api_key") return mockVaultKey;
    return realSecureKeysModule.getSecureKeyAsync(account as string);
  },
}));

import {
  DEFAULT_FISH_AUDIO_MODEL,
  FISH_AUDIO_PCM_SAMPLE_RATE_HZ,
  type FishAudioSynthesisConfig,
  resolveFishAudioApiKey,
  synthesizeWithFishAudio,
} from "../fish-audio-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let originalEnvKey: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnvKey = process.env.FISH_AUDIO_API_KEY;
  delete process.env.FISH_AUDIO_API_KEY;
  mockVaultKey = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvKey === undefined) {
    delete process.env.FISH_AUDIO_API_KEY;
  } else {
    process.env.FISH_AUDIO_API_KEY = originalEnvKey;
  }
});

function makeConfig(
  overrides: Partial<FishAudioSynthesisConfig> = {},
): FishAudioSynthesisConfig {
  return {
    referenceId: "ref-123",
    chunkLength: 200,
    format: "mp3",
    latency: "normal",
    speed: 1.0,
    ...overrides,
  };
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * Install a fetch fake that streams `chunks` back one read at a time and
 * records the outgoing request for assertions.
 */
function mockStreamingFetch(chunks: Uint8Array[]): CapturedRequest {
  const captured: CapturedRequest = {
    url: "",
    headers: new Headers(),
    body: {},
  };
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = typeof input === "string" ? input : input.toString();
      captured.headers = new Headers(init?.headers);
      captured.body = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    },
  ) as unknown as typeof globalThis.fetch;
  return captured;
}

// ---------------------------------------------------------------------------
// API-key resolution
// ---------------------------------------------------------------------------

describe("resolveFishAudioApiKey", () => {
  test("prefers the secure-store key", async () => {
    mockVaultKey = "vault-key";
    process.env.FISH_AUDIO_API_KEY = "env-key";
    expect(await resolveFishAudioApiKey()).toBe("vault-key");
  });

  test("falls back to FISH_AUDIO_API_KEY env when the vault is empty", async () => {
    mockVaultKey = null;
    process.env.FISH_AUDIO_API_KEY = "env-key";
    expect(await resolveFishAudioApiKey()).toBe("env-key");
  });

  test("throws a clear error when neither vault nor env has a key", async () => {
    await expect(resolveFishAudioApiKey()).rejects.toThrow(
      /Fish Audio API key not configured/,
    );
  });
});

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

describe("synthesizeWithFishAudio", () => {
  test("streams response chunks to onChunk in order and returns the concatenation", async () => {
    mockVaultKey = "vault-key";
    mockStreamingFetch([
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([4, 5]),
      Uint8Array.from([6]),
    ]);

    const received: number[][] = [];
    const audio = await synthesizeWithFishAudio("hello", makeConfig(), {
      onChunk: (chunk) => received.push([...chunk]),
    });

    expect(received).toEqual([[1, 2, 3], [4, 5], [6]]);
    expect([...audio]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("sends Bearer auth and the synthesis body to /v1/tts", async () => {
    mockVaultKey = "vault-key";
    const captured = mockStreamingFetch([Uint8Array.from([1])]);

    await synthesizeWithFishAudio("hello world", makeConfig());

    expect(captured.url).toBe("https://api.fish.audio/v1/tts");
    expect(captured.headers.get("Authorization")).toBe("Bearer vault-key");
    expect(captured.body.text).toBe("hello world");
    expect(captured.body.reference_id).toBe("ref-123");
    expect(captured.body.format).toBe("mp3");
    expect(captured.body.chunk_length).toBe(200);
    expect(captured.body.latency).toBe("normal");
  });

  test("uses the env-fallback key when the vault is empty", async () => {
    process.env.FISH_AUDIO_API_KEY = "env-key";
    const captured = mockStreamingFetch([Uint8Array.from([1])]);

    await synthesizeWithFishAudio("hi", makeConfig());

    expect(captured.headers.get("Authorization")).toBe("Bearer env-key");
  });

  test("a pre-resolved options.apiKey wins over vault and env", async () => {
    mockVaultKey = "vault-key";
    const captured = mockStreamingFetch([Uint8Array.from([1])]);

    await synthesizeWithFishAudio("hi", makeConfig(), {
      apiKey: "explicit-key",
    });

    expect(captured.headers.get("Authorization")).toBe("Bearer explicit-key");
  });

  test("throws the configuration error when no key resolves anywhere", async () => {
    mockStreamingFetch([Uint8Array.from([1])]);
    await expect(synthesizeWithFishAudio("hi", makeConfig())).rejects.toThrow(
      /Fish Audio API key not configured/,
    );
  });

  test("defaults the model to s2-pro (the phone path's historical model)", async () => {
    mockVaultKey = "vault-key";
    const captured = mockStreamingFetch([Uint8Array.from([1])]);

    await synthesizeWithFishAudio("hi", makeConfig());

    expect(DEFAULT_FISH_AUDIO_MODEL).toBe("s2-pro");
    expect(captured.body.model).toBe("s2-pro");
  });

  test("a configured model overrides the default", async () => {
    mockVaultKey = "vault-key";
    const captured = mockStreamingFetch([Uint8Array.from([1])]);

    await synthesizeWithFishAudio("hi", makeConfig({ model: "s1" }));

    expect(captured.body.model).toBe("s1");
  });

  test("passes the raw-PCM format through for live-voice streaming", async () => {
    mockVaultKey = "vault-key";
    const captured = mockStreamingFetch([Uint8Array.from([1, 2])]);

    await synthesizeWithFishAudio("hi", makeConfig({ format: "pcm" }));

    expect(captured.body.format).toBe("pcm");
    // Fish raw PCM is fixed-rate; the exported constant is what consumers
    // must label frames with.
    expect(FISH_AUDIO_PCM_SAMPLE_RATE_HZ).toBe(44_100);
  });

  test("throws with status and body on a non-200 response", async () => {
    mockVaultKey = "vault-key";
    globalThis.fetch = mock(
      async () => new Response("payment required", { status: 402 }),
    ) as unknown as typeof globalThis.fetch;

    await expect(synthesizeWithFishAudio("hi", makeConfig())).rejects.toThrow(
      /Fish Audio API error \(402\): payment required/,
    );
  });
});
