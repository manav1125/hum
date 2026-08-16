/**
 * Server-side VAD ingress for live voice (V-1a).
 *
 * Adapted from upstream vellum-assistant's `live-voice-vad.test.ts` for our
 * session shape (single session-level state machine + full-duplex loop-back,
 * not upstream's utterance-cycle records). Covers:
 *
 * - `ready` echoes the negotiated `turnDetection` mode.
 * - Idle-mic silence never reaches STT; the bounded pre-roll ring flushes as
 *   leading context on speech onset.
 * - Speech onset emits `speech_started`; the trailing-silence boundary emits
 *   `utterance_end` and releases the utterance exactly the way `ptt_release`
 *   does (transcriber stop → final → assistant turn).
 * - Multi-turn cycling on one socket (server_vad rides full-duplex).
 * - `ptt_release` still works as a manual override in server_vad mode.
 * - `update_config` retunes the detector live.
 * - THE GATE: a session that did not opt in NEVER receives `speech_started` /
 *   `utterance_end` / `turn_cancelled`, and its manual path is byte-for-byte
 *   unchanged.
 * - Speech landing while a turn is in flight parks in the ring and flushes
 *   into the next armed listening turn (with its boundary replayed).
 *
 * V-1b adds the server-side sustained-speech barge-in guard (gap tolerance,
 * duty-cycle ceiling, drain-window coverage, `turn_cancelled`) and the
 * interrupted-request merge context. V-1c adds the unified front door
 * (speculative dispatch at the silence boundary, verdict-first hold /
 * escalate / answer, discard rollback, the manual-release and
 * speech-resumption races, and the escalation hand-off).
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import { ESCALATION_CONTINUATION_CONTENT } from "../../calls/voice-triage-escalate.js";
import {
  type LiveVoiceConfig,
  LiveVoiceConfigSchema,
  type LiveVoiceFrontDoorConfig,
} from "../../config/schemas/live-voice.js";
import { initializeDb } from "../../memory/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceTtsStreamer,
  type LiveVoiceTurnStarter,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

// The session ensures a `conversations` row on start (FK for the first turn's
// insert), so these tests need a real schema.
initializeDb();

const SAMPLE_RATE = 16_000;

/** PCM16LE chunk of `sampleCount` samples, every sample at `amplitude`. */
function pcm(amplitude: number, sampleCount = 800): Buffer {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return buffer;
}

// 50 ms frames at 16 kHz (the web client's batch size).
const LOUD_CHUNK = pcm(8_000);
const SILENT_CHUNK = pcm(0);

// ---------------------------------------------------------------------------
// Test doubles (mirrors the full-duplex suite)
// ---------------------------------------------------------------------------

class ControllableTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  stopped = false;
  started = false;
  readonly audio: Buffer[] = [];
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.started = true;
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer): void {
    this.audio.push(Buffer.from(audio));
  }

  stop(): void {
    this.stopped = true;
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }

  /** Emit a final transcript then close — the sequence that starts a turn. */
  finishUtterance(text: string, languages?: readonly string[]): void {
    this.emit({
      type: "final",
      text,
      ...(languages ? { languages } : {}),
    });
    this.emit({ type: "closed" });
  }
}

function makeStartFrame(
  overrides: Partial<LiveVoiceClientStartFrame> = {},
): LiveVoiceClientStartFrame {
  return {
    type: "start",
    conversationId: "conversation-123",
    audio: { mimeType: "audio/pcm", sampleRate: SAMPLE_RATE, channels: 1 },
    fullDuplex: true,
    ...overrides,
  } as LiveVoiceClientStartFrame;
}

function makeTtsChunk(text: string): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

/** A TTS chunk carrying real PCM, so it can seed the echo reference. */
function makePcmTtsChunk(audio: Buffer): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    dataBase64: audio.toString("base64"),
  };
}

/** PCM16LE sine tone at `frequencyHz`, `sampleCount` samples at 16 kHz. */
function tonePcm(
  amplitude: number,
  frequencyHz: number,
  sampleCount = 800,
): Buffer {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE),
    );
    buffer.writeInt16LE(sample, index * 2);
  }
  return buffer;
}

function makeTtsResult(text: string): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    chunks: 1,
    bytes: Buffer.byteLength(text),
  };
}

function makeTextDelta(
  text: string,
): Parameters<NonNullable<VoiceTurnCallbacks["assistant_text_delta"]>>[0] {
  return {
    type: "assistant_text_delta",
    text,
    conversationId: "conversation-123",
  };
}

function makeMessageComplete(
  messageId: string,
): Parameters<NonNullable<VoiceTurnCallbacks["message_complete"]>>[0] {
  return {
    type: "message_complete",
    conversationId: "conversation-123",
    messageId,
  };
}

interface TurnScript {
  responseText: string;
  assistantMessageId: string;
  /** When true, the turn is left in flight for the test to complete later. */
  leaveInFlight?: boolean;
}

function createHarness(options: {
  startFrame?: LiveVoiceClientStartFrame;
  silenceThresholdMs?: number;
  maxTurnDurationMs?: number;
  scripts?: TurnScript[];
  /** Custom turn starter; wins over the scripted default. */
  startVoiceTurn?: LiveVoiceTurnStarter;
  /** Custom TTS streamer; wins over the default one-chunk echo. */
  streamTtsAudio?: LiveVoiceTtsStreamer;
  /** Sustained-speech barge-in guard duration (option-level seed). */
  bargeInMinSpeechMs?: number;
  /**
   * Adaptive playback-echo classifier knobs (option-level seeds). The
   * harness defaults `echoBargeInMargin` to 1 (adaptation off) so the many
   * pre-classifier tests keep their fixed-threshold timing model, and
   * `echoDrainSlackMs` to 0 so their post-playback windows do not widen;
   * echo tests opt in explicitly.
   */
  echoBargeInMargin?: number;
  echoEmaHalfLifeMs?: number;
  echoDrainSlackMs?: number;
  /**
   * Enable the unified front door with these overrides (schema defaults fill
   * the rest). Absent = disabled, i.e. V-1a boundary behavior.
   */
  frontDoor?: Partial<LiveVoiceFrontDoorConfig>;
  /** Make resolveTranscriber throw this many times before succeeding. */
  failResolveTimes?: number;
  /** Config-level (daemon `liveVoice.vad`) barge-in guard override. */
  vadConfigBargeInMs?: number;
}) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame:
      options.startFrame ?? makeStartFrame({ turnDetection: "server_vad" }),
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const transcribers: ControllableTranscriber[] = [];
  let resolveFailuresLeft = options.failResolveTimes ?? 0;
  const failNextResolves = (n: number) => {
    resolveFailuresLeft = n;
  };
  const resolveTranscriber = mock(async () => {
    if (resolveFailuresLeft > 0) {
      resolveFailuresLeft--;
      throw new Error("Deepgram realtime connect timeout");
    }
    const transcriber = new ControllableTranscriber();
    transcribers.push(transcriber);
    return transcriber;
  });

  const scripts = options.scripts ?? [];
  let startCount = 0;
  const turnCalls: VoiceTurnOptions[] = [];
  // Callbacks of turns left in flight, completed later by the test.
  const pendingTurns: Array<{
    callbacks: VoiceTurnCallbacks | undefined;
    script: TurnScript;
  }> = [];

  const scriptedStartVoiceTurn: LiveVoiceTurnStarter = mock(
    async (opts: VoiceTurnOptions) => {
      const script = scripts[startCount] ?? {
        responseText: "Default reply.",
        assistantMessageId: `assistant-${startCount + 1}`,
      };
      startCount += 1;
      turnCalls.push(opts);
      if (script.leaveInFlight) {
        pendingTurns.push({ callbacks: opts.callbacks, script });
      } else {
        opts.callbacks?.assistant_text_delta?.(
          makeTextDelta(script.responseText),
        );
        opts.callbacks?.message_complete?.(
          makeMessageComplete(script.assistantMessageId),
        );
      }
      return { turnId: "bridge-turn", abort: mock() };
    },
  );
  const startVoiceTurn = options.startVoiceTurn ?? scriptedStartVoiceTurn;

  const ttsTexts: string[] = [];
  // Full option objects per synthesis call, so tests can assert on the
  // language hint alongside the text.
  const ttsRequests: LiveVoiceTtsOptions[] = [];
  const defaultStreamTtsAudio: LiveVoiceTtsStreamer = mock(
    async (opts: LiveVoiceTtsOptions) => {
      ttsTexts.push(opts.text);
      ttsRequests.push(opts);
      opts.onAudioChunk(makeTtsChunk(`audio:${opts.text}`));
      return makeTtsResult(opts.text);
    },
  );
  const streamTtsAudio = options.streamTtsAudio ?? defaultStreamTtsAudio;

  const liveVoiceConfig: LiveVoiceConfig | undefined =
    options.frontDoor || options.vadConfigBargeInMs !== undefined
      ? LiveVoiceConfigSchema.parse({
          ...(options.frontDoor
            ? { frontDoor: { enabled: true, ...options.frontDoor } }
            : {}),
          ...(options.vadConfigBargeInMs !== undefined
            ? { vad: { bargeInMinSpeechMs: options.vadConfigBargeInMs } }
            : {}),
        })
      : undefined;

  let turnNumber = 0;
  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn,
    streamTtsAudio,
    createTurnId: () => {
      turnNumber += 1;
      return `live-turn-${turnNumber}`;
    },
    ...(options.bargeInMinSpeechMs !== undefined
      ? { bargeInMinSpeechMs: options.bargeInMinSpeechMs }
      : {}),
    echoBargeInMargin: options.echoBargeInMargin ?? 1,
    echoDrainSlackMs: options.echoDrainSlackMs ?? 0,
    ...(options.echoEmaHalfLifeMs !== undefined
      ? { echoEmaHalfLifeMs: options.echoEmaHalfLifeMs }
      : {}),
    ...(liveVoiceConfig ? { liveVoiceConfig } : {}),
    turnDetectorConfig: {
      silenceThresholdMs: options.silenceThresholdMs ?? 40,
      ...(options.maxTurnDurationMs !== undefined
        ? { maxTurnDurationMs: options.maxTurnDurationMs }
        : {}),
    },
  });

  return {
    failNextResolves,
    session,
    frames,
    transcribers,
    turnCalls,
    pendingTurns,
    ttsTexts,
    ttsRequests,
    turnStartCount: () => startCount,
  };
}

function frameTypes(frames: LiveVoiceServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice VAD test condition",
  attempts = 120,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(message);
}

async function sendAudio(
  session: LiveVoiceSession,
  chunk: Buffer,
  times = 1,
): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await session.handleClientFrame({
      type: "audio",
      dataBase64: chunk.toString("base64"),
    });
  }
}

function countType(frames: LiveVoiceServerFrame[], type: string): number {
  return frames.filter((frame) => frame.type === type).length;
}

/** Let queued microtasks/macrotasks (frame sends, verdict handlers) settle. */
async function flushAsyncCallbacks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ready echo", () => {
  test("a server_vad session echoes turnDetection on ready", async () => {
    const h = createHarness({});
    await h.session.start();
    const ready = h.frames.find((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ turnDetection: "server_vad" });
  });

  test("a manual session echoes turnDetection manual", async () => {
    const h = createHarness({ startFrame: makeStartFrame() });
    await h.session.start();
    const ready = h.frames.find((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ turnDetection: "manual" });
  });
});

describe("server VAD ingress", () => {
  test("idle silence never reaches STT; onset flushes the pre-roll as leading context", async () => {
    const h = createHarness({});
    await h.session.start();

    // An open quiet mic: nothing may stream to the transcriber.
    await sendAudio(h.session, SILENT_CHUNK, 5);
    expect(h.transcribers[0]!.audio).toHaveLength(0);
    expect(frameTypes(h.frames)).not.toContain("speech_started");

    // Speech onset: speech_started fires and the parked silence flushes
    // AHEAD of the speech chunk, so STT hears the leading context.
    await sendAudio(h.session, LOUD_CHUNK);
    expect(frameTypes(h.frames)).toContain("speech_started");
    expect(h.transcribers[0]!.audio).toHaveLength(6);
    expect(h.transcribers[0]!.audio[5]!.equals(LOUD_CHUNK)).toBe(true);
  });

  test("the pre-roll ring is bounded (oldest idle silence evicted)", async () => {
    const h = createHarness({});
    await h.session.start();

    await sendAudio(h.session, SILENT_CHUNK, 40);
    await sendAudio(h.session, LOUD_CHUNK);
    // 25-chunk ring + the speech chunk itself.
    expect(h.transcribers[0]!.audio).toHaveLength(26);
  });

  test("the silence boundary emits utterance_end and starts the turn like ptt_release", async () => {
    const h = createHarness({});
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 3);
    // Trailing silence starts the detector countdown (40ms threshold).
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));

    const utteranceEnd = h.frames.find(
      (frame) => frame.type === "utterance_end",
    );
    expect(utteranceEnd).toMatchObject({ reason: "silence" });
    // The release stopped the transcriber, exactly like ptt_release.
    await waitFor(() => h.transcribers[0]!.stopped);

    // STT finalizes → the assistant turn starts on the transcript.
    h.transcribers[0]!.finishUtterance("what is on my calendar");
    await waitFor(() => h.turnStartCount() === 1);
    expect(h.turnCalls[0]!.content).toBe("what is on my calendar");

    // Frame order: onset before boundary, boundary before thinking.
    const types = frameTypes(h.frames);
    expect(types.indexOf("speech_started")).toBeLessThan(
      types.indexOf("utterance_end"),
    );
    expect(types.indexOf("utterance_end")).toBeLessThan(
      types.indexOf("thinking"),
    );
  });

  test("the max-duration hard cap force-ends a runaway turn", async () => {
    const h = createHarness({
      silenceThresholdMs: 5_000,
      maxTurnDurationMs: 60,
    });
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 2);
    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));
    expect(
      h.frames.find((frame) => frame.type === "utterance_end"),
    ).toMatchObject({ reason: "max-duration" });
  });

  test("multi-turn: the session re-arms and runs a second utterance→turn cycle", async () => {
    const h = createHarness({
      scripts: [
        { responseText: "First reply.", assistantMessageId: "assistant-1" },
        { responseText: "Second reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("first utterance");
    await waitFor(() => frameTypes(h.frames).includes("tts_done"));
    // Full-duplex loop-back resolved a fresh transcriber.
    await waitFor(() => h.transcribers.length === 2);

    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[1]!.stopped);
    h.transcribers[1]!.finishUtterance("second utterance");
    await waitFor(() => h.turnStartCount() === 2);
    expect(h.turnCalls[1]!.content).toBe("second utterance");
    expect(
      h.frames.filter((frame) => frame.type === "utterance_end"),
    ).toHaveLength(2);
  });

  test("speech after a transcriber idle-close re-arms listening (the two-exchange drop)", async () => {
    // Deepgram closes its realtime socket after ~30s without audio — routine
    // between exchanges, since idle silence never reaches STT. The regression:
    // the close parked the session in "transcriber_closed" and the next
    // utterance (speech, boundary and all) parked forever — the only other
    // re-arm runs at assistant-turn end, and no turn was running. Real calls
    // read as "voice works for two exchanges, then the room goes deaf".
    const h = createHarness({
      scripts: [
        { responseText: "First reply.", assistantMessageId: "assistant-1" },
        { responseText: "Second reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("first utterance");
    await waitFor(() => frameTypes(h.frames).includes("tts_done"));
    await waitFor(() => h.transcribers.length === 2);

    // The idle gap: the freshly armed transcriber times out and closes with
    // no utterance in flight.
    h.transcribers[1]!.emit({ type: "closed" });

    // New speech must resolve a fresh transcriber and run a full cycle.
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await waitFor(() => h.transcribers.length === 3);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[2]!.stopped);
    h.transcribers[2]!.finishUtterance("after the idle gap");
    await waitFor(() => h.turnStartCount() === 2);
    expect(h.turnCalls[1]!.content).toBe("after the idle gap");
    expect(
      h.frames.filter((frame) => frame.type === "utterance_end"),
    ).toHaveLength(2);
  });

  test("speech during an in-flight turn parks in the ring and flushes into the next cycle", async () => {
    const h = createHarness({
      scripts: [
        {
          responseText: "Slow reply.",
          assistantMessageId: "assistant-1",
          leaveInFlight: true,
        },
        { responseText: "Second reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await h.session.start();

    // Utterance 1 → turn 1 (left in flight).
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("first utterance");
    await waitFor(() => h.pendingTurns.length === 1);

    // The user speaks while the turn is still running: onset fires and the
    // speech parks (nothing streams — no live transcriber for it yet), and
    // the detector's boundary is recorded for replay.
    await sendAudio(h.session, LOUD_CHUNK, 2);
    expect(frameTypes(h.frames)).toContain("speech_started");
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(
      () =>
        h.frames.filter((frame) => frame.type === "utterance_end").length >= 1,
    );

    // Turn 1 completes; the loop-back arms transcriber 2 and the parked
    // speech flushes into it, its boundary replays, and turn 2 starts once
    // STT finalizes.
    const pending = h.pendingTurns[0]!;
    pending.callbacks?.assistant_text_delta?.(makeTextDelta("Slow reply."));
    pending.callbacks?.message_complete?.(makeMessageComplete("assistant-1"));
    await waitFor(() => h.transcribers.length === 2);
    await waitFor(() => h.transcribers[1]!.audio.length >= 2);
    await waitFor(
      () =>
        h.frames.filter((frame) => frame.type === "utterance_end").length >= 2,
    );
    await waitFor(() => h.transcribers[1]!.stopped);
    h.transcribers[1]!.finishUtterance("interjection");
    await waitFor(() => h.turnStartCount() === 2);
    expect(h.turnCalls[1]!.content).toBe("interjection");
  });
});

describe("manual override + update_config", () => {
  test("ptt_release forces the boundary in server_vad mode (one utterance_end, one turn)", async () => {
    const h = createHarness({ silenceThresholdMs: 5_000 });
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 2);
    await h.session.handleClientFrame({ type: "ptt_release" });

    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));
    expect(
      h.frames.filter((frame) => frame.type === "utterance_end"),
    ).toHaveLength(1);
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("released by hand");
    await waitFor(() => h.turnStartCount() === 1);
    expect(h.turnCalls[0]!.content).toBe("released by hand");
  });

  test("update_config retunes the detector thresholds live", async () => {
    const h = createHarness({ silenceThresholdMs: 5_000 });
    await h.session.start();
    expect(h.session.effectiveSilenceThresholdMs).toBe(5_000);

    await h.session.handleClientFrame({
      type: "update_config",
      silenceThresholdMs: 40,
      bargeInMinSpeechMs: 400,
    });
    expect(h.session.effectiveSilenceThresholdMs).toBe(40);
    expect(h.session.effectiveBargeInMinSpeechMs).toBe(400);

    // The retuned pause applies to the running detector: a 40ms silence now
    // ends the utterance that the 5s configuration would have held open.
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));
  });

  test("start-frame overrides win over injected detector config", async () => {
    const h = createHarness({
      startFrame: makeStartFrame({
        turnDetection: "server_vad",
        silenceThresholdMs: 900,
        bargeInMinSpeechMs: 150,
      }),
      silenceThresholdMs: 5_000,
    });
    await h.session.start();
    expect(h.session.effectiveSilenceThresholdMs).toBe(900);
    expect(h.session.effectiveBargeInMinSpeechMs).toBe(150);
  });
});

describe("capability gating", () => {
  test("a session that did not opt in NEVER receives server-VAD frames", async () => {
    const h = createHarness({ startFrame: makeStartFrame() });
    await h.session.start();

    // The manual path streams everything (silence included) directly — the
    // energy gate and pre-roll must not touch it.
    await sendAudio(h.session, SILENT_CHUNK, 2);
    await sendAudio(h.session, LOUD_CHUNK, 2);
    expect(h.transcribers[0]!.audio).toHaveLength(4);

    await h.session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("manual utterance");
    await waitFor(() => frameTypes(h.frames).includes("tts_done"));

    const types = frameTypes(h.frames);
    expect(types).not.toContain("speech_started");
    expect(types).not.toContain("utterance_end");
    expect(types).not.toContain("turn_cancelled");
    expect(h.turnCalls[0]!.content).toBe("manual utterance");
  });

  test("update_config is a no-op on a manual session", async () => {
    const h = createHarness({ startFrame: makeStartFrame() });
    await h.session.start();
    const before = h.session.effectiveSilenceThresholdMs;
    await h.session.handleClientFrame({
      type: "update_config",
      silenceThresholdMs: 200,
    });
    expect(h.session.effectiveSilenceThresholdMs).toBe(before);
  });
});

describe("empty utterance", () => {
  test("a noise-only utterance closes the turn answerless and re-arms listening", async () => {
    const h = createHarness({});
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    // STT heard nothing usable: close with no final.
    h.transcribers[0]!.emit({ type: "closed" });

    // The turn closes with a bare tts_done (no thinking, no assistant turn)
    // and the full-duplex loop re-arms a fresh transcriber.
    await waitFor(() => frameTypes(h.frames).includes("tts_done"));
    expect(h.turnStartCount()).toBe(0);
    expect(frameTypes(h.frames)).not.toContain("thinking");
    await waitFor(() => h.transcribers.length === 2);
  });
});

// ---------------------------------------------------------------------------
// V-1b — server-side sustained-speech barge-in
// ---------------------------------------------------------------------------

// 10 ms chunks at 16 kHz for fine-grained guard accounting. DUCKED models the
// browser's half-duplex echo canceller attenuating the user's voice below the
// energy gate while the assistant is playing.
const TEN_MS_LOUD = pcm(8_000, 160);
const TEN_MS_DUCKED = pcm(100, 160);
const TEN_MS_SILENT = pcm(0, 160);

describe("sustained-speech barge-in guard", () => {
  // Boots a session whose first turn is audibly speaking (its tts_audio
  // frame reached the client) — the state the guard protects. The silence
  // threshold is long, so detector timers stay out of the guard's
  // audio-duration accounting.
  function createSpeakingTurnHarness(options: {
    bargeInMinSpeechMs: number;
    echoBargeInMargin?: number;
    echoEmaHalfLifeMs?: number;
    echoDrainSlackMs?: number;
    /** Real PCM for the reply's tts_audio, so it can seed the echo reference. */
    ttsAudio?: Buffer;
    startFrame?: LiveVoiceClientStartFrame;
  }) {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (turnOptions: VoiceTurnOptions) => {
        callbacks ??= turnOptions.callbacks;
        return { turnId: "bridge-turn", abort };
      },
    );
    const streamTtsAudio: LiveVoiceTtsStreamer = mock(
      async (ttsOptions: LiveVoiceTtsOptions) => {
        ttsOptions.onAudioChunk(
          options.ttsAudio
            ? makePcmTtsChunk(options.ttsAudio)
            : makeTtsChunk("assistant audio"),
        );
        return makeTtsResult("assistant audio");
      },
    );
    const harness = createHarness({
      startVoiceTurn,
      streamTtsAudio,
      bargeInMinSpeechMs: options.bargeInMinSpeechMs,
      echoBargeInMargin: options.echoBargeInMargin ?? 1,
      echoEmaHalfLifeMs: options.echoEmaHalfLifeMs ?? 4,
      // Default 0 preserves the pre-classifier guard tests' timing model
      // (window = the exact playback tail). Echo tests pass 60 s so
      // wall-clock timing cannot race the window shut mid-test.
      echoDrainSlackMs: options.echoDrainSlackMs ?? 0,
      silenceThresholdMs: 5_000,
      ...(options.startFrame ? { startFrame: options.startFrame } : {}),
    });

    async function speakFirstReply(): Promise<void> {
      await harness.session.start();
      await sendAudio(harness.session, LOUD_CHUNK);
      await harness.session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() => harness.transcribers[0]!.stopped);
      harness.transcribers[0]!.finishUtterance("what's the weather");
      await waitFor(() =>
        harness.frames.some((frame) => frame.type === "thinking"),
      );
      callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
      await waitFor(() =>
        harness.frames.some((frame) => frame.type === "tts_audio"),
      );
    }

    function completeFirstReply(): void {
      callbacks?.message_complete?.(makeMessageComplete("assistant-1"));
    }

    return { ...harness, abort, speakFirstReply, completeFirstReply };
  }

  test("speech shorter than the guard leaves the speaking turn untouched", async () => {
    const { frames, session, abort, speakFirstReply, completeFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // 30 ms of speech then silence: never reaches the 60 ms guard.
    await sendAudio(session, TEN_MS_LOUD, 3);
    await sendAudio(session, TEN_MS_SILENT);
    await flushAsyncCallbacks();

    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(countType(frames, "speech_started")).toBe(1);
    expect(abort).not.toHaveBeenCalled();

    // The reply completes in full — the noise never flushed playback.
    completeFirstReply();
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();
  });

  test("sustained speech reaching the guard flushes playback and cancels the turn", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // 50 ms of consecutive speech: one chunk short of the 60 ms guard.
    await sendAudio(session, TEN_MS_LOUD, 5);
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(countType(frames, "speech_started")).toBe(1);
    expect(abort).not.toHaveBeenCalled();

    // The 6th consecutive chunk reaches 60 ms: the deferred speech_started
    // flushes playback and the turn cancels.
    await sendAudio(session, TEN_MS_LOUD);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );

    const types = frameTypes(frames);
    expect(countType(frames, "speech_started")).toBe(2);
    expect(types.lastIndexOf("speech_started")).toBeLessThan(
      types.indexOf("turn_cancelled"),
    );
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ type: "turn_cancelled", turnId: "live-turn-1" });
    await waitFor(() => abort.mock.calls.length === 1);
  });

  test("a brief sub-threshold gap does not reset the sustained-speech run", async () => {
    const { frames, session, speakFirstReply } = createSpeakingTurnHarness({
      bargeInMinSpeechMs: 60,
    });
    await speakFirstReply();

    // 50 ms of speech, then one ducked gap (10 ms — far shorter than
    // BARGE_IN_GAP_TOLERANCE_MS): it must NOT zero the run.
    await sendAudio(session, TEN_MS_LOUD, 5);
    await sendAudio(session, TEN_MS_DUCKED);
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);

    // A single further speech chunk carries the retained 50 ms run across
    // the gap to the 60 ms guard and cancels.
    await sendAudio(session, TEN_MS_LOUD);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
  });

  test("a gap longer than the tolerance resets the sustained-speech run", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // 50 ms of speech, then a ducked gap longer than the 200 ms tolerance
    // (25 chunks = 250 ms): a real pause, so the run resets. The harness
    // silence threshold is 5 s, so this is the gap-tolerance logic, not
    // utterance end.
    await sendAudio(session, TEN_MS_LOUD, 5);
    await sendAudio(session, TEN_MS_DUCKED, 25);
    // 50 ms more speech: accumulates from zero after the reset — the two
    // stretches do not sum across the long gap into a false barge-in.
    await sendAudio(session, TEN_MS_LOUD, 5);
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();

    // A 6th consecutive speech chunk completes a fresh 60 ms run.
    await sendAudio(session, TEN_MS_LOUD);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
  });

  test("a gap of exactly the tolerance is tolerated and does not reset the run", async () => {
    const { frames, session, speakFirstReply } = createSpeakingTurnHarness({
      bargeInMinSpeechMs: 60,
    });
    await speakFirstReply();

    // 50 ms of speech, then a ducked gap of exactly 200 ms (20 chunks). The
    // tolerance is inclusive — client PCM batching lands runs on the
    // boundary exactly — so this gap does not reset the accumulated speech.
    await sendAudio(session, TEN_MS_LOUD, 5);
    await sendAudio(session, TEN_MS_DUCKED, 20);
    await sendAudio(session, TEN_MS_LOUD);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
  });

  test("sparse periodic blips separated by boundary gaps do not accumulate into a barge-in", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 60 });
    await speakFirstReply();

    // A 10 ms blip every 200 ms models residual echo/noise, not sustained
    // speech: each blip clears the consecutive-gap timer while the boundary
    // gap escapes the per-gap reset. The duty-cycle ceiling (cumulative
    // tolerated silence > 60 ms * 4 = 240 ms) resets the run every few
    // cycles, so the blips never sum into a barge-in.
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await sendAudio(session, TEN_MS_LOUD);
      await sendAudio(session, TEN_MS_DUCKED, 20);
    }
    await flushAsyncCallbacks();
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();
  });

  test("bargeInMinSpeechMs 0 restores instant barge-in", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({ bargeInMinSpeechMs: 0 });
    await speakFirstReply();

    // A single 10 ms onset chunk cancels immediately — no accumulation.
    await sendAudio(session, TEN_MS_LOUD);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    const types = frameTypes(frames);
    expect(types.lastIndexOf("speech_started")).toBeLessThan(
      types.indexOf("turn_cancelled"),
    );
    await waitFor(() => abort.mock.calls.length === 1);
  });

  test("onset while listening is instant regardless of the guard", async () => {
    // A guard no amount of speech in this test could satisfy: any
    // speech_started at all proves the instant listening path.
    const h = createHarness({
      bargeInMinSpeechMs: 10_000,
      silenceThresholdMs: 5_000,
    });
    await h.session.start();
    await sendAudio(h.session, TEN_MS_LOUD);
    await waitFor(() => countType(h.frames, "speech_started") === 1);
  });

  test("the guard also covers the client playback tail after tts_done", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (turnOptions: VoiceTurnOptions) => {
        callbacks ??= turnOptions.callbacks;
        return { turnId: "bridge-turn", abort };
      },
    );
    // One full second of PCM: the server clears the turn on tts_done while
    // the client is still audibly draining this tail.
    const longTailChunk: LiveVoiceTtsAudioChunk = {
      type: "tts_audio",
      contentType: "audio/pcm",
      sampleRate: SAMPLE_RATE,
      dataBase64: Buffer.alloc(2 * SAMPLE_RATE).toString("base64"),
    };
    const streamTtsAudio: LiveVoiceTtsStreamer = mock(
      async (opts: LiveVoiceTtsOptions) => {
        opts.onAudioChunk(longTailChunk);
        return makeTtsResult("assistant audio");
      },
    );
    const { frames, session, transcribers } = createHarness({
      startVoiceTurn,
      streamTtsAudio,
      bargeInMinSpeechMs: 60,
      silenceThresholdMs: 5_000,
    });

    await session.start();
    await sendAudio(session, LOUD_CHUNK);
    await session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => transcribers[0]!.stopped);
    transcribers[0]!.finishUtterance("what's the weather");
    await waitFor(() => frames.some((frame) => frame.type === "thinking"));
    callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
    await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
    callbacks?.message_complete?.(makeMessageComplete("assistant-1"));
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
    const baseline = countType(frames, "speech_started");

    // A sub-guard noise blip during the drain window must not flush the
    // audible tail.
    await sendAudio(session, TEN_MS_LOUD, 3);
    await sendAudio(session, TEN_MS_SILENT);
    await flushAsyncCallbacks();
    expect(countType(frames, "speech_started")).toBe(baseline);

    // Sustained speech during the drain window trips the guard: the tail
    // flushes (speech_started) — with no turn left to cancel.
    await sendAudio(session, TEN_MS_LOUD, 6);
    await waitFor(() => countType(frames, "speech_started") === baseline + 1);
    expect(countType(frames, "turn_cancelled")).toBe(0);
    expect(abort).not.toHaveBeenCalled();
  });

  test("start-frame bargeInMinSpeechMs overrides the option value (0 → instant barge-in)", async () => {
    const { frames, session, abort, speakFirstReply } =
      createSpeakingTurnHarness({
        // The option (daemon config) would make barge-in near impossible…
        bargeInMinSpeechMs: 3_000,
        // …but the start-frame override disables the guard entirely.
        startFrame: makeStartFrame({
          turnDetection: "server_vad",
          bargeInMinSpeechMs: 0,
        }),
      });
    await speakFirstReply();

    await sendAudio(session, TEN_MS_LOUD);
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );
    await waitFor(() => abort.mock.calls.length === 1);
  });

  // Ported from upstream 9eaee435d7 (JARVIS-1296): the waveform-correlation
  // playback-echo classifier. 10 ms chunks at 16 kHz; the 200 Hz tone spans
  // exactly 2 periods per chunk, so concatenated chunks stay continuous and
  // correlate cleanly with the 2 s reference sent as the reply's tts_audio.
  describe("echo-adaptive barge-in", () => {
    const playbackEchoChunk = tonePcm(4_700, 200, 160);
    const bargeInSpeechChunk = tonePcm(9_400, 530, 160);
    const playbackReference = tonePcm(4_700, 200, SAMPLE_RATE * 2);

    test("steady loud playback echo does not interrupt the turn", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();
      const speechStartedBaseline = countType(frames, "speech_started");

      await sendAudio(session, playbackEchoChunk, 40);
      await flushAsyncCallbacks();

      expect(countType(frames, "speech_started")).toBe(speechStartedBaseline);
      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
    });

    test("speech above the learned echo margin still interrupts", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 400,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      await sendAudio(session, playbackEchoChunk, 25);
      await sendAudio(session, bargeInSpeechChunk, 8);

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("classified echo resets a partial guard run immediately", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 400,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      await sendAudio(session, playbackEchoChunk, 25);
      await sendAudio(session, bargeInSpeechChunk, 5);
      await sendAudio(session, playbackEchoChunk);
      await sendAudio(session, bargeInSpeechChunk);
      await flushAsyncCallbacks();

      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();

      await sendAudio(session, bargeInSpeechChunk, 5);
      await waitFor(() => countType(frames, "turn_cancelled") === 1);
    });

    test("quiet playback keeps fixed-threshold barge-in sensitivity", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      await sendAudio(session, pcm(200, 160), 31);
      await sendAudio(session, bargeInSpeechChunk, 7);

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("playback echo is never forwarded to transcription", async () => {
      const { frames, session, transcribers, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      const echoChunk = playbackEchoChunk;
      await sendAudio(session, echoChunk, 5);
      await sendAudio(session, bargeInSpeechChunk, 7);
      await waitFor(() => countType(frames, "turn_cancelled") === 1);

      expect(
        transcribers.some((transcriber) =>
          transcriber.audio.some((buffer) => buffer.equals(echoChunk)),
        ),
      ).toBe(false);
    });

    test("instant barge-in remains protected from onset echo", async () => {
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 0,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      await sendAudio(session, playbackEchoChunk, 30);
      await flushAsyncCallbacks();
      expect(countType(frames, "turn_cancelled")).toBe(0);

      await sendAudio(session, bargeInSpeechChunk);
      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("echo suppression covers the client playback tail", async () => {
      const { frames, session, abort, speakFirstReply, completeFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();
      completeFirstReply();
      await waitFor(() => frames.some((frame) => frame.type === "tts_done"));
      const speechStartedBaseline = countType(frames, "speech_started");

      await sendAudio(session, playbackEchoChunk, 40);
      await flushAsyncCallbacks();

      expect(countType(frames, "speech_started")).toBe(speechStartedBaseline);
      expect(countType(frames, "turn_cancelled")).toBe(0);
      expect(abort).not.toHaveBeenCalled();
    });

    test("speech at playback onset cannot seed its own echo threshold", async () => {
      const { frames, session, abort, speakFirstReply, transcribers } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 250,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 400,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
        });
      await speakFirstReply();

      // 300 ms of uncorrelated speech in one chunk: held as the onset probe,
      // released as a nonmatch, replayed through VAD, and long enough to
      // clear the 250 ms guard on its own.
      const onsetSpeech = tonePcm(9_400, 530, 4_800);
      await sendAudio(session, onsetSpeech);

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
      expect(
        transcribers.some((transcriber) =>
          transcriber.audio.some((buffer) => buffer.equals(onsetSpeech)),
        ),
      ).toBe(true);
    });

    test("speech already in progress bypasses playback warm-up", async () => {
      let callbacks: VoiceTurnCallbacks | undefined;
      const abort = mock();
      const startVoiceTurn: LiveVoiceTurnStarter = mock(
        async (turnOptions: VoiceTurnOptions) => {
          callbacks ??= turnOptions.callbacks;
          return { turnId: "bridge-turn", abort };
        },
      );
      const streamTtsAudio: LiveVoiceTtsStreamer = mock(
        async (ttsOptions: LiveVoiceTtsOptions) => {
          ttsOptions.onAudioChunk(makeTtsChunk("assistant audio"));
          return makeTtsResult("assistant audio");
        },
      );
      const { frames, session, transcribers } = createHarness({
        startVoiceTurn,
        streamTtsAudio,
        bargeInMinSpeechMs: 60,
        echoBargeInMargin: 1.5,
        echoEmaHalfLifeMs: 400,
        echoDrainSlackMs: 60_000,
        silenceThresholdMs: 5_000,
      });

      await session.start();
      await sendAudio(session, LOUD_CHUNK);
      await session.handleClientFrame({ type: "ptt_release" });
      await waitFor(() => transcribers[0]!.stopped);
      transcribers[0]!.finishUtterance("what's the weather");
      await waitFor(() => frames.some((frame) => frame.type === "thinking"));
      // 30 ms of speech BEFORE any playback: the guard run is live when the
      // playback window opens, so the carryover skips echo warm-up.
      await sendAudio(session, pcm(3_000, 160), 3);
      callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
      await waitFor(() => frames.some((frame) => frame.type === "tts_audio"));
      await sendAudio(session, pcm(3_000, 160), 3);

      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });

    test("an echoSafePlayback session bypasses the classifier entirely", async () => {
      // Same correlated-echo drive as the suppression test, but the client
      // declared echo-safe playback: its audio is already clean, so the
      // classifier must not run — sustained above-threshold audio counts as
      // speech and interrupts exactly as before the port.
      const { frames, session, abort, speakFirstReply } =
        createSpeakingTurnHarness({
          bargeInMinSpeechMs: 60,
          echoBargeInMargin: 1.5,
          echoEmaHalfLifeMs: 40,
          echoDrainSlackMs: 60_000,
          ttsAudio: playbackReference,
          startFrame: makeStartFrame({
            turnDetection: "server_vad",
            echoSafePlayback: true,
            bargeInMinSpeechMs: 60,
          }),
        });
      await speakFirstReply();

      await sendAudio(session, playbackEchoChunk, 10);
      await waitFor(() => countType(frames, "turn_cancelled") === 1);
      await waitFor(() => abort.mock.calls.length === 1);
    });
  });
});

describe("barge-in interrupted-request merge", () => {
  test("a thinking barge-in merges the interrupted request into the next turn's control prompt", async () => {
    const h = createHarness({
      bargeInMinSpeechMs: 60,
      scripts: [
        {
          responseText: "Slow reply.",
          assistantMessageId: "assistant-1",
          leaveInFlight: true,
        },
        { responseText: "Merged reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK);
    await h.session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("what's the weather");
    await waitFor(() => h.turnStartCount() === 1);

    // Sustained speech while the turn is still thinking (pre-TTS) aborts it.
    await sendAudio(h.session, TEN_MS_LOUD, 6);
    await waitFor(() =>
      h.frames.some((frame) => frame.type === "turn_cancelled"),
    );

    // The barge-in speech flushes into a fresh transcriber; its boundary
    // releases and the follow-up turn launches with the merge note.
    await waitFor(() => h.transcribers.length === 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[1]!.stopped);
    h.transcribers[1]!.finishUtterance("actually just tell me a joke");
    await waitFor(() => h.turnStartCount() === 2);

    expect(h.turnCalls[1]!.content).toBe("actually just tell me a joke");
    expect(h.turnCalls[1]!.voiceControlPrompt).toContain(
      'Their earlier request was: "what\'s the weather"',
    );
  });

  test("an ordinary turn carries no interruption merge context", async () => {
    const h = createHarness({});
    await h.session.start();
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("hello there");
    await waitFor(() => h.turnStartCount() === 1);
    expect(h.turnCalls[0]!.voiceControlPrompt).not.toContain(
      "interrupted your previous",
    );
  });

  test("a discarded barge-in utterance does not leak merge context into a later turn", async () => {
    const h = createHarness({
      bargeInMinSpeechMs: 60,
      scripts: [
        {
          responseText: "Slow reply.",
          assistantMessageId: "assistant-1",
          leaveInFlight: true,
        },
        { responseText: "Fresh reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK);
    await h.session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("what's the weather");
    await waitFor(() => h.turnStartCount() === 1);

    await sendAudio(h.session, TEN_MS_LOUD, 6);
    await waitFor(() =>
      h.frames.some((frame) => frame.type === "turn_cancelled"),
    );
    await waitFor(() => h.transcribers.length === 2);

    // The barge-in utterance transcribes to nothing (a cough): the empty
    // close discards it AND the merge context with it.
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[1]!.stopped);
    h.transcribers[1]!.emit({ type: "closed" });
    await waitFor(() => h.transcribers.length === 3);

    // A later, unrelated turn must not inherit the stale merge note.
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[2]!.stopped);
    h.transcribers[2]!.finishUtterance("tell me a joke");
    await waitFor(() => h.turnStartCount() === 2);
    expect(h.turnCalls[1]!.voiceControlPrompt).not.toContain(
      "interrupted your previous",
    );
  });

  test("a client interrupt after a barge-in drops the pending merge context", async () => {
    const h = createHarness({
      bargeInMinSpeechMs: 60,
      scripts: [
        {
          responseText: "Slow reply.",
          assistantMessageId: "assistant-1",
          leaveInFlight: true,
        },
        { responseText: "Fresh reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK);
    await h.session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("what's the weather");
    await waitFor(() => h.turnStartCount() === 1);

    await sendAudio(h.session, TEN_MS_LOUD, 6);
    await waitFor(() =>
      h.frames.some((frame) => frame.type === "turn_cancelled"),
    );

    // A client interrupt is a hard reset: the merge context dies with it.
    await h.session.handleClientFrame({ type: "interrupt" });
    await waitFor(() => h.transcribers.length >= 2);
    const t = h.transcribers[h.transcribers.length - 1]!;
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => t.stopped);
    t.finishUtterance("tell me a joke");
    await waitFor(() => h.turnStartCount() === 2);
    expect(h.turnCalls[1]!.voiceControlPrompt).not.toContain(
      "interrupted your previous",
    );
  });
});

// ---------------------------------------------------------------------------
// V-1c — unified front-door endpointing (speculative dispatch)
// ---------------------------------------------------------------------------

describe("unified front-door endpointing", () => {
  function spokenDeltaText(frames: LiveVoiceServerFrame[]): string {
    return frames
      .filter((frame) => frame.type === "assistant_text_delta")
      .map((frame) => (frame as { text: string }).text)
      .join("");
  }

  // A scriptable speculative starter: per-call delta scripts, with discard
  // tracked so hold-verdict rollback is observable.
  function makeVerdictTurnStarter(scripts: string[][]): {
    startVoiceTurn: LiveVoiceTurnStarter;
    calls: VoiceTurnOptions[];
    discard: ReturnType<typeof mock>;
  } {
    const calls: VoiceTurnOptions[] = [];
    const discard = mock(async () => {});
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      const script = scripts[calls.length - 1];
      // An empty script models a leg that stays in flight (no verdict, no
      // completion) — a non-empty one streams its deltas then completes.
      if (script && script.length > 0) {
        setTimeout(() => {
          for (const text of script) {
            options.callbacks?.assistant_text_delta?.(makeTextDelta(text));
          }
          options.callbacks?.message_complete?.(
            makeMessageComplete(`assistant-${calls.length}`),
          );
        }, 0);
      }
      return { turnId: `bridge-turn-${calls.length}`, abort: mock(), discard };
    };
    return { startVoiceTurn, calls, discard };
  }

  async function startWithPartial(
    h: ReturnType<typeof createHarness>,
    partialText = "hello wor",
  ): Promise<void> {
    await h.session.start();
    await waitFor(() => h.transcribers.length === 1);
    h.transcribers[0]!.emit({ type: "partial", text: partialText });
  }

  test("a chatty answer commits: the verdict leg IS the endpoint decision, frames follow commit order", async () => {
    const starter = makeVerdictTurnStarter([["Hey! Not much."]]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      frontDoor: {},
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));

    // Dispatched speculatively on the pre-finalize transcript, as the
    // front-door leg with the verdict rule.
    expect(starter.calls).toHaveLength(1);
    expect(starter.calls[0]).toMatchObject({
      content: "hello wor",
      routingLeg: "front-door",
      unifiedVerdict: true,
    });
    // Deferred boundary work lands at commit, before the first spoken delta.
    const types = frameTypes(h.frames);
    expect(types.indexOf("utterance_end")).toBeGreaterThan(-1);
    expect(types.indexOf("utterance_end")).toBeLessThan(
      types.indexOf("thinking"),
    );
    expect(types.indexOf("thinking")).toBeLessThan(
      types.indexOf("assistant_text_delta"),
    );
    expect(spokenDeltaText(h.frames)).toContain("Hey! Not much.");
    expect(starter.discard).not.toHaveBeenCalled();
  });

  test("with the flag off the boundary releases exactly as before (no speculation)", async () => {
    const h = createHarness({});
    await h.session.start();
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("hello world");
    await waitFor(() => h.turnStartCount() === 1);
    // No routing options on the flag-off path.
    expect(h.turnCalls[0]!.routingLeg).toBeUndefined();
    expect(h.turnCalls[0]!.unifiedVerdict).toBeUndefined();
    // utterance_end went out at the boundary, before any turn existed.
    const types = frameTypes(h.frames);
    expect(types.indexOf("utterance_end")).toBeLessThan(
      types.indexOf("thinking"),
    );
  });

  test("a hold verdict discards the leg silently and the extension replays the boundary", async () => {
    const starter = makeVerdictTurnStarter([["[0]"], ["Sure thing."]]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      frontDoor: { endpointExtensionMs: 30 },
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);

    // First leg returned the hold token: rollback, no user-visible frames.
    await waitFor(() => starter.discard.mock.calls.length === 1);
    expect(countType(h.frames, "utterance_end")).toBe(0);
    expect(countType(h.frames, "thinking")).toBe(0);
    expect(countType(h.frames, "assistant_text_delta")).toBe(0);

    // The extension elapses in continued silence: the boundary replays, the
    // second speculative leg answers, and the turn commits normally.
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));
    expect(starter.calls).toHaveLength(2);
    expect(countType(h.frames, "utterance_end")).toBe(1);
    expect(countType(h.frames, "thinking")).toBe(1);
    expect(spokenDeltaText(h.frames)).toContain("Sure thing.");
    // The spoken stream never contains the verdict token.
    expect(spokenDeltaText(h.frames)).not.toContain("[0]");
    // One hold per utterance: the replay leg is not offered the hold verdict
    // again — a second silence means the caller is done.
    expect(starter.calls[0]?.unifiedVerdict).toBe(true);
    expect(starter.calls[1]?.unifiedVerdict).toBeUndefined();
  });

  test("a verdict that misses the deadline commits the turn (fail-open)", async () => {
    // The leg never produces a verdict — a provider TTFT tail. The deadline
    // must commit the turn so the caller gets the thinking frame (and the
    // ack timer arms) instead of unbounded structural silence.
    const starter = makeVerdictTurnStarter([[]]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      frontDoor: {
        endpointDecisionTimeoutMs: 40,
        endpointExtensionMs: 60_000,
      },
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => starter.calls.length === 1);

    await waitFor(() => countType(h.frames, "thinking") === 1);
    expect(countType(h.frames, "utterance_end")).toBe(1);
    // Fail-open commits; nothing was discarded or rolled back.
    expect(starter.discard).not.toHaveBeenCalled();
  });

  test("a final that extends the held transcript replays the boundary immediately", async () => {
    const starter = makeVerdictTurnStarter([["[0]"], ["Got it."]]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      // Extension far beyond the test window: only the fresh-final path can
      // re-dispatch in time.
      frontDoor: { endpointExtensionMs: 60_000 },
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => starter.discard.mock.calls.length === 1);

    // The finalized transcript lands mid-extension and extends the partial
    // the hold judged ("hello wor"): the hold was judged on stale text, so
    // the boundary replays now instead of after the extension window.
    h.transcribers[0]!.emit({ type: "final", text: "hello world how are you" });
    await waitFor(() => starter.calls.length === 2);
    expect(starter.calls[1]?.content).toBe("hello world how are you");
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));
    expect(spokenDeltaText(h.frames)).toContain("Got it.");
  });

  test("speech resuming mid-verdict discards the leg and the utterance keeps accumulating", async () => {
    // First leg never produces a verdict (in flight); second answers.
    const starter = makeVerdictTurnStarter([[], ["Got it all."]]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      frontDoor: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => starter.calls.length === 1);

    // The caller keeps talking while the verdict is in flight: silent
    // discard, no frames for the abandoned leg.
    h.transcribers[0]!.emit({ type: "partial", text: "hello wor and more" });
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => starter.discard.mock.calls.length === 1);
    expect(countType(h.frames, "utterance_end")).toBe(0);
    expect(countType(h.frames, "thinking")).toBe(0);

    // The next silence re-speculates with the grown transcript and commits.
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));
    expect(starter.calls).toHaveLength(2);
    expect(starter.calls[1]?.content).toBe("hello wor and more");
    expect(countType(h.frames, "utterance_end")).toBe(1);
  });

  test("a discard that beats the bridge handle still rolls back the user row", async () => {
    const discard = mock(async () => {});
    const abort = mock();
    let resolveHandle: (() => void) | null = null;
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      if (calls.length === 1) {
        // The speculative leg's handle resolution is delayed past the
        // discard — models startVoiceTurn still inside its persist wait.
        await new Promise<void>((resolve) => {
          resolveHandle = resolve;
        });
        return { turnId: "bridge-slow", abort, discard };
      }
      return { turnId: `bridge-${calls.length}`, abort: mock() };
    };
    const h = createHarness({
      startVoiceTurn,
      frontDoor: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => calls.length === 1);

    // Speech resumes while the handle is still unresolved: the discard
    // finds handle === null and can only latch the request.
    h.transcribers[0]!.emit({ type: "partial", text: "hello wor and more" });
    await sendAudio(h.session, LOUD_CHUNK);

    // The handle finally arrives: it must complete the rollback via
    // discard(), not a plain abort that leaks the persisted user row.
    await waitFor(() => resolveHandle !== null);
    (resolveHandle as (() => void) | null)?.();
    await waitFor(() => discard.mock.calls.length === 1);
    expect(abort).not.toHaveBeenCalled();
  });

  test("a manual release during the verdict window commits the leg instead of discarding it", async () => {
    const discard = mock(async () => {});
    let callbacks: VoiceTurnCallbacks | undefined;
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      callbacks = options.callbacks;
      return { turnId: "bridge-manual", abort: mock(), discard };
    };
    const h = createHarness({
      startVoiceTurn,
      frontDoor: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => calls.length === 1);

    // The caller hits release while the verdict is still in flight: the
    // utterance releases immediately (utterance_end goes out now).
    await h.session.handleClientFrame({ type: "ptt_release" });
    expect(countType(h.frames, "utterance_end")).toBe(1);

    // The verdict arrives as a normal answer — the caller explicitly asked
    // to answer now, so it must commit into the released utterance.
    callbacks?.assistant_text_delta?.(makeTextDelta("Hi there."));
    callbacks?.message_complete?.(makeMessageComplete("assistant-1"));
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));

    expect(discard).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    // No duplicate utterance_end from the commit; the thinking frame and
    // the spoken answer still go out.
    expect(countType(h.frames, "utterance_end")).toBe(1);
    expect(countType(h.frames, "thinking")).toBe(1);
    expect(spokenDeltaText(h.frames)).toContain("Hi there.");
  });

  test("a hold verdict after a manual release relaunches a fresh leg on the released utterance", async () => {
    const discard = mock(async () => {});
    let firstCallbacks: VoiceTurnCallbacks | undefined;
    const calls: VoiceTurnOptions[] = [];
    const startVoiceTurn: LiveVoiceTurnStarter = async (options) => {
      calls.push(options);
      if (calls.length === 1) {
        firstCallbacks = options.callbacks;
        return { turnId: "bridge-held", abort: mock(), discard };
      }
      // The relaunched leg answers normally.
      setTimeout(() => {
        options.callbacks?.assistant_text_delta?.(
          makeTextDelta("Fresh answer."),
        );
        options.callbacks?.message_complete?.(
          makeMessageComplete("assistant-2"),
        );
      }, 0);
      return { turnId: `bridge-${calls.length}`, abort: mock() };
    };
    const h = createHarness({
      startVoiceTurn,
      frontDoor: { endpointExtensionMs: 5_000 },
    });

    await startWithPartial(h);
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => calls.length === 1);

    // The caller hits release; the finalized transcript lands with it.
    await h.session.handleClientFrame({ type: "ptt_release" });
    h.transcribers[0]!.finishUtterance("hello world");

    // The hold lands after the caller already said they were done: moot.
    // The held leg rolls back and a fresh leg answers the released
    // utterance instead of the turn dying with no response.
    firstCallbacks?.assistant_text_delta?.(makeTextDelta("[0]"));
    await waitFor(() => calls.length === 2);
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));

    expect(discard).toHaveBeenCalledTimes(1);
    expect(spokenDeltaText(h.frames)).toContain("Fresh answer.");
    expect(spokenDeltaText(h.frames)).not.toContain("[0]");
  });

  test("an escalate verdict speaks the capped bridge and hands off to the escalated leg", async () => {
    const starter = makeVerdictTurnStarter([
      ["[1] Let me check your email. And then some rambling past the cap."],
      ["Here's your inbox summary."],
    ]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      frontDoor: {},
    });

    await startWithPartial(h, "what's in my email");
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => starter.calls.length === 2);
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));

    // The escalated leg shares the turn: synthetic continuation content, the
    // escalated routing rule, and the exact bridge that was spoken.
    expect(starter.calls[1]).toMatchObject({
      content: ESCALATION_CONTINUATION_CONTENT,
      routingLeg: "escalated",
      spokenEscalationBridge: "Let me check your email.",
    });
    const spoken = spokenDeltaText(h.frames);
    // The caller hears the capped bridge, then the escalated answer — never
    // the verdict token or the post-cap rambling.
    expect(spoken).toContain("Let me check your email.");
    expect(spoken).toContain("Here's your inbox summary.");
    expect(spoken).not.toContain("[1]");
    expect(spoken).not.toContain("rambling");
    // Exactly one thinking frame: the escalated leg continues the SAME turn.
    expect(countType(h.frames, "thinking")).toBe(1);
    expect(countType(h.frames, "utterance_end")).toBe(1);
  });

  test("a front-door answer's held bracket tail is released at leg completion", async () => {
    // The marker holdback parks at a "[" that could still become a control
    // marker. On an ANSWER leg that bracket turned out to be real text, so
    // completion must release it rather than strand it — this is the same
    // rule the hub-stream gate's `finish()` follows, which is what keeps the
    // socket frames and the conversation-hub broadcast on the same text.
    const starter = makeVerdictTurnStarter([
      ["The last element is at index ["],
    ]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      frontDoor: {},
    });

    await startWithPartial(h, "which index is last");
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => h.frames.some((frame) => frame.type === "tts_done"));

    expect(spokenDeltaText(h.frames)).toBe("The last element is at index [");
  });

  test("a front-door leg that produced only an unresolved verdict prefix speaks nothing", async () => {
    // "[" alone never classified, so it is not speech: the leg ends silent
    // rather than emitting a stray bracket. The hub gate matches (its
    // `finish()` releases nothing while still `deciding`).
    const starter = makeVerdictTurnStarter([["["]]);
    const h = createHarness({
      startVoiceTurn: starter.startVoiceTurn,
      frontDoor: {},
    });

    await startWithPartial(h, "hello wor");
    await sendAudio(h.session, LOUD_CHUNK);
    await waitFor(() => starter.calls.length === 1);
    await flushAsyncCallbacks();
    await flushAsyncCallbacks();

    expect(spokenDeltaText(h.frames)).toBe("");
  });
});

describe("transcriber re-arm retry", () => {
  test("a transient connect failure during re-arm retries instead of ending the call", async () => {
    const h = createHarness({
      scripts: [{ responseText: "Reply.", assistantMessageId: "assistant-1" }],
      // The SESSION-START transcriber resolves fine; the first RE-ARM (after
      // the turn) fails once — like a Deepgram connect timeout mid-call —
      // and must be retried, not surfaced as a terminal failure.
      failResolveTimes: 0,
    });
    await h.session.start();
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    // Arm exactly one failure for the post-turn re-arm.
    h.failNextResolves(1);
    h.transcribers[0]!.finishUtterance("first utterance");
    await waitFor(() => frameTypes(h.frames).includes("tts_done"));
    // Despite the failed first attempt, the retry produced a fresh transcriber
    // and the session never emitted a terminal restart error. The first
    // retry backoff is 750ms, so give this wait a wider budget than default.
    await waitFor(
      () => h.transcribers.length === 2,
      "Timed out waiting for the re-arm retry to produce a fresh transcriber",
      600,
    );
    expect(restartErrorFrames(h.frames)).toHaveLength(0);
  });

  test("exhausting every re-arm attempt still fails honestly", async () => {
    const h = createHarness({
      scripts: [{ responseText: "Reply.", assistantMessageId: "assistant-1" }],
    });
    await h.session.start();
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => h.transcribers[0]!.stopped);
    // Arm more failures than the retry budget: every attempt fails.
    h.failNextResolves(10);
    h.transcribers[0]!.finishUtterance("first utterance");
    // 3 attempts with 750ms + 2000ms backoffs between them — wide budget.
    await waitFor(
      () => restartErrorFrames(h.frames).length > 0,
      "Timed out waiting for the exhausted re-arm to surface its error",
      1200,
    );
    expect(h.transcribers).toHaveLength(1);
    expect(restartErrorFrames(h.frames)[0]).toContain(
      "Deepgram realtime connect timeout",
    );
  });
});

/** Messages of `error` frames reporting a failed transcriber restart. */
function restartErrorFrames(frames: LiveVoiceServerFrame[]): string[] {
  return frames
    .filter(
      (frame): frame is LiveVoiceServerFrame & { message: string } =>
        frame.type === "error" &&
        typeof (frame as { message?: unknown }).message === "string",
    )
    .map((frame) => frame.message)
    .filter((message) => message.includes("could not be restarted"));
}

describe("barge-in re-arm race", () => {
  test("a barge-in arms exactly one fresh transcriber and the room keeps hearing", async () => {
    let callbacks: VoiceTurnCallbacks | undefined;
    const abort = mock();
    const startVoiceTurn: LiveVoiceTurnStarter = mock(
      async (turnOptions: VoiceTurnOptions) => {
        callbacks ??= turnOptions.callbacks;
        return { turnId: "bridge-turn", abort };
      },
    );
    const h = createHarness({
      startVoiceTurn,
      bargeInMinSpeechMs: 60,
      silenceThresholdMs: 5_000,
    });
    await h.session.start();
    await sendAudio(h.session, LOUD_CHUNK);
    await h.session.handleClientFrame({ type: "ptt_release" });
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("what's the weather");
    await waitFor(() => h.frames.some((f) => f.type === "thinking"));
    callbacks?.assistant_text_delta?.(makeTextDelta("It is sunny today."));
    await waitFor(() => h.frames.some((f) => f.type === "tts_audio"));

    // Sustained speech past the guard triggers the barge-in — the barge-in
    // handler re-arms, AND the cancelled turn's completion continuation
    // fires its own re-arm. Only one fresh transcriber may result.
    await sendAudio(h.session, pcm(8_000, 160), 10);
    await waitFor(() => h.frames.some((f) => f.type === "turn_cancelled"));
    callbacks?.message_complete?.(makeMessageComplete("assistant-1"));
    await flushAsyncCallbacks();
    await flushAsyncCallbacks();

    expect(h.transcribers).toHaveLength(2);

    // The room still hears: the fresh transcriber takes audio and a final
    // starts the next turn (deaf-room regression check).
    await waitFor(() => h.transcribers[1]!.started);
    await sendAudio(h.session, LOUD_CHUNK, 2);
    await waitFor(() => h.transcribers[1]!.audio.length > 0);
  });
});

describe("echo-safe clients vs the config barge-in stopgap", () => {
  test("echoSafePlayback gets the schema-default guard even when config raises it", async () => {
    const h = createHarness({
      startFrame: makeStartFrame({
        turnDetection: "server_vad",
        echoSafePlayback: true,
      } as Partial<LiveVoiceClientStartFrame>),
      vadConfigBargeInMs: 15000,
    });
    await h.session.start();
    expect(h.session.effectiveBargeInMinSpeechMs).toBe(250);
  });

  test("a client without the flag keeps the config stopgap", async () => {
    const h = createHarness({
      startFrame: makeStartFrame({ turnDetection: "server_vad" }),
      vadConfigBargeInMs: 15000,
    });
    await h.session.start();
    expect(h.session.effectiveBargeInMinSpeechMs).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Detected-language threading (multilinguality port)
// ---------------------------------------------------------------------------

describe("detected-language threading", () => {
  test("finals carrying languages feed the tally; the dominant language reaches the prompt and TTS", async () => {
    const h = createHarness({});
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 3);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));
    await waitFor(() => h.transcribers[0]!.stopped);

    // Three tagged finals: hi outvotes en (only the dominant entry of each
    // final's ranked list votes).
    const transcriber = h.transcribers[0]!;
    transcriber.emit({
      type: "final",
      text: "मुझे कल का शेड्यूल बताओ",
      languages: ["hi"],
    });
    transcriber.emit({ type: "final", text: "please", languages: ["en"] });
    transcriber.emit({ type: "final", text: "जल्दी", languages: ["hi", "en"] });
    transcriber.emit({ type: "closed" });

    await waitFor(() => h.turnStartCount() === 1);
    // The dispatched turn resolved "hi" once at dispatch: the control prompt
    // carries the detected-language note...
    expect(h.turnCalls[0]!.voiceControlPrompt).toContain(
      'language with code "hi"',
    );
    // ...and the reply's TTS synthesis carries the same language hint.
    await waitFor(() => h.ttsRequests.length > 0);
    expect(h.ttsRequests[0]!.language).toBe("hi");
  });

  test("a partial's tags cover a turn whose finals carried none", async () => {
    const h = createHarness({});
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 3);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));
    await waitFor(() => h.transcribers[0]!.stopped);

    const transcriber = h.transcribers[0]!;
    transcriber.emit({ type: "partial", text: "hola", languages: ["es"] });
    // Tag-less final: the tally stays empty, so the partial's detection wins.
    transcriber.finishUtterance("hola, ¿qué tal?");

    await waitFor(() => h.turnStartCount() === 1);
    expect(h.turnCalls[0]!.voiceControlPrompt).toContain(
      'language with code "es"',
    );
    await waitFor(() => h.ttsRequests.length > 0);
    expect(h.ttsRequests[0]!.language).toBe("es");
  });

  test("untagged utterances leave the turn language-neutral (no note, no hint)", async () => {
    const h = createHarness({});
    await h.session.start();

    await sendAudio(h.session, LOUD_CHUNK, 3);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));
    await waitFor(() => h.transcribers[0]!.stopped);

    h.transcribers[0]!.finishUtterance("what is on my calendar");

    await waitFor(() => h.turnStartCount() === 1);
    expect(h.turnCalls[0]!.voiceControlPrompt).not.toContain(
      "language with code",
    );
    await waitFor(() => h.ttsRequests.length > 0);
    expect(h.ttsRequests[0]!.language).toBeUndefined();
  });

  test("the language tally resets between utterances", async () => {
    const h = createHarness({
      scripts: [
        { responseText: "First reply.", assistantMessageId: "assistant-1" },
        { responseText: "Second reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await h.session.start();

    // First exchange: Hindi.
    await sendAudio(h.session, LOUD_CHUNK, 3);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => frameTypes(h.frames).includes("utterance_end"));
    await waitFor(() => h.transcribers[0]!.stopped);
    h.transcribers[0]!.finishUtterance("नमस्ते", ["hi"]);
    await waitFor(() => h.turnStartCount() === 1);
    await waitFor(() => countType(h.frames, "tts_done") === 1);

    // Second exchange: no tags — the previous turn's Hindi must not leak.
    await waitFor(() => h.transcribers.length === 2);
    await sendAudio(h.session, LOUD_CHUNK, 3);
    await sendAudio(h.session, SILENT_CHUNK);
    await waitFor(() => countType(h.frames, "utterance_end") === 2);
    await waitFor(() => h.transcribers[1]!.stopped);
    h.transcribers[1]!.finishUtterance("and tomorrow?");
    await waitFor(() => h.turnStartCount() === 2);

    expect(h.turnCalls[1]!.voiceControlPrompt).not.toContain(
      "language with code",
    );
  });
});
