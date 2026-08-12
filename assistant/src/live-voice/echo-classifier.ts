/**
 * Waveform-correlation playback-echo classifier (upstream 9eaee435d7's
 * mechanism, packaged for engines without the cascade's server-VAD plumbing —
 * today the Gemini Live engine's mic ingest).
 *
 * While assistant audio is (estimated to be) audible on the client, the first
 * above-threshold mic audio is held as a short probe and cross-correlated
 * against a rolling reference of the PCM actually sent to the speaker. A match
 * seeds an exponentially-decaying echo-energy level; subsequent mic input must
 * exceed `margin` times that level to count as user speech, so playback echo
 * is suppressed while genuine barge-in speech still gets through. A nonmatch
 * releases the held audio in original order, so a user who talks right at
 * playback onset is neither learned as echo nor lost.
 *
 * The caller owns the playback window: it calls {@link classify} only while
 * echo is possible (playback tail + drain slack) and {@link resetWindow} once
 * the window closes. The reference buffer may be recorded at a different
 * sample rate than the mic input (Gemini emits 24 kHz, clients usually send
 * 16 kHz); both sides are block-averaged to a common effective rate before
 * correlating. When no common rate exists, or the reference is still too
 * short to identify, the classifier cannot decide — `undecidedIsEcho` then
 * picks the conservative outcome (Gemini keeps its silence substitution).
 */

import {
  DEFAULT_SPEECH_ENERGY_THRESHOLD,
  pcm16MaxNormalizedCorrelation,
  pcm16MeanAmplitude,
} from "../stt/speech-energy.js";

// Mirrors the cascade session's constants (see live-voice-session.ts).
const ECHO_CORRELATION_PROBE_MS = 100;
const ECHO_CORRELATION_MIN_MS = 50;
const ECHO_CORRELATION_THRESHOLD = 0.65;
const ECHO_REFERENCE_MAX_MS = 10_000;
const ECHO_ONSET_ELIGIBILITY_MS = 300;
// Effective correlation rate divisor for the mic side (16 kHz / 8 = 2 kHz).
const INPUT_DOWNSAMPLE_FACTOR = 8;

export type EchoClassification = "speech" | "silence" | "echo";

export interface EchoClassifiedChunk {
  readonly chunk: Buffer;
  readonly classification: EchoClassification;
}

export interface PlaybackEchoClassifierOptions {
  /** Sample rate of the mic audio fed to {@link classify}. */
  inputSampleRate: number;
  /** Sample rate of the outbound PCM fed to {@link appendReference}. */
  referenceSampleRate: number;
  /** Multiplier over the learned echo level that counts as speech. */
  margin: number;
  /** Half-life (ms) of the learned echo level. */
  emaHalfLifeMs: number;
  /**
   * When the classifier cannot decide (no usable reference yet, or the two
   * sample rates share no integer block-average factor), classify
   * above-threshold audio as echo (true — conservative: the caller keeps
   * suppressing) instead of speech (false — permissive).
   */
  undecidedIsEcho: boolean;
  /** Fixed base energy gate; defaults to DEFAULT_SPEECH_ENERGY_THRESHOLD. */
  baseThreshold?: number;
}

type EchoMatch = "match" | "nomatch" | "undecided";

export class PlaybackEchoClassifier {
  private readonly options: PlaybackEchoClassifierOptions;
  private readonly baseThreshold: number;
  /**
   * Block-average factor for the reference side so both sides land on the
   * same effective rate; null when no integer factor exists (correlation is
   * then impossible and every probe is "undecided").
   */
  private readonly referenceDownsampleFactor: number | null;

  private energyEma = 0;
  private probeChunks: Buffer[] = [];
  private referenceAudio = Buffer.alloc(0);
  private windowTotalAudioMs = 0;
  private subBaseRunMs = 0;
  private onsetLapsed = false;

  constructor(options: PlaybackEchoClassifierOptions) {
    this.options = options;
    this.baseThreshold =
      options.baseThreshold ?? DEFAULT_SPEECH_ENERGY_THRESHOLD;
    const factor =
      (INPUT_DOWNSAMPLE_FACTOR * options.referenceSampleRate) /
      options.inputSampleRate;
    this.referenceDownsampleFactor =
      Number.isInteger(factor) && factor > 0 ? factor : null;
  }

  /** Rolling ≤10 s reference of outbound playback PCM (reference rate). */
  appendReference(pcm: Buffer): void {
    const maxBytes = Math.ceil(
      (this.options.referenceSampleRate * ECHO_REFERENCE_MAX_MS * 2) / 1_000,
    );
    const combined = Buffer.concat([this.referenceAudio, pcm]);
    this.referenceAudio =
      combined.byteLength > maxBytes
        ? combined.subarray(combined.byteLength - maxBytes)
        : combined;
  }

  /**
   * Forget the playback burst: the window closed (playback drained), so the
   * reference can no longer describe audible audio and the learned level is
   * stale. The next burst starts a fresh onset-eligibility window.
   */
  resetWindow(): void {
    this.energyEma = 0;
    this.probeChunks = [];
    this.referenceAudio = Buffer.alloc(0);
    this.windowTotalAudioMs = 0;
    this.subBaseRunMs = 0;
    this.onsetLapsed = false;
  }

  /**
   * Classify one mic chunk recorded during the playback window. May return
   * [] while onset audio is being held as a probe; the held chunks are
   * released (classified) by a later call, in original order.
   */
  classify(chunk: Buffer): EchoClassifiedChunk[] {
    const chunkMs = this.durationMs(chunk.byteLength);
    const onsetWasEligible =
      !this.onsetLapsed && this.windowTotalAudioMs < ECHO_ONSET_ELIGIBILITY_MS;
    this.windowTotalAudioMs += chunkMs;

    // The classifier cannot decide without a usable reference (the two rates
    // share no integer block-average factor, or too little playback PCM has
    // arrived to identify). Conservative callers keep the blanket
    // substitution for the whole window — exactly the pre-classifier gate —
    // rather than forwarding possible echo.
    if (this.options.undecidedIsEcho && !this.canCorrelate()) {
      const held = this.probeChunks.splice(0);
      return [...held, chunk].map((heldChunk) => ({
        chunk: heldChunk,
        classification: "echo" as const,
      }));
    }

    if (this.probeChunks.length > 0) {
      this.probeChunks.push(Buffer.from(chunk));
      return this.resolveProbe();
    }

    const meanAmplitude = pcm16MeanAmplitude(chunk);
    if (meanAmplitude <= this.baseThreshold) {
      this.subBaseRunMs += chunkMs;
      if (this.subBaseRunMs >= ECHO_ONSET_ELIGIBILITY_MS) {
        this.energyEma = 0;
        this.onsetLapsed = true;
      }
      return [{ chunk, classification: "silence" }];
    }

    this.subBaseRunMs = 0;
    if (this.energyEma === 0 && onsetWasEligible) {
      this.probeChunks.push(Buffer.from(chunk));
      return this.resolveProbe();
    }

    if (this.energyEma === 0) {
      this.onsetLapsed = true;
      return [{ chunk, classification: "speech" }];
    }

    const speechThreshold = Math.max(
      this.baseThreshold,
      this.options.margin * this.energyEma,
    );
    if (meanAmplitude > speechThreshold) {
      // Only a positive waveform match keeps suppressing above the learned
      // margin — a chunk too short to correlate counts as speech, mirroring
      // the cascade (suppressing here would freeze out genuine barge-in).
      if (this.matchesReference(chunk) === "match") {
        this.updateEnergy(meanAmplitude, chunkMs);
        return [{ chunk, classification: "echo" }];
      }
      return [{ chunk, classification: "speech" }];
    }

    this.updateEnergy(meanAmplitude, chunkMs);
    return [{ chunk, classification: "echo" }];
  }

  private resolveProbe(): EchoClassifiedChunk[] {
    const probe = Buffer.concat(this.probeChunks);
    const probeAudioMs = this.durationMs(probe.byteLength);
    const match =
      probeAudioMs >= ECHO_CORRELATION_MIN_MS
        ? this.matchesReference(probe)
        : "undecided";
    if (match === "match") {
      this.energyEma = Math.max(this.baseThreshold, pcm16MeanAmplitude(probe));
      const chunks = this.probeChunks.splice(0);
      return chunks.map((chunk) => ({
        chunk,
        classification: "echo" as const,
      }));
    }
    if (probeAudioMs < ECHO_CORRELATION_PROBE_MS) {
      return [];
    }

    // A full probe that never matched: the onset was not identifiable echo.
    this.onsetLapsed = true;
    const chunks = this.probeChunks.splice(0);
    return chunks.map((chunk) => ({
      chunk,
      classification:
        pcm16MeanAmplitude(chunk) > this.baseThreshold
          ? ("speech" as const)
          : ("silence" as const),
    }));
  }

  /** A reference exists that a sufficiently long probe could match. */
  private canCorrelate(): boolean {
    const referenceMinimumBytes = Math.ceil(
      (this.options.referenceSampleRate * ECHO_CORRELATION_MIN_MS * 2) / 1_000,
    );
    return (
      this.referenceDownsampleFactor !== null &&
      this.referenceAudio.byteLength >= referenceMinimumBytes
    );
  }

  private matchesReference(chunk: Buffer): EchoMatch {
    const referenceDownsampleFactor = this.referenceDownsampleFactor;
    if (referenceDownsampleFactor === null || !this.canCorrelate()) {
      return "undecided";
    }
    const inputMinimumBytes = Math.ceil(
      (this.options.inputSampleRate * ECHO_CORRELATION_MIN_MS * 2) / 1_000,
    );
    if (chunk.byteLength < inputMinimumBytes) {
      return "undecided";
    }
    const probeByteLength = Math.min(
      chunk.byteLength,
      Math.ceil(
        (this.options.inputSampleRate * ECHO_CORRELATION_PROBE_MS * 2) / 1_000,
      ),
    );
    return pcm16MaxNormalizedCorrelation(
      chunk.subarray(0, probeByteLength),
      this.referenceAudio,
      INPUT_DOWNSAMPLE_FACTOR,
      referenceDownsampleFactor,
    ) >= ECHO_CORRELATION_THRESHOLD
      ? "match"
      : "nomatch";
  }

  private updateEnergy(meanAmplitude: number, chunkMs: number): void {
    const alpha = 1 - 0.5 ** (chunkMs / this.options.emaHalfLifeMs);
    this.energyEma = alpha * meanAmplitude + (1 - alpha) * this.energyEma;
  }

  private durationMs(byteLength: number): number {
    return (byteLength / 2 / this.options.inputSampleRate) * 1_000;
  }
}
