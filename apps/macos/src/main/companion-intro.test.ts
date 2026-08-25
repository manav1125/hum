import { describe, expect, mock, test } from "bun:test";

import { CompanionIntro, COMPANION_INTRO_BEATS } from "./companion-intro";

/**
 * The introduction — design `C4`.
 *
 * The case worth the test is the stale press. It is not hypothetical: the
 * card is drawn by a renderer one IPC message behind, and a double-tap on
 * "Next" is the most ordinary thing a person does to a button that moves
 * something along.
 */

describe("main owns the beat, so a stale press cannot land wrong", () => {
  test("a press names the beat it was made against", () => {
    const intro = new CompanionIntro(false, mock(() => undefined));
    expect(intro.next(0)).toBe(true);
    expect(intro.current()?.beat).toBe(1);
  });

  test("REGRESSION: a second press against a beat that has moved on is discarded", () => {
    // A double-tap: both presses describe beat 0, but only the first was made
    // against a beat 0 that was still on screen. Owned by the renderer, the
    // second would have skipped a beat.
    const intro = new CompanionIntro(false, mock(() => undefined));
    intro.next(0);
    expect(intro.next(0)).toBe(false);
    expect(intro.current()?.beat).toBe(1);
  });

  test("a press from the future is discarded just as firmly", () => {
    const intro = new CompanionIntro(false, mock(() => undefined));
    expect(intro.next(3)).toBe(false);
    expect(intro.current()?.beat).toBe(0);
  });
});

describe("it is shown once, and ends however it ends", () => {
  test("walking to the end finishes it", () => {
    const finished = mock(() => undefined);
    const intro = new CompanionIntro(false, finished);
    for (let i = 0; i < COMPANION_INTRO_BEATS.length; i++) intro.next(i);

    expect(intro.isDone()).toBe(true);
    expect(intro.current()).toBeNull();
    expect(finished).toHaveBeenCalledTimes(1);
  });

  test("dismissing at the first beat finishes it just the same", () => {
    const finished = mock(() => undefined);
    const intro = new CompanionIntro(false, finished);
    intro.dismiss();

    expect(intro.current()).toBeNull();
    expect(finished).toHaveBeenCalledTimes(1);
  });

  test("somebody who has seen it is never shown it again", () => {
    const intro = new CompanionIntro(true, mock(() => undefined));
    expect(intro.current()).toBeNull();
  });

  test("finishing twice notifies once", () => {
    // Dismiss and the last Next can both arrive — the renderer is behind.
    const finished = mock(() => undefined);
    const intro = new CompanionIntro(false, finished);
    intro.dismiss();
    intro.dismiss();
    expect(finished).toHaveBeenCalledTimes(1);
  });
});

describe("the beats say what they are for", () => {
  test("nobody is told how to dismiss it before being told what it is", () => {
    // The order is the argument: what it is, the two things you can do with
    // it, then how to make it go away.
    expect(COMPANION_INTRO_BEATS[0]?.title).toBe("I'm Cue.");
    expect(COMPANION_INTRO_BEATS.at(-1)?.title).toBe("Right-click me");
  });

  test("the last beat offers nothing after it", () => {
    const intro = new CompanionIntro(false, mock(() => undefined));
    intro.next(0);
    intro.next(1);
    intro.next(2);
    expect(intro.current()?.last).toBe(true);
  });
});
