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

/** Mic audio the session actually forwarded to Gemini (post echo gate). */
const forwardedAudio: Uint8Array[] = [];

/** Still images the session forwarded to Gemini (mid-call camera photos). */
const forwardedImages: Array<{ dataBase64: string; mimeType?: string }> = [];

class FakeGeminiLiveClient {
  constructor(options: { callbacks: typeof captured }) {
    captured = options.callbacks;
  }
  async connect(): Promise<void> {}
  sendAudio(chunk: Uint8Array): void {
    forwardedAudio.push(chunk);
  }
  sendImage(dataBase64: string, mimeType?: string): void {
    forwardedImages.push({ dataBase64, mimeType });
  }
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

// attach_image seams: the persist and the attachment hydration.
let photoCalls: Array<{ conversationId: string; attachmentId: string }> = [];
let photoResult: { ok: boolean; messageId?: string } = {
  ok: true,
  messageId: "msg-1",
};
const photoActual = await import("../../live-voice/live-voice-photo.js");
mock.module("../../live-voice/live-voice-photo.js", () => ({
  ...photoActual,
  persistLiveVoicePhoto: async (
    conversationId: string,
    attachmentId: string,
  ) => {
    photoCalls.push({ conversationId, attachmentId });
    return photoResult;
  },
}));

const attachmentsActual = await import("../../memory/attachments-store.js");
mock.module("../../memory/attachments-store.js", () => ({
  ...attachmentsActual,
  getAttachmentsByIds: (ids: string[]) =>
    ids.flatMap((id) =>
      id === "att-42"
        ? [
            {
              id,
              originalFilename: "photo-1.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 5,
              kind: "image",
              thumbnailBase64: null,
              dataBase64: "aGVsbG8=",
              createdAt: 0,
            },
          ]
        : [],
    ),
}));

const { createGeminiLiveSession } = await import("../gemini-live-session.js");

type Frame = { type: string; [key: string]: unknown };

async function startSession(startOverrides: Record<string, unknown> = {}) {
  const frames: Frame[] = [];
  const session = createGeminiLiveSession({
    sessionId: "s1",
    startFrame: {
      type: "start",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      conversationId: "conv-1",
      ...startOverrides,
    } as never,
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
  forwardedAudio.length = 0;
  forwardedImages.length = 0;
  photoCalls = [];
  photoResult = { ok: true, messageId: "msg-1" };
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

  test("closing mid-turn closes the turn instead of stranding the caller", async () => {
    // `thinking` is a promise the client holds to: it leaves that state on
    // `tts_done` and nothing else. Teardown sent none, so a turn still open
    // when the session went down left the orb spinning with no answer and no
    // error — the user's only move was to abandon the call.
    const { session, frames } = await startSession();

    captured.onOutputText?.("Let me check that for—");
    const thinking = frames.find((f) => f.type === "thinking");
    expect(thinking).toBeDefined();

    session.close("client_end");

    const error = frames.find((f) => f.type === "error");
    expect(error?.fatal).toBe(false);
    expect(String(error?.message)).toContain(
      "didn't finish before the call ended",
    );
    const done = frames.filter((f) => f.type === "tts_done");
    expect(done).toHaveLength(1);
    expect(done[0]?.turnId).toBe(thinking?.turnId);
  });

  test("closing between turns says nothing", async () => {
    const { session, frames } = await startSession();

    captured.onOutputText?.("All done.");
    captured.onTurnComplete?.();
    const doneBefore = frames.filter((f) => f.type === "tts_done").length;

    session.close("client_end");

    expect(frames.filter((f) => f.type === "tts_done")).toHaveLength(
      doneBefore,
    );
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });
});

describe("gemini-live echo gate", () => {
  const isSilent = (chunk: Uint8Array) => chunk.every((byte) => byte === 0);

  /** PCM16LE sine tone: `sampleCount` samples at `sampleRate`. */
  const tone = (
    amplitude: number,
    frequencyHz: number,
    sampleCount: number,
    sampleRate: number,
  ): Buffer => {
    const b = Buffer.alloc(sampleCount * 2);
    for (let i = 0; i < sampleCount; i += 1) {
      b.writeInt16LE(
        Math.round(
          amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate),
        ),
        i * 2,
      );
    }
    return b;
  };

  // Model (reference) audio: 2 s of a 200 Hz tone at the 24 kHz output rate.
  const modelTone = () => tone(4_700, 200, 2 * 24_000, 24_000);
  // Mic echo of it: the same 200 Hz tone as heard at the 16 kHz input rate.
  // 160 samples = 10 ms = exactly 2 periods, so concatenation is continuous.
  const echoMicChunk = () => tone(4_700, 200, 160, 16_000);
  // Genuine barge-in speech: louder and uncorrelated (530 Hz).
  const speechMicChunk = () => tone(9_400, 530, 160, 16_000);

  type StartedSession = Awaited<ReturnType<typeof startSession>>["session"];
  const sendMic = (session: StartedSession, chunk: Buffer, times = 1) => {
    for (let i = 0; i < times; i += 1) {
      session.handleClientFrame({
        type: "audio",
        dataBase64: chunk.toString("base64"),
      });
    }
  };

  test("mic echo correlated with playback reaches Gemini as silence", async () => {
    const { session } = await startSession();

    captured.onAudio?.(modelTone());
    sendMic(session, echoMicChunk(), 10);

    // Every chunk was substituted (the onset probe resolved as a match and
    // the learned level absorbed the rest); nothing of the echo got through.
    expect(forwardedAudio).toHaveLength(10);
    expect(forwardedAudio.every((chunk) => isSilent(chunk))).toBe(true);
    expect(forwardedAudio.every((chunk) => chunk.length === 320)).toBe(true);
  });

  test("uncorrelated speech during playback is forwarded — barge-in works", async () => {
    const { session } = await startSession();

    captured.onAudio?.(modelTone());
    // Held as the onset probe until 100 ms accumulates, then released as a
    // nonmatch in original order.
    sendMic(session, speechMicChunk(), 10);

    expect(forwardedAudio).toHaveLength(10);
    expect(forwardedAudio.every((chunk) => !isSilent(chunk))).toBe(true);
  });

  test("speech above the learned echo level interrupts after echo settled", async () => {
    const { session } = await startSession();

    captured.onAudio?.(modelTone());
    sendMic(session, echoMicChunk(), 10);
    forwardedAudio.length = 0;

    sendMic(session, speechMicChunk(), 3);

    expect(forwardedAudio).toHaveLength(3);
    expect(forwardedAudio.every((chunk) => !isSilent(chunk))).toBe(true);
  });

  test("with no usable reference the window keeps the silence substitution", async () => {
    const { session } = await startSession();

    // A sliver of model audio (~4 ms) opens the window (drain slack) but is
    // far too short to correlate against: the classifier cannot decide, so
    // the conservative fallback keeps substituting silence.
    captured.onAudio?.(tone(4_700, 200, 100, 24_000));
    sendMic(session, speechMicChunk(), 12);

    expect(forwardedAudio.length).toBeGreaterThan(0);
    expect(forwardedAudio.every((chunk) => isSilent(chunk))).toBe(true);
  });

  test("mic audio with no playback in flight passes through untouched", async () => {
    const { session } = await startSession();

    sendMic(session, speechMicChunk());

    expect(forwardedAudio).toHaveLength(1);
    expect(isSilent(forwardedAudio[0]!)).toBe(false);
  });
});

describe("gemini-live echo gate: echo-safe clients", () => {
  const loudMic = () => {
    const b = Buffer.alloc(320);
    for (let i = 0; i < b.length; i += 2) b.writeInt16LE(8000, i);
    return b;
  };

  test("an echoSafePlayback client's mic passes through even during playback", async () => {
    const { session } = await startSession({ echoSafePlayback: true });

    captured.onAudio?.(Buffer.alloc(2 * 24000 * 2)); // 2s of assistant audio
    session.handleClientFrame({
      type: "audio",
      dataBase64: loudMic().toString("base64"),
    });

    expect(forwardedAudio).toHaveLength(1);
    expect(forwardedAudio[0]!.every((byte) => byte === 0)).toBe(false);
  });
});

describe("gemini-live attach_image (mid-call camera photos)", () => {
  async function waitFor(
    predicate: () => boolean,
    attempts = 100,
  ): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!predicate()) {
      throw new Error("Timed out waiting for attach_image condition");
    }
  }

  test("the ready frame advertises the attachImage capability", async () => {
    const frames: Frame[] = [];
    const session = createGeminiLiveSession({
      sessionId: "s-ready",
      startFrame: {
        type: "start",
        audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
        conversationId: "conv-ready",
      } as never,
      sendFrame: async (payload) => {
        frames.push(payload as Frame);
        return { ...(payload as Frame), seq: frames.length } as never;
      },
    });
    await session.start();

    expect(frames[0]).toMatchObject({ type: "ready", attachImage: true });
    session.close("client_end");
  });

  test("attach_image forwards the image to Gemini AND persists it", async () => {
    const { session, frames } = await startSession();

    session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-42",
    });
    await waitFor(() => photoCalls.length === 1);

    // Leg 1: the live model sees the photo now (realtime video channel).
    expect(forwardedImages).toEqual([
      { dataBase64: "aGVsbG8=", mimeType: "image/jpeg" },
    ]);
    // Leg 2: the transcript gets the durable row (no turn, no frames).
    expect(photoCalls).toEqual([
      { conversationId: "conv-1", attachmentId: "att-42" },
    ]);
    expect(frames).toHaveLength(0);
  });

  test("an unhydratable attachment still persists, forwarding nothing", async () => {
    const { session } = await startSession();

    session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-unknown",
    });
    await waitFor(() => photoCalls.length === 1);

    expect(forwardedImages).toHaveLength(0);
    expect(photoCalls).toEqual([
      { conversationId: "conv-1", attachmentId: "att-unknown" },
    ]);
  });

  test("a failed persist answers with a non-fatal attach_image error", async () => {
    photoResult = { ok: false };
    const { session, frames } = await startSession();

    session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-42",
    });
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "error" && frame.frameType === "attach_image",
      ),
    );

    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      frameType: "attach_image",
      fatal: false,
    });
  });
});
