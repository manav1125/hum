/**
 * Spoken-ack presence layer wired into the session (WS-E).
 *
 * When `liveVoice.frontModel.spokenAcks` is on and the assistant is slow to
 * produce its first spoken delta, a short static floor-holder is streamed to
 * TTS ahead of the eventual reply, so a slow turn feels responsive. When the
 * first delta arrives before the budget, or the feature is off, no ack speaks.
 *
 * These tests drive a real `LiveVoiceSession` with stubbed transcriber / bridge
 * / TTS and an injected `liveVoiceConfig`, so the wiring (timer arm → fire →
 * TTS enqueue, and its guards) is exercised end-to-end. The DB is initialized
 * up front because `start()` creates the conversation row.
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import { LiveVoiceConfigSchema } from "../../config/schemas/live-voice.js";
import { initializeDb } from "../../memory/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { pickAckPhrase } from "../ack-phrases.js";
import { LiveVoiceSession } from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

initializeDb();

const START_FRAME: LiveVoiceClientStartFrame = {
  type: "start",
  conversationId: "conversation-ack",
  audio: { mimeType: "audio/pcm", sampleRate: 16_000, channels: 1 },
};

class ControllableTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }
  sendAudio(): void {}
  stop(): void {}
  finishUtterance(text: string): void {
    this.onEvent?.({ type: "final", text });
    this.onEvent?.({ type: "closed" });
  }
}

function makeTtsChunk(text: string): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: 16_000,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function makeTextDelta(
  text: string,
): Parameters<NonNullable<VoiceTurnCallbacks["assistant_text_delta"]>>[0] {
  return {
    type: "assistant_text_delta",
    text,
    conversationId: "conversation-ack",
  };
}

function makeMessageComplete(
  messageId: string,
): Parameters<NonNullable<VoiceTurnCallbacks["message_complete"]>>[0] {
  return {
    type: "message_complete",
    conversationId: "conversation-ack",
    messageId,
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("live-voice spoken acks", () => {
  test("slow first delta with spokenAcks on → a static ack is spoken before the reply", async () => {
    const transcriber = new ControllableTranscriber();
    const sequencer = createLiveVoiceServerFrameSequencer();
    const frames: LiveVoiceServerFrame[] = [];
    const ttsTexts: string[] = [];
    let started = false;

    const context: LiveVoiceSessionFactoryContext = {
      sessionId: "session-ack",
      startFrame: START_FRAME,
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    };
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn: mock(async () => {
        started = true;
        // Silent turn: never fire a delta, so the ack timer must fire.
        return { turnId: "bridge-turn", abort: mock() };
      }),
      streamTtsAudio: mock(async (opts: LiveVoiceTtsOptions) => {
        ttsTexts.push(opts.text);
        opts.onAudioChunk(makeTtsChunk(`audio:${opts.text}`));
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: 16_000,
          chunks: 1,
          bytes: Buffer.byteLength(opts.text),
        } satisfies LiveVoiceTtsResult;
      }),
      liveVoiceConfig: LiveVoiceConfigSchema.parse({
        credentialPreflight: false,
        frontModel: { spokenAcks: true, ackFirstDeltaTimeoutMs: 15 },
      }),
      createTurnId: () => "turn-ack",
    });

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.finishUtterance("what's the weather");
    await waitFor(() => started, "assistant turn did not start");
    await waitFor(() => ttsTexts.length > 0, "no ack was spoken");

    expect(ttsTexts[0]).toBe(pickAckPhrase("first_delta", 0));
    await session.close("websocket_close");
  });

  test("fast first delta → no ack, only the reply is spoken", async () => {
    const transcriber = new ControllableTranscriber();
    const sequencer = createLiveVoiceServerFrameSequencer();
    const ttsTexts: string[] = [];
    let started = false;

    const context: LiveVoiceSessionFactoryContext = {
      sessionId: "session-ack",
      startFrame: START_FRAME,
      sendFrame: mock(async (payload) => sequencer.next(payload)),
    };
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn: mock(async (opts: VoiceTurnOptions) => {
        started = true;
        opts.callbacks?.assistant_text_delta?.(makeTextDelta("Sunny."));
        opts.callbacks?.message_complete?.(makeMessageComplete("assistant-1"));
        return { turnId: "bridge-turn", abort: mock() };
      }),
      streamTtsAudio: mock(async (opts: LiveVoiceTtsOptions) => {
        ttsTexts.push(opts.text);
        opts.onAudioChunk(makeTtsChunk(`audio:${opts.text}`));
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: 16_000,
          chunks: 1,
          bytes: Buffer.byteLength(opts.text),
        } satisfies LiveVoiceTtsResult;
      }),
      liveVoiceConfig: LiveVoiceConfigSchema.parse({
        credentialPreflight: false,
        frontModel: { spokenAcks: true, ackFirstDeltaTimeoutMs: 200 },
      }),
      createTurnId: () => "turn-ack",
    });

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.finishUtterance("weather?");
    await waitFor(() => started, "assistant turn did not start");
    await waitFor(() => ttsTexts.length > 0, "no reply was spoken");
    // Give the (200ms) ack timer no chance — the reply already arrived.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const ackPhrases = [0, 1, 2, 3, 4].map((n) =>
      pickAckPhrase("first_delta", n),
    );
    expect(ttsTexts.some((t) => ackPhrases.includes(t))).toBe(false);
    expect(ttsTexts).toContain("Sunny.");
    await session.close("websocket_close");
  });

  test("spokenAcks off → a slow turn speaks nothing extra", async () => {
    const transcriber = new ControllableTranscriber();
    const sequencer = createLiveVoiceServerFrameSequencer();
    const ttsTexts: string[] = [];
    let started = false;

    const context: LiveVoiceSessionFactoryContext = {
      sessionId: "session-ack",
      startFrame: START_FRAME,
      sendFrame: mock(async (payload) => sequencer.next(payload)),
    };
    const session = new LiveVoiceSession(context, {
      resolveTranscriber: mock(async () => transcriber),
      startVoiceTurn: mock(async () => {
        started = true;
        return { turnId: "bridge-turn", abort: mock() };
      }),
      streamTtsAudio: mock(async (opts: LiveVoiceTtsOptions) => {
        ttsTexts.push(opts.text);
        return {
          provider: "fish-audio",
          contentType: "audio/pcm",
          sampleRate: 16_000,
          chunks: 0,
          bytes: 0,
        } satisfies LiveVoiceTtsResult;
      }),
      liveVoiceConfig: LiveVoiceConfigSchema.parse({
        credentialPreflight: false,
        frontModel: { spokenAcks: false, ackFirstDeltaTimeoutMs: 15 },
      }),
      createTurnId: () => "turn-ack",
    });

    await session.start();
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
    await session.handleClientFrame({ type: "ptt_release" });
    transcriber.finishUtterance("weather?");
    await waitFor(() => started, "assistant turn did not start");
    // Wait well past the ack budget; nothing should have been spoken.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ttsTexts).toHaveLength(0);
    await session.close("websocket_close");
  });
});
