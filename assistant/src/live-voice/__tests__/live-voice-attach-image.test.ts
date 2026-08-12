/**
 * The cascade engine's `attach_image` handling (mid-call camera photos,
 * ported from upstream 48a63d28d7 / 639f7bc1cb):
 *
 * - `ready` advertises `attachImage: true` — the capability flag the client
 *   gates its camera on.
 * - An `attach_image` client frame persists via `persistLiveVoicePhoto`
 *   (fire-and-forget; no turn dispatched, no voice-turn started).
 * - A failed persist answers with a NON-fatal `error` frame carrying
 *   `frameType: "attach_image"`, so the client can retract the thumbnail
 *   without tearing the call down.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { initializeDb } from "../../memory/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";

// Seam: the photo persist. Spread the real module; override only the seam.
let photoCalls: Array<{ conversationId: string; attachmentId: string }> = [];
let photoResult: { ok: boolean; messageId?: string } = {
  ok: true,
  messageId: "msg-1",
};
const photoActual = await import("../live-voice-photo.js");
mock.module("../live-voice-photo.js", () => ({
  ...photoActual,
  persistLiveVoicePhoto: async (
    conversationId: string,
    attachmentId: string,
  ) => {
    photoCalls.push({ conversationId, attachmentId });
    return photoResult;
  },
}));

const { LiveVoiceSession } = await import("../live-voice-session.js");
const { createLiveVoiceServerFrameSequencer } = await import("../protocol.js");
type LiveVoiceServerFrame = import("../protocol.js").LiveVoiceServerFrame;

// The session ensures a `conversations` row on start (FK for the first
// turn's insert), so these tests need a real schema.
initializeDb();

class IdleTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  async start(_onEvent: (event: SttStreamServerEvent) => void): Promise<void> {}
  sendAudio(): void {}
  stop(): void {}
}

function createHarness() {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const startVoiceTurn = mock(async () => ({
    turnId: "bridge-turn",
    abort: mock(),
  }));
  const session = new LiveVoiceSession(
    {
      sessionId: "session-attach",
      startFrame: {
        type: "start",
        conversationId: "conversation-attach",
        audio: { mimeType: "audio/pcm", sampleRate: 16_000, channels: 1 },
        fullDuplex: true,
      },
      sendFrame: async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      },
    },
    {
      resolveTranscriber: mock(async () => new IdleTranscriber()),
      startVoiceTurn,
      streamTtsAudio: mock(async () => ({
        provider: "fish-audio" as const,
        contentType: "audio/pcm",
        sampleRate: 16_000,
        chunks: 0,
        bytes: 0,
      })),
    },
  );
  return { session, frames, startVoiceTurn };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for attach_image test condition",
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(message);
}

beforeEach(() => {
  photoCalls = [];
  photoResult = { ok: true, messageId: "msg-1" };
});

describe("cascade attach_image", () => {
  test("ready advertises the attachImage capability", async () => {
    const { session, frames } = createHarness();
    await session.start();

    const ready = frames.find((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ type: "ready", attachImage: true });

    await session.close("client_end");
  });

  test("attach_image persists the photo and dispatches no turn", async () => {
    const { session, frames, startVoiceTurn } = createHarness();
    await session.start();
    const framesAfterReady = frames.length;

    await session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-42",
    });
    await waitFor(() => photoCalls.length === 1);

    expect(photoCalls).toEqual([
      { conversationId: "conversation-attach", attachmentId: "att-42" },
    ]);
    // No turn, no frames: the client already showed its local thumbnail and
    // the persisted row announces itself through the conversation channel.
    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(frames.length).toBe(framesAfterReady);

    await session.close("client_end");
  });

  test("a failed persist answers with a non-fatal attach_image error", async () => {
    photoResult = { ok: false };
    const { session, frames } = createHarness();
    await session.start();

    await session.handleClientFrame({
      type: "attach_image",
      attachmentId: "att-broken",
    });
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.type === "error" && frame.frameType === "attach_image",
      ),
    );

    const error = frames.find((frame) => frame.type === "error");
    expect(error).toMatchObject({
      type: "error",
      code: "invalid_frame",
      frameType: "attach_image",
      fatal: false,
    });

    await session.close("client_end");
  });
});
