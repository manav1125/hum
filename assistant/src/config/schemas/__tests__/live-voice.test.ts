import { describe, expect, test } from "bun:test";

import {
  LiveVoiceConfigSchema,
  LiveVoiceVadConfigSchema,
} from "../live-voice.js";

describe("LiveVoiceVadConfigSchema", () => {
  test("fills the documented defaults", () => {
    expect(LiveVoiceVadConfigSchema.parse({})).toEqual({
      silenceThresholdMs: 1200,
      bargeInMinSpeechMs: 250,
      maxTurnDurationMs: 30_000,
      echoBargeInMargin: 1.5,
      echoEmaHalfLifeMs: 400,
      echoDrainSlackMs: 300,
    });
  });

  test("accepts echo gate overrides", () => {
    const parsed = LiveVoiceVadConfigSchema.parse({
      echoBargeInMargin: 2.25,
      echoEmaHalfLifeMs: 250,
      echoDrainSlackMs: 500,
    });
    expect(parsed.echoBargeInMargin).toBe(2.25);
    expect(parsed.echoEmaHalfLifeMs).toBe(250);
    expect(parsed.echoDrainSlackMs).toBe(500);
  });

  test("rejects an echo margin that cannot exceed its reference", () => {
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoBargeInMargin: 1 }).success,
    ).toBe(false);
  });

  test("rejects invalid echo timing values", () => {
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoEmaHalfLifeMs: 0 }).success,
    ).toBe(false);
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoEmaHalfLifeMs: 250.5 }).success,
    ).toBe(false);
    expect(
      LiveVoiceVadConfigSchema.safeParse({ echoDrainSlackMs: -1 }).success,
    ).toBe(false);
  });
});

describe("LiveVoiceConfigSchema", () => {
  test("the vad block defaults include the echo gate knobs", () => {
    const parsed = LiveVoiceConfigSchema.parse({});
    expect(parsed.vad).toEqual({
      silenceThresholdMs: 1200,
      bargeInMinSpeechMs: 250,
      maxTurnDurationMs: 30_000,
      echoBargeInMargin: 1.5,
      echoEmaHalfLifeMs: 400,
      echoDrainSlackMs: 300,
    });
  });
});
