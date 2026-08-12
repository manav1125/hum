import { describe, expect, test } from "bun:test";

import {
  PlaybackEchoClassifier,
  type PlaybackEchoClassifierOptions,
} from "../echo-classifier.js";

const INPUT_RATE = 16_000;
const REFERENCE_RATE = 24_000;

/** PCM16LE sine tone: `sampleCount` samples at `sampleRate`. */
function tone(
  amplitude: number,
  frequencyHz: number,
  sampleCount: number,
  sampleRate: number,
): Buffer {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(
      Math.round(
        amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate),
      ),
      index * 2,
    );
  }
  return buffer;
}

// 10 ms mic chunks; 200 Hz spans exactly 2 periods per chunk at 16 kHz, so
// concatenated chunks stay continuous and correlate with the reference tone.
const echoChunk = () => tone(4_700, 200, 160, INPUT_RATE);
const speechChunk = () => tone(9_400, 530, 160, INPUT_RATE);
const quietChunk = () => Buffer.alloc(320);
const referenceTone = () =>
  tone(4_700, 200, 2 * REFERENCE_RATE, REFERENCE_RATE);

function makeClassifier(
  overrides: Partial<PlaybackEchoClassifierOptions> = {},
): PlaybackEchoClassifier {
  return new PlaybackEchoClassifier({
    inputSampleRate: INPUT_RATE,
    referenceSampleRate: REFERENCE_RATE,
    margin: 1.5,
    emaHalfLifeMs: 400,
    undecidedIsEcho: true,
    ...overrides,
  });
}

function classifications(
  classifier: PlaybackEchoClassifier,
  chunks: Buffer[],
): string[] {
  return chunks.flatMap((chunk) =>
    classifier.classify(chunk).map((entry) => entry.classification),
  );
}

describe("PlaybackEchoClassifier", () => {
  test("correlated onset audio is held as a probe, then classified echo", () => {
    const classifier = makeClassifier();
    classifier.appendReference(referenceTone());

    const results = classifications(
      classifier,
      Array.from({ length: 10 }, () => echoChunk()),
    );
    // The probe held the first ~50 ms, resolved as a match, and released
    // every held chunk as echo; later chunks track the learned level.
    expect(results).toHaveLength(10);
    expect(results.every((entry) => entry === "echo")).toBe(true);
  });

  test("uncorrelated onset audio replays as speech in original order", () => {
    const classifier = makeClassifier();
    classifier.appendReference(referenceTone());

    const chunks = Array.from({ length: 10 }, () => speechChunk());
    const results = chunks.flatMap((chunk) => classifier.classify(chunk));
    expect(results.map((entry) => entry.classification)).toEqual(
      new Array(10).fill("speech"),
    );
    // Original order and content preserved through the hold.
    results.forEach((entry, index) => {
      expect(entry.chunk.equals(chunks[index]!)).toBe(true);
    });
  });

  test("speech above the learned margin is forwarded after echo settles", () => {
    const classifier = makeClassifier();
    classifier.appendReference(referenceTone());

    for (let index = 0; index < 10; index += 1) {
      classifier.classify(echoChunk());
    }
    expect(classifications(classifier, [speechChunk()])).toEqual(["speech"]);
    // Echo at the learned level keeps being suppressed afterwards.
    expect(classifications(classifier, [echoChunk()])).toEqual(["echo"]);
  });

  test("sub-threshold audio is silence and eventually expires the level", () => {
    const classifier = makeClassifier();
    classifier.appendReference(referenceTone());
    for (let index = 0; index < 10; index += 1) {
      classifier.classify(echoChunk());
    }

    // 300 ms of near-silence: the learned level can no longer describe
    // audible playback, so loud audio afterwards counts as speech.
    const quiet = classifications(
      classifier,
      Array.from({ length: 30 }, () => quietChunk()),
    );
    expect(quiet.every((entry) => entry === "silence")).toBe(true);
    expect(classifications(classifier, [speechChunk()])).toEqual(["speech"]);
  });

  test("an unusable reference keeps the blanket substitution (undecidedIsEcho)", () => {
    const classifier = makeClassifier();
    // Far too short to correlate against (~4 ms).
    classifier.appendReference(tone(4_700, 200, 100, REFERENCE_RATE));

    const results = classifications(
      classifier,
      Array.from({ length: 12 }, () => speechChunk()),
    );
    expect(results).toHaveLength(12);
    expect(results.every((entry) => entry === "echo")).toBe(true);
  });

  test("incompatible sample rates fall back to the blanket substitution", () => {
    const classifier = makeClassifier({
      inputSampleRate: 44_100,
      referenceSampleRate: REFERENCE_RATE,
    });
    classifier.appendReference(referenceTone());

    const loudAt44k = tone(9_400, 530, 441, 44_100);
    expect(classifications(classifier, [loudAt44k])).toEqual(["echo"]);
  });

  test("resetWindow forgets the reference and the learned level", () => {
    const classifier = makeClassifier();
    classifier.appendReference(referenceTone());
    for (let index = 0; index < 10; index += 1) {
      classifier.classify(echoChunk());
    }

    classifier.resetWindow();
    // No reference → conservative blanket substitution again, not a stale
    // learned level.
    expect(classifications(classifier, [speechChunk()])).toEqual(["echo"]);
  });
});
