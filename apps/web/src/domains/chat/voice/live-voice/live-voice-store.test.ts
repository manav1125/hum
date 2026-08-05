/**
 * The session's record of its own call (`turns`).
 *
 * 45104f5e2d deleted the in-thread strip's archive because the chat thread
 * underneath already drew those turns, and drawing both put every finished
 * exchange on screen twice. That reasoning holds only where there IS a thread.
 * The full-screen voice surface covers it entirely, so it needs the call's
 * history from somewhere — and this is it, kept by the store rather than by
 * either surface so the two cannot disagree about what was said.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
});

describe("closing a turn records the exchange", () => {
  test("each finished exchange is appended in the order it happened", () => {
    const s = () => useLiveVoiceStore.getState();
    s().setFinalTranscript("What's on my plate?");
    s().appendAssistantTranscript("Three things.");
    s().closeTurn();
    s().setFinalTranscript("Read them out.");
    s().appendAssistantTranscript("Acme renewal, first.");
    s().closeTurn();

    expect(s().turns).toEqual([
      { id: 1, user: "What's on my plate?", assistant: "Three things." },
      { id: 2, user: "Read them out.", assistant: "Acme renewal, first." },
    ]);
  });

  test("a turn that said nothing is not an exchange", () => {
    // The daemon closes an utterance that transcribed to nothing (a cough, a
    // door) with a bare `tts_done`, which re-arms and closes the turn. Recording
    // that would put an empty pair of bubbles in the transcript.
    useLiveVoiceStore.getState().closeTurn();

    expect(useLiveVoiceStore.getState().turns).toEqual([]);
  });

  test("closing an already-closed turn does not record it twice", () => {
    const s = () => useLiveVoiceStore.getState();
    s().setFinalTranscript("Hello.");
    s().appendAssistantTranscript("Hi there.");
    s().closeTurn();
    s().closeTurn();

    expect(s().turns).toHaveLength(1);
  });

  test("a new session starts with no history", () => {
    const s = () => useLiveVoiceStore.getState();
    s().setFinalTranscript("Hello.");
    s().closeTurn();
    expect(s().turns).toHaveLength(1);

    s().reset();
    expect(s().turns).toEqual([]);
  });
});

describe("W2 · minimize seq and pending approval (v37)", () => {
  const s = () => useLiveVoiceStore.getState();

  test("requestRoomMinimize bumps the seq; reset zeroes it", () => {
    s().requestRoomMinimize();
    s().requestRoomMinimize();
    expect(s().roomMinimizeSeq).toBe(2);

    s().reset();
    expect(s().roomMinimizeSeq).toBe(0);
  });

  test("approval_pending is featured verbatim; a matching resolve clears it", () => {
    s().setPendingApproval({
      type: "approval_pending",
      seq: 3,
      requestId: "req-1",
      turnId: "t-1",
      toolName: "bash",
      summary: "rm -rf build",
      riskLevel: "medium",
      trustLine: "this is the part I can't do alone.",
    });
    expect(s().pendingApproval).toMatchObject({
      requestId: "req-1",
      toolName: "bash",
      summary: "rm -rf build",
      trustLine: "this is the part I can't do alone.",
    });

    // A resolution for some OTHER request never dismisses this card.
    s().clearPendingApproval("req-other");
    expect(s().pendingApproval).not.toBeNull();

    s().clearPendingApproval("req-1");
    expect(s().pendingApproval).toBeNull();
  });

  test("a local deferral (Ask me after) clears without a request id", () => {
    s().setPendingApproval({
      type: "approval_pending",
      seq: 3,
      requestId: "req-1",
      turnId: "t-1",
      toolName: "bash",
      trustLine: "this is the part I can't do alone.",
    });
    s().clearPendingApproval();
    expect(s().pendingApproval).toBeNull();
  });
});
