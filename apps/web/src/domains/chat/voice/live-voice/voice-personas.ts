/**
 * Web-side voice persona metadata — display labels for the mode picker only.
 * The actual behaviour (prompt fragments) lives server-side in
 * `assistant/src/live-voice/voice-personas.ts`; this file must keep the same ids
 * and default so the client sends a value the daemon recognises.
 */

export const VOICE_PERSONA_IDS = [
  "companion",
  "reflective",
  "cofounder",
] as const;

export type VoicePersonaId = (typeof VOICE_PERSONA_IDS)[number];

export const DEFAULT_VOICE_PERSONA: VoicePersonaId = "companion";

export interface VoicePersonaOption {
  readonly id: VoicePersonaId;
  readonly label: string;
  readonly description: string;
}

export const VOICE_PERSONA_OPTIONS: readonly VoicePersonaOption[] = [
  {
    id: "companion",
    label: "Companion",
    description: "Warm and encouraging",
  },
  {
    id: "reflective",
    label: "Reflective",
    description: "Calm, thoughtful listener",
  },
  {
    id: "cofounder",
    label: "Co-founder",
    description: "Direct, strategic operator",
  },
];

export function isVoicePersonaId(value: unknown): value is VoicePersonaId {
  return (
    typeof value === "string" &&
    (VOICE_PERSONA_IDS as readonly string[]).includes(value)
  );
}

/**
 * Resolve the selected persona: an explicit value wins, then
 * `localStorage["cue.voicePersona"]`, else the default. SSR-safe.
 */
export function resolveVoicePersona(explicit?: string): VoicePersonaId {
  if (isVoicePersonaId(explicit)) return explicit;
  if (typeof window === "undefined") return DEFAULT_VOICE_PERSONA;
  try {
    const stored = window.localStorage.getItem("cue.voicePersona");
    if (isVoicePersonaId(stored)) return stored;
  } catch {
    // localStorage can throw in locked-down contexts.
  }
  return DEFAULT_VOICE_PERSONA;
}
