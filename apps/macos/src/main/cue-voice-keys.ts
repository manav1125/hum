import { safeStorage } from "electron";

import log from "./logger";
import { readSetting, writeSetting } from "./settings";

/**
 * Cue Live voice API keys (AssemblyAI for speech-to-text, ElevenLabs for
 * text-to-speech). Stored encrypted at rest via Electron's safeStorage (backed
 * by the macOS Keychain) and only ever handed to the native helper in memory
 * over the local JSON-RPC pipe. The renderer can set them and read their
 * presence, but never reads the secret values back.
 */

type EncryptedField = "assemblyAi" | "elevenLabs";

const encrypt = (plain: string): string =>
  safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(plain).toString("base64")
    : // Fallback when the OS keychain is unavailable: still not plaintext in
      // the JSON, but not truly encrypted. safeStorage is available on macOS.
      Buffer.from(plain, "utf8").toString("base64");

const decrypt = (b64: string): string => {
  const buf = Buffer.from(b64, "base64");
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString("utf8");
  } catch (err) {
    log.warn(
      `[cue-voice-keys] decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "";
  }
};

export interface VoiceConfig {
  assemblyAiKey: string | null;
  elevenLabsKey: string | null;
  elevenLabsVoiceId: string | null;
}

/** Plaintext keys for the helper. Main-process only — never sent to renderer. */
export const getVoiceConfig = (): VoiceConfig => {
  const v = readSetting("voiceKeys") ?? {};
  return {
    assemblyAiKey: v.assemblyAi ? decrypt(v.assemblyAi) : null,
    elevenLabsKey: v.elevenLabs ? decrypt(v.elevenLabs) : null,
    elevenLabsVoiceId: v.elevenLabsVoiceId ?? null,
  };
};

export interface VoiceKeysStatus {
  hasAssemblyAi: boolean;
  hasElevenLabs: boolean;
  elevenLabsVoiceId: string | null;
}

/** Renderer-safe view: which keys are set, plus the (non-secret) voice id. */
export const getVoiceKeysStatus = (): VoiceKeysStatus => {
  const v = readSetting("voiceKeys") ?? {};
  return {
    hasAssemblyAi: Boolean(v.assemblyAi),
    hasElevenLabs: Boolean(v.elevenLabs),
    elevenLabsVoiceId: v.elevenLabsVoiceId ?? null,
  };
};

/** Set or clear a secret key (encrypts before storing). Empty/null clears it. */
export const setVoiceSecret = (
  which: EncryptedField,
  value: string | null,
): void => {
  const v = { ...(readSetting("voiceKeys") ?? {}) };
  if (value && value.trim()) {
    v[which] = encrypt(value.trim());
  } else {
    delete v[which];
  }
  writeSetting("voiceKeys", v);
};

/** Set or clear the (non-secret) ElevenLabs voice id. */
export const setElevenLabsVoiceId = (value: string | null): void => {
  const v = { ...(readSetting("voiceKeys") ?? {}) };
  if (value && value.trim()) {
    v.elevenLabsVoiceId = value.trim();
  } else {
    delete v.elevenLabsVoiceId;
  }
  writeSetting("voiceKeys", v);
};
