/**
 * Per-turn telemetry on the realtime (Gemini Live) engine.
 *
 * This engine used to log one line for an entire call — "session started" — so
 * a caller reporting "it hung after ten seconds" left nothing behind to confirm
 * or deny it. A real session of his ran 68 seconds and logged exactly one line
 * in between. That absence is why the same symptom has been diagnosed three
 * times, each time finding a different real bug, and still recurs.
 *
 * The case these assertions exist for is a SELF-BARGE: the assistant's own
 * speaker audio re-entering the caller's mic and tripping interruption. It is
 * indistinguishable from a real barge-in in every frame the client sees, and
 * separable in the log only by two numbers — it lands a beat after playback
 * starts, and it carries no user speech. So `sinceFirstAudioMs` and `userChars`
 * are the point of the interrupted line, not incidental fields on it.
 *
 * Every module mocked below is spread from the real one; only the seam being
 * driven is replaced.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/** Structured log records the session emitted, in order. */
interface LogRecord {
  fields: Record<string, unknown>;
  message: string;
}
let logs: LogRecord[] = [];

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get:
        () =>
        (fields: unknown, message?: unknown): void => {
          // Only the object-first form carries telemetry; a bare-string log
          // (used for plain narration elsewhere) has nothing to assert on.
          if (fields && typeof fields === "object") {
            logs.push({
              fields: fields as Record<string, unknown>,
              message: typeof message === "string" ? message : "",
            });
          }
        },
    }),
}));

const clientActual = await import("../gemini-live-client.js");

/** Callbacks the session handed to the client — the test's drive handles. */
let captured: import("../gemini-live-client.js").GeminiLiveClientCallbacks;

class FakeGeminiLiveClient {
  constructor(options: { callbacks: typeof captured }) {
    captured = options.callbacks;
  }
  async connect(): Promise<void> {}
  sendAudio(): void {}
  sendImage(): void {}
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
  buildLiveVoiceThreadContext: () => "",
}));

const synthActual =
  await import("../../live-voice/synthesize-live-voice-session.js");
mock.module("../../live-voice/synthesize-live-voice-session.js", () => ({
  ...synthActual,
  synthesizeLiveVoiceSession: async () => ({ newTaskTitles: [] }),
}));

const { createGeminiLiveSession } = await import("../gemini-live-session.js");

async function startSession() {
  const session = createGeminiLiveSession({
    sessionId: "s1",
    startFrame: {
      type: "start",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      conversationId: "conv-1",
    } as never,
    sendFrame: async (payload) => payload as never,
  });
  await session.start();
  logs = []; // drop session-start logging
  return session;
}

/** One 20ms mono s16le chunk at the engine's 24 kHz output rate. */
function audioChunk(): Buffer {
  return Buffer.alloc(960);
}

function find(event: string): LogRecord | undefined {
  return logs.find((entry) => entry.fields.event === event);
}

beforeEach(() => {
  captured = undefined as unknown as typeof captured;
  logs = [];
});

describe("gemini-live turn telemetry", () => {
  test("a completed turn logs its timings, audio and transcript sizes", async () => {
    const asked = "how long is the recovery";
    const answered = "Usually three to six months.";
    const session = await startSession();
    captured.onInputText?.(asked);
    captured.onAudio?.(audioChunk());
    captured.onOutputText?.(answered);
    captured.onTurnComplete?.();

    const complete = find("complete");
    expect(complete).toBeDefined();
    expect(complete?.fields.turn).toBe(1);
    expect(complete?.fields.conversationId).toBe("conv-1");
    expect(complete?.fields.audioBytes).toBe(960);
    expect(complete?.fields.userChars).toBe(asked.length);
    expect(complete?.fields.assistantChars).toBe(answered.length);
    expect(complete?.fields.silent).toBe(false);
    expect(typeof complete?.fields.sinceTurnStartMs).toBe("number");
    session.close("client_closed" as never);
  });

  test("a turn that produced neither audio nor words is marked silent", async () => {
    // The reported symptom — "it stopped answering" — must be as visible in the
    // log as a healthy turn, or it reads as a turn that never happened.
    const session = await startSession();
    captured.onInputText?.("are you there");
    captured.onTurnComplete?.();

    expect(find("complete")?.fields.silent).toBe(true);
    session.close("client_closed" as never);
  });

  test("an interruption records how far into playback it landed", async () => {
    const session = await startSession();
    captured.onAudio?.(audioChunk());
    captured.onInterrupted?.();

    const interrupted = find("interrupted");
    expect(interrupted).toBeDefined();
    // Non-null proves audio had already started when the turn was cut — the
    // difference between the assistant talking over itself and being talked over.
    expect(interrupted?.fields.sinceFirstAudioMs).not.toBeNull();
    expect(interrupted?.fields.audioBytes).toBe(960);
    expect(interrupted?.fields.interruptions).toBe(1);
    session.close("client_closed" as never);
  });

  test("a self-barge is separable from a real barge-in by user speech alone", async () => {
    // Both cut a turn mid-playback and look identical to the client. The only
    // thing that differs is whether anyone actually said something.
    const session = await startSession();
    captured.onAudio?.(audioChunk());
    captured.onInterrupted?.();
    expect(find("interrupted")?.fields.userChars).toBe(0); // echo: nobody spoke

    logs = [];
    captured.onAudio?.(audioChunk());
    captured.onInputText?.("wait, stop");
    captured.onInterrupted?.();
    expect(find("interrupted")?.fields.userChars).toBe(10); // a real barge-in

    session.close("client_closed" as never);
  });

  test("interruptions before any audio report a null playback offset", async () => {
    const session = await startSession();
    captured.onOutputText?.("Let me check");
    captured.onInterrupted?.();

    // Nothing was audible yet, so "how far into playback" has no answer. Null
    // says that; zero would read as "interrupted the instant it spoke".
    expect(find("interrupted")?.fields.sinceFirstAudioMs).toBeNull();
    session.close("client_closed" as never);
  });

  test("closing logs the call's shape, including a turn left open", async () => {
    const session = await startSession();
    captured.onAudio?.(audioChunk());
    captured.onTurnComplete?.();
    captured.onAudio?.(audioChunk());
    captured.onInterrupted?.();
    logs = [];

    session.close("client_closed" as never);

    const closed = find("session_closed");
    expect(closed).toBeDefined();
    expect(closed?.fields.turns).toBe(2);
    expect(closed?.fields.interruptions).toBe(1);
    expect(closed?.fields.reason).toBe("client_closed");
    expect(typeof closed?.fields.durationMs).toBe("number");
  });

  test("a call that dies mid-answer is recorded as leaving a turn unfinished", async () => {
    const session = await startSession();
    captured.onAudio?.(audioChunk());
    logs = [];

    session.close("client_closed" as never);

    expect(find("session_closed")?.fields.unfinishedTurn).toBe(true);
  });

  test("turns are numbered so gaps and repeats are visible in sequence", async () => {
    const session = await startSession();
    for (let i = 0; i < 3; i += 1) {
      captured.onAudio?.(audioChunk());
      captured.onTurnComplete?.();
    }
    expect(
      logs
        .filter((e) => e.fields.event === "complete")
        .map((e) => e.fields.turn),
    ).toEqual([1, 2, 3]);
    session.close("client_closed" as never);
  });
});
