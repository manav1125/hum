import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

import { initializeDb } from "../../memory/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceStreamingTranscriberResolver,
} from "../live-voice-session.js";
import {
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionStartupError,
} from "../live-voice-session-manager.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

// `LiveVoiceSession` ensures a `conversations` row on start — the first turn's
// insert has a FOREIGN KEY to it — so these tests need a real schema. Without
// one the start path throws "no such table: conversations", and because that
// throw is caught upstream every assertion about transcription reads as a
// transcription failure instead of as the missing table it is.
initializeDb();

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly audioChunks: Buffer[] = [];
  readonly mimeTypes: string[] = [];
  started = false;
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.started = true;
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    this.audioChunks.push(audio);
    this.mimeTypes.push(mimeType);
    this.onEvent?.({
      type: "partial",
      text: `partial-${this.audioChunks.length}`,
    });
  }

  stop(): void {
    this.stopped = true;
    this.onEvent?.({ type: "final", text: "final transcript" });
    this.onEvent?.({ type: "closed" });
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function createContext(overrides: Partial<LiveVoiceClientStartFrame> = {}): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const startFrame = {
    ...START_FRAME,
    ...overrides,
  } as LiveVoiceClientStartFrame;

  return {
    frames,
    context: {
      sessionId: "session-123",
      startFrame,
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    },
  };
}

function createSessionWithTranscriber(
  transcriber = new MockStreamingTranscriber(),
) {
  const { context, frames } = createContext();
  const resolver = mock(async () => transcriber);
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: resolver,
  });
  return { frames, resolver, session, transcriber };
}

describe("LiveVoiceSession STT", () => {
  test("resolves streaming STT through the injected resolver and sends ready", async () => {
    const { frames, resolver, session, transcriber } =
      createSessionWithTranscriber();

    await session.start();

    expect(resolver).toHaveBeenCalledWith({ sampleRate: 24_000 });
    expect(transcriber.started).toBe(true);
    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-123",
        conversationId: "conversation-123",
        // A session that never asked for server_vad echoes manual.
        turnDetection: "manual",
        // The cascade accepts mid-call camera photos.
        attachImage: true,
      },
    ]);
  });

  test("forwards binary audio to the transcriber and emits STT frames", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3]));
    transcriber.emit({ type: "final", text: "hello world" });
    await session.handleClientFrame({ type: "ptt_release" });

    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([
      [1, 2, 3],
    ]);
    expect(transcriber.mimeTypes).toEqual(["audio/pcm"]);
    expect(frames.map((frame) => frame.type)).toEqual([
      "ready",
      "stt_partial",
      "stt_final",
      "stt_final",
    ]);
    expect(frames[1]).toMatchObject({
      type: "stt_partial",
      seq: 2,
      text: "partial-1",
    });
    expect(frames[2]).toMatchObject({
      type: "stt_final",
      seq: 3,
      text: "hello world",
    });
    expect(session.finalTranscriptText).toBe("hello world final transcript");
  });

  test("treats ptt_release as end-of-utterance and rejects later audio", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1]));
    await session.handleClientFrame({ type: "ptt_release" });
    await session.handleBinaryAudio(new Uint8Array([2]));
    await session.handleClientFrame({
      type: "audio",
      dataBase64: Buffer.from([3]).toString("base64"),
    });

    expect(transcriber.stopped).toBe(true);
    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([[1]]);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([
      {
        type: "error",
        seq: 4,
        code: "invalid_audio_payload",
        message: "Live voice audio received after push-to-talk release.",
      },
      {
        type: "error",
        seq: 5,
        code: "invalid_audio_payload",
        message: "Live voice audio received after push-to-talk release.",
      },
    ]);
  });

  test("returns a readable error frame when streaming STT is unavailable", async () => {
    const { context, frames } = createContext();
    const resolver = mock(async () => null);
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "error",
      code: "invalid_field",
    });
    const [errorFrame] = frames;
    if (errorFrame?.type !== "error") {
      throw new Error("Expected a live voice error frame");
    }
    expect(errorFrame.message).toContain(
      "Live voice transcription is unavailable",
    );
    expect(errorFrame.message).toContain("credentials configured");
  });

  test("returns a readable error frame when provider setup throws", async () => {
    const { context, frames } = createContext();
    const resolver: LiveVoiceStreamingTranscriberResolver = mock(async () => {
      throw new Error("provider credentials rejected");
    });
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: resolver,
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    expect(frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "invalid_field",
        message:
          "Live voice transcription could not be started: provider credentials rejected",
      },
    ]);
  });

  // An utterance that transcribes to nothing (a cough, a door, background noise
  // that tripped the client's automatic push-to-talk release) has no assistant
  // turn to run — but the turn still has to be CLOSED. The transcriber was
  // stopped by `ptt_release`, so a full-duplex session that just returned was
  // alive on the socket and permanently deaf: no `tts_done`, no re-arm, and the
  // call silently stopped working until the inactivity timeout killed it.
  test("an empty transcript closes the turn and re-arms a full-duplex session", async () => {
    /** Hears only silence: no partials, and no final on stop. */
    class SilentTranscriber implements StreamingTranscriber {
      readonly providerId = "deepgram" as const;
      readonly boundaryId = "daemon-streaming" as const;
      readonly audioChunks: Buffer[] = [];
      private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

      async start(onEvent: (event: SttStreamServerEvent) => void) {
        this.onEvent = onEvent;
      }
      sendAudio(audio: Buffer): void {
        this.audioChunks.push(audio);
      }
      stop(): void {
        this.onEvent?.({ type: "closed" });
      }
    }

    const { context, frames } = createContext({ fullDuplex: true });
    const transcribers: SilentTranscriber[] = [];
    const startVoiceTurn = mock(async () => ({
      turnId: "bridge-turn-1",
      abort: mock(),
    }));
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => {
        const t = new SilentTranscriber();
        transcribers.push(t);
        return t;
      }),
      startVoiceTurn,
      emitMetrics: false,
    });

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3]));
    await session.handleClientFrame({ type: "ptt_release" });
    // The transcriber's `closed` event is dispatched into an async handler, and
    // re-arming resolves a fresh transcriber.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The turn is closed on the wire, so the client leaves `transcribing`.
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(true);

    // And the session really can hear again: a second transcriber is armed and
    // post-release audio reaches it.
    expect(transcribers).toHaveLength(2);
    await session.handleBinaryAudio(new Uint8Array([4, 5, 6]));
    expect(transcribers[1]?.audioChunks.map((chunk) => [...chunk])).toEqual([
      [4, 5, 6],
    ]);
  });

  // A transcriber `error` event is explicitly non-terminal — providers like
  // OpenAI Whisper emit one for a transient poll failure and keep streaming.
  // The wire had no way to say so, so the client ended the call on a hiccup the
  // daemon had already absorbed: live conversations dropped mid-sentence.
  test("marks a recovered transcriber error non-fatal so the client keeps the session", async () => {
    const { frames, session, transcriber } = createSessionWithTranscriber();

    await session.start();
    transcriber.emit({
      type: "error",
      category: "provider-error",
      message: "poll failed",
    });
    // Transcriber events are dispatched into an async handler.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frames.filter((frame) => frame.type === "error")).toEqual([
      {
        type: "error",
        seq: 2,
        code: "invalid_field",
        message: "poll failed",
        fatal: false,
      },
    ]);

    // The session really is still running: audio still reaches the transcriber
    // and the turn still completes.
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3]));
    expect(transcriber.audioChunks.map((chunk) => [...chunk])).toEqual([
      [1, 2, 3],
    ]);
  });

  test("retains transcriber handle when stop() throws so close() can clean up", async () => {
    class ThrowingStopTranscriber extends MockStreamingTranscriber {
      stopCalls = 0;
      override stop(): void {
        this.stopCalls += 1;
        if (this.stopCalls === 1) {
          throw new Error("stop failed");
        }
      }
    }

    const transcriber = new ThrowingStopTranscriber();
    const { frames, session } = createSessionWithTranscriber(transcriber);

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });

    expect(transcriber.stopCalls).toBe(1);
    expect(
      frames.some(
        (frame) =>
          frame.type === "error" &&
          frame.message.includes(
            "Live voice transcription could not be stopped",
          ),
      ),
    ).toBe(true);

    await session.close("websocket_close");

    expect(transcriber.stopCalls).toBe(2);
  });

  test("retains transcriber handle when stop() throws so interrupt() can clean up", async () => {
    class ThrowingStopTranscriber extends MockStreamingTranscriber {
      stopCalls = 0;
      override stop(): void {
        this.stopCalls += 1;
        if (this.stopCalls === 1) {
          throw new Error("stop failed");
        }
      }
    }

    const transcriber = new ThrowingStopTranscriber();
    const { session } = createSessionWithTranscriber(transcriber);

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });

    expect(transcriber.stopCalls).toBe(1);

    await session.handleClientFrame({ type: "interrupt" });

    expect(transcriber.stopCalls).toBe(2);
  });

  test("uses the production streaming transcriber resolver by default", () => {
    const source = readFileSync(
      new URL("../live-voice-session.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("resolveStreamingTranscriber");
    expect(source).not.toMatch(/from\s+["']@anthropic-ai\/sdk/);
    expect(source).not.toMatch(/from\s+["']openai/);
    expect(source).not.toMatch(/from\s+["']@google\/genai/);
    expect(source).not.toMatch(/fetch\(/);
  });
});
