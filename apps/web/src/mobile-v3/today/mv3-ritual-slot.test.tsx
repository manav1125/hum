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
    intake: { read: 41, yours: 12 },
    sources: 6,
    hasSeenBrief: true,
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

/**
 * A sub-line whose emphasis splits it across nodes.
 *
 * Testing Library's default text matcher joins only an element's DIRECT text
 * children, so a line with a `<b>` in the middle of it is invisible to
 * `getByText("the whole sentence")`. That is a property of the matcher, not of
 * the DOM — the owner reads one sentence — so the assertion reads the whole
 * sentence too.
 */
function line(container: HTMLElement, expected: string): HTMLElement {
  const el = Array.from(container.querySelectorAll("div")).find(
    (d) => d.textContent === expected,
  );
  if (!el) {
    throw new Error(
      `no line reading "${expected}" — saw: ${container.textContent}`,
    );
  }
  return el as HTMLElement;
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
    expect((cta as HTMLElement).style.background).toContain(
      "--mv3-accent-fill",
    );
  });

  test("with nothing waiting there is no amber at all", () => {
    draw(<Mv3RitualSlot face={face({ brief: { done: 2, needsYou: 0 } })} />);
    expect(screen.queryByText(/needs? you/)).toBeNull();
  });
});

describe("the all-quiet face (R3)", () => {
  const quiet = () => face({ brief: { done: 0, needsYou: 0 } });

  test("renders no primary verb — the sentence is the brief", () => {
    draw(<Mv3RitualSlot face={quiet()} />);
    expect(screen.getByText("All quiet overnight.")).toBeTruthy();
    // Not a button anywhere except "Dismiss": a verb here would send the owner
    // to an empty room, which is the tap "omit rather than fake" is about.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Dismiss");
    expect(screen.getByText("Nothing to read this morning")).toBeTruthy();
    expect(screen.queryByText("Read it · 2 min")).toBeNull();
    expect(screen.queryByText("Later")).toBeNull();
  });

  test("names what was watched, with the emphasis design draws", () => {
    const { container } = draw(<Mv3RitualSlot face={quiet()} />);
    const sub = line(
      container,
      "Nothing arrived, nothing needs you. Cue was watching — 6 sources, no movement.",
    );
    // The clause that separates a quiet night from a broken pipeline is the
    // one carrying the weight.
    expect(container.querySelector("b")?.textContent).toBe("Cue was watching");
    // It states a fact about watching, not an ask. No amber.
    expect(sub.style.color).not.toContain("amber");
  });

  test("still wears the ritual's blue, one step down", () => {
    const { container } = draw(<Mv3RitualSlot face={quiet()} />);
    const slot = container.querySelector(
      '[data-slot="mv3-ritual"]',
    ) as HTMLElement;
    expect(slot.style.border).toContain("61, 110, 232");
    // Dimmer than the eventful card — the ritual is no less real, the night
    // just was less busy.
    expect(slot.style.border).toContain(".32");
  });

  test("Dismiss records the ritual as done", () => {
    draw(<Mv3RitualSlot face={quiet()} />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(readRitualProgress("brief", new Date()).dismissed).toBe(true);
  });
});

describe("the first-brief face (R5)", () => {
  const first = () => face({ hasSeenBrief: false });

  test("introduces itself with the figures it measured", () => {
    const { container } = draw(<Mv3RitualSlot face={first()} />);
    expect(screen.getByText("YOUR FIRST BRIEF")).toBeTruthy();
    expect(
      screen.getByText("One night in, and I've read 41 things."),
    ).toBeTruthy();
    expect(
      line(
        container,
        "Twelve looked like yours. This is what every morning looks like now.",
      ),
    ).toBeTruthy();
    expect(container.querySelector("b")?.textContent).toBe(
      "This is what every morning looks like now.",
    );
    expect(screen.getByText("Read it · 2 min")).toBeTruthy();
  });

  test("is the loudest the card ever gets — and only this once", () => {
    const { container } = draw(<Mv3RitualSlot face={first()} />);
    const slot = container.querySelector(
      '[data-slot="mv3-ritual"]',
    ) as HTMLElement;
    expect(slot.dataset.tone).toBe("first");
    expect(slot.style.borderWidth).toBe("1.5px");

    cleanup();
    const ordinary = draw(<Mv3RitualSlot face={face()} />);
    const after = ordinary.container.querySelector(
      '[data-slot="mv3-ritual"]',
    ) as HTMLElement;
    expect(after.dataset.tone).toBe("ordinary");
    expect(after.style.borderWidth).toBe("1px");
  });

  test("nothing watched yet renders NOTHING — the takeover keeps the screen", () => {
    const { container } = draw(
      <Mv3RitualSlot
        face={face({
          hasSeenBrief: false,
          intake: { read: 0, yours: 0 },
          sources: 0,
        })}
      />,
    );
    expect(container.querySelector('[data-slot="mv3-ritual"]')).toBeNull();
    expect(container.textContent).toBe("");
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
