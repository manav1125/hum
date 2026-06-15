import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import log from "./logger";
import { readSetting, writeSetting } from "./settings";

/**
 * Cue Live voice API keys (AssemblyAI for speech-to-text, ElevenLabs for
 * text-to-speech). Encrypted at rest with AES-256-GCM under a random key kept
 * in a 0600 file in userData, and only ever handed to the native helper in
 * memory over the local JSON-RPC pipe. The renderer can set them and read
 * their presence, but never reads the secret values back.
 *
 * Why a keyfile and not Electron `safeStorage`: safeStorage's macOS key is
 * bound to the app's code signature, so every re-pack (re-sign) silently makes
 * previously-stored keys undecryptable. The keyfile lives in userData and
 * survives re-packs, so the user enters their keys once.
 */

type EncryptedField = "assemblyAi" | "elevenLabs";

let cachedMasterKey: Buffer | null = null;

/** Load (or create) the 32-byte master key from userData. */
const masterKey = (): Buffer => {
  if (cachedMasterKey) return cachedMasterKey;
  const keyPath = join(app.getPath("userData"), "cue-voice.key");
  if (existsSync(keyPath)) {
    cachedMasterKey = readFileSync(keyPath);
  } else {
    cachedMasterKey = randomBytes(32);
    writeFileSync(keyPath, cachedMasterKey, { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // best-effort; the mode on write usually suffices
    }
  }
  return cachedMasterKey;
};

const encrypt = (plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  // layout: iv(12) | authTag(16) | ciphertext
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
};

const decrypt = (b64: string): string => {
  try {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // Old safeStorage-encrypted blobs (pre-migration) land here — treat as
    // absent so the user re-enters once into the stable scheme.
    log.warn(
      `[cue-voice-keys] decrypt failed (re-enter the key): ${
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
