/**
 * The legacy gemini-live pin migration (voice re-platform): a stored
 * "gemini-live" written before the re-platform was the era's default, not a
 * decision, and must migrate to cascade exactly once; a deliberate
 * post-re-platform selection is respected.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_VOICE_ENGINE,
  LS_VOICE_ENGINE,
  readVoiceEngine,
  resolveVoiceEngine,
  writeVoiceEngine,
} from "./voice-engine";

const LS_MARKER = "cue.voiceEngine.postReplatform";

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("legacy gemini-live pin migration", () => {
  test("a pre-re-platform stored gemini-live resolves as cascade and is rewritten", () => {
    window.localStorage.setItem(LS_VOICE_ENGINE, "gemini-live");
    expect(resolveVoiceEngine()).toBe(DEFAULT_VOICE_ENGINE);
    expect(window.localStorage.getItem(LS_VOICE_ENGINE)).toBe(
      DEFAULT_VOICE_ENGINE,
    );
    expect(window.localStorage.getItem(LS_MARKER)).toBe("1");
  });

  test("a deliberate post-re-platform gemini-live choice is respected", () => {
    writeVoiceEngine("gemini-live");
    expect(resolveVoiceEngine()).toBe("gemini-live");
    expect(readVoiceEngine()).toBe("gemini-live");
  });

  test("readVoiceEngine migrates too (the Preferences row shows the truth)", () => {
    window.localStorage.setItem(LS_VOICE_ENGINE, "gemini-live");
    expect(readVoiceEngine()).toBe(DEFAULT_VOICE_ENGINE);
  });

  test("a stored cascade choice is untouched and unmarked", () => {
    window.localStorage.setItem(LS_VOICE_ENGINE, "cascade");
    expect(resolveVoiceEngine()).toBe("cascade");
    expect(window.localStorage.getItem(LS_MARKER)).toBeNull();
  });

  test("the ?voiceEngine=gemini-live debug override still works and does not migrate", () => {
    window.history.replaceState(null, "", "?voiceEngine=gemini-live");
    window.localStorage.setItem(LS_VOICE_ENGINE, "gemini-live");
    expect(resolveVoiceEngine()).toBe("gemini-live");
  });
});
