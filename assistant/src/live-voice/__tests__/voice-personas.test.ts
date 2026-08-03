import { describe, expect, test } from "bun:test";

import { validateLiveVoiceClientFrame } from "../protocol.js";
import {
  DEFAULT_VOICE_PERSONA,
  isVoicePersonaId,
  resolveVoicePersona,
  VOICE_PERSONA_IDS,
} from "../voice-personas.js";

describe("resolveVoicePersona", () => {
  test("resolves each known persona id", () => {
    for (const id of VOICE_PERSONA_IDS) {
      const persona = resolveVoicePersona(id);
      expect(persona.id).toBe(id);
      expect(persona.promptFragment.length).toBeGreaterThan(0);
      expect(persona.label.length).toBeGreaterThan(0);
    }
  });

  test("defaults to companion for absent or unknown ids", () => {
    expect(resolveVoicePersona().id).toBe(DEFAULT_VOICE_PERSONA);
    expect(resolveVoicePersona(null).id).toBe(DEFAULT_VOICE_PERSONA);
    expect(resolveVoicePersona("").id).toBe(DEFAULT_VOICE_PERSONA);
    expect(resolveVoicePersona("therapist").id).toBe(DEFAULT_VOICE_PERSONA);
    expect(DEFAULT_VOICE_PERSONA).toBe("companion");
  });

  test("the reflective persona carries the non-clinical safety guidance", () => {
    const reflective = resolveVoicePersona("reflective");
    expect(reflective.promptFragment.toLowerCase()).toContain(
      "not a therapist",
    );
    expect(reflective.promptFragment.toLowerCase()).toContain("crisis");
  });

  test("isVoicePersonaId guards correctly", () => {
    expect(isVoicePersonaId("cofounder")).toBe(true);
    expect(isVoicePersonaId("nope")).toBe(false);
    expect(isVoicePersonaId(42)).toBe(false);
    expect(isVoicePersonaId(undefined)).toBe(false);
  });
});

describe("start frame persona validation", () => {
  const baseStart = {
    type: "start",
    audio: { sampleRate: 16000, mimeType: "audio/pcm", channels: 1 },
  };

  test("accepts a valid persona on the start frame", () => {
    const result = validateLiveVoiceClientFrame({
      ...baseStart,
      persona: "reflective",
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === "start") {
      expect(result.frame.persona).toBe("reflective");
    }
  });

  test("silently drops an invalid persona (never rejects the session)", () => {
    const result = validateLiveVoiceClientFrame({
      ...baseStart,
      persona: "wizard",
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === "start") {
      expect(result.frame.persona).toBeUndefined();
    }
  });

  test("start frame with no persona stays valid and unset", () => {
    const result = validateLiveVoiceClientFrame(baseStart);
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === "start") {
      expect(result.frame.persona).toBeUndefined();
    }
  });
});
