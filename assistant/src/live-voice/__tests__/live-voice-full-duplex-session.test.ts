/**
 * Full-duplex (opt-in continuous) live-voice session behavior.
 *
 * Covers the opt-in `fullDuplex` start flag added for issue #53:
 * - DEFAULT (flag absent): byte-for-byte legacy single-turn behavior —
 *   post-`ptt_release` audio is rejected with `invalid_audio_payload`, and the
 *   session does NOT loop back after `tts_done`. This is the regression guard
 *   protecting old clients (macOS Swift client is not updated).
 * - FULL-DUPLEX (flag set): after `tts_done` the session re-arms a fresh
 *   transcriber and returns to listening; a second utterance produces a second
 *   turn with a fresh turnId; barge-in (`interrupt`) stops speaking and
 *   re-listens; explicit close tears everything down (no zombie transcriber);
 *   an inactivity timeout bounds an abandoned session.
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
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

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Controllable streaming transcriber: audio is captured; `final`/`closed` are
 * driven from the test rather than auto-emitted on `stop()`. This lets us model
 * a distinct utterance per turn.
 */
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

function makeStartFrame(fullDuplex: boolean): LiveVoiceClientStartFrame {
  return {
    type: "start",
    conversationId: "conversation-123",
    audio: { mimeType: "audio/pcm", sampleRate: 16_000, channels: 1 },
    ...(fullDuplex ? { fullDuplex: true } : {}),
  };
}

function createContext(fullDuplex: boolean): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  return {
    frames,
    context: {
      sessionId: "session-123",
      startFrame: makeStartFrame(fullDuplex),
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    },
  };
}

function makeTtsChunk(text: string): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: 16_000,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function makeTtsResult(text: string): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType: "audio/pcm",
    sampleRate: 16_000,
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
  /** Assistant text streamed for this turn (drives TTS). */
  responseText: string;
  /** Persisted assistant message id for this turn. */
  assistantMessageId: string;
  /**
   * When true, `message_complete` is NOT fired inline — the turn is left
   * in-flight so the test can barge-in mid-response.
   */
  leaveInFlight?: boolean;
}

interface Harness {
  session: LiveVoiceSession;
  frames: LiveVoiceServerFrame[];
  transcribers: ControllableTranscriber[];
  /** How many assistant turns have been started so far. */
  turnStartCount(): number;
  ttsTexts: string[];
}

function createHarness(options: {
  fullDuplex: boolean;
  turnIds?: string[];
  fullDuplexIdleTimeoutMs?: number;
  /** Scripted assistant responses, one per turn. */
  scripts?: TurnScript[];
}): Harness {
  const { context, frames } = createContext(options.fullDuplex);
  const transcribers: ControllableTranscriber[] = [];
  const ttsTexts: string[] = [];
  let startCount = 0;

  const resolveTranscriber = mock(async () => {
    const transcriber = new ControllableTranscriber();
    transcribers.push(transcriber);
    return transcriber;
  });

  const scripts = options.scripts ?? [];

  // The bridge normally streams the assistant response asynchronously; here we
  // drive the scripted response for this turn inline so tests do not have to
  // hold a (soon-stale) reference to per-turn callbacks across loop-backs.
  const startVoiceTurn: LiveVoiceTurnStarter = mock(
    async (opts: VoiceTurnOptions) => {
      const script = scripts[startCount] ?? {
        responseText: "Default reply.",
        assistantMessageId: `assistant-${startCount + 1}`,
      };
      startCount += 1;
      opts.callbacks?.assistant_text_delta?.(
        makeTextDelta(script.responseText),
      );
      if (!script.leaveInFlight) {
        opts.callbacks?.message_complete?.(
          makeMessageComplete(script.assistantMessageId),
        );
      }
      return { turnId: "bridge-turn", abort: mock() };
    },
  );

  const streamTtsAudio: LiveVoiceTtsStreamer = mock(
    async (opts: LiveVoiceTtsOptions) => {
      ttsTexts.push(opts.text);
      opts.onAudioChunk(makeTtsChunk(`audio:${opts.text}`));
      return makeTtsResult(opts.text);
    },
  );

  const turnIds = options.turnIds ?? ["turn-1", "turn-2", "turn-3"];
  let turnIndex = 0;

  const session = new LiveVoiceSession(context, {
    resolveTranscriber,
    startVoiceTurn,
    streamTtsAudio,
    createTurnId: () => turnIds[turnIndex++] ?? `turn-${turnIndex}`,
    ...(options.fullDuplexIdleTimeoutMs !== undefined
      ? { fullDuplexIdleTimeoutMs: options.fullDuplexIdleTimeoutMs }
      : {}),
  });

  return {
    session,
    frames,
    transcribers,
    turnStartCount: () => startCount,
    ttsTexts,
  };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice test condition",
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function frameTypes(frames: LiveVoiceServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

/**
 * Drive one utterance: audio → release → final transcript. The scripted
 * assistant response (see harness `scripts`) fires inline from `startVoiceTurn`.
 */
async function runUtterance(
  harness: Harness,
  transcriberIndex: number,
  utterance: string,
): Promise<void> {
  const startCountBefore = harness.turnStartCount();
  await harness.session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
  await harness.session.handleClientFrame({ type: "ptt_release" });
  const transcriber = harness.transcribers[transcriberIndex];
  if (!transcriber) throw new Error("transcriber not resolved");
  transcriber.finishUtterance(utterance);
  await waitFor(
    () => harness.turnStartCount() > startCountBefore,
    "assistant turn did not start for utterance",
  );
}

// ---------------------------------------------------------------------------
// Default (half-duplex) regression guard
// ---------------------------------------------------------------------------

describe("LiveVoiceSession default (half-duplex) — unchanged", () => {
  test("rejects audio after ptt_release with invalid_audio_payload", async () => {
    const harness = createHarness({ fullDuplex: false });
    await harness.session.start();
    await harness.session.handleClientFrame({ type: "ptt_release" });

    await harness.session.handleBinaryAudio(new Uint8Array([9, 9, 9, 9]));

    const errorFrame = harness.frames.find((frame) => frame.type === "error");
    expect(errorFrame).toMatchObject({
      type: "error",
      code: "invalid_audio_payload",
      message: expect.stringContaining("after push-to-talk release"),
    });
  });

  test("does NOT loop back to listening after tts_done (no fresh transcriber)", async () => {
    const harness = createHarness({
      fullDuplex: false,
      turnIds: ["turn-1", "turn-2"],
      scripts: [
        { responseText: "Hi there.", assistantMessageId: "assistant-1" },
      ],
    });
    await harness.session.start();
    await runUtterance(harness, 0, "hello");
    await waitFor(() =>
      harness.frames.some((frame) => frame.type === "tts_done"),
    );

    // Only the single startup transcriber was ever resolved — no loop-back.
    expect(harness.transcribers).toHaveLength(1);
    // A late audio frame is still rejected (session is terminal for input).
    await harness.session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
    expect(
      harness.frames.filter((frame) => frame.type === "error"),
    ).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full-duplex looping
// ---------------------------------------------------------------------------

describe("LiveVoiceSession full-duplex — continuous session", () => {
  test("loops back to listening after tts_done with a fresh transcriber", async () => {
    const harness = createHarness({
      fullDuplex: true,
      scripts: [
        { responseText: "First reply.", assistantMessageId: "assistant-1" },
      ],
    });
    await harness.session.start();
    expect(harness.transcribers).toHaveLength(1);

    await runUtterance(harness, 0, "first utterance");
    await waitFor(() =>
      harness.frames.some((frame) => frame.type === "tts_done"),
    );

    // A second transcriber is resolved for the next turn (loop-back happened).
    await waitFor(() => harness.transcribers.length === 2);
    expect(harness.transcribers[1]?.started).toBe(true);
    // Post-release audio is now accepted (no invalid_audio_payload error).
    expect(
      harness.frames.some(
        (frame) =>
          frame.type === "error" && frame.code === "invalid_audio_payload",
      ),
    ).toBe(false);
  });

  test("a second utterance produces a second turn with a fresh turnId", async () => {
    const harness = createHarness({
      fullDuplex: true,
      turnIds: ["turn-1", "turn-2"],
      scripts: [
        { responseText: "First reply.", assistantMessageId: "assistant-1" },
        { responseText: "Second reply.", assistantMessageId: "assistant-2" },
      ],
    });
    await harness.session.start();

    await runUtterance(harness, 0, "first");
    await waitFor(() =>
      harness.frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "turn-1",
      ),
    );
    await waitFor(() => harness.transcribers.length === 2);

    await runUtterance(harness, 1, "second");
    await waitFor(() =>
      harness.frames.some(
        (frame) => frame.type === "tts_done" && frame.turnId === "turn-2",
      ),
    );

    const thinkingTurnIds = harness.frames
      .filter((frame) => frame.type === "thinking")
      .map((frame) => (frame as { turnId: string }).turnId);
    expect(thinkingTurnIds).toEqual(["turn-1", "turn-2"]);

    const ttsDoneTurnIds = harness.frames
      .filter((frame) => frame.type === "tts_done")
      .map((frame) => (frame as { turnId: string }).turnId);
    expect(ttsDoneTurnIds).toEqual(["turn-1", "turn-2"]);
  });

  test("barge-in (interrupt) stops speaking and re-arms listening", async () => {
    const harness = createHarness({
      fullDuplex: true,
      // The first turn streams text but never completes — we barge in mid-response.
      scripts: [
        {
          responseText: "Once upon a time.",
          assistantMessageId: "assistant-1",
          leaveInFlight: true,
        },
      ],
    });
    await harness.session.start();

    await runUtterance(harness, 0, "tell me a long story");
    await waitFor(() =>
      harness.frames.some((frame) => frame.type === "tts_audio"),
    );

    await harness.session.handleClientFrame({ type: "interrupt" });

    // The interrupt re-arms a fresh transcriber for the barge-in utterance.
    await waitFor(() => harness.transcribers.length === 2);
    expect(harness.transcribers[1]?.started).toBe(true);
    // No terminal error surfaced from the barge-in.
    expect(
      harness.frames.some(
        (frame) =>
          frame.type === "error" && frame.code === "invalid_audio_payload",
      ),
    ).toBe(false);
  });

  test("explicit close tears everything down — no zombie transcriber", async () => {
    const harness = createHarness({
      fullDuplex: true,
      scripts: [
        { responseText: "First reply.", assistantMessageId: "assistant-1" },
      ],
    });
    await harness.session.start();
    await runUtterance(harness, 0, "first");
    await waitFor(() =>
      harness.frames.some((frame) => frame.type === "tts_done"),
    );
    await waitFor(() => harness.transcribers.length === 2);

    await harness.session.close("client_end");

    // Every resolved transcriber is stopped after close.
    for (const transcriber of harness.transcribers) {
      expect(transcriber.stopped).toBe(true);
    }
    // Audio after close is a silent no-op (session is terminal).
    const errorsBefore = harness.frames.filter(
      (frame) => frame.type === "error",
    ).length;
    await harness.session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
    expect(
      harness.frames.filter((frame) => frame.type === "error"),
    ).toHaveLength(errorsBefore);
  });

  test("inactivity timeout bounds an abandoned full-duplex session", async () => {
    const harness = createHarness({
      fullDuplex: true,
      fullDuplexIdleTimeoutMs: 20,
    });
    await harness.session.start();

    await waitFor(
      () =>
        harness.frames.some(
          (frame) =>
            frame.type === "error" &&
            frame.message.includes("inactivity timeout"),
        ),
      "idle timeout did not fire",
    );
    // The startup transcriber was stopped when the session failed.
    expect(harness.transcribers[0]?.stopped).toBe(true);
  });

  test("startup ready frame is still emitted for full-duplex sessions", async () => {
    const harness = createHarness({
      fullDuplex: true,
      fullDuplexIdleTimeoutMs: 10_000,
    });
    await harness.session.start();
    expect(frameTypes(harness.frames)).toContain("ready");
    await harness.session.close("client_end");
  });
});
