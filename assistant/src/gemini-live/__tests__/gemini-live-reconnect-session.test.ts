/**
 * Session-layer behavior across upstream reconnects (H-3).
 *
 * The user-facing WebSocket must survive every upstream hiccup the client can
 * recover from: transient drops surface as `fatal: false` error frames (the
 * browser keeps the call up — same convention as the cascade's recovered
 * transcriber errors), a NON-resumed reconnect hands the fresh Gemini session
 * a transcript recap so it doesn't amnesia mid-call, and only an exhausted
 * reconnect ends the session — with an honest terminal error frame.
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
/** Context notes the session injected via sendUserText. */
let injectedNotes: string[];

class FakeGeminiLiveClient {
  constructor(options: { callbacks: typeof captured }) {
    captured = options.callbacks;
  }
  async connect(): Promise<void> {}
  sendAudio(): void {}
  sendAudioStreamEnd(): void {}
  sendToolResponse(): void {}
  sendUserText(text: string): void {
    injectedNotes.push(text);
  }
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
  injectedNotes = [];
});

describe("gemini-live session across reconnects", () => {
  test("a reconnect surfaces as a NON-fatal error frame — the call stays up", async () => {
    const { frames } = await startSession();

    captured.onReconnecting?.({ reason: "close_1011" });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "error", fatal: false });

    // The session keeps working after the gap: the next model turn flows.
    captured.onOutputText?.("Back with you.");
    expect(frames.map((f) => f.type)).toEqual([
      "error",
      "thinking",
      "assistant_text_delta",
    ]);
  });

  test("a drop mid-model-turn closes the stranded turn before the hiccup frame", async () => {
    const { frames } = await startSession();

    captured.onOutputText?.("Let me check your calen—");
    captured.onReconnecting?.({ reason: "close_1006" });

    // The stranded turn is closed (tts_done) so the client's turn state
    // cannot wedge, then the non-fatal hiccup is reported.
    expect(frames.map((f) => f.type)).toEqual([
      "thinking",
      "assistant_text_delta",
      "tts_done",
      "error",
    ]);
    const thinking = frames.find((f) => f.type === "thinking");
    const done = frames.find((f) => f.type === "tts_done");
    expect(done!.turnId).toBe(thinking!.turnId);
  });

  test("client-level recoverable errors are non-fatal too", async () => {
    const { frames } = await startSession();

    captured.onError?.("transient decode hiccup");

    expect(frames[0]).toMatchObject({
      type: "error",
      code: "invalid_field",
      fatal: false,
    });
  });

  test("a resumed reconnect injects nothing — the server kept the context", async () => {
    await startSession();

    captured.onReconnected?.({ resumed: true });

    expect(injectedNotes).toEqual([]);
  });

  test("a fresh reconnect hands the new session a transcript recap", async () => {
    await startSession();

    // Two completed turns before the drop.
    captured.onInputText?.("Remind me to call Priya tomorrow.");
    captured.onOutputText?.("Done — saved to your task list.");
    captured.onTurnComplete?.();
    captured.onInputText?.("What's on my plate today?");
    captured.onOutputText?.("Three things, starting with the board deck.");
    captured.onTurnComplete?.();

    captured.onReconnected?.({ resumed: false });

    expect(injectedNotes).toHaveLength(1);
    const note = injectedNotes[0]!;
    expect(note).toContain("call Priya");
    expect(note).toContain("board deck");
    // Honesty instruction: ask, don't confabulate.
    expect(note).toContain("ask instead of guessing");
  });

  test("a fresh reconnect with no prior turns still notes possible context loss", async () => {
    await startSession();

    captured.onReconnected?.({ resumed: false });

    expect(injectedNotes).toHaveLength(1);
    expect(injectedNotes[0]).toContain("may be missing");
  });

  test("an exhausted reconnect ends honestly: terminal error frame", async () => {
    const { frames } = await startSession();

    captured.onClose?.(1011, "internal error");

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "error" });
    // `fatal` omitted → terminal by protocol contract.
    expect(frames[0]!.fatal).toBeUndefined();
    expect(String(frames[0]!.message)).toContain("could not be restored");
  });

  test("after the session's own close, upstream teardown is silent", async () => {
    const { session, frames } = await startSession();

    session.close("client_end");
    frames.length = 0;
    captured.onReconnecting?.({ reason: "close_1006" });
    captured.onClose?.(1006, "");

    expect(frames).toEqual([]);
  });
});
