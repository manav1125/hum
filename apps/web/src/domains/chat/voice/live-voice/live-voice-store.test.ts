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

describe("mic dead-silence flag", () => {
  const s = () => useLiveVoiceStore.getState();

  test("defaults to false — a fresh session presumes the mic is live", () => {
    expect(s().micSilent).toBe(false);
  });

  test("setMicSilent raises and clears the flag", () => {
    s().setMicSilent(true);
    expect(s().micSilent).toBe(true);

    s().setMicSilent(false);
    expect(s().micSilent).toBe(false);
  });

  test("reset clears the flag with the rest of the session state", () => {
    // Session teardown runs `reset()`; a dead-mic warning must not survive
    // into the next call (whose mic may be a different, working device).
    s().setMicSilent(true);
    s().setInputAmplitude(0.4);

    s().reset();
    expect(s().micSilent).toBe(false);
    expect(s().inputAmplitude).toBe(0);
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

describe("mid-call camera state", () => {
  test("photo rejections bump the seq and carry the latest reason", () => {
    const s = () => useLiveVoiceStore.getState();
    expect(s().photoRejectedSeq).toBe(0);
    expect(s().photoRejectedReason).toBeNull();

    s().notePhotoRejected("failed");
    expect(s().photoRejectedSeq).toBe(1);
    expect(s().photoRejectedReason).toBe("failed");

    // Consecutive rejections must each register (the strip retracts one
    // thumbnail per bump).
    s().notePhotoRejected("unsupported");
    expect(s().photoRejectedSeq).toBe(2);
    expect(s().photoRejectedReason).toBe("unsupported");
  });

  test("attachLiveVoiceImage routes through the registered delegate", async () => {
    const { attachLiveVoiceImage } = await import(
      "@/domains/chat/voice/live-voice/live-voice-store"
    );
    const sent: string[] = [];

    // No session: false, never a silent drop.
    expect(attachLiveVoiceImage("att-1")).toBe(false);

    useLiveVoiceStore.getState().setAttachImageDelegate((id) => {
      sent.push(id);
      return true;
    });
    expect(attachLiveVoiceImage("att-2")).toBe(true);
    expect(sent).toEqual(["att-2"]);

    // A delegate reporting a reconnect gap propagates its false.
    useLiveVoiceStore.getState().setAttachImageDelegate(() => false);
    expect(attachLiveVoiceImage("att-3")).toBe(false);
  });

  test("reset clears the camera capability, delegate, and session assistant", () => {
    const s = () => useLiveVoiceStore.getState();
    s().setSessionAssistantId("assistant-1");
    s().setAttachImageSupported(true);
    s().setAttachImageDelegate(() => true);
    s().notePhotoRejected("failed");

    s().reset();

    expect(s().sessionAssistantId).toBeNull();
    expect(s().attachImageSupported).toBe(false);
    expect(s().attachImage).toBeNull();
    expect(s().photoRejectedSeq).toBe(0);
    expect(s().photoRejectedReason).toBeNull();
  });
});
