import { describe, expect, test } from "bun:test";

import {
  parseServerFrame,
  type LiveVoiceServerFrame,
} from "@/domains/chat/voice/live-voice/protocol";

describe("parseServerFrame", () => {
  const frames: LiveVoiceServerFrame[] = [
    { type: "ready", seq: 1, sessionId: "s1", conversationId: "c1" },
    {
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: "c1",
      turnDetection: "server_vad",
    },
    { type: "busy", seq: 2, activeSessionId: "s9" },
    { type: "speech_started", seq: 2 },
    { type: "utterance_end", seq: 3, reason: "silence" },
    { type: "utterance_end", seq: 3, reason: "max-duration" },
    { type: "turn_cancelled", seq: 3, turnId: "t1" },
    { type: "stt_partial", seq: 3, text: "hel" },
    { type: "stt_final", seq: 4, text: "hello" },
    { type: "thinking", seq: 5, turnId: "t1" },
    { type: "assistant_text_delta", seq: 6, text: "hi" },
    {
      type: "tts_audio",
      seq: 7,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAAA",
    },
    { type: "tts_done", seq: 8, turnId: "t1" },
    {
      type: "metrics",
      seq: 9,
      turnId: "t1",
      sttMs: 120,
      llmFirstDeltaMs: 200,
      ttsFirstAudioMs: null,
      totalMs: null,
    },
    {
      type: "metrics",
      seq: 9,
      turnId: "t1",
      sttMs: 120,
      llmFirstDeltaMs: 200,
      dispatchToFirstDeltaMs: 150,
      dispatchToFirstAudioMs: 300,
      ttsFirstAudioMs: null,
      totalMs: null,
      endpointHoldCount: 1,
      endpointDecisionMaxLatencyMs: 480,
    },
    {
      type: "archived",
      seq: 10,
      conversationId: "c1",
      sessionId: "s1",
      turnId: "t1",
      role: "assistant",
      attachmentId: "a1",
      attachmentIds: ["a1", "a2"],
      warning: { code: "w", message: "warn" },
    },
    {
      type: "card",
      seq: 11,
      op: "show",
      surfaceId: "surface-1",
      surfaceType: "list",
      title: "Late-night spots",
      data: { items: [{ id: "a", title: "Luigi's Hot Pizza" }] },
      actions: [{ id: "open", label: "Open", style: "primary" }],
      turnId: "t1",
    },
    {
      type: "card",
      seq: 12,
      op: "dismiss",
      surfaceId: "surface-1",
      turnId: "t1",
    },
    { type: "error", seq: 13, code: "boom", message: "bad" },
  ];

  for (const frame of frames) {
    test(`round-trips ${frame.type} frame`, () => {
      const result = parseServerFrame(JSON.stringify(frame));
      expect(result).toEqual(frame);
    });
  }

  test("returns invalid_json for malformed JSON", () => {
    const result = parseServerFrame("{not json");
    expect(result).toEqual({
      type: "error",
      code: "invalid_json",
      message: expect.any(String),
    });
  });

  test("returns invalid_json for non-object JSON", () => {
    for (const raw of ["42", '"str"', "null", "[]"]) {
      expect(parseServerFrame(raw)).toEqual({
        type: "error",
        code: "invalid_json",
        message: expect.any(String),
      });
    }
  });

  test("returns an ignorable unknown_frame for unknown frame types", () => {
    // Newer daemons may emit frame types this client version does not know
    // (e.g. the V-1b/V-1c additions). They must parse to an ignorable
    // unknown_frame, NOT a fatal invalid_json — an unknown frame killing the
    // call is the compatibility failure the capability-flag convention
    // exists to prevent.
    const result = parseServerFrame(
      JSON.stringify({ type: "made_up", seq: 1 }),
    );
    expect(result).toEqual({ type: "unknown_frame", frameType: "made_up" });
  });

  test("returns invalid_json for missing type", () => {
    const result = parseServerFrame(JSON.stringify({ seq: 1, text: "x" }));
    expect(result).toEqual({
      type: "error",
      code: "invalid_json",
      message: expect.any(String),
    });
  });

  test("parses the W2 frames: minimize_room, approval_pending, approval_resolved", () => {
    expect(
      parseServerFrame(
        JSON.stringify({ type: "minimize_room", seq: 4, turnId: "t-1" }),
      ),
    ).toEqual({ type: "minimize_room", seq: 4, turnId: "t-1" });

    expect(
      parseServerFrame(
        JSON.stringify({
          type: "approval_pending",
          seq: 5,
          requestId: "req-1",
          turnId: "t-1",
          toolName: "bash",
          summary: "rm -rf build",
          riskLevel: "medium",
          trustLine: "this is the part I can't do alone.",
        }),
      ),
    ).toMatchObject({
      type: "approval_pending",
      requestId: "req-1",
      toolName: "bash",
      trustLine: "this is the part I can't do alone.",
    });

    expect(
      parseServerFrame(
        JSON.stringify({
          type: "approval_resolved",
          seq: 6,
          requestId: "req-1",
          turnId: "t-1",
          outcome: "expired",
        }),
      ),
    ).toMatchObject({
      type: "approval_resolved",
      requestId: "req-1",
      outcome: "expired",
    });
  });
});

describe("attach_image additions (mid-call camera photos)", () => {
  test("a ready frame advertising attachImage round-trips", () => {
    const parsed = parseServerFrame(
      JSON.stringify({
        type: "ready",
        seq: 1,
        sessionId: "s1",
        conversationId: "c1",
        attachImage: true,
      }),
    );
    expect(parsed).toEqual({
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: "c1",
      attachImage: true,
    });
  });

  test("an error frame's frameType attribution round-trips", () => {
    const parsed = parseServerFrame(
      JSON.stringify({
        type: "error",
        seq: 2,
        code: "invalid_frame",
        message: "Could not attach that photo to the conversation.",
        frameType: "attach_image",
        fatal: false,
      }),
    );
    expect(parsed).toEqual({
      type: "error",
      seq: 2,
      code: "invalid_frame",
      message: "Could not attach that photo to the conversation.",
      frameType: "attach_image",
      fatal: false,
    });
  });
});
