/**
 * Zustand store for the live turn-status affordance.
 *
 * Captures the transient, per-turn signal the SSE stream carries but the
 * turn reducer intentionally doesn't hold: the wall-clock moment the turn
 * became active, a rolling preview of the current thinking block, and the
 * set of currently-running tool calls (with names + start times). The
 * `LiveTurnStatus` component projects this into the "show our work" status
 * line pinned next to the assistant avatar while a turn is in flight.
 *
 * Writers:
 *   - a module-scope `useTurnStore.subscribe` below stamps turn start /
 *     turn boundary / reset transitions so every activation path (composer
 *     send, queued continuation, external-channel turn, reconnect) is
 *     covered without touching each call site;
 *   - `handleAssistantThinkingDelta` appends thinking chunks;
 *   - `handleGenerationHandoff` clears the thinking buffer between LLM
 *     calls inside one turn;
 *   - `handleToolUseStart` / `handleToolResult` push/pop running tools.
 *
 * All timestamps are stamped inside actions at event time — never during
 * render (see the repo rule: no `Date.now()` in render).
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveToolRun {
  toolUseId: string;
  toolName: string;
  /** Raw tool input — forwarded to `deriveStepLabelFromName` for labels. */
  input?: Record<string, unknown>;
  startedAt: number;
}

export interface LiveStatusState {
  /** Wall-clock ms when the current turn became active. Null when idle. */
  turnStartedAt: number | null;
  /** Accumulated text of the CURRENT thinking block (capped — the status
   *  line only previews the first ~80 chars). Cleared on tool start,
   *  generation handoff, and turn boundaries so it always reflects the
   *  latest block rather than stale reasoning from a previous phase. */
  thinkingTail: string;
  /** Wall-clock ms of the most recent thinking delta. Lets the status line
   *  prefer a fresh thinking preview over the generic streaming copy. */
  thinkingAt: number | null;
  /** Currently-running tool calls, oldest first. */
  runningTools: LiveToolRun[];
}

/** Stop growing the buffer once the preview window is comfortably covered. */
const THINKING_TAIL_CAP = 400;

const INITIAL_STATE: LiveStatusState = {
  turnStartedAt: null,
  thinkingTail: "",
  thinkingAt: null,
  runningTools: [],
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface LiveStatusActions {
  /** A turn became active — stamp the start time and drop any transient
   *  signal left over from a previous turn. Idempotent per activation:
   *  callers guard on the inactive→active transition. */
  noteTurnStart: () => void;
  /** A turn finished but the queue keeps the phase active ("queued" →
   *  next turn). Re-stamps the start time and clears transient signal so
   *  the continuation reads as a fresh turn. */
  noteTurnBoundary: () => void;
  /** Append a streaming thinking chunk to the current block's buffer. */
  noteThinkingDelta: (chunk: string) => void;
  /** Clear the thinking buffer (new LLM call / new phase of work). */
  clearThinking: () => void;
  noteToolStart: (run: {
    toolUseId: string;
    toolName: string;
    input?: Record<string, unknown>;
  }) => void;
  noteToolEnd: (toolUseId: string | undefined) => void;
  reset: () => void;
}

export type LiveStatusStore = LiveStatusState & LiveStatusActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useLiveStatusStoreBase = create<LiveStatusStore>()((set, get) => ({
  ...INITIAL_STATE,

  noteTurnStart: () =>
    set({
      turnStartedAt: Date.now(),
      thinkingTail: "",
      thinkingAt: null,
      runningTools: [],
    }),

  noteTurnBoundary: () =>
    set({
      turnStartedAt: Date.now(),
      thinkingTail: "",
      thinkingAt: null,
      runningTools: [],
    }),

  noteThinkingDelta: (chunk) => {
    const s = get();
    const tail =
      s.thinkingTail.length >= THINKING_TAIL_CAP
        ? s.thinkingTail
        : (s.thinkingTail + chunk).slice(0, THINKING_TAIL_CAP);
    set({ thinkingTail: tail, thinkingAt: Date.now() });
  },

  clearThinking: () => set({ thinkingTail: "", thinkingAt: null }),

  noteToolStart: ({ toolUseId, toolName, input }) => {
    const s = get();
    set({
      runningTools: [
        ...s.runningTools.filter((t) => t.toolUseId !== toolUseId),
        { toolUseId, toolName, input, startedAt: Date.now() },
      ],
      // A tool starting marks a new phase of work — the previous thinking
      // block is done, so the next thinking preview starts fresh.
      thinkingTail: "",
      thinkingAt: null,
    });
  },

  noteToolEnd: (toolUseId) => {
    if (!toolUseId) return;
    const s = get();
    if (!s.runningTools.some((t) => t.toolUseId === toolUseId)) return;
    set({
      runningTools: s.runningTools.filter((t) => t.toolUseId !== toolUseId),
    });
  },

  reset: () => set({ ...INITIAL_STATE }),
}));

export const useLiveStatusStore = createSelectors(useLiveStatusStoreBase);

// ---------------------------------------------------------------------------
// Turn lifecycle wiring
// ---------------------------------------------------------------------------

/**
 * Mirror turn-store lifecycle transitions into this store. A single
 * module-scope subscription covers every activation/termination path
 * (composer send, surface-action send, queued continuation, SSE-driven
 * external turns, cancel/error/timeout/reset, conversation switches) so no
 * send-path call site needs editing.
 */
useTurnStore.subscribe((state, prev) => {
  const wasActive = isSending(prev.phase);
  const nowActive = isSending(state.phase);
  const live = useLiveStatusStore.getState();
  if (!wasActive && nowActive) {
    live.noteTurnStart();
    return;
  }
  if (wasActive && !nowActive) {
    live.reset();
    return;
  }
  // Turn completed but the phase stayed active because queued messages
  // remain ("queued" continuation) — treat as a fresh turn boundary.
  if (nowActive && prev.activeTurnId !== null && state.activeTurnId === null) {
    live.noteTurnBoundary();
  }
});
