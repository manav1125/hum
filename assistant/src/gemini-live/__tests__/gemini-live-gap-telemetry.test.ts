/**
 * Turnless-gap telemetry on the realtime (Gemini Live) engine.
 *
 * Every other line this engine logs is emitted by a turn, so the failure
 * users actually report was the one shape the log could not describe. From a
 * real call on 2026-08-19: two turns, one interruption, `unfinishedTurn:
 * false`, `client_end` — a session that by every logged field behaved, and
 * that the caller ended because after his barge-in it stopped hearing him.
 * The twenty-three seconds he spent talking to a room that had gone deaf
 * were, in the log, indistinguishable from twenty-three seconds of a man
 * thinking.
 *
 * These assertions are on the line that tells those apart. `micReaching` is
 * the field that matters and it names a place, not a culprit:
 *
 * - `"nothing"` — no mic audio reached the daemon at all. The break is
 *   client → daemon, and nothing done here can hear him.
 * - `"gate"` — audio arrived and the echo gate replaced all of it with
 *   silence. Gemini heard an empty room.
 * - `"gemini"` — real audio went upstream and no turn opened anyway.
 *
 * Mocked exactly as gemini-live-turn-telemetry.test.ts mocks (this directory
 * is mock-polluted when the files run in one process — run per file).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Read at session construction, so it must be set before the first import
// that could build one. 20ms keeps the probe drivable in real time.
process.env.CUE_GEMINI_LIVE_GAP_PROBE_MS = "20";

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
/** Chunks the session forwarded upstream, so "reached Gemini" is checkable. */
let sentUpstream: Uint8Array[] = [];

class FakeGeminiLiveClient {
  constructor(options: { callbacks: typeof captured }) {
    captured = options.callbacks;
  }
  async connect(): Promise<void> {}
  sendAudio(pcm: Uint8Array): void {
    sentUpstream.push(pcm);
  }
  sendImage(): void {}
  sendAudioStreamEnd(): void {}
  sendUserText(): void {}
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

const toolsActual = await import("../gemini-live-tools.js");
mock.module("../gemini-live-tools.js", () => ({
  ...toolsActual,
  executeGeminiLiveFunctionCall: async (call: {
    id?: string;
    name: string;
  }) => ({
    ...(call.id !== undefined ? { id: call.id } : {}),
    name: call.name,
    response: { ok: true },
  }),
}));

const { createGeminiLiveSession } = await import("../gemini-live-session.js");

/**
 * The probe is interval-driven, so a session left open by a failing
 * assertion keeps logging into the next test. Each session gets its own
 * conversation id (assertions filter on it) and is closed after every test.
 */
let conversationSeq = 0;
let conversationId = "";
let openSessions: Array<{ close(reason: never): void }> = [];

async function startSession() {
  conversationSeq += 1;
  conversationId = `conv-${conversationSeq}`;
  const session = createGeminiLiveSession({
    sessionId: `s${conversationSeq}`,
    startFrame: {
      type: "start",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      conversationId,
    } as never,
    sendFrame: async (payload) => payload as never,
  });
  await session.start();
  openSessions.push(session);
  logs = [];
  sentUpstream = [];
  return session;
}

/** A short burst of the assistant's own reply audio (24 kHz s16le mono). */
function replyAudio(durationMs = 20): Buffer {
  return Buffer.alloc(Math.round((24_000 * durationMs) / 1_000) * 2);
}

/** `durationMs` of a `hz` sine at `sampleRate`, as PCM16LE. */
function sine(sampleRate: number, durationMs: number, hz = 200): Buffer {
  const sampleCount = Math.round((sampleRate * durationMs) / 1_000);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    buffer.writeInt16LE(
      Math.round(8_000 * Math.sin((2 * Math.PI * hz * i) / sampleRate)),
      i * 2,
    );
  }
  return buffer;
}

/** Push one mic chunk in through the client protocol, exactly as the app does. */
function sendMic(
  session: {
    handleClientFrame(frame: { type: string; dataBase64?: string }): void;
  },
  pcm: Buffer,
): void {
  session.handleClientFrame({
    type: "audio",
    dataBase64: pcm.toString("base64"),
  });
}

function gapLines(): LogRecord[] {
  return logs.filter(
    (entry) =>
      entry.fields.event === "gap" &&
      entry.fields.conversationId === conversationId,
  );
}

/** Wait for the interval-driven probe to emit at least one line. */
async function waitForGap(): Promise<LogRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [first] = gapLines();
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no gap line was ever logged");
}

beforeEach(() => {
  captured = undefined as unknown as typeof captured;
  logs = [];
  sentUpstream = [];
});

afterEach(() => {
  for (const session of openSessions) session.close("client_closed" as never);
  openSessions = [];
});

describe("gemini-live turnless-gap telemetry", () => {
  test("a session whose client stopped sending mic audio says so", async () => {
    // THE reported failure. The daemon is healthy, the turn closed cleanly,
    // and the caller is talking into a microphone whose audio never leaves
    // his machine. Before this line the gap logged nothing at all.
    const session = await startSession();
    captured.onAudio?.(replyAudio());
    captured.onTurnComplete?.();
    logs = [];

    const gap = await waitForGap();
    expect(gap.fields.micReaching).toBe("nothing");
    expect(gap.fields.micChunks).toBe(0);
    expect(gap.fields.forwardedChunks).toBe(0);
    // Which turn the silence follows, so a gap is placeable in the call.
    expect(gap.fields.afterTurn).toBe(1);
    expect(typeof gap.fields.sinceTurnEndMs).toBe("number");
    session.close("client_closed" as never);
  });

  test("mic audio arriving with no turn opening is reported as reaching Gemini", async () => {
    // The other half of the fork: the caller IS being heard and still no turn
    // opens. Same silence to him, entirely different bug — and now separable
    // without a repro.
    const session = await startSession();
    // No reply audio: the echo window is shut, so the gate is out of the
    // picture and every chunk passes straight through.
    captured.onTurnComplete?.();
    logs = [];
    for (let i = 0; i < 5; i += 1) sendMic(session, sine(16_000, 20));

    const gap = await waitForGap();
    expect(gap.fields.micReaching).toBe("gemini");
    expect(gap.fields.micChunks).toBe(5);
    expect(gap.fields.forwardedChunks).toBe(5);
    expect(gap.fields.echoSuppressedChunks).toBe(0);
    expect(gap.fields.sinceLastMicChunkMs).not.toBeNull();
    // …and the audio really did go upstream, not just get counted.
    expect(sentUpstream.length).toBe(5);
    session.close("client_closed" as never);
  });

  test("an echo gate swallowing the caller is visible as a gate, not as silence", async () => {
    // The deafness class this codebase has shipped twice: the gate keeps
    // substituting silence for real speech, so Gemini hears an empty room
    // while the client is streaming a man talking. `micReaching: "gate"`
    // with a still-open `echoWindowMs` is that failure, stated.
    const session = await startSession();
    // Three seconds of reply audio: the echo window stays open across the
    // whole gap, and the classifier has a reference to correlate against.
    captured.onAudio?.(sine(24_000, 3_000));
    captured.onTurnComplete?.();
    logs = [];
    // The same waveform back through the mic — textbook playback echo.
    for (let i = 0; i < 3; i += 1) sendMic(session, sine(16_000, 100));

    const gap = await waitForGap();
    expect(gap.fields.micReaching).toBe("gate");
    expect(gap.fields.micChunks).toBe(3);
    expect(gap.fields.forwardedChunks).toBe(0);
    expect(gap.fields.echoSuppressedChunks).toBe(3);
    // The window the gate is acting on, so an estimate left open long past
    // the reply is readable as the cause rather than inferred.
    expect(gap.fields.echoWindowMs as number).toBeGreaterThan(0);
    session.close("client_closed" as never);
  });

  test("no gap is reported while a turn is actually running", async () => {
    // The probe must not cry wolf over the assistant taking its time to
    // answer — a turn in progress is not a gap, however long it runs.
    const session = await startSession();
    captured.onAudio?.(replyAudio());
    logs = [];
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(gapLines()).toHaveLength(0);
    session.close("client_closed" as never);
  });

  test("the gap reports whether Gemini is still saying anything", async () => {
    // A socket that goes quiet without closing looks exactly like one nobody
    // is talking to. `sinceUpstreamMs` is the only thing that separates them,
    // and it is null — never 0 — while there is nothing to measure from.
    const session = await startSession();
    captured.onTurnComplete?.();
    logs = [];

    const before = await waitForGap();
    expect(before.fields.sinceUpstreamMs).toBeNull();
    expect(before.fields.upstreamKinds).toEqual([]);

    logs = [];
    captured.onUpstreamMessage?.(["serverContent"]);
    const after = await waitForGap();
    expect(typeof after.fields.sinceUpstreamMs).toBe("number");
    expect(after.fields.upstreamKinds).toEqual(["serverContent"]);
    session.close("client_closed" as never);
  });

  test("a barge-in opens a gap of its own", async () => {
    // The exact sequence of the reported call: the turn was interrupted, and
    // from that moment nothing else in this engine spoke. The gap after an
    // interruption is the one that most needs describing.
    const session = await startSession();
    captured.onAudio?.(replyAudio());
    captured.onInterrupted?.();
    logs = [];

    const gap = await waitForGap();
    expect(gap.fields.micReaching).toBe("nothing");
    expect(gap.fields.interruptions).toBe(1);
    session.close("client_closed" as never);
  });

  test("a server-scheduled disconnect is logged where the gap can see it", async () => {
    const session = await startSession();
    captured.onGoAway?.(1_500);

    const goAway = logs.find((entry) => entry.fields.event === "go_away");
    expect(goAway).toBeDefined();
    expect(goAway?.fields.timeLeftMs).toBe(1_500);
    session.close("client_closed" as never);
  });

  test("the closing line says the call ended in silence, and how long a one", async () => {
    // "turns: 2, unfinishedTurn: false" is what a satisfied caller and a
    // stranded one both look like. These two fields are the difference.
    const session = await startSession();
    captured.onAudio?.(replyAudio());
    captured.onTurnComplete?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    logs = [];

    session.close("client_end" as never);

    const closed = logs.find(
      (entry) => entry.fields.event === "session_closed",
    );
    expect(closed?.fields.endedInSilenceMs as number).toBeGreaterThanOrEqual(
      25,
    );
    // Nothing was ever heard from the client on this call.
    expect(closed?.fields.sinceLastMicChunkMs).toBeNull();
  });
});
