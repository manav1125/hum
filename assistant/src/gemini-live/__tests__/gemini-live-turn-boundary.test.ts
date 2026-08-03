/**
 * Turn boundaries on the realtime (Gemini Live) engine.
 *
 * `thinking` is the protocol's turn-start marker: it is what tells a client to
 * reset its per-turn display state (the reply text, the result cards). The
 * cascade sends one per turn; this engine sent none at all, so on the realtime
 * path a client had no turn boundary — replies ran together with no separator
 * and each new turn opened by repeating the answer to the PREVIOUS question.
 *
 * Every module mocked below is spread from the real one; only the seam being
 * driven is replaced.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// The session must not reach the network, the workspace, or the thread store.
const clientActual = await import("../gemini-live-client.js");

/** Callbacks the session handed to the client — the test's drive handles. */
let captured: import("../gemini-live-client.js").GeminiLiveClientCallbacks;

class FakeGeminiLiveClient {
  constructor(options: { callbacks: typeof captured }) {
    captured = options.callbacks;
  }
  async connect(): Promise<void> {}
  sendAudio(): void {}
  sendAudioStreamEnd(): void {}
  sendToolResponse(): void {}
  close(): void {}
}

mock.module("../gemini-live-client.js", () => ({
  ...clientActual,
  resolveGeminiLiveApiKey: async () => "test-key",
  GeminiLiveClient: FakeGeminiLiveClient,
}));

const briefingActual = await import("../../live-voice/build-live-briefing.js");
mock.module("../../live-voice/build-live-briefing.js", () => ({
  ...briefingActual,
  buildLiveBriefing: () => "",
}));

const threadActual = await import("../../live-voice/live-voice-thread.js");
mock.module("../../live-voice/live-voice-thread.js", () => ({
  ...threadActual,
  ensureLiveVoiceThread: () => {},
  persistLiveVoiceTurn: async () => {},
  finalizeLiveVoiceThread: async () => {},
}));

const synthActual =
  await import("../../live-voice/synthesize-live-voice-session.js");
mock.module("../../live-voice/synthesize-live-voice-session.js", () => ({
  ...synthActual,
  synthesizeLiveVoiceSession: async () => ({ newTaskTitles: [] }),
}));

const { createGeminiLiveSession } = await import("../gemini-live-session.js");

type Frame = { type: string; [key: string]: unknown };

async function startSession() {
  const frames: Frame[] = [];
  const session = createGeminiLiveSession({
    sessionId: "s1",
    startFrame: {
      type: "start",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      conversationId: "conv-1",
    },
    sendFrame: async (payload) => {
      frames.push(payload as Frame);
      return { ...(payload as Frame), seq: frames.length } as never;
    },
  });
  await session.start();
  frames.length = 0; // drop the `ready` frame
  return { session, frames };
}

beforeEach(() => {
  captured = undefined as unknown as typeof captured;
});

describe("gemini-live turn boundary", () => {
  test("announces each model turn with `thinking` before the first delta", async () => {
    const { frames } = await startSession();

    captured.onOutputText?.("Loud and clear!");

    expect(frames.map((f) => f.type)).toEqual([
      "thinking",
      "assistant_text_delta",
    ]);
    expect(typeof frames[0]?.turnId).toBe("string");
  });

  test("announces the turn exactly once, however many deltas it has", async () => {
    const { frames } = await startSession();

    captured.onOutputText?.("Loud ");
    captured.onOutputText?.("and clear!");
    captured.onAudio?.(Buffer.from([0, 1, 2, 3]));

    expect(frames.filter((f) => f.type === "thinking")).toHaveLength(1);
  });

  test("a second turn gets its own `thinking` with a fresh turn id", async () => {
    const { frames } = await startSession();

    captured.onOutputText?.("Loud and clear! How can I help today?");
    captured.onTurnComplete?.();
    captured.onOutputText?.("I can help with a bunch of things.");
    captured.onTurnComplete?.();

    const thinking = frames.filter((f) => f.type === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]?.turnId).not.toBe(thinking[1]?.turnId);

    // And each `tts_done` closes the turn it was announced for.
    const done = frames.filter((f) => f.type === "tts_done");
    expect(done.map((f) => f.turnId)).toEqual([
      thinking[0]?.turnId,
      thinking[1]?.turnId,
    ]);
  });

  test("a turn whose first frame is audio is announced too", async () => {
    const { frames } = await startSession();

    captured.onAudio?.(Buffer.from([0, 1, 2, 3]));

    expect(frames.map((f) => f.type)).toEqual(["thinking", "tts_audio"]);
  });
});
