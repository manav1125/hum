/**
 * A TURN can fail without the CONVERSATION failing.
 *
 * Every way a turn could go wrong used to end the whole call, and it ended it
 * twice over: the `error` frame carried no severity so the client tore the
 * session down on it, and even a client that ignored the frame was left deaf,
 * because the turn ended with no `tts_done` — the client's only "this turn is
 * over" signal — and with no fresh transcriber on the daemon side (the previous
 * one was stopped at `ptt_release`). One bad turn read as "the conversation
 * randomly drops out", which is exactly what the owner kept reporting.
 *
 * These drive a real `LiveVoiceSession` in full-duplex and assert the recovery
 * that makes the non-fatal marking honest: the turn is CLOSED on the wire and a
 * second transcriber is armed, so the session can genuinely hear the next
 * utterance. A failure the daemon cannot recover from must still be fatal —
 * `beginNextListeningTurn` failing sends its own fatal error, and the last test
 * here pins that so this never becomes a blanket downgrade.
 */

import { describe, expect, mock, test } from "bun:test";

import type { VoiceTurnOptions } from "../../calls/voice-session-bridge.js";
import { initializeDb } from "../../memory/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceSessionOptions,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

// The session ensures a `conversations` row on start; the first turn's user
// message has a FOREIGN KEY to it.
initializeDb();

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  fullDuplex: true,
  audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
} as const satisfies LiveVoiceClientStartFrame;

/** Hands back "hello" on stop, so `ptt_release` produces a real utterance. */
class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly audioChunks: Buffer[] = [];
  stopped = false;
  sendAudioThrows: Error | null = null;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(private readonly stopEvents: SttStreamServerEvent[] = []) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer): void {
    if (this.sendAudioThrows) throw this.sendAudioThrows;
    this.audioChunks.push(audio);
  }

  stop(): void {
    this.stopped = true;
    for (const event of this.stopEvents) this.onEvent?.(event);
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function defaultStopEvents(): SttStreamServerEvent[] {
  return [{ type: "final", text: "hello" }, { type: "closed" }];
}

function createHarness(options: {
  startVoiceTurn?: (opts: VoiceTurnOptions) => Promise<{
    turnId: string;
    abort: () => void;
  }>;
  transcribers?: MockStreamingTranscriber[];
  streamTtsAudio?: LiveVoiceSessionOptions["streamTtsAudio"];
  resolveTranscriber?: () => Promise<StreamingTranscriber | null>;
}) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  // Every re-arm resolves a BRAND-NEW transcriber; the array is how a test sees
  // whether the session really got its hearing back.
  const transcribers = options.transcribers ?? [];
  const resolveTranscriber =
    options.resolveTranscriber ??
    (async () => {
      const t = new MockStreamingTranscriber(defaultStopEvents());
      transcribers.push(t);
      return t;
    });

  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(resolveTranscriber),
    startVoiceTurn: mock(
      options.startVoiceTurn ??
        (async () => ({ turnId: "bridge-turn-1", abort: mock() })),
    ),
    createTurnId: () => `live-turn-${transcribers.length}`,
    emitMetrics: false,
    ...(options.streamTtsAudio
      ? { streamTtsAudio: options.streamTtsAudio }
      : {}),
  });

  return { context, frames, session, transcribers };
}

async function waitFor(
  predicate: () => boolean,
  message = "timed out waiting for the session to recover",
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function errorFrames(frames: LiveVoiceServerFrame[]) {
  return frames.filter(
    (frame): frame is Extract<LiveVoiceServerFrame, { type: "error" }> =>
      frame.type === "error",
  );
}

/** Speak an utterance and wait for the turn to be closed on the wire. */
async function speakAndWaitForTurnClose(harness: {
  frames: LiveVoiceServerFrame[];
  session: LiveVoiceSession;
}): Promise<void> {
  await harness.session.handleBinaryAudio(new Uint8Array([1, 2, 3]));
  await harness.session.handleClientFrame({ type: "ptt_release" });
  await waitFor(() => harness.frames.some((f) => f.type === "tts_done"));
}

/**
 * The next utterance really is heard: a second transcriber exists and the audio
 * the user speaks after the failed turn reaches it. This is the assertion that
 * earns `fatal: false` — without it, "non-fatal" would just be a lie told to a
 * client that then sits in front of a dead session.
 */
async function expectSessionStillHears(harness: {
  session: LiveVoiceSession;
  transcribers: MockStreamingTranscriber[];
}): Promise<void> {
  await waitFor(
    () => harness.transcribers.length >= 2,
    "the session never re-armed a transcriber after the failed turn",
  );
  await harness.session.handleBinaryAudio(new Uint8Array([9, 9, 9]));
  expect(
    harness.transcribers[1]?.audioChunks.map((chunk) => [...chunk]),
  ).toEqual([[9, 9, 9]]);
}

describe("a failed turn does not end the conversation", () => {
  test("the brain erroring mid-turn closes the turn and hands the floor back", async () => {
    const harness = createHarness({
      startVoiceTurn: async (opts: VoiceTurnOptions) => {
        opts.onError?.("Model provider returned 502");
        return { turnId: "bridge-turn-1", abort: mock() };
      },
    });

    await harness.session.start();
    await speakAndWaitForTurnClose(harness);

    expect(errorFrames(harness.frames)).toEqual([
      expect.objectContaining({
        type: "error",
        message: "Model provider returned 502",
        fatal: false,
      }),
    ]);
    await expectSessionStillHears(harness);
  });

  test("a cancelled generation closes the turn instead of going silently deaf", async () => {
    // The quietest death of all: no error frame at all, no `tts_done`, no
    // re-arm. The call just stopped hearing, mid-conversation, with nothing on
    // screen to say why.
    const harness = createHarness({
      startVoiceTurn: async (opts: VoiceTurnOptions) => {
        opts.callbacks?.message_complete?.({
          type: "generation_cancelled",
          conversationId: opts.conversationId,
        });
        return { turnId: "bridge-turn-1", abort: mock() };
      },
    });

    await harness.session.start();
    await speakAndWaitForTurnClose(harness);

    await expectSessionStillHears(harness);
  });

  test("an assistant turn that cannot start is non-fatal and re-arms", async () => {
    const harness = createHarness({
      startVoiceTurn: async () => {
        throw new Error("bridge unavailable");
      },
    });

    await harness.session.start();
    await speakAndWaitForTurnClose(harness);

    expect(errorFrames(harness.frames)).toEqual([
      expect.objectContaining({
        type: "error",
        message:
          "Live voice assistant turn could not be started: bridge unavailable",
        fatal: false,
      }),
    ]);
    await expectSessionStillHears(harness);
  });

  test("audio that the transcriber rejects is non-fatal and re-arms", async () => {
    const transcribers: MockStreamingTranscriber[] = [];
    const harness = createHarness({ transcribers });

    await harness.session.start();
    await waitFor(() => transcribers.length >= 1);
    transcribers[0]!.sendAudioThrows = new Error("socket already closed");
    await harness.session.handleBinaryAudio(new Uint8Array([1, 2, 3]));
    await waitFor(() => harness.frames.some((f) => f.type === "tts_done"));

    expect(errorFrames(harness.frames)).toEqual([
      expect.objectContaining({
        type: "error",
        code: "invalid_audio_payload",
        fatal: false,
      }),
    ]);
    await expectSessionStillHears(harness);
  });

  test("a TTS failure the daemon already absorbed is marked non-fatal", async () => {
    // This one needs no new recovery: the segment's failure is swallowed by the
    // TTS queue's own catch, so the turn still finalizes, still sends
    // `tts_done`, and still re-arms. Only the client ever hung up on it.
    const harness = createHarness({
      startVoiceTurn: async (opts: VoiceTurnOptions) => {
        opts.callbacks?.assistant_text_delta?.({
          type: "assistant_text_delta",
          text: "Sure thing.",
          conversationId: opts.conversationId,
        });
        opts.callbacks?.message_complete?.({
          type: "message_complete",
          conversationId: opts.conversationId,
          messageId: "assistant-message-1",
        });
        return { turnId: "bridge-turn-1", abort: mock() };
      },
      streamTtsAudio: async () => {
        throw new Error("voice provider timed out");
      },
    });

    await harness.session.start();
    await speakAndWaitForTurnClose(harness);

    expect(errorFrames(harness.frames)).toEqual([
      expect.objectContaining({
        type: "error",
        message: "Live voice TTS failed: voice provider timed out",
        fatal: false,
      }),
    ]);
    await expectSessionStillHears(harness);
  });
});

describe("a failure the daemon cannot recover from is still fatal", () => {
  test("a re-arm that cannot get a transcriber reports a fatal error", async () => {
    // The guard against this becoming a blanket "nothing is fatal": when the
    // recovery itself fails there is no session left to keep, and the client
    // must be told so rather than left holding a dead orb.
    const transcribers: MockStreamingTranscriber[] = [];
    let armed = 0;
    const harness = createHarness({
      transcribers,
      startVoiceTurn: async (opts: VoiceTurnOptions) => {
        opts.onError?.("Model provider returned 502");
        return { turnId: "bridge-turn-1", abort: mock() };
      },
      resolveTranscriber: async () => {
        armed += 1;
        if (armed > 1) throw new Error("no transcription credentials");
        const t = new MockStreamingTranscriber(defaultStopEvents());
        transcribers.push(t);
        return t;
      },
    });

    await harness.session.start();
    await speakAndWaitForTurnClose(harness);
    await waitFor(() =>
      errorFrames(harness.frames).some((f) => f.fatal === undefined),
    );

    const fatal = errorFrames(harness.frames).at(-1);
    expect(fatal?.message).toContain(
      "Live voice transcription could not be restarted",
    );
    expect(fatal?.fatal).toBeUndefined();
  });
});
