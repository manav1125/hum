import { beforeEach, describe, expect, test } from "bun:test";

import {
  EMPTY_LIVE_STATUS,
  useLiveStatusStore,
  type ConversationLiveStatus,
} from "@/domains/chat/live-status-store";
import {
  deriveLiveStatus,
  formatTokens,
  formatTurnMeta,
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

  test("fresh thinking shows CALM derived copy with brain glyph — never the raw tail", () => {
    const view = deriveLiveStatus(
      input({
        thinkingTail: "The user wants\n two things:  " + "x".repeat(200),
        thinkingAt: T0 + 900,
      }),
    );
    expect(view?.brain).toBe(true);
    expect(view?.text).toBe("Thinking it through…");
    expect(view?.text).not.toContain("The user wants");
  });

  test("error-ish thinking maps to the honest snag tier, still never verbatim", () => {
    const view = deriveLiveStatus(
      input({
        thinkingTail:
          "Bash tool is erroring — same recurring issue with the sandbox",
        thinkingAt: T0 + 900,
      }),
    );
    expect(view?.text).toBe("Hit a snag — working through it…");
    expect(view?.text).not.toContain("Bash");
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
    expect(fresh?.text).toBe("Thinking it through…");
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

// ---------------------------------------------------------------------------
// State machine — the single most important word. The user's core complaint
// was being unable to tell "Cue is working" from "Cue is waiting on ME" from
// "Cue looks hung". Each maps to a distinct `state` the UI colours/animates
// differently; these assert the mapping, not the styling.
// ---------------------------------------------------------------------------

describe("deriveLiveStatus — state word", () => {
  test("a running tool is Working", () => {
    const view = deriveLiveStatus(
      input({
        runningTools: [
          { toolUseId: "t1", toolName: "web_search", startedAt: T0 },
        ],
      }),
    );
    expect(view?.state).toBe("working");
    expect(view?.label).toBe("Working");
    // The action is carried separately from the state word so the desktop
    // line can render "Working · Searching the web…".
    expect(view?.activity).toBe("Searching the web…");
  });

  test("a pending question/approval is Waiting on you — NOT working", () => {
    const view = deriveLiveStatus(input({ phase: "awaiting_user_input" }));
    expect(view?.state).toBe("waiting");
    expect(view?.label).toBe("Waiting on you");
    // Waiting must be visually un-animated: no brain glyph, and the state is
    // explicitly not "working" so the component drops the typing-dot wave.
    expect(view?.state).not.toBe("working");
    expect(view?.brain).toBeUndefined();
  });

  test("fresh reasoning is Thinking", () => {
    const view = deriveLiveStatus(
      input({ thinkingTail: "weighing the options", thinkingAt: T0 + 900 }),
    );
    expect(view?.state).toBe("thinking");
    expect(view?.label).toBe("Thinking");
    // Calm thinking adds no action beyond the word; a snag does.
    expect(view?.activity).toBeNull();
    const snag = deriveLiveStatus(
      input({ thinkingTail: "the bash tool keeps erroring", thinkingAt: T0 + 900 }),
    );
    expect(snag?.state).toBe("thinking");
    expect(snag?.activity).toBe("working through a snag");
  });

  test("a dropped stream is Blocked (Reconnecting) — never a stale Working", () => {
    const view = deriveLiveStatus(
      input({ now: T0 + 70_000, sseConnected: false }),
    );
    expect(view?.state).toBe("blocked");
    expect(view?.label).toBe("Reconnecting");
  });

  test("the elapsed-fallback ladder stays Working (honest, not hung)", () => {
    const at70 = deriveLiveStatus(input({ now: T0 + 70_000 }));
    expect(at70?.state).toBe("working");
    expect(at70?.label).toBe("Working");
    expect(at70?.text).toBe("Still working — big step in progress");
    expect(at70?.detail).toBe("1m 10s");
  });

  test("streaming and daemon-activity rungs are Working with an action", () => {
    const writing = deriveLiveStatus(input({ phase: "streaming" }));
    expect(writing?.state).toBe("working");
    expect(writing?.activity).toBe("writing the reply");
    const daemon = deriveLiveStatus(
      input({ statusText: "Processing bash results" }),
    );
    expect(daemon?.state).toBe("working");
    expect(daemon?.activity).toBe("Processing bash results");
  });
});

// ---------------------------------------------------------------------------
// Token / step burn-down — the quiet secondary "effort" signal.
// ---------------------------------------------------------------------------

describe("token + step meta", () => {
  test("formatTokens is compact and honest", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(820)).toBe("820");
    expect(formatTokens(8_234)).toBe("8.2k");
    expect(formatTokens(42_000)).toBe("42k");
    expect(formatTokens(1_300_000)).toBe("1.3M");
  });

  test("formatTurnMeta shows nothing until there is effort to report", () => {
    expect(formatTurnMeta(0, 0)).toBeNull();
    expect(formatTurnMeta(1, 0)).toBe("1 step");
    expect(formatTurnMeta(3, 0)).toBe("3 steps");
    expect(formatTurnMeta(3, 8_234)).toBe("3 steps · 8.2k tokens");
    expect(formatTurnMeta(0, 500)).toBe("500 tokens");
  });
});

// ---------------------------------------------------------------------------
// Per-conversation store scoping — the cross-conversation leak regression.
// The status line reads exactly one conversation's slice (the viewed one),
// so signal written under any other conversation id must never surface.
// ---------------------------------------------------------------------------

/** Mirror of `useLiveStatusForConversation`'s selector, callable outside
 *  React: the slice the LiveTurnStatus component would render for
 *  `conversationId`. */
function sliceFor(conversationId: string): ConversationLiveStatus {
  return (
    useLiveStatusStore.getState().byConversation[conversationId] ??
    EMPTY_LIVE_STATUS
  );
}

/** Derive the status-line view exactly as the component does when viewing
 *  `conversationId` with an active thinking-phase turn. */
function viewWhileViewing(conversationId: string) {
  const slice = sliceFor(conversationId);
  return deriveLiveStatus(
    input({
      thinkingTail: slice.thinkingTail,
      thinkingAt: slice.thinkingAt,
      runningTools: slice.runningTools,
      turnStartedAt: slice.turnStartedAt ?? T0,
    }),
  );
}

describe("live-status store conversation scoping", () => {
  beforeEach(() => {
    useLiveStatusStore.getState().resetAll();
  });

  test("a thinking delta for conversation B does NOT surface while viewing A", () => {
    const live = useLiveStatusStore.getState();
    live.noteTurnStart("conv-a");
    // Concurrent background turn in B streams its reasoning.
    live.noteThinkingDelta("conv-b", "Projecting Q3 revenue for the model");

    // Viewing A: no thinking preview leaks — the line falls back to the
    // elapsed ladder copy instead of B's reasoning.
    expect(sliceFor("conv-a").thinkingTail).toBe("");
    const view = viewWhileViewing("conv-a");
    expect(view?.text).not.toContain("Projecting Q3 revenue");
    expect(view?.brain).toBeUndefined();

    // B's own slice carries the preview for whoever views B.
    expect(sliceFor("conv-b").thinkingTail).toBe(
      "Projecting Q3 revenue for the model",
    );
  });

  test("thinking deltas for the viewed conversation DO surface (as calm derived copy)", () => {
    const live = useLiveStatusStore.getState();
    live.noteTurnStart("conv-a");
    live.noteThinkingDelta("conv-a", "The user wants a new personality");
    live.noteThinkingDelta("conv-b", "unrelated background reasoning");

    const view = viewWhileViewing("conv-a");
    // The raw tail never surfaces verbatim — the viewed conversation's fresh
    // thinking signal maps to the calm derived tier.
    expect(view?.text).toBe("Thinking it through…");
    expect(view?.brain).toBe(true);
    expect(sliceFor("conv-a").thinkingTail).not.toContain("unrelated");
  });

  test("running tools are scoped per conversation", () => {
    const live = useLiveStatusStore.getState();
    live.noteToolStart("conv-b", { toolUseId: "t1", toolName: "web_search" });

    expect(sliceFor("conv-a").runningTools).toHaveLength(0);
    expect(viewWhileViewing("conv-a")?.text).not.toBe("Searching the web…");
    expect(viewWhileViewing("conv-b")?.text).toBe("Searching the web…");

    live.noteToolEnd("conv-b", "t1");
    expect(sliceFor("conv-b").runningTools).toHaveLength(0);
  });

  test("tool ends only pop the named conversation's run", () => {
    const live = useLiveStatusStore.getState();
    live.noteToolStart("conv-a", { toolUseId: "t1", toolName: "bash" });
    live.noteToolStart("conv-b", { toolUseId: "t1", toolName: "web_fetch" });

    // Same toolUseId, different conversation — A's run must survive.
    live.noteToolEnd("conv-b", "t1");
    expect(sliceFor("conv-a").runningTools).toHaveLength(1);
    expect(sliceFor("conv-b").runningTools).toHaveLength(0);
  });

  test("turn-boundary clearing is per-conversation", () => {
    const live = useLiveStatusStore.getState();
    live.noteThinkingDelta("conv-a", "A reasoning");
    live.noteThinkingDelta("conv-b", "B reasoning");

    // A's turn ends — only A's slice is dropped.
    live.reset("conv-a");
    expect(sliceFor("conv-a")).toBe(EMPTY_LIVE_STATUS);
    expect(sliceFor("conv-b").thinkingTail).toBe("B reasoning");

    // A queued-continuation boundary in B re-stamps B without touching
    // any other conversation.
    live.noteThinkingDelta("conv-a", "A again");
    live.noteTurnBoundary("conv-b");
    expect(sliceFor("conv-b").thinkingTail).toBe("");
    expect(sliceFor("conv-b").turnStartedAt).not.toBeNull();
    expect(sliceFor("conv-a").thinkingTail).toBe("A again");
  });

  test("clearThinking (generation handoff) only clears its conversation", () => {
    const live = useLiveStatusStore.getState();
    live.noteThinkingDelta("conv-a", "A reasoning");
    live.noteThinkingDelta("conv-b", "B reasoning");
    live.clearThinking("conv-b");
    expect(sliceFor("conv-a").thinkingTail).toBe("A reasoning");
    expect(sliceFor("conv-b").thinkingTail).toBe("");
  });

  test("tracked-conversation map stays bounded (oldest evicted)", () => {
    const live = useLiveStatusStore.getState();
    for (let i = 0; i < 12; i++) {
      live.noteThinkingDelta(`conv-${i}`, "x");
    }
    const keys = Object.keys(useLiveStatusStore.getState().byConversation);
    expect(keys.length).toBeLessThanOrEqual(8);
    expect(keys).not.toContain("conv-0");
    expect(keys).toContain("conv-11");
  });
});
