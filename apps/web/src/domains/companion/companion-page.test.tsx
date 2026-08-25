/**
 * The companion page — design `C1`–`C3`.
 *
 * What is worth pinning here is the division of labour, because every part of
 * it exists to stop an always-on-top window from swallowing clicks meant for
 * other applications:
 *
 *   1. **The page draws what main gives it** — size, growth, card-growth — and
 *      backfills once for a cold window that missed the first publish.
 *   2. **Hover is main's answer, not the page's guess.** Being pointed at is
 *      something the page reports; whether that counts as hover comes back
 *      from main, which is the only side that can know without the window
 *      having claimed its whole canvas.
 *   3. **Coverage is re-reported on every phase**, including the phases that
 *      remove what the pointer was over.
 *   4. **A press is captured and always released**, so the drag ends wherever
 *      the button comes up.
 *
 * The bridge module is mocked wholesale: the page is presentation over
 * `companion-bridge`, whose own off-Electron no-op behaviour is a one-line
 * guard per function.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { AssistantStatus } from "@/runtime/is-electron";

let statusListeners: Array<(status: AssistantStatus) => void> = [];
let stateListeners: Array<(state: Record<string, unknown>) => void> = [];
let pulledStatus: AssistantStatus | null = "idle";
let pulledState: Record<string, unknown> | null = null;

const talkSpy = mock(() => Promise.resolve());
const openCueSpy = mock(() => Promise.resolve());
const hideSpy = mock(() => Promise.resolve());
const getStatusSpy = mock(() => Promise.resolve(pulledStatus));
const getStateSpy = mock(() => Promise.resolve(pulledState));
const pointerOverSpy = mock((_over: boolean) => undefined);
const dragBeginSpy = mock(() => undefined);
const dragEndSpy = mock(() => undefined);

mock.module("@/domains/companion/companion-bridge", () => ({
  companionTalk: talkSpy,
  companionOpenCue: openCueSpy,
  hideCompanion: hideSpy,
  getCompanionStatus: getStatusSpy,
  getCompanionState: getStateSpy,
  setCompanionPointerOver: pointerOverSpy,
  companionDragBegin: dragBeginSpy,
  companionDragEnd: dragEndSpy,
  subscribeCompanionStatus: (callback: (status: AssistantStatus) => void) => {
    statusListeners.push(callback);
    return () => {
      statusListeners = statusListeners.filter((l) => l !== callback);
    };
  },
  subscribeCompanionState: (
    callback: (state: Record<string, unknown>) => void,
  ) => {
    stateListeners.push(callback);
    return () => {
      stateListeners = stateListeners.filter((l) => l !== callback);
    };
  },
}));

const { CompanionPage } = await import("./companion-page");

// happy-dom does not implement pointer capture. The page's contract is that it
// *asks* for capture and always releases it, so record the asks.
const captured = new Set<number>();
beforeEach(() => {
  Object.assign(HTMLElement.prototype, {
    setPointerCapture(id: number) {
      captured.add(id);
    },
    releasePointerCapture(id: number) {
      captured.delete(id);
    },
    hasPointerCapture(id: number) {
      return captured.has(id);
    },
  });
});

const pushStatus = (status: AssistantStatus): void => {
  act(() => {
    for (const listener of [...statusListeners]) listener(status);
  });
};

const pushState = (state: Record<string, unknown>): void => {
  act(() => {
    for (const listener of [...stateListeners]) listener(state);
  });
};

const flushMicrotasks = () => act(async () => {});

/** The surface's outermost element — the page's drag handle. */
const handle = (): HTMLElement =>
  document.querySelector("[data-companion-handle]") as HTMLElement;

const creature = (): HTMLElement =>
  document.querySelector("[data-companion-creature]") as HTMLElement;

/** The transparent canvas the surface sits on — what receives forwarded moves. */
const canvas = (): HTMLElement => handle().parentElement as HTMLElement;

// happy-dom lays nothing out, so the drawn area has to be stated. Stating it
// is the point of these tests anyway: coverage is answered from geometry, not
// from the browser's enter/leave bookkeeping.
const drawnArea = (width: number, height: number): void => {
  handle().getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
};

beforeEach(() => {
  statusListeners = [];
  stateListeners = [];
  pulledStatus = "idle";
  pulledState = null;
  captured.clear();
  talkSpy.mockClear();
  openCueSpy.mockClear();
  hideSpy.mockClear();
  getStatusSpy.mockClear();
  getStateSpy.mockClear();
  pointerOverSpy.mockClear();
  dragBeginSpy.mockClear();
  dragEndSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("the page draws what main gives it", () => {
  test("the creature's box comes from main, not from a copy of the scale", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    // The default the page opens at, before main has said anything.
    expect(creature().style.width).toBe("66px");

    pushState({ avatarBox: 110 });
    expect(creature().style.width).toBe("110px");
  });

  test("a cold window backfills from the one-shot pull", async () => {
    // The route chunk loads lazily, so main's first publish can land before
    // this page exists. Without the pull the creature would draw at its
    // default size until something else happened to change.
    pulledState = { avatarBox: 88, growth: "left", cardGrowth: "down" };
    render(<CompanionPage />);
    await flushMicrotasks();

    expect(creature().style.width).toBe("88px");
  });

  test("growth mirrors the row, so the creature holds its x", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushState({ hover: true, growth: "left" });
    // Growing leftward needs the row reversed as well as the window anchored
    // by its right edge. Half the fix is upstream's `db9392ef`.
    const row = handle().firstElementChild as HTMLElement;
    expect(row.style.flexDirection).toBe("row-reverse");
  });
});

describe("hover is main's answer, not the page's guess", () => {
  test("being pointed at is reported, and changes nothing on its own", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    drawnArea(200, 60);

    fireEvent.mouseMove(canvas(), { clientX: 40, clientY: 30 });
    expect(pointerOverSpy).toHaveBeenLastCalledWith(true);
    // Reported, but not acted on: the page has not drawn the hover
    // affordances, because whether this counts as hover is main's to say.
    expect(screen.queryByText("\u270e Type")).toBeNull();

    pushState({ hover: true });
    expect(screen.getByText("\u270e Type")).toBeTruthy();
  });

  test("a move over the empty canvas is not coverage", async () => {
    // Most of the window is empty. Claiming it because the pointer crossed it
    // is how an always-on-top surface swallows other applications' clicks.
    render(<CompanionPage />);
    await flushMicrotasks();
    drawnArea(200, 60);

    fireEvent.mouseMove(canvas(), { clientX: 900, clientY: 400 });
    expect(pointerOverSpy).toHaveBeenLastCalledWith(false);
  });

  test("the canvas is handed back when the pointer leaves", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    drawnArea(200, 60);

    fireEvent.mouseMove(canvas(), { clientX: 40, clientY: 30 });
    fireEvent.mouseLeave(canvas());
    expect(pointerOverSpy).toHaveBeenLastCalledWith(false);
  });

  test("REGRESSION: the drawn area shrinking under a still pointer hands the canvas back", async () => {
    // The pill collapses, or a card is dismissed, and no mouse-move follows —
    // so nothing recomputes on its own and the window goes on claiming a
    // canvas many times the size of the creature. Upstream shipped exactly
    // this in the intro (`64e3eead`).
    render(<CompanionPage />);
    await flushMicrotasks();

    drawnArea(320, 60);
    pushState({ hover: true }); // the pill is out; the pointer is on its far end
    fireEvent.mouseMove(canvas(), { clientX: 280, clientY: 30 });
    expect(pointerOverSpy).toHaveBeenLastCalledWith(true);

    pointerOverSpy.mockClear();
    drawnArea(66, 66); // collapsed back to just the creature
    pushState({ hover: false });

    expect(pointerOverSpy).toHaveBeenLastCalledWith(false);
  });
});

describe("a press is captured, and always released", () => {
  test("a press asks for capture and tells main to start reading the cursor", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.pointerDown(handle(), { button: 0, pointerId: 7 });

    expect(dragBeginSpy).toHaveBeenCalledTimes(1);
    // Capture is what makes the release reportable when the button comes up
    // over another application — which it routinely does, because a fast drag
    // outruns a window moved one IPC message at a time.
    expect(captured.has(7)).toBe(true);
  });

  test("the release ends the press and gives the capture back", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.pointerDown(handle(), { button: 0, pointerId: 7 });
    fireEvent.pointerUp(handle(), { button: 0, pointerId: 7 });

    expect(dragEndSpy).toHaveBeenCalledTimes(1);
    expect(captured.has(7)).toBe(false);
  });

  test("REGRESSION: losing the capture ends the press too", async () => {
    // The OS taking the capture back, or the window going away under the
    // hand, both leave a press outstanding otherwise — and an unended press
    // is a window that never stops claiming its canvas.
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.pointerDown(handle(), { button: 0, pointerId: 7 });
    fireEvent.lostPointerCapture(handle(), { pointerId: 7 });

    expect(dragEndSpy).toHaveBeenCalledTimes(1);
  });

  test("a right-click is not a drag", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.pointerDown(handle(), { button: 2, pointerId: 7 });

    expect(dragBeginSpy).not.toHaveBeenCalled();
  });
});

describe("status outranks a resting creature", () => {
  test("a run in progress sends the dot travelling, pushed and pulled alike", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushStatus("thinking");
    // Working travels; rest pulses. Never both — one claim about whose turn
    // it is.
    expect(creature().style.animation).toBe("");

    pushStatus("idle");
    expect(creature().style.animation).toContain("cueCreatureGlow");
  });

  test("the one-shot pull backfills the initial status", async () => {
    pulledStatus = "thinking";
    render(<CompanionPage />);
    await flushMicrotasks();

    expect(creature().style.animation).toBe("");
  });
});
