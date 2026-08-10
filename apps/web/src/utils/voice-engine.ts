/**
 * Where the voice engine choice LIVES — one key, one reader, one writer.
 *
 * v35 moved this control off the call screen: "nobody changes engines
 * mid-sentence." It is now a Your Cue → Preferences → Voice row, and the call
 * screen keeps a long-press on the timer as the engineering back door. Both of
 * those, and the session start that consumes the value, read this module, so
 * there is no second copy of the storage key to drift from the first.
 *
 * `cascade` is the STT → agent-loop → TTS pipeline (the full assistant, and the
 * only engine that reports the tools it touches). `gemini-live` is the
 * speech-native realtime session. Names on the wire are internal; the words a
 * user reads never name a vendor.
 */

export type VoiceEngine = "cascade" | "gemini-live";

/** localStorage key. Unchanged, so an existing choice survives the move. */
export const LS_VOICE_ENGINE = "cue.voiceEngine";

/**
 * One-time migration marker (see {@link migrateLegacyEngineChoice}): before
 * the voice re-platform, `gemini-live` was the de-facto production engine and
 * old clients wrote it here as a standing choice. The re-platformed cascade
 * supersedes it (tools, memory, hands-free turn-taking — gemini-live has
 * three tools and no web access, which read as "voice can't answer and then
 * drops"). A stored `gemini-live` WITHOUT this marker is that legacy default,
 * not a decision, and migrates to cascade once; choosing gemini-live in
 * Preferences afterwards sets the marker and is respected.
 */
const LS_VOICE_ENGINE_MIGRATED = "cue.voiceEngine.postReplatform";

/** The engine used when nothing has been chosen. */
export const DEFAULT_VOICE_ENGINE: VoiceEngine = "cascade";

function migrateLegacyEngineChoice(stored: string | null): string | null {
  if (stored !== "gemini-live") return stored;
  try {
    if (window.localStorage.getItem(LS_VOICE_ENGINE_MIGRATED) === "1") {
      return stored;
    }
    window.localStorage.setItem(LS_VOICE_ENGINE, DEFAULT_VOICE_ENGINE);
    window.localStorage.setItem(LS_VOICE_ENGINE_MIGRATED, "1");
    return DEFAULT_VOICE_ENGINE;
  } catch {
    // Locked-down storage: fall through with the stored value untouched.
    return stored;
  }
}

function isVoiceEngine(value: unknown): value is VoiceEngine {
  return value === "cascade" || value === "gemini-live";
}

/**
 * Resolve the engine: an explicit argument wins, then `?voiceEngine=…`, then
 * the stored choice, else the cascade default. Side-effect-free and SSR-safe —
 * a locked-down `localStorage` or `location` degrades to the default rather
 * than throwing into a session start.
 */
export function resolveVoiceEngine(explicit?: VoiceEngine): VoiceEngine {
  if (explicit) return explicit;
  if (typeof window === "undefined") return DEFAULT_VOICE_ENGINE;
  try {
    const param = new URLSearchParams(window.location.search).get(
      "voiceEngine",
    );
    if (isVoiceEngine(param)) return param;
    const stored = migrateLegacyEngineChoice(
      window.localStorage.getItem(LS_VOICE_ENGINE),
    );
    if (isVoiceEngine(stored)) return stored;
  } catch {
    // Access to location/localStorage can throw in locked-down contexts.
  }
  return DEFAULT_VOICE_ENGINE;
}

/** The stored choice only — what a settings row should show as selected. */
export function readVoiceEngine(): VoiceEngine {
  if (typeof window === "undefined") return DEFAULT_VOICE_ENGINE;
  try {
    const stored = migrateLegacyEngineChoice(
      window.localStorage.getItem(LS_VOICE_ENGINE),
    );
    return isVoiceEngine(stored) ? stored : DEFAULT_VOICE_ENGINE;
  } catch {
    return DEFAULT_VOICE_ENGINE;
  }
}

/** Persist the choice. Applied at the NEXT session start, never mid-sentence. */
export function writeVoiceEngine(engine: VoiceEngine): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_VOICE_ENGINE, engine);
    // A write is a deliberate choice: mark it so the legacy migration never
    // second-guesses a post-re-platform gemini-live selection.
    window.localStorage.setItem(LS_VOICE_ENGINE_MIGRATED, "1");
  } catch {
    // Locked-down storage: the choice simply does not persist.
  }
}
