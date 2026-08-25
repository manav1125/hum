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
const readySpy = mock(() => undefined);
const drawnRectSpy = mock(
  (_r: { x: number; y: number; width: number; height: number }) => undefined,
);
const dragBeginSpy = mock(() => undefined);
const dragEndSpy = mock(() => undefined);
const menuSpy = mock(() => undefined);
const introNextSpy = mock((_fromBeat: number) => undefined);
const introDismissSpy = mock(() => undefined);
const nudgeOpenSpy = mock(() => undefined);
const stopSpy = mock(() => undefined);
const dragOverSpy = mock((_over: boolean) => undefined);
const dropSpy = mock((_item: { kind: string; value: string }) => undefined);
const dropChooseSpy = mock((_choice: string) => undefined);
const dropReleaseSpy = mock(() => undefined);
const askSpy = mock((_m: string) => undefined);
const keepSpy = mock((_m: string) => undefined);
const closeCardSpy = mock(() => undefined);
const nudgeDismissSpy = mock(() => undefined);

mock.module("@/domains/companion/companion-bridge", () => ({
  companionTalk: talkSpy,
  companionOpenCue: openCueSpy,
  hideCompanion: hideSpy,
  // Deliberate traps: `companion-bridge` no longer exports these, so the
  // only way they can fire is somebody re-introducing a second source of
  // truth for whose turn it is. See the regression test at the bottom.
  getCompanionStatus: getStatusSpy,
  getCompanionState: getStateSpy,
  setCompanionPointerOver: pointerOverSpy,
  setCompanionDrawnRect: drawnRectSpy,
  companionReady: readySpy,
  companionDragBegin: dragBeginSpy,
  companionDragEnd: dragEndSpy,
  openCompanionMenu: menuSpy,
  companionIntroNext: introNextSpy,
  companionIntroDismiss: introDismissSpy,
  companionNudgeOpen: nudgeOpenSpy,
  companionStop: stopSpy,
  companionDragOver: dragOverSpy,
  companionDrop: dropSpy,
  companionDropChoose: dropChooseSpy,
  companionDropRelease: dropReleaseSpy,
  companionAsk: askSpy,
  companionKeepAsNote: keepSpy,
  companionCloseCard: closeCardSpy,
  companionNudgeDismiss: nudgeDismissSpy,
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

/**
 * Main publishes the whole payload every time, and the page replaces rather
 * than merges — so these helpers do too. Merging is the bug being guarded
 * against, not a convenience worth keeping in the test.
 */
const BASE = {
  phase: "resting",
  avatarBox: 66,
  growth: "right",
  cardGrowth: "up",
} as const;

const pushState = (state: Record<string, unknown>): void => {
  act(() => {
    for (const listener of [...stateListeners]) listener({ ...BASE, ...state });
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
  drawnRectSpy.mockClear();
  readySpy.mockClear();
  dragBeginSpy.mockClear();
  dragEndSpy.mockClear();
  menuSpy.mockClear();
  introNextSpy.mockClear();
  introDismissSpy.mockClear();
  nudgeOpenSpy.mockClear();
  stopSpy.mockClear();
  dragOverSpy.mockClear();
  dropSpy.mockClear();
  dropChooseSpy.mockClear();
  dropReleaseSpy.mockClear();
  askSpy.mockClear();
  keepSpy.mockClear();
  closeCardSpy.mockClear();
  nudgeDismissSpy.mockClear();
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
    pulledState = { ...BASE, avatarBox: 88, growth: "left", cardGrowth: "down" };
    render(<CompanionPage />);
    await flushMicrotasks();

    expect(creature().style.width).toBe("88px");
  });

  test("growth mirrors the row, so the creature holds its x", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushState({ phase: "hover", growth: "left" });
    // Growing leftward needs the row reversed as well as the window anchored
    // by its right edge. Half the fix is upstream's `db9392ef`.
    const row = handle().firstElementChild as HTMLElement;
    expect(row.style.flexDirection).toBe("row-reverse");
  });
});

describe("main does the hit-testing; this page reports what it drew", () => {
  test("REGRESSION: the drawn rectangle is published, not a hover guess", async () => {
    // The page's own hover answer depended on `mousemove` reaching a
    // click-through, non-activating panel. When those did not arrive the
    // window never became interactive — the introduction rendered with a Next
    // button that did nothing. Main can always read the cursor; this page
    // always knows its rectangle.
    render(<CompanionPage />);
    await flushMicrotasks();
    drawnArea(200, 60);
    drawnRectSpy.mockClear();

    pushState({ phase: "hover" });

    expect(drawnRectSpy).toHaveBeenCalled();
    expect(drawnRectSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      width: 200,
      height: 60,
    });
  });

  test("every change to what is drawn republishes the rectangle", async () => {
    // A card opening, a beat advancing, a nudge retracting: each moves the
    // rectangle main is testing against.
    render(<CompanionPage />);
    await flushMicrotasks();
    drawnArea(320, 60);
    pushState({ phase: "hover" });
    drawnRectSpy.mockClear();

    drawnArea(66, 66);
    pushState({ phase: "resting" });

    expect(drawnRectSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      width: 66,
      height: 66,
    });
  });

  test("an unmeasurable surface publishes nothing rather than a zero rect", async () => {
    // A zero rectangle would tell main the pointer is never over anything,
    // which is the same inert window by another route.
    render(<CompanionPage />);
    await flushMicrotasks();
    drawnArea(0, 0);
    drawnRectSpy.mockClear();

    pushState({ phase: "hover" });
    expect(drawnRectSpy).not.toHaveBeenCalled();
  });
});

describe("the introduction (C4)", () => {
  const beat = (patch: Record<string, unknown> = {}) => ({
    intro: {
      beat: 0,
      total: 4,
      step: "1 · MEET",
      title: "I'm Cue.",
      body: "I stay on your desktop, even when the app is closed.",
      last: false,
      ...patch,
    },
  });

  test("it draws the beat main is on", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState(beat());

    expect(screen.getByText("I'm Cue.")).toBeTruthy();
    expect(screen.getByText("1 · MEET")).toBeTruthy();
  });

  test("Next names the beat it was pressed against", async () => {
    // Main discards a press describing a beat that has moved on, which only
    // works if the press carries one.
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState(beat({ beat: 2 }));

    fireEvent.click(screen.getByText("Next"));
    expect(introNextSpy).toHaveBeenLastCalledWith(2);
  });

  test("the last beat offers nothing after it", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState(beat({ beat: 3, last: true }));

    expect(screen.queryByText("Next")).toBeNull();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });

  test("REGRESSION: a publish that stops offering it takes the card away", async () => {
    // Optional fields are absent from every publish that does not need them.
    // Merged rather than replaced, the last one would stay forever — an
    // introduction that cannot be dismissed.
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState(beat());
    expect(screen.getByText("I'm Cue.")).toBeTruthy();

    pushState({ phase: "resting" });
    expect(screen.queryByText("I'm Cue.")).toBeNull();
  });

  test("REGRESSION: a line from an earlier phase does not outlive it", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "couldnt", line: "I couldn't read that just now." });
    expect(screen.getByText("I couldn't read that just now.")).toBeTruthy();

    pushState({ phase: "hover" });
    expect(screen.queryByText("I couldn't read that just now.")).toBeNull();
  });
});

describe("the nudge (C7)", () => {
  test("one line, one Open, one ✕ — and nothing that acts", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "nudge", line: "Dana replied on pricing" });

    expect(
      handle().textContent?.includes("Dana replied on pricing"),
    ).toBe(true);
    // Acting needs the card or the app, so a stray click cannot approve
    // anything (`C9`'s protocol).
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.getByText("Open ›")).toBeTruthy();
  });

  test("Open hands it to the app rather than opening Cue generally", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "nudge", line: "Dana replied on pricing" });

    fireEvent.click(screen.getByText("Open ›"));
    expect(nudgeOpenSpy).toHaveBeenCalledTimes(1);
    expect(openCueSpy).not.toHaveBeenCalled();
  });

  test("✕ teaches the valve", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "nudge", line: "Dana replied on pricing" });

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(nudgeDismissSpy).toHaveBeenCalledTimes(1);
  });

  test("ignored, it becomes a glint the creature keeps", async () => {
    // Never lost, and never repeated out loud.
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "resting", heldNudge: "Dana replied on pricing" });

    const glint = creature().querySelector("span");
    expect(glint).toBeTruthy();
    expect((glint as HTMLElement).style.background).toBe("#6FD69A");
  });

  test("a nudge on screen does not also wear the glint", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({
      phase: "nudge",
      line: "Dana replied on pricing",
      heldNudge: "Dana replied on pricing",
    });

    expect(creature().querySelector("span")).toBeNull();
  });
});

describe("Stop stops what is running (C11)", () => {
  test("REGRESSION: it does not open the voice surface", async () => {
    // It was wired to "talk to Cue", so Stop on a live recording opened voice
    // and left the microphone running — the worst possible button.
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "recording", line: "Recording · Board prep · 12:41" });

    fireEvent.click(screen.getByText("Stop"));

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(talkSpy).not.toHaveBeenCalled();
  });
});

describe("what a screen reader hears (C12)", () => {
  const live = (): string =>
    (document.querySelector("[aria-live]") as HTMLElement)?.textContent ?? "";

  test("turn changes, not every phase", async () => {
    // Narrating each fine phase would say more about Cue in one minute than
    // the creature says all day.
    render(<CompanionPage />);
    await flushMicrotasks();

    pushState({ phase: "working" });
    expect(live()).toBe("Cue is working");

    pushState({ phase: "waiting" });
    expect(live()).toBe("Cue is waiting on you");
  });

  test("REGRESSION: two phases meaning the same turn do not announce twice", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushState({ phase: "waiting" });
    pushState({ phase: "couldnt" });
    // Both are "waiting on you". An aria-live region repeats whatever it is
    // given, including the same sentence.
    expect(live()).toBe("Cue is waiting on you");
  });

  test("your turn is not announced at all — it is what the surface looks like", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushState({ phase: "hover" });
    expect(live()).toBe("");
  });

  test("a nudge announces its one line", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushState({ phase: "nudge", line: "Dana replied on pricing" });
    expect(live()).toBe("Dana replied on pricing");
  });

  test("a capture says so, because it is the one thing worth interrupting for", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushState({ phase: "recording", line: "Recording · Board prep · 12:41" });
    expect(live()).toBe("Recording");
  });
});

describe("drops — the arc's mouth is the slot (C10)", () => {
  const transfer = (init: {
    files?: Array<{ name: string; type: string; path?: string }>;
    uri?: string;
    text?: string;
  }) =>
    ({
      files: init.files ?? [],
      getData: (kind: string) =>
        kind === "text/uri-list" ? (init.uri ?? "") : (init.text ?? ""),
    }) as unknown as DataTransfer;

  test("a drag approaching opens the arc", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.dragOver(canvas(), { dataTransfer: transfer({}) });
    expect(dragOverSpy).toHaveBeenLastCalledWith(true);

    fireEvent.dragLeave(canvas());
    expect(dragOverSpy).toHaveBeenLastCalledWith(false);
  });

  test("REGRESSION: a dropped file is named by the file, not by its URL", async () => {
    // A Finder drag also carries a `text/uri-list`, and describing a contract
    // as a `file://` URL would name it wrongly on a surface whose whole
    // promise is that the chip names exactly what arrived.
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.drop(canvas(), {
      dataTransfer: transfer({
        files: [
          { name: "acme-msa-v4.pdf", type: "application/pdf", path: "/x/acme-msa-v4.pdf" },
        ],
        uri: "file:///x/acme-msa-v4.pdf",
      }),
    });

    expect(dropSpy).toHaveBeenLastCalledWith({
      kind: "file",
      value: "/x/acme-msa-v4.pdf",
    });
  });

  test("an image is known to be an image", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.drop(canvas(), {
      dataTransfer: transfer({
        files: [{ name: "shot.png", type: "image/png", path: "/x/shot.png" }],
      }),
    });
    expect(dropSpy.mock.calls.at(-1)?.[0]?.kind).toBe("image");
  });

  test("a link is a link, and plain words are words", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.drop(canvas(), {
      dataTransfer: transfer({ text: "https://example.com/pricing" }),
    });
    expect(dropSpy.mock.calls.at(-1)?.[0]?.kind).toBe("url");

    fireEvent.drop(canvas(), {
      dataTransfer: transfer({ text: "Dana wants the 24-month term" }),
    });
    expect(dropSpy.mock.calls.at(-1)?.[0]?.kind).toBe("text");
  });

  test("an empty drop is not caught at all", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.drop(canvas(), { dataTransfer: transfer({}) });
    expect(dropSpy).not.toHaveBeenCalled();
  });

  test("the chip names what arrived, and offers three choices that act on nothing", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({
      phase: "caught",
      caught: { kind: "file", label: "acme-msa-v4.pdf" },
    });

    expect(handle().textContent).toContain("acme-msa-v4.pdf");
    // Read / file / note. `C9`'s protocol holds even for something the owner
    // put in Cue's hands themselves.
    expect(screen.getByText("Read it")).toBeTruthy();
    expect(screen.getByText("▤ File it")).toBeTruthy();
    expect(screen.getByText("✎ Note")).toBeTruthy();
    expect(screen.queryByText(/Send|Pay|Approve/)).toBeNull();

    fireEvent.click(screen.getByText("▤ File it"));
    expect(dropChooseSpy).toHaveBeenLastCalledWith("file");
  });

  test("✕ lets it go — not a delete, because nothing was stored", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({
      phase: "caught",
      caught: { kind: "url", label: "example.com/x" },
    });

    fireEvent.click(screen.getByLabelText("Let it go"));
    expect(dropReleaseSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the typing card's two verbs (C2, Q1)", () => {
  const open = async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "typing" });
    return screen.getByLabelText("Ask Cue") as HTMLInputElement;
  };

  test("↵ asks, and the card does not answer into a thread", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "when does Acme renew?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(askSpy).toHaveBeenLastCalledWith("when does Acme renew?");
    expect(keepSpy).not.toHaveBeenCalled();
  });

  test("⌘↵ keeps it as a note instead", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "Dana is out Thursday" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(keepSpy).toHaveBeenLastCalledWith("Dana is out Thursday");
    expect(askSpy).not.toHaveBeenCalled();
  });

  test("REGRESSION: an empty press does nothing at all", async () => {
    // A blank ask would open the app for no reason, and a blank ⌘↵ would
    // manufacture an empty note.
    const input = await open();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(askSpy).not.toHaveBeenCalled();
    expect(keepSpy).not.toHaveBeenCalled();
  });

  test("esc closes, and cancels nothing", async () => {
    // Dismissing a surface must never be a way to lose work already running —
    // the corner's rule, kept.
    const input = await open();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(closeCardSpy).toHaveBeenCalledTimes(1);
    expect(askSpy).not.toHaveBeenCalled();
  });

  test("what was sent is cleared, so a second press cannot resend it", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "ask once" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(askSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the whole settings surface is one right-click away (C5)", () => {
  test("a right-click pops main's menu instead of the platform's", async () => {
    // Native, and main's: the menu is routinely taller than the creature, and
    // a drawn one would have to grow the canvas to hold it — the one thing the
    // fixed canvas exists to prevent.
    render(<CompanionPage />);
    await flushMicrotasks();

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    handle().dispatchEvent(event);

    expect(menuSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("the creature draws whose turn it is, as main resolved it", () => {
  test("working travels; rest pulses; never both", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    pushState({ phase: "working" });
    // One claim about whose turn it is. The rest-glow would be a second.
    expect(creature().style.animation).toBe("");

    pushState({ phase: "resting" });
    expect(creature().style.animation).toContain("cueCreatureGlow");
  });

  test("REGRESSION: the page no longer holds its own copy of the status", async () => {
    // It used to outrank a pushed phase against a separately-subscribed
    // assistant status — two sources of truth for one question, and the one
    // that loses is whichever the user is actually looking at.
    pulledState = { ...BASE };
    render(<CompanionPage />);
    await flushMicrotasks();

    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(statusListeners).toHaveLength(0);
  });
});
