/**
 * Tests for the `useLiveVoice` session controller.
 *
 * The three merged primitives — client, capture, player — are replaced with
 * hand-rolled fakes injected through `useLiveVoice`'s factory options, so no
 * WebSocket, microphone, or AudioContext is touched. The fakes expose drivers
 * (`emit`, `pushChunk`, `pushAmplitude`) so a test can drive a full turn and
 * assert the state-machine transitions, barge-in, automatic ptt_release, and
 * teardown.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

// The default client factory in use-live-voice statically imports the real
// LiveVoiceChannelClient, which pulls in connection.ts -> the generated SDK.
// Tests inject fake primitives, so we never construct the real client; mock the
// connection module so importing the controller doesn't drag in the SDK client.
mock.module("@/domains/chat/voice/live-voice/connection", () => ({
  resolveLiveVoiceWsUrl: mock(
    async () => "wss://velay.vellum.ai/a/v1/live-voice",
  ),
}));

import type {
  LiveVoiceChannelClient,
  LiveVoiceClientError,
  LiveVoiceClientEventMap,
  LiveVoiceClientEventName,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import type {
  LiveVoiceAudioCapture,
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import type { LiveVoiceAudioPlayer } from "@/domains/chat/voice/live-voice/tts-playback";

// Import the controller + store *after* the connection mock is registered, so
// the real connection.ts (which imports the generated SDK) never enters the
// static import graph.
const { useLiveVoice } =
  await import("@/domains/chat/voice/live-voice/use-live-voice");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeClient {
  connectArgs: {
    assistantId: string;
    conversationId?: string;
    fullDuplex?: boolean;
    engine?: "cascade" | "gemini-live";
    persona?: string;
  } | null = null;
  sentAudio: ArrayBuffer[] = [];
  pttReleaseCount = 0;
  interruptCount = 0;
  ended = false;
  closed = false;

  private handlers = new Map<
    LiveVoiceClientEventName,
    Set<(payload: never) => void>
  >();

  on<E extends LiveVoiceClientEventName>(
    event: E,
    handler: (payload: LiveVoiceClientEventMap[E]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set?.delete(handler as (payload: never) => void);
  }

  async connect(args: {
    assistantId: string;
    conversationId?: string;
    fullDuplex?: boolean;
    engine?: "cascade" | "gemini-live";
    persona?: string;
  }): Promise<void> {
    this.connectArgs = args;
  }

  sendAudio(pcm: ArrayBuffer): void {
    this.sentAudio.push(pcm);
  }
  pttRelease(): void {
    this.pttReleaseCount++;
  }
  interrupt(): void {
    this.interruptCount++;
  }
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
  }

  /** Drive a server event to the controller's subscribed handlers. */
  emit<E extends LiveVoiceClientEventName>(
    event: E,
    payload: LiveVoiceClientEventMap[E],
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (payload: LiveVoiceClientEventMap[E]) => void)(payload);
    }
  }
}

class FakeCapture {
  readonly onChunk: (buf: ArrayBuffer) => void;
  readonly onAmplitude?: (amplitude: number) => void;

  startCount = 0;
  stopCount = 0;
  shutdownCount = 0;
  startResult: LiveVoiceCaptureResult = { ok: true };

  constructor(options: LiveVoiceAudioCaptureOptions) {
    this.onChunk = options.onChunk;
    this.onAmplitude = options.onAmplitude;
  }

  async start(): Promise<LiveVoiceCaptureResult> {
    this.startCount++;
    return this.startResult;
  }
  async stop(): Promise<void> {
    this.stopCount++;
  }
  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }
  /** Batch-tail drain (see pcm-capture BATCH_SAMPLES); a no-op for the fake. */
  flush(): void {
    this.flushCount++;
  }
  flushCount = 0;

  /** Feed a captured PCM chunk to the controller. */
  pushChunk(buf: ArrayBuffer): void {
    this.onChunk(buf);
  }
  /** Feed an amplitude reading to the controller. */
  pushAmplitude(amplitude: number): void {
    this.onAmplitude?.(amplitude);
  }
}

class FakePlayer {
  enqueued: unknown[] = [];
  stopCount = 0;
  disposeCount = 0;
  prewarmCount = 0;
  isPlaying = false;
  private drainResolvers: Array<() => void> = [];

  /** Real player unlocks/resumes the AudioContext inside the user gesture. */
  prewarm(): void {
    this.prewarmCount++;
  }
  enqueue(chunk: unknown): void {
    this.enqueued.push(chunk);
    this.isPlaying = true;
  }
  stop(): void {
    this.stopCount++;
    this.isPlaying = false;
    this.resolveDrain();
  }
  async dispose(): Promise<void> {
    this.disposeCount++;
    this.stop();
  }
  async waitUntilDrained(): Promise<void> {
    if (!this.isPlaying) return;
    await new Promise<void>((resolve) => this.drainResolvers.push(resolve));
  }

  /** Simulate playback finishing naturally. */
  finishPlayback(): void {
    this.isPlaying = false;
    this.resolveDrain();
  }
  private resolveDrain(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A PCM chunk of `ms` milliseconds at 16 kHz mono Int16. */
function pcmChunk(ms: number): ArrayBuffer {
  const samples = Math.round((16000 * ms) / 1000);
  return new Int16Array(samples).buffer;
}

/**
 * The controller's BARGE_IN_MIN_SPEECH_MS (kept in sync with the source).
 * A single loud reading no longer interrupts: the level must stay above the
 * threshold for this long, so the assistant's own voice leaking back through
 * the speakers as a transient echo spike can't cut it off.
 */
const BARGE_IN_MIN_SPEECH_MS_PROBE = 220;

/**
 * Drive a real barge-in: sustained speech over the amplitude threshold.
 *
 * The controller measures the sustain window against the wall clock, so the
 * clock is advanced between readings rather than the test sleeping. Emits
 * `readings` amplitude values, each one sustain-window apart.
 */
function pushSustainedAmplitude(
  capture: FakeCapture,
  amplitude: number,
  readings = 2,
): void {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (let i = 0; i < readings; i++) {
      capture.pushAmplitude(amplitude);
      clock += BARGE_IN_MIN_SPEECH_MS_PROBE + 1;
    }
  } finally {
    Date.now = realNow;
  }
}

function renderController(
  overrides: { fullDuplex?: boolean; handsFree?: boolean } = {},
) {
  const client = new FakeClient();
  const player = new FakePlayer();
  let capture!: FakeCapture;

  const view = renderHook(() =>
    useLiveVoice({
      createClient: () => client as unknown as LiveVoiceChannelClient,
      createPlayer: () => player as unknown as LiveVoiceAudioPlayer,
      createCapture: (options) => {
        capture = new FakeCapture(options);
        return capture as unknown as LiveVoiceAudioCapture;
      },
      // Legacy suites below assert single-utterance behavior; opt out of the
      // default full-duplex mode so they exercise the half-duplex path. The
      // dedicated "full-duplex" suite opts back in explicitly.
      fullDuplex: overrides.fullDuplex ?? false,
      ...(overrides.handsFree !== undefined
        ? { handsFree: overrides.handsFree }
        : {}),
    }),
  );

  return {
    view,
    client,
    player,
    getCapture: () => capture,
  };
}

/** Start a session and drive it to the listening state (ready + capture). */
async function startListening(h: ReturnType<typeof renderController>) {
  await act(async () => {
    await h.view.result.current.start("assistant-1", "conv-1");
  });
  // `ready` kicks off capture; await the microtask that resolves capture.start.
  await act(async () => {
    h.client.emit("ready", {
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: "conv-1",
    });
    await Promise.resolve();
  });
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
});

afterEach(() => {
  // Unmount any still-mounted controller so its session teardown runs — with
  // continuous listening a session stays live (mic open) until stop()/unmount,
  // so without this the store/session would leak into the next test.
  cleanup();
  useLiveVoiceStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Full turn
// ---------------------------------------------------------------------------

describe("full turn", () => {
  test("drives idle → connecting → listening → thinking → speaking → idle (session ends after the turn)", async () => {
    const h = renderController();

    expect(h.view.result.current.state).toBe("idle");

    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    expect(h.view.result.current.state).toBe("connecting");
    expect(h.client.connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
      fullDuplex: false,
      // The speech-native engine is opt-in; the cascaded pipeline (which keeps
      // tools + memory) is what a default session asks for.
      engine: "cascade",
      persona: "companion",
    });

    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.getCapture().startCount).toBe(1);

    // Captured audio is forwarded to the client.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio).toHaveLength(1);

    // Partial then final transcript.
    act(() => {
      h.client.emit("sttPartial", { type: "stt_partial", seq: 2, text: "hel" });
    });
    expect(h.view.result.current.partialTranscript).toBe("hel");

    act(() => {
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: "hello" });
    });
    expect(h.view.result.current.finalTranscript).toBe("hello");
    expect(h.view.result.current.partialTranscript).toBe("");
    // Capture still running, so stt_final keeps us listening.
    expect(h.view.result.current.state).toBe("listening");

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("thinking");

    act(() => {
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 5,
        text: "hi ",
      });
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 6,
        text: "there",
      });
    });
    expect(h.view.result.current.assistantTranscript).toBe("hi there");

    act(() => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 7,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(h.player.enqueued).toHaveLength(1);

    // tts_done awaits playback drain, then ends the session (single-utterance):
    // the socket is closed and the mic is shut down, returning to idle.
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 8, turnId: "t1" });
      h.player.finishPlayback();
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.closed).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Barge-in
// ---------------------------------------------------------------------------

describe("barge-in", () => {
  test("sustained amplitude over threshold while speaking stops playback, interrupts, and ends the session", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    expect(h.player.isPlaying).toBe(true);

    act(() => {
      pushSustainedAmplitude(h.getCapture(), 0.2); // over the threshold
    });

    // Playback is stopped and a single interrupt is sent; the (now terminal)
    // session is then torn down → idle (mic shut down, socket closed).
    expect(h.player.isPlaying).toBe(false);
    expect(h.client.interruptCount).toBe(1);
    expect(h.view.result.current.state).toBe("idle");
    expect(h.client.closed).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
  });

  test("a single transient spike does not interrupt — echo must not cut the assistant off", async () => {
    // The assistant's own voice leaks back through the speakers as short
    // spikes. Only speech sustained past the guard window may barge in;
    // without this the assistant interrupts itself mid-sentence.
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    act(() => {
      h.getCapture().pushAmplitude(0.2); // one loud reading, not sustained
    });

    expect(h.client.interruptCount).toBe(0);
    expect(h.player.isPlaying).toBe(true);
    expect(h.view.result.current.state).toBe("speaking");
  });

  test("interrupt is sent at most once per response", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
      // Keep talking well past the first interrupt — the user holding the
      // floor must not fire a second interrupt for the same response.
      pushSustainedAmplitude(h.getCapture(), 0.25, 4);
    });

    expect(h.client.interruptCount).toBe(1);
  });

  test("realistic turn: auto-release → speaking → barge-in ends the session", async () => {
    const h = renderController();
    await startListening(h);
    const capture = h.getCapture();

    // Speak, then go silent so push-to-talk auto-releases.
    act(() => {
      capture.pushAmplitude(0.1); // speech
      capture.pushChunk(pcmChunk(200));
      capture.pushAmplitude(0.0); // trailing silence
      capture.pushChunk(pcmChunk(1000));
    });
    expect(h.client.pttReleaseCount).toBe(1);
    expect(h.view.result.current.state).toBe("transcribing");

    // Server thinks, then streams TTS — we move to speaking.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 5,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    // The mic never stopped, so amplitude still flows while the assistant
    // speaks: sustained speech interrupts (barge-in), which ends the session.
    act(() => {
      pushSustainedAmplitude(capture, 0.3); // over the threshold
    });
    expect(h.client.interruptCount).toBe(1);
    expect(h.player.isPlaying).toBe(false);
    expect(h.view.result.current.state).toBe("idle");
    expect(capture.shutdownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Automatic push-to-talk release on silence
// ---------------------------------------------------------------------------

describe("automatic ptt_release", () => {
  test("speech followed by a silence window releases push-to-talk", async () => {
    const h = renderController();
    await startListening(h);

    // Speech: a chunk above the speech threshold accrues speech duration.
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(200));
    });
    expect(h.client.pttReleaseCount).toBe(0);

    // Silence: a chunk below the speech threshold for >= 1s triggers release.
    act(() => {
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(1000));
    });

    expect(h.client.pttReleaseCount).toBe(1);
    expect(h.view.result.current.state).toBe("transcribing");
  });

  test("silence without prior speech does not release", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.getCapture().pushAmplitude(0.0);
      h.getCapture().pushChunk(pcmChunk(2000));
    });

    expect(h.client.pttReleaseCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// Hands-free (server VAD owns utterance boundaries)
// ---------------------------------------------------------------------------

describe("hands-free (server VAD)", () => {
  /** Start a full-duplex session whose daemon confirms server_vad on ready. */
  async function startHandsFree(h: ReturnType<typeof renderController>) {
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    await act(async () => {
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      });
      await Promise.resolve();
    });
  }

  test("full-duplex sessions request server_vad on connect; half-duplex never does", async () => {
    const h = renderController({ fullDuplex: true });
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    expect(
      (h.client.connectArgs as { turnDetection?: string } | null)
        ?.turnDetection,
    ).toBe("server_vad");

    cleanup();
    useLiveVoiceStore.getState().reset();

    const manual = renderController({ fullDuplex: false });
    await act(async () => {
      await manual.view.result.current.start("assistant-1", "conv-1");
    });
    expect(
      "turnDetection" in
        (manual.client.connectArgs as unknown as Record<string, unknown>),
    ).toBe(false);
  });

  test("handsFree: false opts out of server_vad even in full-duplex", async () => {
    const h = renderController({ fullDuplex: true, handsFree: false });
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    expect(
      "turnDetection" in
        (h.client.connectArgs as unknown as Record<string, unknown>),
    ).toBe(false);
  });

  test("ready echoing server_vad disables the client auto-release VAD", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);
    expect(h.view.result.current.state).toBe("listening");
    expect(useLiveVoiceStore.getState().handsFree).toBe(true);

    // Speech then a silence window far past SILENCE_DURATION_BEFORE_RELEASE_MS:
    // in manual mode this releases push-to-talk; hands-free must NOT — the
    // server VAD owns the boundary.
    act(() => {
      h.getCapture().pushAmplitude(0.2);
      h.getCapture().pushChunk(pcmChunk(200));
      h.getCapture().pushAmplitude(0);
      h.getCapture().pushChunk(pcmChunk(2000));
    });
    expect(h.client.pttReleaseCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");
    // The audio itself still streamed (the server VAD needs the raw feed).
    expect(h.client.sentAudio.length).toBe(2);
  });

  test("ready without the echo falls back to full client-side VAD", async () => {
    const h = renderController({ fullDuplex: true });
    // The daemon is old: ready has no turnDetection echo.
    await startListening(h);
    expect(useLiveVoiceStore.getState().handsFree).toBe(false);

    act(() => {
      h.getCapture().pushAmplitude(0.2);
      h.getCapture().pushChunk(pcmChunk(200));
      h.getCapture().pushAmplitude(0);
      h.getCapture().pushChunk(pcmChunk(1200));
    });
    // Exactly today's behavior: the client auto-release fires.
    expect(h.client.pttReleaseCount).toBe(1);
    expect(h.view.result.current.state).toBe("transcribing");
  });

  test("utterance_end drives listening → transcribing → thinking on a real final", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);

    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 2 });
    });
    expect(h.view.result.current.state).toBe("listening");

    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 3,
        reason: "silence",
      });
    });
    expect(h.view.result.current.state).toBe("transcribing");

    act(() => {
      h.client.emit("sttFinal", {
        type: "stt_final",
        seq: 4,
        text: "hello there",
      });
    });
    expect(h.view.result.current.state).toBe("thinking");
  });

  test("an empty final never advances a hands-free session to thinking", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);

    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: "  " });
    });
    expect(h.view.result.current.state).toBe("transcribing");
  });

  test("an answerless close (bare tts_done) cycles back to listening", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);

    // A noise-only utterance: the server closes it and, finding no
    // transcript, ends the turn with a bare tts_done (no thinking, no audio).
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
    });
    expect(h.view.result.current.state).toBe("transcribing");

    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 3, turnId: "t1" });
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    // The mic gate stayed open throughout.
    const sentBefore = h.client.sentAudio.length;
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio.length).toBe(sentBefore + 1);
  });

  /** Drive a hands-free session through a full turn to `speaking`. */
  function driveToSpeaking(h: ReturnType<typeof renderController>): void {
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: "hi" });
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 5,
        mimeType: "audio/pcm",
        sampleRate: 16000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
  }

  test("client amplitude barge-in stands down in hands-free — the server owns barge-in (V-1b)", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);
    driveToSpeaking(h);

    // Sustained loud amplitude must NOT interrupt: in server_vad mode the
    // daemon's sustained-speech guard detects barge-in and drives the
    // flush via speech_started/turn_cancelled. Two client+server detectors
    // would race and double-interrupt.
    const realNow = Date.now;
    try {
      let now = realNow();
      Date.now = () => now;
      act(() => {
        h.getCapture().pushAmplitude(0.5);
      });
      now += 400; // > BARGE_IN_MIN_SPEECH_MS
      act(() => {
        h.getCapture().pushAmplitude(0.5);
      });
    } finally {
      Date.now = realNow;
    }
    expect(h.client.interruptCount).toBe(0);
    expect(h.view.result.current.state).toBe("speaking");
  });

  test("client amplitude barge-in stays active in manual (non-hands-free) sessions", async () => {
    const h = renderController({ fullDuplex: true, handsFree: false });
    await startListening(h);
    act(() => {
      h.client.emit("sttFinal", { type: "stt_final", seq: 2, text: "hi" });
      h.client.emit("thinking", { type: "thinking", seq: 3, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 4,
        mimeType: "audio/pcm",
        sampleRate: 16000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    act(() => {
      pushSustainedAmplitude(h.getCapture(), 0.5);
    });
    expect(h.client.interruptCount).toBe(1);
    expect(h.view.result.current.state).toBe("listening");
  });

  test("speech_started flushes playback to listening mid-speaking (server barge-in)", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);
    driveToSpeaking(h);
    const stopsBefore = h.player.stopCount;

    // The daemon's sustained-speech guard fired: flush the tail NOW.
    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 6 });
    });
    expect(h.player.stopCount).toBe(stopsBefore + 1);
    expect(h.view.result.current.state).toBe("listening");
    // No client interrupt frame: the server already cancelled the turn.
    expect(h.client.interruptCount).toBe(0);
  });

  test("speech_started flushes to listening even mid-thinking (no cancellation follows)", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);
    act(() => {
      h.client.emit("utteranceEnd", {
        type: "utterance_end",
        seq: 2,
        reason: "silence",
      });
      h.client.emit("sttFinal", { type: "stt_final", seq: 3, text: "hi" });
      h.client.emit("thinking", { type: "thinking", seq: 4, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("thinking");

    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 5 });
    });
    expect(h.view.result.current.state).toBe("listening");
  });

  test("turn_cancelled flushes the cancelled turn's playback (no tts_done follows)", async () => {
    const h = renderController({ fullDuplex: true });
    await startHandsFree(h);
    driveToSpeaking(h);

    act(() => {
      h.client.emit("speechStarted", { type: "speech_started", seq: 6 });
      h.client.emit("turnCancelled", {
        type: "turn_cancelled",
        seq: 7,
        turnId: "t1",
      });
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.player.isPlaying).toBe(false);

    // The next turn's audio still plays normally after the cancel.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 8, turnId: "t2" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 9,
        mimeType: "audio/pcm",
        sampleRate: 16000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
  });

  test("turn_cancelled is ignored on a manual session (defense in depth)", async () => {
    const h = renderController({ fullDuplex: true, handsFree: false });
    await startListening(h);
    act(() => {
      h.client.emit("turnCancelled", {
        type: "turn_cancelled",
        seq: 2,
        turnId: "t1",
      });
    });
    expect(h.player.stopCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full-duplex (continuous session across turns)
// ---------------------------------------------------------------------------

describe("full-duplex", () => {
  test("defaults to full-duplex (continuous conversation)", async () => {
    // Default (no override) — full-duplex is the shipped default now that the
    // full STT → brain → streaming-TTS loop + re-arm are verified end-to-end.
    // A consumer can still force legacy push-to-talk with `fullDuplex: false`.
    const client = new FakeClient();
    const player = new FakePlayer();
    let capture!: FakeCapture;
    const view = renderHook(() =>
      useLiveVoice({
        createClient: () => client as unknown as LiveVoiceChannelClient,
        createPlayer: () => player as unknown as LiveVoiceAudioPlayer,
        createCapture: (options) => {
          capture = new FakeCapture(options);
          return capture as unknown as LiveVoiceAudioCapture;
        },
      }),
    );
    await act(async () => {
      await view.result.current.start("assistant-1", "conv-1");
    });
    expect(client.connectArgs?.fullDuplex).toBe(true);
    act(() => view.unmount());
    void capture;
  });

  test("tts_done loops back to listening on the same socket (no close)", async () => {
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    // Turn 1: think → speak.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    // tts_done → drain → back to listening (socket stays open, mic stays up).
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 4, turnId: "t1" });
      h.player.finishPlayback();
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);

    // Turn 2: forwarding is re-armed, so a fresh chunk is streamed again.
    const sentBefore = h.client.sentAudio.length;
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio.length).toBe(sentBefore + 1);

    // And a second full turn drives the machine again.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 5, turnId: "t2" });
    });
    expect(h.view.result.current.state).toBe("thinking");
    act(() => {
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 6,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");
    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 7, turnId: "t2" });
      h.player.finishPlayback();
      await Promise.resolve();
    });
    expect(h.view.result.current.state).toBe("listening");
    // The session was never closed across two turns.
    expect(h.client.closed).toBe(false);
    expect(h.client.ended).toBe(false);
  });

  test("barge-in interrupts and resumes listening on the same socket", async () => {
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: 3,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    expect(h.view.result.current.state).toBe("speaking");

    act(() => {
      pushSustainedAmplitude(h.getCapture(), 0.2); // over the threshold
    });

    // Playback stopped, one interrupt sent, and — unlike half-duplex — the
    // session stays open and resumes listening for the barge-in utterance.
    expect(h.player.isPlaying).toBe(false);
    expect(h.client.interruptCount).toBe(1);
    expect(h.view.result.current.state).toBe("listening");
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);

    // Forwarding is re-armed after barge-in.
    const sentBefore = h.client.sentAudio.length;
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio.length).toBe(sentBefore + 1);
  });

  // -------------------------------------------------------------------------
  // Turn boundaries. Regression: the ONLY thing that ever reset the assistant
  // transcript was the server's `thinking` frame, which the cascade sends and
  // the realtime engine does not. On the realtime engine every reply was
  // therefore appended to the previous one — replies ran together with no
  // separator, and each new turn opened by repeating the answer to the
  // PREVIOUS question, which is the worst part: Cue appeared to answer a
  // question it was never asked.
  // -------------------------------------------------------------------------

  /** Drive one full-duplex turn: user utterance → reply text → tts → drain. */
  async function driveTurn(
    h: ReturnType<typeof renderController>,
    opts: { seq: number; turnId: string; user?: string; reply: string },
  ) {
    if (opts.user !== undefined) {
      act(() => {
        h.client.emit("sttFinal", {
          type: "stt_final",
          seq: opts.seq,
          text: opts.user as string,
        });
      });
    }
    act(() => {
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: opts.seq + 1,
        text: opts.reply,
      });
      h.client.emit("ttsAudio", {
        type: "tts_audio",
        seq: opts.seq + 2,
        mimeType: "audio/pcm",
        sampleRate: 24000,
        dataBase64: "AAAA",
      });
    });
    await act(async () => {
      h.client.emit("ttsDone", {
        type: "tts_done",
        seq: opts.seq + 3,
        turnId: opts.turnId,
      });
      h.player.finishPlayback();
      await Promise.resolve();
    });
  }

  test("a reply never carries the previous turn's answer, even with no `thinking` frame", async () => {
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    await driveTurn(h, {
      seq: 2,
      turnId: "t1",
      user: "Hello, can you hear me?",
      reply: "Loud and clear! How can I help today?",
    });
    expect(h.view.result.current.assistantTranscript).toBe(
      "Loud and clear! How can I help today?",
    );

    await driveTurn(h, {
      seq: 10,
      turnId: "t2",
      user: "How much does the architect cost?",
      reply: "It's $40 a month.",
    });

    // Not "Loud and clear! How can I help today?It's $40 a month."
    expect(h.view.result.current.assistantTranscript).toBe("It's $40 a month.");
    expect(h.view.result.current.finalTranscript).toBe(
      "How much does the architect cost?",
    );
  });

  test("a reply that arrives before any new user transcript still opens a new turn", async () => {
    // The realtime engine's input and output transcriptions race; a turn whose
    // first frame is a delta must not extend the finished reply either.
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    await driveTurn(h, { seq: 2, turnId: "t1", user: "Hi", reply: "Hello!" });
    await driveTurn(h, { seq: 10, turnId: "t2", reply: "Still here." });

    expect(h.view.result.current.assistantTranscript).toBe("Still here.");
  });

  test("deltas within one turn still accumulate", async () => {
    // The turn boundary must not degrade into "last delta wins" — streaming a
    // reply chunk by chunk is the normal case.
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    act(() => {
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 2,
        text: "I can help ",
      });
      h.client.emit("assistantTextDelta", {
        type: "assistant_text_delta",
        seq: 3,
        text: "with a bunch of things.",
      });
    });
    expect(h.view.result.current.assistantTranscript).toBe(
      "I can help with a bunch of things.",
    );
  });

  test("a turn that ends without ever speaking still re-arms the mic", async () => {
    // An utterance that transcribes to nothing (a cough, a door) is closed by
    // the daemon with a bare `tts_done` — no thinking, no audio. Ignoring that
    // left the session stuck in `transcribing` with the mic gate shut: alive on
    // the socket, unable to hear another word.
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    // Drive the automatic push-to-talk release: speech, then trailing silence.
    act(() => {
      h.getCapture().pushAmplitude(0.2);
      h.getCapture().pushChunk(pcmChunk(200));
      h.getCapture().pushAmplitude(0);
      h.getCapture().pushChunk(pcmChunk(1200));
    });
    expect(h.view.result.current.state).toBe("transcribing");
    expect(h.client.pttReleaseCount).toBe(1);

    await act(async () => {
      h.client.emit("ttsDone", { type: "tts_done", seq: 5, turnId: "t1" });
      await Promise.resolve();
    });

    expect(h.view.result.current.state).toBe("listening");

    // And the mic gate really did re-open.
    const sentBefore = h.client.sentAudio.length;
    act(() => {
      h.getCapture().pushAmplitude(0.1);
      h.getCapture().pushChunk(pcmChunk(20));
    });
    expect(h.client.sentAudio.length).toBe(sentBefore + 1);
  });

  test("stop() still tears down a full-duplex session", async () => {
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    await act(async () => {
      await h.view.result.current.stop();
    });

    expect(h.client.ended).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
    expect(h.view.result.current.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("failure", () => {
  test("error frame transitions to failed with the message and tears down", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      const err: LiveVoiceClientError = {
        reason: "protocol-error",
        message: "kaboom",
        fatal: true,
      };
      h.client.emit("error", err);
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe("kaboom");
    expect(h.client.closed).toBe(true);
    expect(h.getCapture().shutdownCount).toBe(1);
  });

  test("a non-fatal error frame leaves the session running", async () => {
    // The daemon reports conditions it has already recovered from over the same
    // `error` frame (a transcriber's transient poll error, say). Treating those
    // as terminal is what dropped live conversations mid-sentence.
    const h = renderController({ fullDuplex: true });
    await startListening(h);

    act(() => {
      const err: LiveVoiceClientError = {
        reason: "protocol-error",
        code: "invalid_field",
        message: "transcription poll failed",
        fatal: false,
      };
      h.client.emit("error", err);
    });

    expect(h.view.result.current.state).toBe("listening");
    expect(h.view.result.current.error).toBeNull();
    expect(h.client.closed).toBe(false);
    expect(h.getCapture().shutdownCount).toBe(0);

    // And the session still works: the next turn drives the machine as usual.
    act(() => {
      h.client.emit("thinking", { type: "thinking", seq: 9, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("thinking");
  });

  test("busy frame fails the session", async () => {
    const h = renderController();
    await startListening(h);

    act(() => {
      h.client.emit("busy", {
        type: "busy",
        seq: 2,
        activeSessionId: "other",
      });
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toBe(
      "Another live-voice session is active.",
    );
  });

  test("capture failure fails the session", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.start("assistant-1");
    });
    await act(async () => {
      // The capture instance exists once start() ran; make its start fail.
      h.getCapture().startResult = {
        ok: false,
        error: "permission-denied",
      };
      h.client.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    expect(h.view.result.current.state).toBe("failed");
    expect(h.client.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("teardown", () => {
  test("stop() ends the session and releases mic, socket, and audio", async () => {
    const h = renderController();
    await startListening(h);
    const capture = h.getCapture();

    await act(async () => {
      await h.view.result.current.stop();
    });

    expect(h.client.ended).toBe(true);
    // dispose() releases the AudioContext (not just stop()); confirm capture is
    // fully shut down too.
    expect(h.player.disposeCount).toBeGreaterThanOrEqual(1);
    expect(capture.shutdownCount).toBe(1);
    expect(h.view.result.current.state).toBe("idle");
  });

  test("unmount releases mic, socket, and audio and resets the store to idle", async () => {
    const h = renderController();
    await startListening(h);
    const capture = h.getCapture();
    // Sanity: a live session leaves the store non-idle before unmount.
    expect(h.view.result.current.state).toBe("listening");

    act(() => {
      h.view.unmount();
    });

    expect(h.client.closed).toBe(true);
    // Unmount must dispose the player so the AudioContext is released.
    expect(h.player.disposeCount).toBeGreaterThanOrEqual(1);
    expect(capture.shutdownCount).toBe(1);
    // Gap 2: teardown must reset the store so a mid-session unmount doesn't
    // strand it in a non-idle phase (which would keep dictation disabled).
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("stop() with no active session resets to idle without throwing", async () => {
    const h = renderController();
    await act(async () => {
      await h.view.result.current.stop();
    });
    expect(h.view.result.current.state).toBe("idle");
  });
});

describe("reconnect on unexpected drop", () => {
  /** Render with a FRESH FakeClient per createClient() call, so a reconnect
   *  can be observed as a new client + new connect. */
  function renderWithFreshClients(fullDuplex = false) {
    const clients: FakeClient[] = [];
    const view = renderHook(() =>
      useLiveVoice({
        createClient: () => {
          const c = new FakeClient();
          clients.push(c);
          return c as unknown as LiveVoiceChannelClient;
        },
        createPlayer: () => new FakePlayer() as unknown as LiveVoiceAudioPlayer,
        createCapture: (o) =>
          new FakeCapture(o) as unknown as LiveVoiceAudioCapture,
        fullDuplex,
      }),
    );
    return { view, clients };
  }

  async function startReady(h: ReturnType<typeof renderWithFreshClients>) {
    await act(async () => {
      await h.view.result.current.start("assistant-1", "conv-1");
    });
    await act(async () => {
      h.clients[h.clients.length - 1].emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
  }

  test("an unexpected close reconnects with the same conversation, not idle", async () => {
    const h = renderWithFreshClients();
    await startReady(h);
    expect(h.view.result.current.state).not.toBe("idle");

    // Server drops the socket mid-session (no clean end()).
    await act(async () => {
      h.clients[0].emit("closed", undefined);
    });
    // It recovers instead of ending: shows connecting, doesn't go idle.
    expect(h.view.result.current.state).toBe("connecting");

    // After the backoff, a NEW client connects with the same conversationId.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(h.clients.length).toBe(2);
    expect(h.clients[1].connectArgs?.conversationId).toBe("conv-1");
  });

  test("gives up (idle) after the attempt budget is exhausted", async () => {
    const h = renderWithFreshClients();
    await startReady(h);
    // Drop each freshly-reconnected client without ever reaching `ready`,
    // waiting past that attempt's backoff so the next client is actually
    // created before we drop it. Backoff grows (400/1200/3000ms).
    const BACKOFFS = [500, 1_300, 3_100];
    for (const wait of BACKOFFS) {
      await act(async () => {
        h.clients[h.clients.length - 1].emit("closed", undefined);
        await new Promise((r) => setTimeout(r, wait));
      });
    }
    // Budget spent: the final drop tears down instead of reconnecting.
    await act(async () => {
      h.clients[h.clients.length - 1].emit("closed", undefined);
      await new Promise((r) => setTimeout(r, 50));
    });
    // Bounded clients (initial + at most MAX reconnects), and it gives up with
    // an explanation rather than looping forever OR silently resetting to idle
    // (which is how a dropped session read as "voice randomly stops").
    expect(h.clients.length).toBeLessThanOrEqual(MAX_ATTEMPTS_PROBE + 1);
    expect(h.view.result.current.state).toBe("failed");
    expect(h.view.result.current.error).toContain("reconnect");
  });

  test("a protocol error is terminal — no reconnect", async () => {
    const h = renderWithFreshClients();
    await startReady(h);
    await act(async () => {
      h.clients[0].emit("error", {
        reason: "protocol-error",
        message: "server refused",
        fatal: true,
      });
      h.clients[0].emit("closed", undefined);
      await new Promise((r) => setTimeout(r, 500));
    });
    // No second client; the session failed rather than reconnecting.
    expect(h.clients.length).toBe(1);
    expect(h.view.result.current.state).toBe("failed");
  });
});

// The controller's MAX_RECONNECT_ATTEMPTS (kept in sync with the source; the
// budget test only needs an upper bound to bound the loop).
const MAX_ATTEMPTS_PROBE = 3;
