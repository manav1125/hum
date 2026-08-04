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
      interrupt: () => {},
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
/**
 * The call screen, to v35 §V1.
 *
 * The rules being pinned here are the ones a redesign quietly loses: the screen
 * is a CALL and not a transcript, it has exactly three controls, and the
 * thinking state never says something it was not told.
 */
describe("the call screen is a call", () => {
  test("it captions the CURRENT sentence and does not redraw the thread", () => {
    const view = renderStrip(
      () => {
        const s = useLiveVoiceStore.getState();
        s.setEngine("cascade");
        s.setFinalTranscript("What's on my plate today?");
        s.appendAssistantTranscript("Three things — want them in order?");
        s.closeTurn();
        s.setFinalTranscript("Yes please.");
        s.setState("listening");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    // The open sentence is captioned…
    expect(view.queryByText(/Yes please\./)).not.toBeNull();
    // …and the finished exchange is NOT, because it already belongs to the
    // thread. v35: "live captions of the current sentence only — the full
    // transcript belongs to the thread, not the call."
    expect(view.queryByText(/What's on my plate today\?/)).toBeNull();
    expect(
      view.queryByText(/Three things — want them in order\?/),
    ).toBeNull();
  });

  test("exactly three controls: mute, end, collapse", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore.getState().setState("listening");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    expect(view.queryByLabelText("Mute microphone")).not.toBeNull();
    expect(view.queryByLabelText("End call")).not.toBeNull();
    expect(view.queryByLabelText("Back to the conversation")).not.toBeNull();

    // Nothing else. The buttons on screen are the three controls plus the call
    // timer (which is also the engine back door) — no engine pill, no persona
    // cycle, no composer.
    const buttons = view.container.querySelectorAll("button");
    expect(buttons.length).toBeLessThanOrEqual(4);
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByLabelText("Send message")).toBeNull();
  });

  test("the engine toggle is NOT on the call screen", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore.getState().setState("listening");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    // v35: it moved to Your Cue → Preferences → Voice. Long-pressing the timer
    // is the only way back to it, and a long-press is not a control on screen.
    expect(view.queryByText("Realtime")).toBeNull();
    expect(view.queryByText("Classic")).toBeNull();
  });

  test("listening says so; speaking offers the interrupt", () => {
    const listening = renderStrip(
      () => {
        useLiveVoiceStore.getState().setState("listening");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );
    expect(listening.queryByText("Listening")).not.toBeNull();
    expect(listening.queryByText("tap anywhere to interrupt")).toBeNull();
    cleanup();

    const speaking = renderStrip(
      () => {
        const s = useLiveVoiceStore.getState();
        s.appendAssistantTranscript("Starting with the Acme renewal.");
        s.setState("speaking");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );
    expect(speaking.queryByText("tap anywhere to interrupt")).not.toBeNull();
    expect(
      speaking.queryByText(/Starting with the Acme renewal\./),
    ).not.toBeNull();
  });
});

/**
 * The thinking caption is the one place this surface could invent a fact, so
 * it gets its own guard. Every phrase must trace to a tool that really started.
 */
describe("the thinking state never invents what it is doing", () => {
  function renderThinking(activityTool: string | null) {
    return renderStrip(
      () => {
        const s = useLiveVoiceStore.getState();
        s.setState("thinking");
        s.setActivityTool(activityTool);
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );
  }

  test("a reported tool is named in words", () => {
    const view = renderThinking("web_search");
    expect(view.queryByText("Searching the web…")).not.toBeNull();
  });

  test("a tool with no copy is admitted, not dressed up", () => {
    const view = renderThinking("some_tool_nobody_wrote_copy_for");
    expect(view.queryByText("Using a tool…")).not.toBeNull();
  });

  test("nothing reported says only what it knows", () => {
    // The realtime engine, an older daemon, or a moment that is not inside a
    // tool call. All three land here, and all three must show a plain wait.
    const view = renderThinking(null);
    expect(view.queryByText("Thinking…")).not.toBeNull();
  });

  test("one turn's tool is never shown as the next turn's work", () => {
    const view = renderStrip(
      () => {
        const s = useLiveVoiceStore.getState();
        s.setState("thinking");
        s.setActivityTool("web_search");
        // The turn finishes and a new one opens.
        s.closeTurn();
        s.setFinalTranscript("And what about Tuesday?");
        s.setState("thinking");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    expect(view.queryByText("Searching the web…")).toBeNull();
    expect(view.queryByText("Thinking…")).not.toBeNull();
  });
});

describe("a call you can always leave", () => {
  test("a failed call keeps end and collapse, and says the words are kept", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore
          .getState()
          .fail("Voice couldn't connect.", "session");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    // Fail open: the exits survive the failure.
    expect(view.queryByLabelText("End call")).not.toBeNull();
    expect(view.queryByLabelText("Back to the conversation")).not.toBeNull();
    // …and the transcript contract is stated where it matters most.
    expect(
      view.queryByText(/saved in this conversation/i),
    ).not.toBeNull();
  });

  test("a connecting call is drawn as connecting, not as listening", () => {
    const view = renderStrip(
      () => {
        useLiveVoiceStore.getState().setState("connecting");
      },
      { fullScreen: true, onToggleFullScreen: () => {} },
    );

    expect(view.queryByText("Connecting…")).not.toBeNull();
    expect(view.queryByText("Listening")).toBeNull();
    expect(view.queryByLabelText("Back to the conversation")).not.toBeNull();
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
