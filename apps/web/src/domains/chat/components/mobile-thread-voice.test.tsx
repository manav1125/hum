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
function renderStrip(
  drive: () => void,
  props: Partial<React.ComponentProps<typeof MobileThreadVoice>> = {},
) {
  let view!: ReturnType<typeof render>;
  act(() => {
    view = render(
      <MobileThreadVoice
        assistantId="assistant-1"
        conversationId="conv-1"
        keyboardMode={false}
        onFlipToKeyboard={() => {}}
        onEnded={() => {}}
        {...props}
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

// The report: "when in voice mode and the convo drops ... nothing happens".
// The ⌨ flip hid the whole bar, failure row included, so a session that died
// while the user was typing said nothing at all — and the composer kept showing
// the live orb chip and the header kept reading "voice active in this chat".
describe("a dead session cannot pretend to be alive", () => {
  test("the failure is shown even after the ⌨ flip to typing", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore
          .getState()
          .fail("Voice disconnected and couldn't reconnect.", "session");
      },
      { keyboardMode: true },
    );

    expect(
      view.queryByText(/Voice disconnected and couldn't reconnect\./),
    ).not.toBeNull();
    expect(view.queryByRole("button", { name: "Try again" })).not.toBeNull();
  });

  test("a healthy session still hides the bar behind the ⌨ flip", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore.getState().setState("listening");
      },
      { keyboardMode: true },
    );

    expect(view.queryByLabelText("End voice session")).toBeNull();
  });
});

// "i think we should go to full screen voice mode as an option somewhere - i do
// like the real life voice mode like chat back and forth ... lets find a way to
// do both?" — same session, two presentations.
describe("full screen shows the call, not a typing surface", () => {
  test("it draws the whole exchange, including the cascade's, and this session's earlier turns", () => {
    const view = renderStrip(
      () => {
        const s = useLiveVoiceStore.getState();
        // The cascade — the engine the strip deliberately stays out of the way
        // of, because the thread streams it. Full screen covers the thread, so
        // if it deferred in the same way it would show nothing at all.
        s.setEngine("cascade");
        s.setFinalTranscript("What's on my plate today?");
        s.appendAssistantTranscript("Three things — want them in order?");
        s.closeTurn();
        s.setFinalTranscript("Yes please.");
        s.appendAssistantTranscript("Starting with the Acme renewal.");
        s.setState("speaking");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    expect(view.queryByText(/What's on my plate today\?/)).not.toBeNull();
    expect(view.queryByText(/Three things — want them in order\?/)).not.toBeNull();
    expect(view.queryByText(/Yes please\./)).not.toBeNull();
    expect(view.queryByText(/Starting with the Acme renewal\./)).not.toBeNull();
  });

  test("a closed turn is drawn once, not twice", () => {
    const view = renderStrip(
      () => {
        const s = useLiveVoiceStore.getState();
        s.setFinalTranscript("Remind me to call Sam.");
        s.appendAssistantTranscript("Saved it.");
        s.closeTurn();
        s.setState("listening");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    expect(view.queryAllByText(/Remind me to call Sam\./)).toHaveLength(1);
    expect(view.queryAllByText(/Saved it\./)).toHaveLength(1);
  });

  test("there is no text composer on it — no textbox and no send", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore.getState().setState("listening");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByLabelText("Send message")).toBeNull();
    // …and the way back into the thread is on screen, so it is not a trap.
    expect(
      view.queryByLabelText("Back to the conversation"),
    ).not.toBeNull();
  });

  test("the inline bar offers the way in", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore.getState().setState("listening");
      },
      { onToggleFullScreen: () => {} },
    );

    expect(view.queryByLabelText("Full-screen voice")).not.toBeNull();
  });
});
