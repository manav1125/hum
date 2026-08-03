/**
 * The layout contract, enforced rather than remembered.
 *
 * `phone-keyboard.test.ts` proves the arithmetic. This proves the rendered
 * frame is the shape that arithmetic assumes — because the shipped bug was not
 * a wrong number, it was the right number applied to the wrong property. A
 * `transform` on the composer and a `translate` on the shell both typecheck and
 * both look plausible in review; they only fail when you type into a thread.
 *
 * So the assertions here are the four sentences of design's rule, in the DOM:
 *   · the shell does not translate;
 *   · the header is outside every scroller and does not shrink;
 *   · the thread is the one elastic child;
 *   · the composer's bottom inset is the keyboard, on the system curve.
 *
 * Run at both thread sizes, since a 200-row thread is what turned the last
 * plausible-looking version into a jumping header.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { createElement, createRef, type ReactNode } from "react";

import { PhoneChatFrame } from "./phone-chat-frame";
import { KEYBOARD_CURVE, resolveChatFrame } from "./phone-keyboard";

afterEach(cleanup);

const SHELL = 844;
const KEYBOARD = 336;
const HEADER = 58;
const COMPOSER = 64;

function fakeTranscript(count: number): ReactNode {
  return createElement(
    "div",
    { "data-testid": "transcript-scroll-container" },
    createElement(
      "div",
      { "data-testid": "transcript-content" },
      ...Array.from({ length: count }, (_, i) =>
        createElement("div", { key: i, "data-msg": i }, `message ${i}`),
      ),
    ),
  );
}

function renderFrame(count: number, keyboardHeight: number) {
  const frame = resolveChatFrame({
    shellHeight: SHELL,
    keyboardHeight,
    headerHeight: HEADER,
    composerHeight: COMPOSER,
  });
  const view = render(
    createElement(PhoneChatFrame, {
      frame,
      shellRef: createRef<HTMLDivElement>(),
      headerRef: createRef<HTMLDivElement>(),
      composerRef: createRef<HTMLDivElement>(),
      header: createElement("div", { "data-testid": "hdr" }, "Acme pricing"),
      thread: fakeTranscript(count),
      composer: createElement("textarea", { "aria-label": "Message Cue" }),
    }),
  );
  const shell = view.container.querySelector<HTMLElement>(
    "[data-phone-chat-frame]",
  )!;
  return {
    frame,
    shell,
    header: shell.querySelector<HTMLElement>("[data-phone-chat-header]")!,
    thread: shell.querySelector<HTMLElement>("[data-phone-thread]")!,
    composer: shell.querySelector<HTMLElement>("[data-phone-composer]")!,
    scroller: shell.querySelector<HTMLElement>(
      '[data-testid="transcript-scroll-container"]',
    )!,
  };
}

/**
 * The regression that only the 200-message thread exposed.
 *
 * Driving the real frame at 390×844 with a 336px keyboard: a 2-message thread
 * was perfect, and a 200-message thread left the newest message 300px BELOW the
 * fold — because the thread's viewport shrank while `scrollTop` stayed put, so
 * the reader was suddenly looking at message 178. It passed every static
 * assertion and every typecheck; it took the size design specified to see it.
 *
 * happy-dom has no layout engine, so the scroller's geometry is stubbed. What
 * is under test is the wiring — that a change in the frame's thread height
 * reaches `nextScrollTop` and lands on `scrollTop` — not the arithmetic, which
 * `phone-keyboard.test.ts` covers on its own.
 */
describe("the reader's position survives the thread shrinking", () => {
  function stubbedScroller(view: ReturnType<typeof render>) {
    const el = view.container.querySelector<HTMLElement>(
      '[data-testid="transcript-scroll-container"]',
    )!;
    let clientHeight = 645;
    let scrollTop = 0;
    Object.defineProperty(el, "scrollHeight", { value: 11287, configurable: true });
    Object.defineProperty(el, "clientHeight", {
      get: () => clientHeight,
      configurable: true,
    });
    Object.defineProperty(el, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    return {
      el,
      setClientHeight: (h: number) => {
        clientHeight = h;
      },
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(v: number) {
        scrollTop = v;
      },
    };
  }

  function frameProps(threadHeight: number) {
    return {
      shellRef: createRef<HTMLDivElement>(),
      headerRef: createRef<HTMLDivElement>(),
      composerRef: createRef<HTMLDivElement>(),
      header: createElement("div", null, "h"),
      thread: fakeTranscript(200),
      composer: createElement("div", null, "c"),
      frame: {
        ...resolveChatFrame({
          shellHeight: SHELL,
          keyboardHeight: 0,
          headerHeight: HEADER,
          composerHeight: COMPOSER,
        }),
        threadHeight,
      },
    };
  }

  /**
   * happy-dom reports every height as 0 until we stub, so the first commit
   * remembers 0. A second render at the SAME height seeds the real one — which
   * is what a real first paint does anyway.
   */
  function mountedAt645() {
    const view = render(createElement(PhoneChatFrame, frameProps(645)));
    const scroller = stubbedScroller(view);
    view.rerender(createElement(PhoneChatFrame, frameProps(645)));
    return { view, scroller };
  }

  test("a pinned thread stays pinned when the keyboard takes 296px", () => {
    const { view, scroller } = mountedAt645();

    // The reader is at the newest message.
    scroller.scrollTop = 11287 - 645;

    // Keyboard up: the thread viewport shrinks, nothing else moves.
    scroller.setClientHeight(349);
    view.rerender(createElement(PhoneChatFrame, frameProps(349)));

    expect(scroller.scrollTop).toBe(11287 - 349);
  });

  test("a reader scrolled up is held on the same content, not snapped down", () => {
    const { view, scroller } = mountedAt645();

    scroller.scrollTop = 11287 - 645 - 900; // 900px up from the newest message

    scroller.setClientHeight(349);
    view.rerender(createElement(PhoneChatFrame, frameProps(349)));

    // Same distance from the bottom → the same messages are on screen.
    expect(11287 - 349 - scroller.scrollTop).toBe(900);
  });

  test("no scroll event is required — a missed one must not misplace the reader", () => {
    // The correction reads the scroller live rather than trusting a snapshot,
    // so it is correct in an environment that delivers no scroll events at all.
    // That is not hypothetical: the browser this was driven in delivered none.
    const { view, scroller } = mountedAt645();
    scroller.scrollTop = 11287 - 645; // set with no event of any kind
    scroller.setClientHeight(349);
    view.rerender(createElement(PhoneChatFrame, frameProps(349)));
    expect(scroller.scrollTop).toBe(11287 - 349);
  });
});

describe.each([
  ["2-message thread", 2],
  ["200-message thread", 200],
])("%s", (_label, count) => {
  test("the window never moves — no transform anywhere in the frame", () => {
    for (const keyboard of [0, KEYBOARD]) {
      const { shell, header, thread, composer } = renderFrame(count, keyboard);
      for (const el of [shell, header, thread, composer]) {
        const t = el.style.transform;
        expect(t === "" || t === "none").toBe(true);
        // The other way to move a window: taking it out of flow.
        expect(el.style.position === "fixed").toBe(false);
      }
      expect(shell.style.transform).toBe("none");
      cleanup();
    }
  });

  test("the header is pinned outside the scroller and never shrinks", () => {
    const { header, scroller } = renderFrame(count, KEYBOARD);
    expect(header.style.flexShrink).toBe("0");
    expect(scroller.contains(header)).toBe(false);
    expect(header.querySelector('[data-testid="hdr"]')).not.toBeNull();
  });

  test("the thread is the one elastic child, and it clips", () => {
    const { thread } = renderFrame(count, KEYBOARD);
    expect(thread.style.flex).toBe("1 1 0%");
    expect(parseFloat(thread.style.minHeight)).toBe(0);
    expect(thread.style.overflow).toBe("hidden");
  });

  test("the composer sits on the keyboard, on the system curve", () => {
    const down = renderFrame(count, 0);
    expect(down.composer.style.paddingBottom).toBe("");
    expect(down.frame.tabBarVisible).toBe(true);
    cleanup();

    const up = renderFrame(count, KEYBOARD);
    expect(up.composer.style.paddingBottom).toBe(`${KEYBOARD}px`);
    expect(up.composer.style.transition).toBe(
      `padding-bottom ${KEYBOARD_CURVE}`,
    );
    expect(up.composer.style.flexShrink).toBe("0");
    // Spec 4 — navigation is gone while typing.
    expect(up.frame.tabBarVisible).toBe(false);
    expect(up.shell.getAttribute("data-keyboard-open")).toBe("true");
  });

  test("the thread is bottom-anchored", () => {
    const { shell } = renderFrame(count, KEYBOARD);
    const css = shell.querySelector("style")?.innerHTML ?? "";
    expect(css).toContain("margin-top: auto");
    expect(css).toContain('[data-testid="transcript-scroll-container"] > *');
  });

  test("the dock rides above the composer, not over the thread", () => {
    // A live-activity block that overlays the thread hides the newest message,
    // which is the same failure as a composer that overlays it.
    const view = render(
      createElement(PhoneChatFrame, {
        frame: resolveChatFrame({
          shellHeight: SHELL,
          keyboardHeight: KEYBOARD,
          headerHeight: HEADER,
          composerHeight: COMPOSER,
        }),
        shellRef: createRef<HTMLDivElement>(),
        headerRef: createRef<HTMLDivElement>(),
        composerRef: createRef<HTMLDivElement>(),
        header: createElement("div", null, "h"),
        thread: fakeTranscript(count),
        dock: createElement("div", { "data-testid": "dock" }, "working…"),
        composer: createElement("div", null, "c"),
      }),
    );
    const composerRegion = view.container.querySelector<HTMLElement>(
      "[data-phone-composer]",
    )!;
    const dock = view.container.querySelector<HTMLElement>(
      '[data-testid="dock"]',
    )!;
    const thread = view.container.querySelector<HTMLElement>(
      "[data-phone-thread]",
    )!;
    expect(composerRegion.contains(dock)).toBe(true);
    expect(thread.contains(dock)).toBe(false);
    expect(dock.style.position === "absolute").toBe(false);
  });
});
