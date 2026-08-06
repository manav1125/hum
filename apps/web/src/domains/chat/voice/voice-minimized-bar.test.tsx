/**
 * Tests for `VoiceMinimizedBar` — rung 2 of the desktop call ladder (v37 §W1).
 *
 * The rules pinned here are the ones a redesign quietly loses: the bar keeps
 * the state word, the ▤ thing chip, the timer, and the same three controls;
 * its level bars move from REAL audio levels only (silence rests, it never
 * pretends); and a failed call says so in words instead of breathing on.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { VoiceMinimizedBar } from "@/domains/chat/voice/voice-minimized-bar";

afterEach(cleanup);

function renderBar(
  props: Partial<React.ComponentProps<typeof VoiceMinimizedBar>> = {},
) {
  return render(
    <VoiceMinimizedBar
      state="listening"
      amplitude={0}
      muted={false}
      startedAt={Date.now() - 65_000}
      thingLabel="Renew Acme"
      error={null}
      failureKind={null}
      onOpenThing={() => {}}
      onToggleMute={() => {}}
      onEnd={() => {}}
      onExpand={() => {}}
      onRetry={() => {}}
      {...props}
    />,
  );
}

describe("what the bar keeps (v37 W1)", () => {
  test("state word, thing chip, and a real timer", () => {
    const view = renderBar();
    expect(view.queryByText("Listening")).not.toBeNull();
    // ▤ chip names the thing…
    expect(view.queryByText(/Renew Acme/)).not.toBeNull();
    // …and the timer counts from the real start (65s in → 1:05).
    expect(view.queryByText(/1:05/)).not.toBeNull();
  });

  test("the three controls: mute · end · expand", () => {
    const onToggleMute = mock(() => {});
    const onEnd = mock(() => {});
    const onExpand = mock(() => {});
    const view = renderBar({ onToggleMute, onEnd, onExpand });

    fireEvent.click(view.getByLabelText("Mute microphone"));
    fireEvent.click(view.getByLabelText("End call"));
    fireEvent.click(view.getByLabelText("Expand the call"));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  test("the ▤ chip opens the thing", () => {
    const onOpenThing = mock(() => {});
    const view = renderBar({ onOpenThing, thingLabel: "Pricing table" });
    fireEvent.click(view.getByLabelText("Open Pricing table"));
    expect(onOpenThing).toHaveBeenCalledTimes(1);
  });

  test("no start time → no timer, never a made-up clock", () => {
    const view = renderBar({ startedAt: null });
    expect(view.container.textContent).not.toMatch(/\d+:\d{2}/);
  });

  test("micSilent replaces the state word with the quiet admission", () => {
    // The mic self-check flagged dead silence (the TCC hole): "Listening"
    // would be pretend health. The bar keeps everything else — informational,
    // fail-open.
    const view = renderBar({ micSilent: true });
    expect(view.queryByText("can't hear you")).not.toBeNull();
    expect(view.queryByText("Listening")).toBeNull();
    // The call itself is untouched: the controls all stay.
    expect(view.queryByLabelText("Mute microphone")).not.toBeNull();
    expect(view.queryByLabelText("End call")).not.toBeNull();
    expect(view.queryByLabelText("Expand the call")).not.toBeNull();

    cleanup();
    // Muted wins — a muted mic reads 0 legitimately, and "Muted" is true.
    const muted = renderBar({ micSilent: true, muted: true });
    expect(muted.queryByText("Muted")).not.toBeNull();
    expect(muted.queryByText("can't hear you")).toBeNull();
  });

  test("state words follow the call: thinking · speaking · muted", () => {
    expect(
      renderBar({ state: "thinking" }).queryByText("Thinking"),
    ).not.toBeNull();
    cleanup();
    expect(
      renderBar({ state: "speaking" }).queryByText("Speaking"),
    ).not.toBeNull();
    cleanup();
    const muted = renderBar({ muted: true });
    expect(muted.queryByText("Muted")).not.toBeNull();
    expect(muted.queryByLabelText("Unmute microphone")).not.toBeNull();
  });
});

describe("the honesty rule for sound", () => {
  /** Read the scaleY the level bars are drawn at. */
  function barScale(view: ReturnType<typeof render>): string[] {
    return Array.from(view.container.querySelectorAll<HTMLElement>("span"))
      .map((el) => el.style.transform)
      .filter((t) => t.startsWith("scaleY"));
  }

  test("silence rests at the stub — no keyframe loop pretending activity", () => {
    const view = renderBar({ amplitude: 0 });
    const scales = barScale(view);
    expect(scales.length).toBe(4);
    for (const s of scales) expect(s).toBe("scaleY(0.18)");
    // No animation is attached to the level bars at all: motion comes only
    // from the real level via transform transitions.
    for (const el of view.container.querySelectorAll<HTMLElement>("span")) {
      if (el.style.transform.startsWith("scaleY")) {
        expect(el.style.animation).toBe("");
      }
    }
  });

  test("a real level moves the bars", () => {
    const view = renderBar({ amplitude: 0.8 });
    for (const s of barScale(view)) expect(s).toBe("scaleY(1)");
  });

  test("a muted mic rests the bars regardless of level", () => {
    const view = renderBar({ amplitude: 0.9, muted: true });
    for (const s of barScale(view)) expect(s).toBe("scaleY(0.18)");
  });
});

describe("fail open", () => {
  test("a failed call says so, offers retry, and keeps end", () => {
    const onRetry = mock(() => {});
    const view = renderBar({
      state: "failed",
      error: "Voice disconnected and couldn't reconnect.",
      failureKind: "session",
      onRetry,
    });

    expect(
      view.queryByText(/Voice disconnected and couldn't reconnect\./),
    ).not.toBeNull();
    expect(view.queryByLabelText("End call")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // A dead call has no levels and no state word to breathe.
    expect(view.queryByText("Listening")).toBeNull();
  });

  test("a mic failure names the mic, not a generic drop", () => {
    const view = renderBar({
      state: "failed",
      error: null,
      failureKind: "mic",
    });
    expect(
      view.queryByText(/Cue can't reach your microphone\./),
    ).not.toBeNull();
  });
});
