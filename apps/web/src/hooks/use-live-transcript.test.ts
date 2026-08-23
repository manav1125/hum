import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The live-transcript mirror, and the rule that it may never cost a capture.
 *
 * This hook exists to satisfy F2·E ("words land as you speak") and S1·B. It
 * runs *beside* the `MediaRecorder` that actually keeps the note, which means
 * every one of its failure modes — a cloud assistant with no self-hosted
 * ingress, a browser without AudioWorklet, a socket that never opens — has
 * exactly one correct outcome: **no live words, and a recording that still
 * works.** A display feature that can take someone's note down with it is a
 * worse trade than having no live words at all, so the fail-open behaviour is
 * tested here rather than left to the reader.
 */

let started: Array<{ onPartial: (text: string) => void }> = [];
let stopCalls = 0;
/** What `startDictationStream` should do on the next call. */
let mode: "live" | "unavailable" | "throws" = "live";

mock.module("@/domains/chat/voice/dictation-stream", () => ({
  startDictationStream: ({ onPartial }: { onPartial: (t: string) => void }) => {
    if (mode === "throws") throw new Error("no mic");
    if (mode === "unavailable") return null;
    started.push({ onPartial });
    return {
      isLive: () => true,
      stop: () => {
        stopCalls += 1;
      },
    };
  },
}));

const { useLiveTranscript } = await import("./use-live-transcript");

/**
 * Drives the hook's real callbacks without a renderer: `useState` and
 * `useRef` are stubbed to plain cells, and `useCallback`/`useEffect` to
 * pass-throughs. A test that reimplemented the hook's branches instead would
 * pass while the hook did the opposite.
 */
function drive(): {
  read: () => { text: string; isLive: boolean };
  start: () => void;
  stop: () => void;
} {
  const cells: unknown[] = [];
  let i = 0;
  const React = {
    useState: (init: unknown) => {
      const at = i++;
      if (cells.length <= at) cells[at] = init;
      return [cells[at], (v: unknown) => (cells[at] = v)] as const;
    },
    useRef: (init: unknown) => {
      const at = i++;
      if (cells.length <= at) cells[at] = { current: init };
      return cells[at] as { current: unknown };
    },
  };
  mock.module("react", () => ({
    ...React,
    useCallback: (fn: unknown) => fn,
    useEffect: () => undefined,
  }));
  let api!: ReturnType<typeof useLiveTranscript>;
  const run = (): void => {
    i = 0;
    // Deliberately calling the hook outside a component: `react` is stubbed
    // above so this drives the hook's REAL callbacks with plain cells, which
    // is the point — a fake that reimplemented the branches could pass while
    // the hook did the opposite.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    api = useLiveTranscript();
  };
  run();
  return {
    read: () => {
      run();
      return { text: api.text, isLive: api.isLive };
    },
    start: () => {
      api.start();
      run();
    },
    stop: () => {
      api.stop();
      run();
    },
  };
}

beforeEach(() => {
  started = [];
  stopCalls = 0;
  mode = "live";
});

describe("it fails open, always", () => {
  test("no ingress or no worklet: start() is a no-op, never a throw", () => {
    mode = "unavailable";
    const h = drive();
    expect(() => h.start()).not.toThrow();
    expect(h.read()).toEqual({ text: "", isLive: false });
  });

  test("a throwing stream is swallowed — the recording is not this hook's", () => {
    mode = "throws";
    const h = drive();
    expect(() => h.start()).not.toThrow();
    expect(h.read().isLive).toBe(false);
  });

  test("stop() is safe with nothing running, and idempotent", () => {
    const h = drive();
    expect(() => {
      h.stop();
      h.stop();
    }).not.toThrow();
  });
});

describe("when it is live, the words land", () => {
  test("partials become the visible text", () => {
    const h = drive();
    h.start();
    expect(h.read().isLive).toBe(true);
    started[0]!.onPartial("don't lead with price");
    expect(h.read().text).toBe("don't lead with price");
  });

  test("stop clears the words and closes the session", () => {
    const h = drive();
    h.start();
    started[0]!.onPartial("something");
    h.stop();
    expect(stopCalls).toBe(1);
    expect(h.read()).toEqual({ text: "", isLive: false });
  });

  test("a second start while live does not open a second session", () => {
    const h = drive();
    h.start();
    h.start();
    expect(started).toHaveLength(1);
  });
});
