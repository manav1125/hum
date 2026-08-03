/**
 * Two things the owner reported off his own phone, both about Today, both
 * invisible to a simulator pass because they are about what sits ON TOP of the
 * canvas and what the canvas can say for itself.
 *
 * **The census must not be an overlay.** It shipped as
 * `position: absolute; bottom: 0` with a blur — permanently across the card
 * stack. On a real device it cut the REVIEW READY card in half mid-title. The
 * bar is a footer for the page, not chrome over it: the one number that says
 * how much Cue is holding does not get to hide the work it is counting.
 *
 * **The day strip must say whose day it is.** It carried its sentence as an
 * `aria-label` and nothing else, so a sighted reader got an unlabelled run of
 * bars — which is exactly how it was reported: *"the home screen shows a
 * calendar but that calendar doesn't seem to be connected to anything."* The
 * data was real and correct the whole time. A true picture nobody can read as
 * true is still a trust bug.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { DayPicture } from "@/pages/hq/hq-k1-modules";

import { Mv3DayStrip } from "./mv3-day-strip";
import { Mv3Census } from "./mv3-today";

afterEach(cleanup);

const at = (hour: number, minute = 0) =>
  new Date(2026, 7, 3, hour, minute, 0).getTime();

function draw(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("the census is the page's last line, not a bar across it", () => {
  test("it is in the flow — never positioned over the canvas", () => {
    draw(
      <Mv3Census
        segments={[
          { label: "need you", value: 6 },
          { label: "Cue is doing", value: 0, keep: true },
        ]}
      />,
    );
    const bar = document.querySelector<HTMLElement>('[data-slot="mv3-census"]');
    expect(bar).not.toBeNull();

    // The exact shape of the bug: an absolutely-positioned, bottom-pinned,
    // stacked element paints over whatever card happens to be under it.
    expect(bar!.style.position).not.toBe("absolute");
    expect(bar!.style.position).not.toBe("fixed");
    expect(bar!.style.bottom).toBe("");
    expect(bar!.style.zIndex).toBe("");
  });

  test("it still states the numbers, including a zero that is carrying a lane", () => {
    draw(
      <Mv3Census
        segments={[
          { label: "need you", value: 6 },
          // in-motion is absorbed BY this segment, so it cannot vanish at zero
          // or "is anything running?" goes unanswered on the whole screen.
          { label: "Cue is doing", value: 0, keep: true },
          { label: "waiting", value: 0 },
        ]}
      />,
    );
    const text = document.querySelector('[data-slot="mv3-census"]')!.textContent;
    expect(text).toContain("6 need you");
    expect(text).toContain("0 Cue is doing");
    // A segment with nothing in it is omitted — a zero reads as "none", a claim.
    expect(text).not.toContain("waiting");
  });
});

describe("the day strip says its day out loud", () => {
  /** The owner's real 2026-08-03, as read off prod: solid, one 15m gap. */
  const packed: DayPicture = {
    commitments: [
      { id: "a", title: "All morning", startMs: at(8), endMs: at(12, 15) },
      { id: "b", title: "All afternoon", startMs: at(12, 30), endMs: at(19) },
    ],
    unbookedMinutes: 15,
    freeBlock: { startMs: at(12, 15), endMs: at(12, 30), minutes: 15 },
  };

  test("the sentence is visible text, not only an aria-label", () => {
    draw(<Mv3DayStrip day={packed} nowMs={at(11)} />);
    // Rendered, not merely announced — this is the whole fix for "it doesn't
    // seem to be connected to anything".
    expect(screen.getByText("2 commitments today · 15m free")).toBeDefined();
  });

  test("by evening it no longer offers a gap that closed at lunch", () => {
    draw(<Mv3DayStrip day={packed} nowMs={at(23, 11)} />);
    expect(screen.getByText("2 commitments today")).toBeDefined();
    expect(screen.queryByText(/15m free/)).toBeNull();
  });

  test("a calendar it could not read is an error, never an empty day", () => {
    draw(
      <Mv3DayStrip
        day={null}
        unavailable={{ reason: "Cue couldn't reach your calendar just now" }}
        nowMs={at(11)}
      />,
    );
    expect(
      screen.getByText("Cue couldn't reach your calendar just now"),
    ).toBeDefined();
    expect(screen.queryByText(/Nothing is booked/)).toBeNull();
  });
});
