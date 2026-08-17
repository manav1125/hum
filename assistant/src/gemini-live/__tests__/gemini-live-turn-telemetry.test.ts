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

/**
 * Tool execution is replaced wholesale: what is under test is whether a call
 * LEAVES A TRACE, not what the tools do (that is gemini-live-tools.test.ts).
 * `toolResponses` is the script each test sets before driving `onToolCall`.
 */
let toolResponses: Record<string, unknown> = {};
const toolsActual = await import("../gemini-live-tools.js");
mock.module("../gemini-live-tools.js", () => ({
  ...toolsActual,
  executeGeminiLiveFunctionCall: async (call: {
    id?: string;
    name: string;
  }) => ({
    ...(call.id !== undefined ? { id: call.id } : {}),
    name: call.name,
    response: toolResponses[call.name] ?? { ok: true, result: "fine" },
  }),
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

/**
 * The client hands tool calls to the session fire-and-forget (`onToolCall:
 * (calls) => void this.onToolCall(calls)`), so the returned value cannot be
 * awaited — yield the loop until the execution and its logging have settled.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  test("the wait a caller feels is reported separately from how long the reply ran", async () => {
    // `sinceFirstAudioMs` on a completed turn is the LENGTH of the answer —
    // 566 KB of 24 kHz audio logged 11,955 ms and was read as a twelve-second
    // stall. The number that means what that one looked like it meant is
    // `replyLatencyMs`: last heard speech → first audio out.
    const session = await startSession();
    captured.onInputText?.("what's on tomorrow");
    captured.onAudio?.(audioChunk());
    captured.onAudio?.(audioChunk());
    captured.onTurnComplete?.();

    const complete = find("complete");
    expect(typeof complete?.fields.replyLatencyMs).toBe("number");
    // Distinct fields, distinct meanings: the reply ran at least as long as
    // the audio it produced, and both are on the same line to compare.
    expect(typeof complete?.fields.sinceFirstAudioMs).toBe("number");
    expect(complete?.fields.audioBytes).toBe(1920);
    session.close("client_closed" as never);
  });

  test("a turn nobody was heard on reports an unknown wait, not a zero one", async () => {
    const session = await startSession();
    captured.onAudio?.(audioChunk());
    captured.onTurnComplete?.();

    // Zero would read as "answered instantly"; there was simply nothing to
    // measure from.
    expect(find("complete")?.fields.replyLatencyMs).toBeNull();
    session.close("client_closed" as never);
  });
});

/**
 * Whether the model called a tool at all.
 *
 * On 2026-08-17 a prod call said "I've pulled up your message inboxes, but it
 * looks like you're all caught up" and "I checked your calendar and emails".
 * The `tool_invocations` audit table held nothing for either conversation —
 * which was read as proof no tool ran, and is not: that table is written by a
 * lifecycle listener wired into the cascade's executor only, and this engine
 * builds its own. So the sole record of a realtime tool call was a permission
 * denial that happened to log itself on the way past.
 *
 * These lines are that record. A call that never happened and a call that
 * happened and failed are different bugs with the same spoken symptom, and
 * until now they were indistinguishable after the fact.
 */
describe("gemini-live tool-call telemetry", () => {
  beforeEach(() => {
    toolResponses = {};
  });

  test("a tool call is logged when it arrives and again with its outcome", async () => {
    const session = await startSession();
    captured.onToolCall?.([
      { id: "c1", name: "check_inbox", args: { limit: 10 } },
    ]);
    await settle();

    const requested = find("tool_call");
    expect(requested?.fields.tools).toEqual(["check_inbox"]);
    expect(requested?.fields.conversationId).toBe("conv-1");

    const result = find("tool_result");
    expect(result?.fields.tools).toEqual([{ name: "check_inbox", ok: true }]);
    expect(typeof result?.fields.toolMs).toBe("number");
    session.close("client_closed" as never);
  });

  test("a refused tool is recorded as having run and failed, not as silence", async () => {
    // The distinction the calendar turn needed: the model DID ask, and was
    // told no. Absent this line that turn is indistinguishable from a model
    // that answered out of thin air.
    toolResponses = {
      get_calendar: {
        ok: false,
        error: "This action needs the user's approval",
      },
    };
    const session = await startSession();
    captured.onToolCall?.([{ id: "c2", name: "get_calendar", args: {} }]);
    await settle();

    expect(find("tool_result")?.fields.tools).toEqual([
      { name: "get_calendar", ok: false },
    ]);
    session.close("client_closed" as never);
  });

  test("a turn that answered without calling anything leaves no tool line", async () => {
    // The other half of the same prod call, and the reason these lines exist:
    // "I've pulled up your message inboxes" with no tool_call line before it
    // is now, on its own, proof of a fabrication.
    const session = await startSession();
    captured.onInputText?.("what's my latest emails");
    captured.onOutputText?.("You're all caught up!");
    captured.onTurnComplete?.();

    expect(find("tool_call")).toBeUndefined();
    expect(find("complete")).toBeDefined();
    session.close("client_closed" as never);
  });
});
