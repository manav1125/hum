/**
 * Tests for `VoiceFullScreen` — the room's mic dead-silence caption.
 *
 * The macOS TCC hole: Chrome without OS-level mic permission gets a
 * `getUserMedia` stream that "succeeds" and delivers pure zeros — no prompt,
 * no error — so the room sits in "Listening" looking healthy but deaf. The
 * honesty rule (v35: the mark IS the state, never fake activity) wants the
 * screen to say what's true: when the session's self-check raises
 * `micSilent`, a quiet caption appears under the state word. Informational
 * and fail-open — the pin here is that the caption exists, never that the
 * call ends.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// The room portals through the mobile overlay target; pin the layout hooks to
// desktop so it renders inline (same pattern as voice-call-host.test.tsx).
mock.module("@/hooks/use-is-mobile", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
  useIsMobile: () => false,
  useMobileLayout: () => false,
  usePointerCoarse: () => false,
  usePhoneLayout: () => false,
}));

const { VoiceFullScreen } =
  await import("@/domains/chat/voice/voice-fullscreen");

afterEach(cleanup);

const MIC_SILENT_CAPTION =
  "Cue can't hear anything — check your microphone permissions.";

function renderRoom(
  props: Partial<React.ComponentProps<typeof VoiceFullScreen>> = {},
) {
  return render(
    <VoiceFullScreen
      title="Renew Acme"
      currentUser=""
      currentAssistant=""
      state="listening"
      activityTool={null}
      muted={false}
      startedAt={Date.now()}
      error={null}
      failureKind={null}
      onEnd={() => {}}
      onToggleMute={() => {}}
      onInterrupt={() => {}}
      onRetry={() => {}}
      {...props}
    />,
  );
}

describe("the mic dead-silence caption", () => {
  test("micSilent draws the quiet caption under the state word", () => {
    const view = renderRoom({ micSilent: true });
    // The state word stays — the caption is under it, not instead of it.
    expect(view.queryByText("Listening")).not.toBeNull();
    expect(view.queryByText(MIC_SILENT_CAPTION)).not.toBeNull();
  });

  test("a live mic draws no caption (and none by default)", () => {
    const view = renderRoom();
    expect(view.queryByText(MIC_SILENT_CAPTION)).toBeNull();

    cleanup();
    const explicit = renderRoom({ micSilent: false });
    expect(explicit.queryByText(MIC_SILENT_CAPTION)).toBeNull();
  });

  test("never while muted — a muted mic reads 0 legitimately, and Muted is the true state", () => {
    // Belt to the controller's suspender (the hook clears the flag on mute):
    // even if both arrive, the room refuses the double message.
    const view = renderRoom({ micSilent: true, muted: true });
    expect(view.queryByText("Muted — Cue can't hear you")).not.toBeNull();
    expect(view.queryByText(MIC_SILENT_CAPTION)).toBeNull();
  });

  test("fail-open: the caption changes nothing about the call's controls", () => {
    const view = renderRoom({ micSilent: true });
    expect(view.queryByLabelText("End call")).not.toBeNull();
    expect(view.queryByLabelText("Mute microphone")).not.toBeNull();
  });
});
