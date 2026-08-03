/**
 * Tests for `MobileThreadVoice`'s live strip.
 *
 * The strip renders inside a chat thread that ALREADY renders the conversation:
 * persisted voice turns carry the durable `voiceTurn` marker and MobileChatView
 * draws them with this component's own VOICE_BUBBLE_LOOK. So the one thing the
 * strip must never do is draw an exchange the thread is already showing — that
 * is what put every completed turn on screen twice.
 *
 * The session controller is replaced by a fake that projects the REAL
 * live-voice store, so a test drives the store exactly as `useLiveVoice` would
 * and asserts on what the strip renders. Only `useLiveVoice` is overridden —
 * the rest of the module is spread through.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

// The real `use-live-voice` statically imports connection.ts → the generated
// SDK client. Only `resolveLiveVoiceWsUrl` is reachable from the controller, and
// the fake below never calls it, so stub that one export rather than pulling the
// SDK into this render.
const connectionActual =
  await import("@/domains/chat/voice/live-voice/connection");
mock.module("@/domains/chat/voice/live-voice/connection", () => ({
  ...connectionActual,
  resolveLiveVoiceWsUrl: mock(async () => "wss://example.invalid/live-voice"),
}));

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");

const useLiveVoiceActual =
  await import("@/domains/chat/voice/live-voice/use-live-voice");
mock.module("@/domains/chat/voice/live-voice/use-live-voice", () => ({
  ...useLiveVoiceActual,
  // Project the real store so a test drives it exactly as the controller does.
  useLiveVoice: () => {
    const s = useLiveVoiceStore();
    return {
      state: s.state,
      partialTranscript: s.partialTranscript,
      finalTranscript: s.finalTranscript,
      assistantTranscript: s.assistantTranscript,
      inputAmplitude: s.inputAmplitude,
      error: s.error,
      failureKind: s.failureKind,
      muted: false,
      start: async () => {},
      stop: async () => {},
      setMuted: () => {},
    };
  },
}));

const { MobileThreadVoice } =
  await import("@/domains/chat/components/mobile-thread-voice");

/**
 * Mount the strip, then apply `drive` to the store and let it re-render.
 * Returns the rendered view for querying.
 */
function renderStrip(drive: () => void) {
  let view!: ReturnType<typeof render>;
  act(() => {
    view = render(
      <MobileThreadVoice
        assistantId="assistant-1"
        conversationId="conv-1"
        keyboardMode={false}
        onFlipToKeyboard={() => {}}
        onEnded={() => {}}
      />,
    );
  });
  act(() => drive());
  return view;
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
});

describe("completed turns belong to the thread, not the strip", () => {
  test("a finished exchange is not re-drawn by the strip", () => {
    const view = renderStrip(() => {
      const s = useLiveVoiceStore.getState();
      s.setEngine("gemini-live");
      s.setFinalTranscript("Hello, can you hear me?");
      s.appendAssistantTranscript("Loud and clear! How can I help today?");
      // `resumeListening()` closes the turn when the session re-arms; by then
      // the exchange is a persisted 🎙 citizen of the thread above.
      s.closeTurn();
      s.setState("listening");
    });

    expect(view.queryByText(/Hello, can you hear me\?/)).toBeNull();
    expect(view.queryByText(/Loud and clear/)).toBeNull();
  });

  test("the cascade's in-flight exchange is not drawn either — the thread streams it", () => {
    // The cascade persists the user message at turn start and broadcasts every
    // assistant delta onto the conversation, so both are already chat citizens.
    const view = renderStrip(() => {
      const s = useLiveVoiceStore.getState();
      s.setEngine("cascade");
      s.setFinalTranscript("What can you do?");
      s.appendAssistantTranscript("I can help with a bunch of things.");
      s.setState("speaking");
    });

    expect(view.queryByText(/What can you do\?/)).toBeNull();
    expect(view.queryByText(/I can help with a bunch of things/)).toBeNull();
  });
});

describe("what the strip does carry", () => {
  test("the in-flight partial transcript — it never reaches the thread", () => {
    const view = renderStrip(() => {
      const s = useLiveVoiceStore.getState();
      s.setEngine("cascade");
      s.setState("listening");
      s.setPartialTranscript("how much does the arch");
    });

    expect(view.queryByText(/how much does the arch/)).not.toBeNull();
  });

  test("the realtime engine's OPEN exchange — the thread has nothing until it ends", () => {
    const view = renderStrip(() => {
      const s = useLiveVoiceStore.getState();
      s.setEngine("gemini-live");
      s.setFinalTranscript("What can you do?");
      s.appendAssistantTranscript("I can help with a bunch of things.");
      s.setState("speaking");
    });

    expect(view.queryByText(/What can you do\?/)).not.toBeNull();
    expect(
      view.queryByText(/I can help with a bunch of things/),
    ).not.toBeNull();
  });
});
