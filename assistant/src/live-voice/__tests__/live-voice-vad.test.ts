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
 *   `utterance_end`, and its manual path is byte-for-byte unchanged.
 * - Speech landing while a turn is in flight parks in the ring and flushes
 *   into the next armed listening turn (with its boundary replayed).
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
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
  finishUtterance(text: string): void {
    this.emit({ type: "final", text });
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
  const resolveTranscriber = mock(async () => {
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

  const startVoiceTurn: LiveVoiceTurnStarter = mock(
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

  const ttsTexts: string[] = [];
  const streamTtsAudio: LiveVoiceTtsStreamer = mock(
    async (opts: LiveVoiceTtsOptions) => {
      ttsTexts.push(opts.text);
      opts.onAudioChunk(makeTtsChunk(`audio:${opts.text}`));
      return makeTtsResult(opts.text);
    },
  );

  let turnNumber = 0;
  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn,
    streamTtsAudio,
    createTurnId: () => {
      turnNumber += 1;
      return `live-turn-${turnNumber}`;
    },
    turnDetectorConfig: {
      silenceThresholdMs: options.silenceThresholdMs ?? 40,
      ...(options.maxTurnDurationMs !== undefined
        ? { maxTurnDurationMs: options.maxTurnDurationMs }
        : {}),
    },
  });

  return {
    session,
    frames,
    transcribers,
    turnCalls,
    pendingTurns,
    ttsTexts,
    turnStartCount: () => startCount,
  };
}

function frameTypes(frames: LiveVoiceServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice VAD test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
