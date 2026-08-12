import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SPEECH_ENERGY_THRESHOLD,
  detectPcm16SpeechActivity,
  pcm16MaxNormalizedCorrelation,
  pcm16MeanAmplitude,
} from "../speech-energy.js";

/** Build a PCM16LE buffer from an array of sample values. */
function pcm16(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, index * 2);
  });
  return buffer;
}

describe("detectPcm16SpeechActivity", () => {
  test("returns false for an empty buffer", () => {
    expect(detectPcm16SpeechActivity(Buffer.alloc(0))).toBe(false);
  });

  test("classifies silence below the threshold", () => {
    expect(detectPcm16SpeechActivity(pcm16([100, -200, 300, -150]))).toBe(
      false,
    );
  });

  test("classifies loud audio above the threshold", () => {
    expect(
      detectPcm16SpeechActivity(pcm16([4_000, -3_500, 5_000, -4_200])),
    ).toBe(true);
  });

  test("respects a custom threshold", () => {
    const quiet = pcm16([400, -450, 420, -380]);
    expect(detectPcm16SpeechActivity(quiet, 300)).toBe(true);
    expect(detectPcm16SpeechActivity(quiet, 500)).toBe(false);
  });
});

describe("pcm16MeanAmplitude", () => {
  test("returns 0 for an empty buffer", () => {
    expect(pcm16MeanAmplitude(Buffer.alloc(0))).toBe(0);
  });

  test("returns the exact mean absolute amplitude", () => {
    expect(pcm16MeanAmplitude(pcm16([1_000, -2_000, 3_000, -4_000]))).toBe(
      2_500,
    );
  });

  test("ignores a trailing odd byte", () => {
    const samples = pcm16([3_000, -3_000]);
    expect(
      pcm16MeanAmplitude(Buffer.concat([samples, Buffer.from([0x01])])),
    ).toBe(3_000);
  });

  test("matches the detector's threshold comparison", () => {
    const chunks = [
      Buffer.alloc(0),
      pcm16([0, 0]),
      pcm16([500, -500]),
      pcm16([DEFAULT_SPEECH_ENERGY_THRESHOLD]),
      pcm16([DEFAULT_SPEECH_ENERGY_THRESHOLD + 1]),
    ];
    for (const chunk of chunks) {
      expect(detectPcm16SpeechActivity(chunk)).toBe(
        pcm16MeanAmplitude(chunk) > DEFAULT_SPEECH_ENERGY_THRESHOLD,
      );
    }
  });
});

describe("pcm16MaxNormalizedCorrelation", () => {
  const wave = (frequency: number, count: number): Buffer =>
    pcm16(
      Array.from({ length: count }, (_, index) =>
        Math.round(
          8_000 * Math.sin((2 * Math.PI * frequency * index) / 16_000),
        ),
      ),
    );

  test("finds a matching waveform at an arbitrary reference offset", () => {
    const input = wave(240, 800);
    const reference = Buffer.concat([wave(410, 400), input, wave(610, 400)]);

    expect(pcm16MaxNormalizedCorrelation(input, reference)).toBeGreaterThan(
      0.99,
    );
  });

  test("is invariant to gain and polarity", () => {
    const inputSamples = Array.from({ length: 800 }, (_, index) =>
      Math.round(5_000 * Math.sin((2 * Math.PI * index) / 83)),
    );
    const inverted = pcm16(inputSamples.map((sample) => -2 * sample));

    expect(
      pcm16MaxNormalizedCorrelation(pcm16(inputSamples), inverted),
    ).toBeGreaterThan(0.99);
  });

  test("rejects an unrelated waveform and flat power", () => {
    expect(
      pcm16MaxNormalizedCorrelation(wave(240, 800), wave(610, 1_600)),
    ).toBeLessThan(0.3);
    expect(
      pcm16MaxNormalizedCorrelation(
        pcm16(new Array(800).fill(3_000)),
        pcm16(new Array(1_600).fill(3_000)),
      ),
    ).toBe(0);
  });

  test("rejects a non-integer downsample factor", () => {
    const input = wave(240, 800);
    expect(pcm16MaxNormalizedCorrelation(input, input, 2.5)).toBe(0);
    expect(pcm16MaxNormalizedCorrelation(input, input, 0)).toBe(0);
    expect(pcm16MaxNormalizedCorrelation(input, input, 8, 2.5)).toBe(0);
  });

  test("matches across sample rates via a reference downsample factor", () => {
    // The same 240 Hz tone captured at 16 kHz (input) and 24 kHz
    // (reference): block-averaging at 8 vs. 12 lands both at 2 kHz
    // effective, so the correlation still identifies the waveform.
    const inputAt16k = pcm16(
      Array.from({ length: 1_600 }, (_, index) =>
        Math.round(8_000 * Math.sin((2 * Math.PI * 240 * index) / 16_000)),
      ),
    );
    const referenceAt24k = pcm16(
      Array.from({ length: 4_800 }, (_, index) =>
        Math.round(8_000 * Math.sin((2 * Math.PI * 240 * index) / 24_000)),
      ),
    );
    expect(
      pcm16MaxNormalizedCorrelation(inputAt16k, referenceAt24k, 8, 12),
    ).toBeGreaterThan(0.9);
    // An unrelated tone stays rejected across rates too.
    const otherAt24k = pcm16(
      Array.from({ length: 4_800 }, (_, index) =>
        Math.round(8_000 * Math.sin((2 * Math.PI * 610 * index) / 24_000)),
      ),
    );
    expect(
      pcm16MaxNormalizedCorrelation(inputAt16k, otherAt24k, 8, 12),
    ).toBeLessThan(0.3);
  });
});
