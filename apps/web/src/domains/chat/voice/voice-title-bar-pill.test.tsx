/**
 * Tests for `VoiceTitleBarPill` — rung 3 of the desktop call ladder (v37 §W1).
 *
 * The pill's contract: "Cue · <state word>" + timer + level bars, click
 * ANYWHERE except ✕ to return to the room, ✕ ends. And the same honesty rule
 * as the bar: levels move from real audio only.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { VoiceTitleBarPill } from "@/domains/chat/voice/voice-title-bar-pill";

afterEach(cleanup);

function renderPill(
  props: Partial<React.ComponentProps<typeof VoiceTitleBarPill>> = {},
) {
  return render(
    <VoiceTitleBarPill
      state="speaking"
      amplitude={0}
      muted={false}
      startedAt={Date.now() - 220_000}
      onReturn={() => {}}
      onEnd={() => {}}
      {...props}
    />,
  );
}

describe("what the pill says", () => {
  test("Cue · speaking, with the real timer", () => {
    const view = renderPill();
    expect(view.queryByText("Cue · speaking")).not.toBeNull();
    // 220s in → 3:40 (the frame's own example).
    expect(view.queryByText("3:40")).not.toBeNull();
  });

  test("the state word follows the call", () => {
    expect(
      renderPill({ state: "listening" }).queryByText("Cue · listening"),
    ).not.toBeNull();
    cleanup();
    expect(
      renderPill({ state: "thinking" }).queryByText("Cue · thinking"),
    ).not.toBeNull();
    cleanup();
    expect(
      renderPill({ state: "connecting" }).queryByText("Cue · connecting…"),
    ).not.toBeNull();
    cleanup();
    // A dropped call must not read as a live one (fail open).
    expect(
      renderPill({ state: "failed" }).queryByText("Cue · call dropped"),
    ).not.toBeNull();
  });
});

describe("click anywhere except ✕ returns", () => {
  test("the pill body returns to the call", () => {
    const onReturn = mock(() => {});
    const onEnd = mock(() => {});
    const view = renderPill({ onReturn, onEnd });

    fireEvent.click(view.getByLabelText("Return to the call"));
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  test("✕ ends — and does NOT also return", () => {
    const onReturn = mock(() => {});
    const onEnd = mock(() => {});
    const view = renderPill({ onReturn, onEnd });

    fireEvent.click(view.getByLabelText("End call"));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onReturn).not.toHaveBeenCalled();
  });
});

describe("the honesty rule for sound", () => {
  function barScales(view: ReturnType<typeof render>): string[] {
    return Array.from(view.container.querySelectorAll<HTMLElement>("span"))
      .map((el) => el.style.transform)
      .filter((t) => t.startsWith("scaleY"));
  }

  test("silence rests; a real level moves the bars; no keyframes", () => {
    const quiet = renderPill({ amplitude: 0 });
    const quietScales = barScales(quiet);
    expect(quietScales.length).toBe(3);
    for (const s of quietScales) expect(s).toBe("scaleY(0.18)");
    cleanup();

    const loud = renderPill({ amplitude: 0.9 });
    for (const s of barScales(loud)) expect(s).toBe("scaleY(1)");
  });
});
