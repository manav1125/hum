import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CompanionDrag } from "./companion-drag";
import { CompanionHitTest } from "./companion-hit-test";

/**
 * The window discipline — design `C3`'s engineering notes.
 *
 * Every case here is one of upstream's shipped bugs. They are worth testing
 * rather than reviewing because the failure is invisible in our own app and
 * lands in someone else's: an always-on-top window that is wrong about its own
 * hit-test **eats the clicks the user meant for whatever is behind it**. Three
 * of upstream's five ended that way.
 */

type Win = {
  isDestroyed: () => boolean;
  setIgnoreMouseEvents: ReturnType<typeof mock>;
};

function makeWindow(): Win {
  return {
    isDestroyed: () => false,
    setIgnoreMouseEvents: mock(() => undefined),
  };
}

describe("the canvas is transparent to clicks until the pointer is on something", () => {
  let win: Win;
  let hit: CompanionHitTest;

  beforeEach(() => {
    win = makeWindow();
    hit = new CompanionHitTest({ window: () => win as never });
  });

  test("handing clicks back forwards moves, so hover can still be known", () => {
    hit.set(true);
    hit.set(false);
    // `forward: true` is the whole technique: mouse-move keeps arriving so the
    // surface knows it is pointed at, while presses go to what is behind.
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("claiming clicks takes the canvas, and only then", () => {
    hit.set(true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  test("it does not thrash the host on repeated identical calls", () => {
    hit.set(true);
    hit.set(true);
    hit.set(true);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
  });

  test("REGRESSION: removing a card under a still pointer hands clicks back", () => {
    // Upstream's intro leak (`64e3eead`). Skip, "Got it" and an incoming call
    // all take the card out from under a stationary pointer — and with no
    // mouse-move to follow, nothing recomputes. The window then keeps the
    // whole canvas until the user happens to move the mouse.
    hit.set(true);
    hit.releaseAfterRemoval();
    expect(hit.isInteractive()).toBe(false);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
  });

  test("a destroyed window is not interactive and does not throw", () => {
    const dead = { ...makeWindow(), isDestroyed: () => true };
    const h = new CompanionHitTest({ window: () => dead as never });
    expect(() => h.set(true)).not.toThrow();
    expect(h.isInteractive()).toBe(false);
  });
});

describe("a drag ends wherever the button comes up", () => {
  const moves: Array<{ x: number; y: number }> = [];
  const settles: Array<{ x: number; y: number }> = [];
  const interactive: boolean[] = [];
  let drag: CompanionDrag;

  beforeEach(() => {
    moves.length = 0;
    settles.length = 0;
    interactive.length = 0;
    drag = new CompanionDrag({
      moveTo: (c) => moves.push(c),
      settle: (c) => settles.push(c),
      setInteractive: (v) => interactive.push(v),
    });
  });

  test("it follows the pointer while held", () => {
    drag.begin({ x: 100, y: 100 }, { x: 500, y: 400 });
    drag.move({ x: 140, y: 90 });
    expect(moves.at(-1)).toEqual({ x: 540, y: 390 });
  });

  test("REGRESSION: a move with no press outstanding is ignored", () => {
    // The visible half of upstream's `56405459`: after a press that never
    // ended, every later move was read as a drag frame and the surface chased
    // a pointer with no button held.
    drag.move({ x: 900, y: 900 });
    expect(moves).toHaveLength(0);
  });

  test("REGRESSION: ending over another app still ends the drag", () => {
    // The cause: a fast drag outruns a window moved one IPC message at a time,
    // so the button comes up somewhere the page is not. Ending on a page
    // `mouseup` therefore never fires — the press outlives the gesture, and
    // the hit-test never resumes.
    drag.begin({ x: 100, y: 100 }, { x: 500, y: 400 });
    drag.move({ x: 300, y: 250 });
    drag.end({ x: 1800, y: 20 }); // reported globally, far outside the canvas
    expect(drag.isHeld()).toBe(false);
    expect(settles).toHaveLength(1);
  });

  test("the canvas is handed back the moment a drag ends", () => {
    drag.begin({ x: 0, y: 0 }, { x: 10, y: 10 });
    drag.move({ x: 5, y: 5 });
    drag.end({ x: 5, y: 5 });
    expect(interactive.at(-1)).toBe(false);
  });

  test("REGRESSION: a still hand is a click, however often the cursor is read", () => {
    // Main polls the cursor rather than waiting for renderer events, so a
    // press that never moves still produces a move every frame. Without a
    // threshold every click on the creature would count as a drag and settle
    // it to an edge.
    drag.begin({ x: 200, y: 200 }, { x: 500, y: 400 });
    for (let i = 0; i < 20; i++) drag.move({ x: 201, y: 199 });
    expect(moves).toHaveLength(0);
    expect(drag.end({ x: 201, y: 199 }).dragged).toBe(false);
  });

  test("once it is a drag it stays one, even if the hand comes to rest", () => {
    drag.begin({ x: 200, y: 200 }, { x: 500, y: 400 });
    drag.move({ x: 260, y: 200 });
    drag.move({ x: 261, y: 200 });
    expect(moves).toHaveLength(2);
    expect(drag.hasMoved()).toBe(true);
  });

  test("a press that never moved is a click, not a drag", () => {
    drag.begin({ x: 10, y: 10 }, { x: 500, y: 400 });
    const { dragged } = drag.end({ x: 10, y: 10 });
    expect(dragged).toBe(false);
    expect(settles).toHaveLength(0);
  });

  test("ending twice is safe — blur and mouse-up can both arrive", () => {
    drag.begin({ x: 0, y: 0 }, { x: 10, y: 10 });
    drag.end({ x: 4, y: 4 });
    expect(() => drag.end({ x: 4, y: 4 })).not.toThrow();
    expect(drag.isHeld()).toBe(false);
  });
});
