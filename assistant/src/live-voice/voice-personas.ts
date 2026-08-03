/**
 * Voice personas — selectable "modes" for a live voice conversation. Each mode
 * is a short instruction fragment appended to the base voice system prompt that
 * shapes tone and stance without changing what Cue can *do* (the tools, the
 * anti-fabrication rules, and the context briefing are identical across modes).
 *
 * v1 differentiates by behaviour only and keeps the configured voice for every
 * mode: swapping the Gemini prebuilt voice per persona risks a config-rejection
 * close (1007) on some models, so voice-per-persona is deferred to a later
 * on-device-verified pass. The `voice` field is reserved for that; it is not
 * wired to override the session voice yet.
 *
 * Unknown/absent persona ids resolve to the default (`companion`), so old
 * clients that never send a persona get exactly today's behaviour.
 */

export const VOICE_PERSONA_IDS = [
  "companion",
  "reflective",
  "cofounder",
] as const;

export type VoicePersonaId = (typeof VOICE_PERSONA_IDS)[number];

export const DEFAULT_VOICE_PERSONA: VoicePersonaId = "companion";

export interface VoicePersona {
  readonly id: VoicePersonaId;
  /** Short human label for the client picker. */
  readonly label: string;
  /** One-line description for the client picker. */
  readonly description: string;
  /**
   * Instruction fragment appended to the base voice system prompt. Kept short
   * and spoken-conversation-shaped (this is read by a realtime model).
   */
  readonly promptFragment: string;
  /**
   * Reserved: a preferred Gemini prebuilt voice for this persona. NOT wired to
   * override the session voice in v1 (see file header).
   */
  readonly voice?: string;
}

export const VOICE_PERSONAS: Record<VoicePersonaId, VoicePersona> = {
  companion: {
    id: "companion",
    label: "Companion",
    description:
      "Warm, upbeat, and encouraging — your everyday chief-of-staff.",
    promptFragment:
      "MODE — Companion: be warm, upbeat, and encouraging, like a trusted friend who also happens to run your life brilliantly. Match their energy, celebrate small wins, and keep things light while still getting things done.",
  },
  reflective: {
    id: "reflective",
    label: "Reflective",
    description:
      "Calm and thoughtful — a patient listener to think out loud with.",
    promptFragment:
      "MODE — Reflective: be calm, patient, and unhurried. Listen more than you talk, reflect back what you hear, and ask one gentle, open question at a time to help them think out loud. You are a supportive thinking partner, NOT a therapist or medical professional — never give clinical, diagnostic, or crisis advice. If they raise self-harm, a mental-health crisis, or a medical emergency, gently and briefly encourage them to reach a qualified professional or a local crisis line, and stay warm.",
  },
  cofounder: {
    id: "cofounder",
    label: "Co-founder",
    description:
      "Direct and strategic — a sharp operator biased toward action.",
    promptFragment:
      "MODE — Co-founder: be direct, strategic, and candid, like a sharp co-founder. Cut to the point, pressure-test their thinking, name the real trade-off, and bias toward the next concrete action. Disagree when you have reason to. Keep it brisk and outcome-focused.",
  },
};

/**
 * Resolve a persona id (possibly from an untrusted client) to a persona.
 * Unknown/absent → the default companion. Never throws.
 */
export function resolveVoicePersona(id?: string | null): VoicePersona {
  if (id && (VOICE_PERSONA_IDS as readonly string[]).includes(id)) {
    return VOICE_PERSONAS[id as VoicePersonaId];
  }
  return VOICE_PERSONAS[DEFAULT_VOICE_PERSONA];
}

/** Type guard for a valid persona id — used by the protocol validator. */
export function isVoicePersonaId(value: unknown): value is VoicePersonaId {
  return (
    typeof value === "string" &&
    (VOICE_PERSONA_IDS as readonly string[]).includes(value)
  );
}
