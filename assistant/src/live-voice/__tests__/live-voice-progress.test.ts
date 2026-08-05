/**
 * Spoken progress narration wired into the session
 * (liveVoice.frontModel.progress).
 *
 * A long-running turn narrates its tool activity into audible dead air: the
 * `ops` trigger after enough tool starts, `op_complete` when a long op
 * finishes (inferred from the next tool start — our bridge has no
 * tool_result callback), and the `idle` heartbeat after `maxSilenceMs` of
 * unbroken silence (static fallback when the decider fails). The phrase is
 * audio-only: it reaches the TTS queue and never an `assistant_text_delta`
 * frame.
 *
 * These tests drive a real `LiveVoiceSession` with stubbed transcriber /
 * bridge / TTS, an injected `liveVoiceConfig`, and an injected front decider,
 * so the gates and cadence are exercised end-to-end. The DB is initialized up
 * front because `start()` creates the conversation row.
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
import type { VoiceFrontDecider } from "../front-decision.js";
import { LiveVoiceSession } from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import { PROGRESS_FALLBACK_PHRASES } from "../progress-phrases.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

initializeDb();

const START_FRAME: LiveVoiceClientStartFrame = {
  type: "start",
  conversationId: "conversation-progress",
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

function makeToolUseStart(
  toolName: string,
  toolUseId: string,
): Parameters<NonNullable<VoiceTurnCallbacks["tool_use_start"]>>[0] {
  return {
    type: "tool_use_start",
    conversationId: "conversation-progress",
    toolUseId,
    toolName,
    input: {},
  } as Parameters<NonNullable<VoiceTurnCallbacks["tool_use_start"]>>[0];
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function stubDecider(
  generateProgressText: VoiceFrontDecider["generateProgressText"],
): VoiceFrontDecider {
  return {
    generateAckText: async () => null,
    generateProgressText,
  };
}

/**
 * Boot a session into a released, still-running (never-completing) turn and
 * expose its bridge callbacks plus everything spoken to TTS.
 */
async function startNarratableTurn(options: {
  liveVoiceConfig: ReturnType<typeof LiveVoiceConfigSchema.parse>;
  frontDecider: VoiceFrontDecider | null;
}): Promise<{
  session: LiveVoiceSession;
  frames: LiveVoiceServerFrame[];
  ttsTexts: string[];
  callbacks: () => VoiceTurnCallbacks | undefined;
}> {
  const transcriber = new ControllableTranscriber();
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const ttsTexts: string[] = [];
  let callbacks: VoiceTurnCallbacks | undefined;
  let started = false;

  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-progress",
    startFrame: START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn: mock(async (opts: VoiceTurnOptions) => {
      callbacks = opts.callbacks;
      started = true;
      // Long-running turn: never produces a delta and never completes.
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
    liveVoiceConfig: options.liveVoiceConfig,
    frontDecider: options.frontDecider,
    createTurnId: () => "turn-progress",
  });

  await session.start();
  await session.handleBinaryAudio(new Uint8Array([1, 2, 3, 4]));
  await session.handleClientFrame({ type: "ptt_release" });
  transcriber.finishUtterance("plan my trip to lisbon");
  await waitFor(() => started, "assistant turn did not start");

  return { session, frames, ttsTexts, callbacks: () => callbacks };
}

function progressConfig(
  progress: Record<string, unknown>,
): ReturnType<typeof LiveVoiceConfigSchema.parse> {
  return LiveVoiceConfigSchema.parse({
    credentialPreflight: false,
    frontModel: { progress },
  });
}

describe("live-voice progress narration", () => {
  test("ships inert: progress.enabled defaults to false (deviation from upstream)", () => {
    expect(LiveVoiceConfigSchema.parse({}).frontModel.progress.enabled).toBe(
      false,
    );
  });

  test("disabled (default) → a tool-heavy silent turn narrates nothing", async () => {
    const { session, ttsTexts, callbacks } = await startNarratableTurn({
      liveVoiceConfig: LiveVoiceConfigSchema.parse({
        credentialPreflight: false,
      }),
      frontDecider: stubDecider(async () => "Searching the web now."),
    });

    for (let i = 0; i < 4; i += 1) {
      callbacks()?.tool_use_start?.(makeToolUseStart("web_search", `t-${i}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(ttsTexts).toHaveLength(0);
    await session.close("websocket_close");
  });

  test("ops trigger: enough tool starts → one decider-phrased update, audio-only", async () => {
    const { session, frames, ttsTexts, callbacks } = await startNarratableTurn({
      liveVoiceConfig: progressConfig({
        enabled: true,
        opsThreshold: 3,
        idleIntervalMs: 60_000,
        maxSilenceMs: 60_000,
        minGapMs: 1,
      }),
      frontDecider: stubDecider(
        async () => "Searched the web, checking calendars now.",
      ),
    });

    callbacks()?.tool_use_start?.(makeToolUseStart("web_search", "t-1"));
    callbacks()?.tool_use_start?.(makeToolUseStart("web_fetch", "t-2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Two ops are below the threshold: nothing spoken yet.
    expect(ttsTexts).toHaveLength(0);

    callbacks()?.tool_use_start?.(makeToolUseStart("calendar_list", "t-3"));
    await waitFor(() => ttsTexts.length > 0, "ops trigger never narrated");

    expect(ttsTexts).toEqual(["Searched the web, checking calendars now."]);
    // Audio-only: the narration reaches TTS and the socket's tts_audio
    // frames, but never an assistant_text_delta (captions/persisted
    // transcript carry only the model's own output).
    expect(
      frames.some(
        (frame) =>
          frame.type === "assistant_text_delta" &&
          frame.text.includes("Searched the web"),
      ),
    ).toBe(false);
    expect(frames.some((frame) => frame.type === "tts_audio")).toBe(true);
    await session.close("websocket_close");
  });

  test("op_complete trigger: a long op closing narrates without waiting for opsThreshold", async () => {
    const { session, ttsTexts, callbacks } = await startNarratableTurn({
      liveVoiceConfig: progressConfig({
        enabled: true,
        opsThreshold: 5,
        idleIntervalMs: 60_000,
        maxSilenceMs: 60_000,
        minGapMs: 1,
        longOpMs: 1,
      }),
      frontDecider: stubDecider(async () => "Finished the search."),
    });

    callbacks()?.tool_use_start?.(makeToolUseStart("web_search", "t-1"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    // The next tool starting closes the previous op (our bridge forwards no
    // tool_result); a >= longOpMs op completing narrates immediately even
    // though only 2 ops have started (threshold is 5).
    callbacks()?.tool_use_start?.(makeToolUseStart("web_fetch", "t-2"));
    await waitFor(() => ttsTexts.length > 0, "op_complete never narrated");

    expect(ttsTexts).toEqual(["Finished the search."]);
    await session.close("websocket_close");
  });

  test("idle heartbeat: decider failure falls back to a static phrase", async () => {
    const { session, ttsTexts } = await startNarratableTurn({
      liveVoiceConfig: progressConfig({
        enabled: true,
        opsThreshold: 3,
        idleIntervalMs: 25,
        maxSilenceMs: 25,
        minGapMs: 1,
      }),
      // Decider fails on every generation: the idle trigger must still
      // speak (silence is actively harmful there) via the static fallback.
      frontDecider: stubDecider(async () => null),
    });

    await waitFor(() => ttsTexts.length > 0, "idle heartbeat never narrated");
    expect(PROGRESS_FALLBACK_PHRASES).toContain(ttsTexts[0]);
    await session.close("websocket_close");
  });

  test("idle tick with nothing new stays quiet until the heartbeat ceiling", async () => {
    const { session, ttsTexts } = await startNarratableTurn({
      liveVoiceConfig: progressConfig({
        enabled: true,
        opsThreshold: 3,
        idleIntervalMs: 20,
        // Ceiling far away: ticks find no new activity and no expired
        // heartbeat, so nothing speaks.
        maxSilenceMs: 60_000,
        minGapMs: 1,
      }),
      frontDecider: stubDecider(async () => "Should never be spoken."),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ttsTexts).toHaveLength(0);
    await session.close("websocket_close");
  });
});
