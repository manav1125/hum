/**
 * Tests for the desktop call LADDER (v37 §W1): room → minimized bar →
 * title-bar pill, one surface visible at a time — and the invariant the whole
 * slice exists for: **demotion and promotion never touch the socket or the
 * mic.**
 *
 * The harness mounts the real `VoiceCallHost` (which owns the one real
 * `useLiveVoice` controller) inside a real memory router, with the
 * conversation view rendering the real room/bar projections. Mocking happens
 * at the controller BOUNDARY only — the transport/audio primitives are
 * injected fakes — so every ladder transition runs through the production
 * store, host, and components. Socket survival is asserted on object
 * identity: one client instance, never `end()`ed or `close()`d by any
 * presentation swap; one capture instance, never shut down.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router";

// The controller's default factories statically import connection.ts → the
// generated SDK client. Fakes are injected, so stub the connection module out
// of the static import graph (same pattern as use-live-voice.test.ts).
mock.module("@/domains/chat/voice/live-voice/connection", () => ({
  resolveLiveVoiceWsUrl: mock(
    async () => "wss://velay.vellum.ai/a/v1/live-voice",
  ),
}));

// The ladder is desktop: pin the layout hooks rather than emulate matchMedia.
mock.module("@/hooks/use-is-mobile", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
  useIsMobile: () => false,
  useMobileLayout: () => false,
  usePointerCoarse: () => false,
  usePhoneLayout: () => false,
}));

import type {
  LiveVoiceChannelClient,
  LiveVoiceClientEventMap,
  LiveVoiceClientEventName,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import type {
  LiveVoiceAudioCapture,
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import type { LiveVoiceAudioPlayer } from "@/domains/chat/voice/live-voice/tts-playback";
import type { UseLiveVoiceOptions } from "@/domains/chat/voice/live-voice/use-live-voice";

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useVoiceCallStore } =
  await import("@/domains/chat/voice/voice-call-store");
const { VoiceCallHost } = await import("@/domains/chat/voice/voice-call-host");
const { ConversationVoiceBar, ConversationVoiceRoomOverlay } =
  await import("@/domains/chat/voice/voice-call-conversation-slot");

// ---------------------------------------------------------------------------
// Controller-boundary fakes (modeled on use-live-voice.test.ts)
// ---------------------------------------------------------------------------

class FakeClient {
  connectCount = 0;
  ended = false;
  closed = false;

  private handlers = new Map<
    LiveVoiceClientEventName,
    Set<(payload: never) => void>
  >();

  on<E extends LiveVoiceClientEventName>(
    event: E,
    handler: (payload: LiveVoiceClientEventMap[E]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set?.delete(handler as (payload: never) => void);
  }

  async connect(): Promise<void> {
    this.connectCount++;
  }
  sendAudio(): void {}
  pttRelease(): void {}
  interrupt(): void {}
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
  }

  emit<E extends LiveVoiceClientEventName>(
    event: E,
    payload: LiveVoiceClientEventMap[E],
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (payload: LiveVoiceClientEventMap[E]) => void)(payload);
    }
  }
}

class FakeCapture {
  readonly onAmplitude?: (amplitude: number) => void;
  shutdownCount = 0;
  mutedCalls: boolean[] = [];

  constructor(options: LiveVoiceAudioCaptureOptions) {
    this.onAmplitude = options.onAmplitude;
  }

  async start(): Promise<LiveVoiceCaptureResult> {
    return { ok: true };
  }
  async stop(): Promise<void> {}
  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }
  setMuted(muted: boolean): void {
    this.mutedCalls.push(muted);
  }
  flush(): void {}

  pushAmplitude(amplitude: number): void {
    this.onAmplitude?.(amplitude);
  }
}

class FakePlayer {
  prewarm(): void {}
  enqueue(): void {}
  stop(): void {}
  async dispose(): Promise<void> {}
  async waitUntilDrained(): Promise<void> {}
  isPlaying = false;
}

// ---------------------------------------------------------------------------
// Harness: real router, real host, real projections
// ---------------------------------------------------------------------------

const CONV_PATH = "/assistant/conversations/conv-1";

function makeHarness() {
  const clients: FakeClient[] = [];
  const captures: FakeCapture[] = [];

  const liveVoiceOptions: UseLiveVoiceOptions = {
    createClient: () => {
      const client = new FakeClient();
      clients.push(client);
      return client as unknown as LiveVoiceChannelClient;
    },
    createCapture: (options) => {
      const capture = new FakeCapture(options);
      captures.push(capture);
      return capture as unknown as LiveVoiceAudioCapture;
    },
    createPlayer: () => new FakePlayer() as unknown as LiveVoiceAudioPlayer,
  };

  function Layout() {
    return (
      <>
        <Outlet />
        <VoiceCallHost liveVoiceOptions={liveVoiceOptions} />
      </>
    );
  }

  function ConversationScreen() {
    return (
      <div style={{ position: "relative" }}>
        {/* The composer stand-in: the view beneath the ladder stays usable. */}
        <input aria-label="Message Cue" />
        <ConversationVoiceBar
          conversationId="conv-1"
          conversationTitle="Renew Acme"
        />
        <ConversationVoiceRoomOverlay
          conversationId="conv-1"
          conversationTitle="Renew Acme"
        />
      </div>
    );
  }

  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: CONV_PATH, element: <ConversationScreen /> },
          { path: "/assistant/hq", element: <div>HQ screen</div> },
        ],
      },
    ],
    { initialEntries: [CONV_PATH] },
  );

  const view = render(<RouterProvider router={router} />);
  return { view, router, clients, captures };
}

/** Start a call and drive the session to `listening`. */
async function startCall(h: ReturnType<typeof makeHarness>) {
  await act(async () => {
    useVoiceCallStore.getState().startCall("assistant-1", "conv-1");
  });
  await act(async () => {
    h.clients[0]!.emit("ready", {
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: "conv-1",
    });
    await Promise.resolve();
  });
}

/** The one socket + mic, untouched by whatever transition just happened. */
function expectSessionUntouched(h: ReturnType<typeof makeHarness>) {
  expect(h.clients.length).toBe(1);
  expect(h.clients[0]!.ended).toBe(false);
  expect(h.clients[0]!.closed).toBe(false);
  expect(h.captures.length).toBe(1);
  expect(h.captures[0]!.shutdownCount).toBe(0);
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useVoiceCallStore.getState().endCall();
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useVoiceCallStore.getState().endCall();
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe("room → bar → pill, one surface at a time", () => {
  test("starting a call opens the room over a still-usable composer", async () => {
    const h = makeHarness();
    await startCall(h);

    expect(h.view.queryByRole("dialog", { name: "Voice call" })).not.toBeNull();
    expect(h.view.queryByText("Listening")).not.toBeNull();
    // The composer beneath is still in the tree — typing mid-call is a
    // feature, not an edge case.
    expect(h.view.queryByLabelText("Message Cue")).not.toBeNull();
    expectSessionUntouched(h);
  });

  test("⤓ collapses to the bar; ⤢ promotes back — the session object survives both", async () => {
    const h = makeHarness();
    await startCall(h);
    const sessionBefore = useVoiceCallStore.getState().session;

    // Collapse: room gone, bar present.
    fireEvent.click(h.view.getByLabelText("Back to the conversation"));
    expect(h.view.queryByRole("dialog", { name: "Voice call" })).toBeNull();
    expect(h.view.queryByRole("region", { name: "Voice call" })).not.toBeNull();
    expectSessionUntouched(h);

    // Expand: bar gone, room back.
    fireEvent.click(h.view.getByLabelText("Expand the call"));
    expect(h.view.queryByRole("dialog", { name: "Voice call" })).not.toBeNull();
    expect(h.view.queryByRole("region", { name: "Voice call" })).toBeNull();
    expectSessionUntouched(h);

    // Identity, not just liveness: the SAME session request all the way.
    expect(useVoiceCallStore.getState().session).toBe(sessionBefore);
  });

  test("navigating away demotes to the title-bar pill without touching the socket", async () => {
    const h = makeHarness();
    await startCall(h);

    await act(async () => {
      await h.router.navigate("/assistant/hq");
    });

    // Conversation surfaces unmounted, pill up — the ONLY surface visible.
    expect(h.view.queryByRole("dialog", { name: "Voice call" })).toBeNull();
    expect(h.view.queryByRole("region", { name: "Voice call" })).toBeNull();
    expect(h.view.queryByText("Cue · listening")).not.toBeNull();
    expectSessionUntouched(h);
  });

  test("clicking the pill returns to the conversation, promoted to the room", async () => {
    const h = makeHarness();
    await startCall(h);

    // Leave with the call collapsed, to prove the pill promotes ALL the way.
    fireEvent.click(h.view.getByLabelText("Back to the conversation"));
    await act(async () => {
      await h.router.navigate("/assistant/hq");
    });

    await act(async () => {
      fireEvent.click(h.view.getByLabelText("Return to the call"));
    });

    expect(h.router.state.location.pathname).toBe(CONV_PATH);
    expect(h.view.queryByRole("dialog", { name: "Voice call" })).not.toBeNull();
    expectSessionUntouched(h);
  });

  test("the pill's ✕ ends the call for real", async () => {
    const h = makeHarness();
    await startCall(h);
    await act(async () => {
      await h.router.navigate("/assistant/hq");
    });

    await act(async () => {
      fireEvent.click(h.view.getByLabelText("End call"));
    });

    expect(h.clients[0]!.ended).toBe(true);
    expect(useVoiceCallStore.getState().session).toBeNull();
    expect(h.view.queryByText(/Cue · /)).toBeNull();
  });

  test("ending from the room clears every rung", async () => {
    const h = makeHarness();
    await startCall(h);

    await act(async () => {
      fireEvent.click(h.view.getByLabelText("End call"));
    });

    expect(h.clients[0]!.ended).toBe(true);
    expect(useVoiceCallStore.getState().session).toBeNull();
    expect(h.view.queryByRole("dialog", { name: "Voice call" })).toBeNull();
    expect(h.view.queryByRole("region", { name: "Voice call" })).toBeNull();
  });
});

describe("the bar is live, not a poster", () => {
  test("real amplitude reaches the bar's levels; mute routes to the real capture", async () => {
    const h = makeHarness();
    await startCall(h);
    fireEvent.click(h.view.getByLabelText("Back to the conversation"));

    // A real level from the (fake) capture propagates through the store into
    // the drawn scale — the honesty rule wired end to end.
    await act(async () => {
      h.captures[0]!.pushAmplitude(0.9);
    });
    const scaled = Array.from(
      h.view.container.querySelectorAll<HTMLElement>("span"),
    ).filter((el) => el.style.transform === "scaleY(1)");
    expect(scaled.length).toBeGreaterThanOrEqual(4);

    // Mute on the bar reaches the real capture's tracks.
    await act(async () => {
      fireEvent.click(h.view.getByLabelText("Mute microphone"));
    });
    expect(h.captures[0]!.mutedCalls).toEqual([true]);
    expect(h.view.queryByText("Muted")).not.toBeNull();
    expectSessionUntouched(h);
  });

  test("one turn's session state word flows to the pill", async () => {
    const h = makeHarness();
    await startCall(h);
    await act(async () => {
      await h.router.navigate("/assistant/hq");
    });

    await act(async () => {
      useLiveVoiceStore.getState().setState("speaking");
    });
    expect(h.view.queryByText("Cue · speaking")).not.toBeNull();
  });
});

describe("one session, ever", () => {
  test("startCall for the same conversation promotes instead of double-starting", async () => {
    const h = makeHarness();
    await startCall(h);
    fireEvent.click(h.view.getByLabelText("Back to the conversation"));

    await act(async () => {
      useVoiceCallStore.getState().startCall("assistant-1", "conv-1");
    });

    // Promoted to the room; still exactly one client and one connect.
    expect(h.view.queryByRole("dialog", { name: "Voice call" })).not.toBeNull();
    expect(h.clients.length).toBe(1);
    expect(h.clients[0]!.connectCount).toBe(1);
  });

  test("startCall for another conversation is refused while a call is live", async () => {
    const h = makeHarness();
    await startCall(h);

    await act(async () => {
      useVoiceCallStore.getState().startCall("assistant-1", "conv-2");
    });

    expect(useVoiceCallStore.getState().session?.conversationId).toBe("conv-1");
    expect(h.clients.length).toBe(1);
  });
});

describe("fail open on the ladder", () => {
  test("a failure keeps the ladder up and the bar says so", async () => {
    const h = makeHarness();
    await startCall(h);
    fireEvent.click(h.view.getByLabelText("Back to the conversation"));

    await act(async () => {
      h.clients[0]!.emit("error", {
        reason: "protocol-error",
        message: "The daemon refused the session.",
        fatal: true,
      });
    });

    // The session request survives (retry is offered); the bar shows the
    // failure instead of breathing on.
    expect(useVoiceCallStore.getState().session).not.toBeNull();
    expect(
      h.view.queryByText(/The daemon refused the session\./),
    ).not.toBeNull();
    expect(h.view.queryByRole("button", { name: "Try again" })).not.toBeNull();
  });
});
