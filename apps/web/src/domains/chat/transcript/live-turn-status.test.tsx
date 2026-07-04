import { describe, expect, test } from "bun:test";

import {
  deriveLiveStatus,
  type DeriveLiveStatusInput,
} from "@/domains/chat/transcript/live-turn-status";

const T0 = 1_000_000;

function input(
  overrides: Partial<DeriveLiveStatusInput>,
): DeriveLiveStatusInput {
  return {
    phase: "thinking",
    statusText: null,
    pendingQueuedCount: 0,
    thinkingTail: "",
    thinkingAt: null,
    runningTools: [],
    turnStartedAt: T0,
    now: T0 + 1_000,
    fallbackActive: false,
    ...overrides,
  };
}

describe("deriveLiveStatus", () => {
  test("idle with no fallback → null (line hidden)", () => {
    expect(deriveLiveStatus(input({ phase: "idle" }))).toBeNull();
    expect(deriveLiveStatus(input({ phase: "errored" }))).toBeNull();
  });

  test("idle but fallback-active (restored/external turn) → fallback copy", () => {
    const view = deriveLiveStatus(
      input({ phase: "idle", fallbackActive: true }),
    );
    expect(view?.text).toBe("Cue is reading your message…");
  });

  test("awaiting_user_input → waiting copy", () => {
    const view = deriveLiveStatus(input({ phase: "awaiting_user_input" }));
    expect(view?.text).toBe("Waiting for your input");
  });

  // --- elapsed-aware fallback ladder -------------------------------------

  test("no events yet: <5s reads, <20s works, <45s ticks, ≥45s big step", () => {
    expect(deriveLiveStatus(input({ now: T0 + 2_000 }))?.text).toBe(
      "Cue is reading your message…",
    );
    expect(deriveLiveStatus(input({ now: T0 + 10_000 }))?.text).toBe(
      "Working on it…",
    );
    const at30 = deriveLiveStatus(input({ now: T0 + 30_000 }));
    expect(at30?.text).toBe("Still working…");
    expect(at30?.detail).toBe("30s");
    const at70 = deriveLiveStatus(input({ now: T0 + 70_000 }));
    expect(at70?.text).toBe("Still working — big step in progress");
    expect(at70?.detail).toBe("1m 10s");
  });

  // --- running tools -------------------------------------------------------

  test("running web_search → humanized copy, elapsed suffix only after 8s", () => {
    const tool = { toolUseId: "t1", toolName: "web_search", startedAt: T0 };
    const early = deriveLiveStatus(
      input({ runningTools: [tool], now: T0 + 2_000 }),
    );
    expect(early?.text).toBe("Searching the web…");
    expect(early?.detail).toBeUndefined();
    const late = deriveLiveStatus(
      input({ runningTools: [tool], now: T0 + 12_000 }),
    );
    expect(late?.detail).toBe("12s");
  });

  test("running bash → title + command info", () => {
    const view = deriveLiveStatus(
      input({
        runningTools: [
          {
            toolUseId: "t1",
            toolName: "bash",
            input: { command: "npm run build" },
            startedAt: T0,
          },
        ],
      }),
    );
    expect(view?.text).toBe("Working · npm run build…");
  });

  test("daemon activity sentence on the tool input wins over title/info", () => {
    const view = deriveLiveStatus(
      input({
        runningTools: [
          {
            toolUseId: "t1",
            toolName: "str_replace_editor",
            input: {
              command: "create",
              path: "/a/NOW.md",
              activity: "Updating NOW.md",
            },
            startedAt: T0,
          },
        ],
      }),
    );
    expect(view?.text).toBe("Updating NOW.md…");
  });

  test("most recently started tool wins", () => {
    const view = deriveLiveStatus(
      input({
        runningTools: [
          { toolUseId: "t1", toolName: "bash", startedAt: T0 },
          { toolUseId: "t2", toolName: "web_fetch", startedAt: T0 + 500 },
        ],
      }),
    );
    expect(view?.text).toBe("Reading a web page…");
  });

  // --- thinking preview ----------------------------------------------------

  test("thinking preview shows with brain glyph, whitespace collapsed + capped", () => {
    const view = deriveLiveStatus(
      input({
        thinkingTail: "The user wants\n two things:  " + "x".repeat(200),
        thinkingAt: T0 + 900,
      }),
    );
    expect(view?.brain).toBe(true);
    expect(view?.text.startsWith("The user wants two things: ")).toBe(true);
    expect(view?.text.length).toBeLessThanOrEqual(80);
  });

  test("while streaming, stale thinking loses to Writing…, fresh thinking wins", () => {
    const stale = deriveLiveStatus(
      input({
        phase: "streaming",
        thinkingTail: "old reasoning",
        thinkingAt: T0,
        now: T0 + 10_000,
      }),
    );
    expect(stale?.text).toBe("Writing…");
    const fresh = deriveLiveStatus(
      input({
        phase: "streaming",
        thinkingTail: "new reasoning",
        thinkingAt: T0 + 9_500,
        now: T0 + 10_000,
      }),
    );
    expect(fresh?.text).toBe("new reasoning");
  });

  // --- daemon statusText -----------------------------------------------------

  test("daemon statusText shows when no tool/preview signal", () => {
    const view = deriveLiveStatus(
      input({ statusText: "Processing bash results" }),
    );
    expect(view?.text).toBe("Processing bash results…");
  });

  // --- queued continuation ----------------------------------------------------

  test("queued phase → queue copy", () => {
    expect(
      deriveLiveStatus(input({ phase: "queued", pendingQueuedCount: 1 }))?.text,
    ).toBe("Picking up your queued message…");
    expect(
      deriveLiveStatus(input({ phase: "queued", pendingQueuedCount: 0 }))?.text,
    ).toBe("Finishing up…");
  });

  // --- SSE disconnect ---------------------------------------------------------

  test("stream down while active → Reconnecting…, beating every other rung", () => {
    // The dropped stream wins over long-elapsed fallback copy ("Still
    // working…" must never claim progress the client cannot observe)…
    const stale = deriveLiveStatus(
      input({ now: T0 + 70_000, sseConnected: false }),
    );
    expect(stale?.text).toBe("Reconnecting…");
    // …over running tools and daemon statusText…
    const tool = deriveLiveStatus(
      input({
        runningTools: [
          { toolUseId: "t1", toolName: "web_search", startedAt: T0 },
        ],
        statusText: "Processing bash results",
        sseConnected: false,
      }),
    );
    expect(tool?.text).toBe("Reconnecting…");
    // …and shows for fallback-active (external/restored) turns too.
    const fallback = deriveLiveStatus(
      input({ phase: "idle", fallbackActive: true, sseConnected: false }),
    );
    expect(fallback?.text).toBe("Reconnecting…");
  });

  test("stream down while idle → still hidden", () => {
    expect(
      deriveLiveStatus(input({ phase: "idle", sseConnected: false })),
    ).toBeNull();
  });

  test("sseConnected omitted defaults to connected behaviour", () => {
    expect(deriveLiveStatus(input({ now: T0 + 2_000 }))?.text).toBe(
      "Cue is reading your message…",
    );
  });
});
