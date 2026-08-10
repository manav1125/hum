/**
 * Tests for the live-voice credential-readiness preflight resolver (WS-E).
 *
 * The resolver combines an STT-streaming verdict and a TTS
 * catalog/registry/secret verdict into one ready / not-ready result. Each leaf
 * dependency is mocked so the *combination* logic is exercised in isolation —
 * without booting the config store or the TTS provider registry.
 *
 * `mock.module` is process-global in Bun and leaks into sibling files that run
 * later in the same `bun test` invocation, so every stub delegates to the real
 * implementation unless this file's tests are active (`preflightMocksActive`,
 * toggled in beforeAll/afterAll). The real exports are snapshotted into plain
 * objects NOW, before the stubs register — a module namespace is a live view,
 * so reading a real export after the stub installs would resolve back to the
 * stub (infinite recursion).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

let preflightMocksActive = false;

const realResolveModule = {
  ...(await import("../../providers/speech-to-text/resolve.js")),
};
const realSecureKeysModule = {
  ...(await import("../../security/secure-keys.js")),
};
const realTtsConfigModule = {
  ...(await import("../../tts/tts-config-resolver.js")),
};
const realCatalogModule = {
  ...(await import("../../tts/provider-catalog.js")),
};
const realRegistryModule = {
  ...(await import("../../tts/provider-registry.js")),
};
const realLoaderModule = {
  ...(await import("../../config/loader.js")),
};

// -- Mutable stub state --------------------------------------------------------

import type { ConversationStreamingSttCapability } from "../../providers/speech-to-text/resolve.js";

let sttCapability: ConversationStreamingSttCapability;
let sttConfiguredProvider: string;
let ttsProviderId: string;
let ttsProviderConfig: Record<string, unknown>;
let ttsSupportsStreaming: boolean;
let ttsKeys: Record<string, string>;
// Catalog entries by id; a missing id makes getCatalogProvider "throw"
// (unknown provider) exactly as the real catalog does.
let ttsCatalog: Record<
  string,
  {
    id: string;
    secretRequirements: { credentialStoreKey: string; displayName: string }[];
  }
>;

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  ...realResolveModule,
  resolveConversationStreamingSttCapability: async () =>
    preflightMocksActive
      ? sttCapability
      : realResolveModule.resolveConversationStreamingSttCapability(),
}));

mock.module("../../security/secure-keys.js", () => ({
  ...realSecureKeysModule,
  getSecureKeyAsync: async (account: string) =>
    preflightMocksActive
      ? ttsKeys[account]
      : realSecureKeysModule.getSecureKeyAsync(account),
}));

mock.module("../../tts/tts-config-resolver.js", () => ({
  ...realTtsConfigModule,
  resolveTtsConfig: () =>
    preflightMocksActive
      ? { provider: ttsProviderId, providerConfig: ttsProviderConfig }
      : realTtsConfigModule.resolveTtsConfig(realLoaderModule.getConfig()),
}));

mock.module("../../tts/provider-catalog.js", () => ({
  ...realCatalogModule,
  getCatalogProvider: (id: string) => {
    if (!preflightMocksActive) return realCatalogModule.getCatalogProvider(id);
    const entry = ttsCatalog[id];
    if (!entry) throw new Error(`unknown tts provider "${id}"`);
    return entry;
  },
}));

mock.module("../../tts/provider-registry.js", () => ({
  ...realRegistryModule,
  getTtsProvider: (id: string) => {
    if (!preflightMocksActive) return realRegistryModule.getTtsProvider(id);
    return {
      capabilities: { supportsStreaming: ttsSupportsStreaming },
      synthesizeStream: ttsSupportsStreaming ? () => {} : undefined,
    };
  },
}));

mock.module("../../config/loader.js", () => ({
  ...realLoaderModule,
  getConfig: () =>
    preflightMocksActive
      ? ({
          services: { stt: { provider: sttConfiguredProvider } },
        } as ReturnType<typeof realLoaderModule.getConfig>)
      : realLoaderModule.getConfig(),
}));

import { resolveLiveVoiceCredentialReadiness } from "../live-voice-credential-preflight.js";

beforeAll(() => {
  preflightMocksActive = true;
});

afterAll(() => {
  preflightMocksActive = false;
});

beforeEach(() => {
  // Baseline: everything ready — a streaming STT provider with credentials
  // and the streaming-capable fish-audio TTS provider with a key + referenceId.
  sttConfiguredProvider = "deepgram";
  sttCapability = {
    status: "supported",
    providerId: "deepgram",
    streamingMode: "realtime-ws",
  };
  ttsProviderId = "fish-audio";
  ttsProviderConfig = { referenceId: "ref-123" };
  ttsSupportsStreaming = true;
  ttsKeys = { "credential/fish-audio/api_key": "test-key" };
  ttsCatalog = {
    "fish-audio": {
      id: "fish-audio",
      secretRequirements: [
        {
          credentialStoreKey: "credential/fish-audio/api_key",
          displayName: "Fish Audio API Key",
        },
      ],
    },
  };
});

function expectNotReady(
  readiness: Awaited<ReturnType<typeof resolveLiveVoiceCredentialReadiness>>,
) {
  expect(readiness.status).toBe("not-ready");
  if (readiness.status !== "not-ready") {
    throw new Error("expected not-ready");
  }
  return readiness;
}

describe("resolveLiveVoiceCredentialReadiness", () => {
  test("streaming STT + streaming TTS with credentials → ready", async () => {
    expect(await resolveLiveVoiceCredentialReadiness()).toEqual({
      status: "ready",
    });
  });

  test("STT missing credentials → not-ready with an stt entry naming the provider", async () => {
    sttCapability = {
      status: "missing-credentials",
      providerId: "deepgram",
      credentialProvider: "deepgram",
      reason: 'No API key configured for credential provider "deepgram"',
    };

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "deepgram",
        reason: 'No API key configured for credential provider "deepgram"',
      },
    ]);
    expect(readiness.userMessage).toContain('"deepgram"');
    expect(readiness.userMessage).toContain("speech-to-text");
  });

  test("unknown STT provider → not-ready with a catalog gap naming the configured id", async () => {
    sttConfiguredProvider = "acme-stt";
    sttCapability = {
      status: "unconfigured",
      reason: 'STT provider "acme-stt" is not in the provider catalog',
    };

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "acme-stt",
        reason: 'STT provider "acme-stt" is not in the provider catalog',
      },
    ]);
    expect(readiness.userMessage).toContain('"acme-stt"');
  });

  test("STT provider without conversation streaming → not-ready with a capability gap", async () => {
    sttCapability = {
      status: "unsupported",
      providerId: "openai-whisper",
      reason:
        'STT provider "openai-whisper" does not support conversation streaming',
    };

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "openai-whisper",
        reason:
          'STT provider "openai-whisper" does not support conversation streaming',
      },
    ]);
    expect(readiness.userMessage).toContain("live transcription");
  });

  test("non-streaming TTS provider → not-ready with a tts entry naming the provider", async () => {
    ttsProviderId = "xai";
    ttsSupportsStreaming = false;
    ttsKeys = { "credential/xai/api_key": "test-key" };
    ttsCatalog = {
      xai: {
        id: "xai",
        secretRequirements: [
          {
            credentialStoreKey: "credential/xai/api_key",
            displayName: "xAI API Key",
          },
        ],
      },
    };

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "xai",
        reason: 'TTS provider "xai" does not support streaming synthesis',
      },
    ]);
    expect(readiness.userMessage).toContain('"xai"');
    expect(readiness.userMessage).toContain("streaming synthesis");
  });

  test("streaming TTS provider missing credentials → not-ready naming the missing key", async () => {
    ttsKeys = {};

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "fish-audio",
        reason:
          'TTS provider "fish-audio" is missing credentials (Fish Audio API Key)',
      },
    ]);
    expect(readiness.userMessage).toContain('"fish-audio"');
    expect(readiness.userMessage).toContain("text-to-speech");
    expect(readiness.userMessage).toContain("Fish Audio API Key");
  });

  test("fish-audio keyed but referenceId-less → not-ready naming the reference ID", async () => {
    ttsProviderConfig = {};

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "fish-audio",
        reason:
          'TTS provider "fish-audio" has no Fish Audio reference ID configured (services.tts.providers.fish-audio.referenceId)',
      },
    ]);
    expect(readiness.userMessage).toContain("Fish Audio voice reference ID");
    expect(readiness.userMessage).toContain(
      "services.tts.providers.fish-audio.referenceId",
    );
  });

  test("unknown TTS provider → not-ready with a catalog gap naming the configured id", async () => {
    ttsProviderId = "acme-tts";
    ttsCatalog = {};

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "acme-tts",
        reason: 'TTS provider "acme-tts" is not in the provider catalog',
      },
    ]);
    expect(readiness.userMessage).toContain('"acme-tts"');
  });

  test("both STT and TTS missing → both entries, message names both providers, one sentence", async () => {
    sttCapability = {
      status: "missing-credentials",
      providerId: "deepgram",
      credentialProvider: "deepgram",
      reason: 'No API key configured for credential provider "deepgram"',
    };
    ttsKeys = {};

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing.map((gap) => gap.kind)).toEqual(["stt", "tts"]);
    expect(readiness.userMessage).toContain('"deepgram"');
    expect(readiness.userMessage).toContain('"fish-audio"');
    // Single sentence: suitable for the client `error` frame.
    expect(readiness.userMessage).not.toContain("\n");
    expect(readiness.userMessage.endsWith(".")).toBe(true);
  });

  test("a TTS key absent from the vault but present in env → ready (the adapter's own fallback)", async () => {
    // Containerized self-host wipes the credential store on restart; the
    // provider adapters fall back to env at synth time. The preflight must
    // not refuse a session the adapter would serve.
    ttsKeys = {};
    process.env.FISH_AUDIO_API_KEY = "env-key";
    try {
      expect(await resolveLiveVoiceCredentialReadiness()).toEqual({
        status: "ready",
      });
    } finally {
      delete process.env.FISH_AUDIO_API_KEY;
    }
  });

  test("a TTS key absent from vault AND env → not-ready", async () => {
    ttsKeys = {};
    delete process.env.FISH_AUDIO_API_KEY;
    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing.map((gap) => gap.kind)).toEqual(["tts"]);
  });
});
