/**
 * The slot as rendered — four faces, and one of them is nothing.
 *
 * The absent case gets a test of its own because it is the failure design is
 * explicitly guarding against and the only one that is invisible in a
 * screenshot of a busy account: a slot that renders empty is "a permanent
 * Brief row empty six hours a day", which is fabricated content in navigation
 * form. A regression there would look like a slightly larger gap above the
 * ring, and nobody files that.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { Mv3RitualSlot } from "./mv3-ritual-slot";
import { readRitualProgress } from "./ritual-progress";
import { pickRitualFace, type RitualSlotInput } from "./ritual-slot";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const at = (day: number, hour: number) => new Date(2026, 7, day, hour, 0, 0);

function face(over: Partial<RitualSlotInput> = {}) {
  return pickRitualFace({
    now: at(19, 7), // Wednesday morning
    brief: { done: 4, needsYou: 1, by: "10:30" },
    weekly: { moved: 9, slipped: 2 },
    briefProgress: { read: false, dismissed: false },
    weeklyProgress: { read: false, dismissed: false },
    briefHref: "/assistant/brief",
    weeklyHref: "/assistant/weekly",
    ...over,
  });
}

function draw(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("the brief face", () => {
  test("carries the dated label, the serif sentence and the timed verb", () => {
    draw(<Mv3RitualSlot face={face()} />);
    expect(screen.getByText("WEDNESDAY · YOUR BRIEF")).toBeTruthy();
    expect(
      screen.getByText("While you slept, Cue finished four things."),
    ).toBeTruthy();
    expect(screen.getByText("Read it · 2 min")).toBeTruthy();
    expect(screen.getByText("Later")).toBeTruthy();
  });

  test("the ONLY amber in the slot is the needs-you line", () => {
    const { container } = draw(<Mv3RitualSlot face={face()} />);
    const amber = screen.getByText("One needs you before 10:30.");
    expect((amber as HTMLElement).style.color).toContain("--mv3-amber-text");

    // The invitation itself spends no state colour — the card, its border and
    // its button are all brand blue on both faces.
    const slot = container.querySelector('[data-slot="mv3-ritual"]');
    expect((slot as HTMLElement).style.borderColor).toContain("61, 110, 232");
    const cta = screen.getByText("Read it · 2 min");
    expect((cta as HTMLElement).style.background).toContain("--mv3-accent-fill");
  });

  test("with nothing waiting there is no amber at all", () => {
    draw(<Mv3RitualSlot face={face({ brief: { done: 2, needsYou: 0 } })} />);
    expect(screen.queryByText(/needs? you/)).toBeNull();
  });
});

describe("the weekly face", () => {
  test("is the same blue card, differing by label and sentence only", () => {
    const { container } = draw(
      <Mv3RitualSlot face={face({ now: at(22, 15) })} />,
    );
    expect(screen.getByText("THIS WEEK · READY")).toBeTruthy();
    expect(screen.getByText("4 beats")).toBeTruthy();
    expect(screen.getByText("Nine things moved. Two slipped.")).toBeTruthy();
    expect(screen.getByText("Look back · 3 min")).toBeTruthy();

    const slot = container.querySelector('[data-slot="mv3-ritual"]');
    expect((slot as HTMLElement).style.borderColor).toContain("61, 110, 232");
  });

  test("its sub-line is muted, not amber — it describes, it does not ask", () => {
    draw(<Mv3RitualSlot face={face({ now: at(22, 15) })} />);
    const sub = screen.getByText(
      "And one question about what Cue should handle alone.",
    );
    expect((sub as HTMLElement).style.color).not.toContain("amber");
  });
});

describe("the collapsed face", () => {
  test('"Later" collapses it in place, still openable', () => {
    const { container, rerender } = draw(<Mv3RitualSlot face={face()} />);
    fireEvent.click(screen.getByText("Later"));

    // The store took the dismissal; the model then yields the one-row face.
    expect(readRitualProgress("brief", new Date()).dismissed).toBe(true);
    rerender(
      <MemoryRouter>
        <Mv3RitualSlot
          face={face({ briefProgress: { read: false, dismissed: true } })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("TODAY'S BRIEF")).toBeTruthy();
    expect(screen.getByText("Read it ›")).toBeTruthy();
    expect(screen.queryByText("Later")).toBeNull();
    expect(container.querySelector('[data-ritual="brief"]')).toBeTruthy();
  });
});

describe("the absent face", () => {
  test("nothing due renders NOTHING — not an empty card, not a spacer", () => {
    const { container } = draw(
      <Mv3RitualSlot face={face({ now: at(19, 14) })} />,
    );
    expect(container.querySelector('[data-slot="mv3-ritual"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("in the window with no data behind it, likewise nothing", () => {
    const { container } = draw(<Mv3RitualSlot face={face({ brief: null })} />);
    expect(container.querySelector('[data-slot="mv3-ritual"]')).toBeNull();
    expect(container.textContent).toBe("");
  });
});

describe("opening it is what stops it asking", () => {
  test("the CTA records the ritual as read", () => {
    draw(<Mv3RitualSlot face={face()} />);
    fireEvent.click(screen.getByText("Read it · 2 min"));
    expect(readRitualProgress("brief", new Date()).read).toBe(true);
  });
});
