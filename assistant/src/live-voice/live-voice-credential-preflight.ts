/**
 * Live-voice credential-readiness preflight.
 *
 * A live voice session needs the daemon to run both audio legs: streaming
 * speech-to-text for the caller's audio, and streaming text-to-speech for the
 * assistant's audio. This resolver combines the two checks into a single
 * ready / not-ready verdict with a user-facing message suitable for the client
 * `error` frame, so a session fails at the `start` frame instead of falling
 * silent mid-conversation — the "Cue Live stops responding" failure class this
 * preflight exists to kill. It opens no live connections and performs no
 * session wiring — the session gates startup on the verdict.
 *
 * Adopted from upstream's voice cluster (WS-E), adapted to our fork's STT/TTS
 * stack (Deepgram STT + ElevenLabs TTS). The managed-speech ("vellum") leg is
 * intentionally dropped — that path is SaaS-only and not part of this fork.
 */

import { getConfig } from "../config/loader.js";
import { resolveConversationStreamingSttCapability } from "../providers/speech-to-text/resolve.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getCatalogProvider } from "../tts/provider-catalog.js";
import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single credential/capability gap blocking live-voice readiness. */
export interface LiveVoiceCredentialGap {
  kind: "stt" | "tts";
  providerId: string;
  reason: string;
}

/** Result of resolving whether live-voice STT+TTS credentials are in order. */
export type LiveVoiceCredentialReadiness =
  | { status: "ready" }
  | {
      status: "not-ready";
      missing: LiveVoiceCredentialGap[];
      /**
       * A single human-readable sentence naming the offending provider(s)
       * and missing credential(s), suitable for the client `error` frame.
       */
      userMessage: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether the daemon can run both audio legs of a live voice session.
 *
 * Readiness requires:
 * - STT: the configured `services.stt.provider` supports conversation
 *   streaming and its credentials resolve (the session arms one streaming
 *   transcriber per utterance — there is no batch fallback on the live-voice
 *   transport).
 * - TTS: the configured `services.tts.provider` supports streaming synthesis
 *   (`synthesizeStream`), all of its required secrets resolve, and
 *   provider-specific invariants hold (fish-audio requires a configured
 *   `referenceId` — live voice supplies no per-request voiceId).
 */
export async function resolveLiveVoiceCredentialReadiness(): Promise<LiveVoiceCredentialReadiness> {
  const gaps = (await Promise.all([resolveSttGap(), resolveTtsGap()])).filter(
    (gap): gap is GapWithClause => gap !== null,
  );

  if (gaps.length === 0) {
    return { status: "ready" };
  }

  return {
    status: "not-ready",
    missing: gaps.map(({ gap }) => gap),
    userMessage: `Live voice is unavailable because it requires ${gaps
      .map(({ clause }) => clause)
      .join(" and ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A gap entry plus its user-message clause. */
interface GapWithClause {
  gap: LiveVoiceCredentialGap;
  clause: string;
}

/**
 * Resolve the STT leg via the shared conversation-streaming capability
 * resolver: no gap when the configured provider supports streaming and its
 * key resolves; otherwise classify why so the gap names the missing piece.
 */
async function resolveSttGap(): Promise<GapWithClause | null> {
  const capability = await resolveConversationStreamingSttCapability();

  switch (capability.status) {
    case "supported":
      return null;
    case "unconfigured":
      return {
        gap: {
          kind: "stt",
          providerId: getConfig().services.stt.provider,
          reason: capability.reason,
        },
        clause: `a recognized speech-to-text provider (the configured "${getConfig().services.stt.provider}" is not in the provider catalog)`,
      };
    case "unsupported":
      return {
        gap: {
          kind: "stt",
          providerId: capability.providerId,
          reason: capability.reason,
        },
        clause: `a speech-to-text provider that supports live transcription (the configured "${capability.providerId}" does not)`,
      };
    case "missing-credentials":
      return {
        gap: {
          kind: "stt",
          providerId: capability.providerId,
          reason: capability.reason,
        },
        clause: `an API key for the speech-to-text provider "${capability.providerId}"`,
      };
  }
}

/**
 * Resolve the TTS leg: no gap when the configured provider supports streaming
 * synthesis, every secret its catalog entry requires resolves to a value, and
 * fish-audio (which live voice drives without a per-request voiceId) has a
 * configured `referenceId`.
 */
async function resolveTtsGap(): Promise<GapWithClause | null> {
  const { provider: providerId, providerConfig } =
    resolveTtsConfig(getConfig());

  let entry: ReturnType<typeof getCatalogProvider>;
  try {
    entry = getCatalogProvider(providerId);
  } catch {
    return {
      gap: {
        kind: "tts",
        providerId,
        reason: `TTS provider "${providerId}" is not in the provider catalog`,
      },
      clause: `a recognized text-to-speech provider (the configured "${providerId}" is not in the provider catalog)`,
    };
  }

  // The adapter registry is populated at daemon boot (`registerBuiltinTtsProviders`).
  // A missing registration is a boot-order fault, not a credential gap — treat
  // it as a non-streaming gap so the session fails cleanly rather than throwing.
  let supportsStreaming = false;
  try {
    const adapter = getTtsProvider(entry.id);
    supportsStreaming =
      adapter.capabilities.supportsStreaming &&
      typeof adapter.synthesizeStream === "function";
  } catch {
    supportsStreaming = false;
  }

  if (!supportsStreaming) {
    return {
      gap: {
        kind: "tts",
        providerId: entry.id,
        reason: `TTS provider "${entry.id}" does not support streaming synthesis`,
      },
      clause: `a text-to-speech provider that supports streaming synthesis (the configured "${entry.id}" does not)`,
    };
  }

  for (const secret of entry.secretRequirements) {
    if (!(await ttsSecretResolves(secret.credentialStoreKey))) {
      return {
        gap: {
          kind: "tts",
          providerId: entry.id,
          reason: `TTS provider "${entry.id}" is missing credentials (${secret.displayName})`,
        },
        clause: `an API key for the text-to-speech provider "${entry.id}" (${secret.displayName})`,
      };
    }
  }

  if (
    entry.id === "fish-audio" &&
    !fishAudioReferenceIdConfigured(providerConfig)
  ) {
    return {
      gap: {
        kind: "tts",
        providerId: entry.id,
        reason: `TTS provider "${entry.id}" has no Fish Audio reference ID configured (services.tts.providers.fish-audio.referenceId)`,
      },
      clause: `a Fish Audio voice reference ID for the text-to-speech provider "${entry.id}" (set services.tts.providers.fish-audio.referenceId)`,
    };
  }

  return null;
}

/**
 * A TTS secret resolves when the secure-key store returns a non-empty value
 * for its `credential/<service>/<field>` account. Mirrors how each provider
 * adapter reads its own key at synth time.
 */
async function ttsSecretResolves(credentialStoreKey: string): Promise<boolean> {
  const value = await getSecureKeyAsync(credentialStoreKey);
  return typeof value === "string" && value.trim().length > 0;
}

/** Fish-audio needs a non-empty `referenceId` in its resolved provider config. */
function fishAudioReferenceIdConfigured(
  providerConfig: Record<string, unknown>,
): boolean {
  const referenceId = providerConfig.referenceId;
  return typeof referenceId === "string" && referenceId.trim().length > 0;
}
