/**
 * V-3 · Mid-call reveal + approval moment (design v37 §W2).
 *
 * Reveal — "voice announces, screen follows": a turn that left a surface on
 * screen (the `ui_surface_show`/`ui_update` card path; `ui_dismiss` clears
 * it) emits `minimize_room` strictly AFTER its `tts_done`, at most once per
 * turn, and only to sessions that opted into `turnDetection: "server_vad"`.
 * Nothing the model says moves the room ([-1] stays strip-only).
 *
 * Approval — a turn parked on a pending confirmation emits
 * `approval_pending` IMMEDIATELY (no drain to wait for), speaks the fixed
 * phrase exactly once per wait through the audio-only filler path, stands
 * progress narration down for the duration, bounds the presentation with a
 * 45 s window (`approval_resolved` outcome `expired` — the confirmation
 * itself stays pending on the chat path), and reports every real resolution
 * as `approval_resolved`.
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceApprovalOutcome,
  VoicePendingApprovalEvent,
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
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

initializeDb();

const APPROVAL_PHRASE = "That one needs your okay — take a look.";

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

function makeStartFrame(
  overrides: Partial<LiveVoiceClientStartFrame> = {},
): LiveVoiceClientStartFrame {
  return {
    type: "start",
    conversationId: "conversation-reveal",
    audio: { mimeType: "audio/pcm", sampleRate: 16_000, channels: 1 },
    ...overrides,
  } as LiveVoiceClientStartFrame;
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
    conversationId: "conversation-reveal",
  };
}

function makeMessageComplete(): Parameters<
  NonNullable<VoiceTurnCallbacks["message_complete"]>
>[0] {
  return {
    type: "message_complete",
    conversationId: "conversation-reveal",
    messageId: "assistant-message-1",
  };
}

function makeUiSurfaceShow(
  surfaceId = "surface-1",
): Parameters<NonNullable<VoiceTurnCallbacks["ui_surface_show"]>>[0] {
  return {
    type: "ui_surface_show",
    conversationId: "conversation-reveal",
    surfaceId,
    surfaceType: "list",
    title: "Late-night spots",
    data: { items: [], selectionMode: "none" },
  } as Parameters<NonNullable<VoiceTurnCallbacks["ui_surface_show"]>>[0];
}

function makeUiSurfaceDismiss(
  surfaceId = "surface-1",
): Parameters<NonNullable<VoiceTurnCallbacks["ui_surface_dismiss"]>>[0] {
  return {
    type: "ui_surface_dismiss",
    conversationId: "conversation-reveal",
    surfaceId,
  } as Parameters<NonNullable<VoiceTurnCallbacks["ui_surface_dismiss"]>>[0];
}

function makeApproval(requestId = "req-1"): VoicePendingApprovalEvent {
  return {
    requestId,
    toolName: "bash",
    riskLevel: "medium",
    input: { command: "rm -rf build" },
    summary: "rm -rf build",
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flushAsyncCallbacks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Boot a session into a released, in-flight turn whose bridge callbacks —
 * including the approval callbacks — the test drives directly.
 */
async function startTurnHarness(
  options: {
    startFrame?: LiveVoiceClientStartFrame;
    liveVoiceConfig?: ReturnType<typeof LiveVoiceConfigSchema.parse>;
    frontDecider?: VoiceFrontDecider | null;
    approvalPresentationTimeoutMs?: number;
  } = {},
) {
  const transcriber = new ControllableTranscriber();
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const ttsTexts: string[] = [];
  let callbacks: VoiceTurnCallbacks | undefined;
  let approvalPending: ((a: VoicePendingApprovalEvent) => void) | undefined;
  let approvalResolved:
    | ((requestId: string, outcome: VoiceApprovalOutcome) => void)
    | undefined;
  let started = false;

  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-reveal",
    startFrame:
      options.startFrame ?? makeStartFrame({ turnDetection: "server_vad" }),
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
      approvalPending = opts.onApprovalPending;
      approvalResolved = opts.onApprovalResolved;
      started = true;
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
    liveVoiceConfig:
      options.liveVoiceConfig ??
      LiveVoiceConfigSchema.parse({ credentialPreflight: false }),
    frontDecider: options.frontDecider ?? null,
    createTurnId: () => "live-turn-1",
    ...(options.approvalPresentationTimeoutMs !== undefined
      ? {
          approvalPresentationTimeoutMs: options.approvalPresentationTimeoutMs,
        }
      : {}),
  });

  await session.start();
  await session.handleClientFrame({ type: "ptt_release" });
  transcriber.finishUtterance("show me the pricing table");
  await waitFor(() => started, "assistant turn did not start");

  return {
    session,
    frames,
    ttsTexts,
    callbacks: () => callbacks,
    announceApprovalPending: (approval: VoicePendingApprovalEvent) =>
      approvalPending?.(approval),
    announceApprovalResolved: (
      requestId: string,
      outcome: VoiceApprovalOutcome,
    ) => approvalResolved?.(requestId, outcome),
  };
}

function frameIndex(frames: LiveVoiceServerFrame[], type: string): number {
  return frames.findIndex((frame) => frame.type === type);
}

// ---------------------------------------------------------------------------
// Reveal — voice announces, screen follows
// ---------------------------------------------------------------------------

describe("live-voice mid-call reveal", () => {
  test("a shown surface emits minimize_room after tts_done, once", async () => {
    const h = await startTurnHarness();

    h.callbacks()?.ui_surface_show?.(makeUiSurfaceShow("surface-1"));
    h.callbacks()?.ui_surface_show?.(makeUiSurfaceShow("surface-2"));
    h.callbacks()?.assistant_text_delta?.(
      makeTextDelta("Here's the pricing table."),
    );
    h.callbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(
      () => frameIndex(h.frames, "minimize_room") !== -1,
      "minimize_room never arrived",
    );

    const ttsDoneIndex = frameIndex(h.frames, "tts_done");
    const minimizeIndex = frameIndex(h.frames, "minimize_room");
    expect(ttsDoneIndex).toBeGreaterThanOrEqual(0);
    // After the announcing sentence's speech drains — never mid-sentence.
    expect(minimizeIndex).toBeGreaterThan(ttsDoneIndex);
    expect(h.frames[minimizeIndex]).toMatchObject({
      type: "minimize_room",
      turnId: "live-turn-1",
    });
    // At most once, however many surfaces the turn touched.
    expect(
      h.frames.filter((frame) => frame.type === "minimize_room"),
    ).toHaveLength(1);
    await h.session.close("websocket_close");
  });

  test("a surface taken away before the reply ends reveals nothing", async () => {
    const h = await startTurnHarness();

    h.callbacks()?.ui_surface_show?.(makeUiSurfaceShow("surface-1"));
    h.callbacks()?.ui_surface_dismiss?.(makeUiSurfaceDismiss("surface-1"));
    h.callbacks()?.assistant_text_delta?.(
      makeTextDelta("Never mind, sorted it."),
    );
    h.callbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(
      () => frameIndex(h.frames, "tts_done") !== -1,
      "tts_done never arrived",
    );
    await flushAsyncCallbacks();

    // Minimizing to show the user something that is no longer there is the
    // opposite of the point.
    expect(h.frames.some((frame) => frame.type === "minimize_room")).toBe(
      false,
    );
    await h.session.close("websocket_close");
  });

  test("a turn that shows nothing emits no minimize_room", async () => {
    const h = await startTurnHarness();

    h.callbacks()?.assistant_text_delta?.(makeTextDelta("Just an answer."));
    h.callbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(
      () => frameIndex(h.frames, "tts_done") !== -1,
      "tts_done never arrived",
    );
    await flushAsyncCallbacks();

    expect(h.frames.some((frame) => frame.type === "minimize_room")).toBe(
      false,
    );
    await h.session.close("websocket_close");
  });

  test("a manual (non-server_vad) session never sees minimize_room, but keeps its card", async () => {
    const h = await startTurnHarness({ startFrame: makeStartFrame() });

    h.callbacks()?.ui_surface_show?.(makeUiSurfaceShow("surface-1"));
    h.callbacks()?.assistant_text_delta?.(
      makeTextDelta("Here's the pricing table."),
    );
    h.callbacks()?.message_complete?.(makeMessageComplete());
    await waitFor(
      () => frameIndex(h.frames, "tts_done") !== -1,
      "tts_done never arrived",
    );
    await flushAsyncCallbacks();

    // The card path is unchanged for old clients; the new frame type is
    // capability-gated and never reaches a client that did not opt in.
    expect(h.frames.some((frame) => frame.type === "card")).toBe(true);
    expect(h.frames.some((frame) => frame.type === "minimize_room")).toBe(
      false,
    );
    await h.session.close("websocket_close");
  });
});

// ---------------------------------------------------------------------------
// Approval — the mid-call approval moment
// ---------------------------------------------------------------------------

describe("live-voice mid-call approval", () => {
  test("a pending approval emits approval_pending immediately with the payload", async () => {
    const h = await startTurnHarness();

    h.announceApprovalPending(makeApproval("req-1"));
    await waitFor(
      () => frameIndex(h.frames, "approval_pending") !== -1,
      "approval_pending never arrived",
    );

    // Immediately — before any tts_done (approval ≠ reveal: a blocked turn
    // has no speech left to drain).
    expect(h.frames.some((frame) => frame.type === "tts_done")).toBe(false);
    expect(h.frames[frameIndex(h.frames, "approval_pending")]).toMatchObject({
      type: "approval_pending",
      requestId: "req-1",
      turnId: "live-turn-1",
      toolName: "bash",
      summary: "rm -rf build",
      riskLevel: "medium",
      trustLine: "this is the part I can't do alone.",
    });
    await h.session.close("websocket_close");
  });

  test("speaks the fixed phrase once per wait, audio-only, never persisted or captioned", async () => {
    const h = await startTurnHarness();

    h.announceApprovalPending(makeApproval("req-1"));
    await waitFor(
      () => h.ttsTexts.join(" ").includes("okay"),
      "approval phrase never spoken",
    );
    // A second pending approval in the same wait does not repeat the line.
    h.announceApprovalPending(makeApproval("req-2"));
    await flushAsyncCallbacks();

    expect(h.ttsTexts.filter((text) => text === APPROVAL_PHRASE)).toHaveLength(
      1,
    );
    // Audio-only invariant: the phrase reaches TTS (and tts_audio frames)
    // but never an assistant_text_delta — captions and the persisted
    // transcript carry only the model's own words.
    expect(
      h.frames.some(
        (frame) =>
          frame.type === "assistant_text_delta" && frame.text.includes("okay"),
      ),
    ).toBe(false);
    expect(h.frames.some((frame) => frame.type === "tts_audio")).toBe(true);
    await h.session.close("websocket_close");
  });

  test("a resolution reaches the client as approval_resolved with the outcome", async () => {
    const h = await startTurnHarness();

    h.announceApprovalPending(makeApproval("req-1"));
    await waitFor(
      () => frameIndex(h.frames, "approval_pending") !== -1,
      "approval_pending never arrived",
    );
    h.announceApprovalResolved("req-1", "approved");
    await waitFor(
      () => frameIndex(h.frames, "approval_resolved") !== -1,
      "approval_resolved never arrived",
    );

    expect(h.frames[frameIndex(h.frames, "approval_resolved")]).toMatchObject({
      type: "approval_resolved",
      requestId: "req-1",
      turnId: "live-turn-1",
      outcome: "approved",
    });
    await h.session.close("websocket_close");
  });

  test("the 45s presentation window expires as approval_resolved outcome expired", async () => {
    const h = await startTurnHarness({ approvalPresentationTimeoutMs: 20 });

    h.announceApprovalPending(makeApproval("req-1"));
    await waitFor(
      () =>
        h.frames.some(
          (frame) =>
            frame.type === "approval_resolved" && frame.outcome === "expired",
        ),
      "presentation window never expired",
    );

    // Presentation only: a real decision landing later still reports its own
    // outcome (the confirmation stayed pending on the chat path — the
    // chat-surface expiry owns its final consequence).
    h.announceApprovalResolved("req-1", "denied");
    await waitFor(
      () =>
        h.frames.some(
          (frame) =>
            frame.type === "approval_resolved" && frame.outcome === "denied",
        ),
      "late real resolution never reported",
    );
    await h.session.close("websocket_close");
  });

  test("a turn cancelled mid-wait supersedes its pending approvals", async () => {
    const h = await startTurnHarness();

    h.announceApprovalPending(makeApproval("req-1"));
    await waitFor(
      () => frameIndex(h.frames, "approval_pending") !== -1,
      "approval_pending never arrived",
    );

    await h.session.handleClientFrame({ type: "interrupt" });
    await waitFor(
      () =>
        h.frames.some(
          (frame) =>
            frame.type === "approval_resolved" &&
            frame.outcome === "superseded",
        ),
      "cancelled turn never superseded its approval",
    );
    await h.session.close("websocket_close");
  });

  test("a manual (non-server_vad) session gets the phrase but no approval frames", async () => {
    const h = await startTurnHarness({ startFrame: makeStartFrame() });

    h.announceApprovalPending(makeApproval("req-1"));
    await waitFor(
      () => h.ttsTexts.includes(APPROVAL_PHRASE),
      "approval phrase never spoken",
    );
    await flushAsyncCallbacks();

    expect(h.frames.some((frame) => frame.type === "approval_pending")).toBe(
      false,
    );
    expect(h.frames.some((frame) => frame.type === "approval_resolved")).toBe(
      false,
    );
    await h.session.close("websocket_close");
  });

  test("progress narration stands down while an approval is pending and resumes after", async () => {
    const h = await startTurnHarness({
      liveVoiceConfig: LiveVoiceConfigSchema.parse({
        credentialPreflight: false,
        frontModel: {
          progress: {
            enabled: true,
            opsThreshold: 1,
            idleIntervalMs: 60_000,
            maxSilenceMs: 60_000,
            minGapMs: 1,
          },
        },
      }),
      frontDecider: {
        generateAckText: async () => null,
        generateProgressText: async () => "Still working on it.",
      },
    });

    h.announceApprovalPending(makeApproval("req-1"));
    await waitFor(
      () => h.ttsTexts.includes(APPROVAL_PHRASE),
      "approval phrase never spoken",
    );

    // The ops trigger fires while the wait is on: narration must stand down
    // — every phrase it has describes work in flight, and nothing is.
    h.callbacks()?.tool_use_start?.({
      type: "tool_use_start",
      conversationId: "conversation-reveal",
      toolUseId: "t-1",
      toolName: "web_search",
      input: {},
    } as Parameters<NonNullable<VoiceTurnCallbacks["tool_use_start"]>>[0]);
    await flushAsyncCallbacks();
    expect(h.ttsTexts).not.toContain("Still working on it.");

    // Decision lands → the wait is over → the same trigger narrates again.
    h.announceApprovalResolved("req-1", "approved");
    h.callbacks()?.tool_use_start?.({
      type: "tool_use_start",
      conversationId: "conversation-reveal",
      toolUseId: "t-2",
      toolName: "web_search",
      input: {},
    } as Parameters<NonNullable<VoiceTurnCallbacks["tool_use_start"]>>[0]);
    await waitFor(
      () => h.ttsTexts.includes("Still working on it."),
      "narration never resumed after the approval resolved",
    );
    await h.session.close("websocket_close");
  });
});
