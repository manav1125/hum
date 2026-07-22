/**
 * Zustand store for the live turn-status affordance — keyed PER
 * CONVERSATION.
 *
 * Captures the transient, per-turn signal the SSE stream carries but the
 * turn reducer intentionally doesn't hold: the wall-clock moment the turn
 * became active, a rolling preview of the current thinking block, and the
 * set of currently-running tool calls (with names + start times). The
 * `LiveTurnStatus` component projects this into the "show our work" status
 * line pinned next to the assistant avatar while a turn is in flight.
 *
 * Scoping: all signal is stored under the conversation id the originating
 * SSE event belongs to (`byConversation`), and readers select a single
 * conversation's slice. A single global buffer let ANY conversation's
 * thinking/tool deltas surface in whichever transcript was on screen —
 * e.g. a background conversation's reasoning previewing inside an
 * unrelated chat — which was both confusing and a cross-thread privacy
 * leak. Writers must therefore always attribute signal to the event's own
 * conversation id (falling back to the stream anchor), never to "whatever
 * is currently rendered".
 *
 * Writers:
 *   - a module-scope `useTurnStore.subscribe` below stamps turn start /
 *     turn boundary / reset transitions for the ACTIVE conversation (the
 *     turn reducer only ever tracks the active conversation's turn) so
 *     every activation path (composer send, queued continuation,
 *     external-channel turn, reconnect) is covered without touching each
 *     call site;
 *   - `handleAssistantThinkingDelta` appends thinking chunks under the
 *     event's conversation;
 *   - `handleGenerationHandoff` clears that conversation's thinking buffer
 *     between LLM calls inside one turn;
 *   - `handleToolUseStart` / `handleToolResult` push/pop running tools
 *     under the event's conversation;
 *   - the terminal stream handlers (`message_complete`,
 *     `generation_cancelled`, `turn_interrupted`, `assistant_activity_state`
 *     idle) drop the finished conversation's slice, so turn-boundary
 *     clearing is itself per-conversation.
 *
 * All timestamps are stamped inside actions at event time — never during
 * render (see the repo rule: no `Date.now()` in render).
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";

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

/**
 * One entry in the turn's step history — every tool call the turn has
 * started, whether still running or already finished. Drives the mobile
 * live-activity block's step counter + "latest steps" mini-stream, which
 * needs finished steps too (the `runningTools` list drops them the moment
 * their result lands, which on fast tools means the UI never sees them).
 */
export interface LiveStep {
  toolUseId: string;
  toolName: string;
  input?: Record<string, unknown>;
  startedAt: number;
  /** Null while the tool is still running. */
  endedAt: number | null;
}

/** Bound on the retained step history per conversation. The mini-stream
 *  shows only the latest few; older entries only feed the counter, which
 *  is tracked separately in `stepCount` so eviction never skews it. */
const MAX_STEPS = 12;

/** Per-conversation transient turn signal. */
export interface ConversationLiveStatus {
  /** Wall-clock ms when this conversation's turn became active. Null when
   *  the turn started before this slice existed (e.g. a restored/external
   *  turn — the viewer stamps it on first sight). */
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
  /** Step history for the current turn (running + finished), oldest first,
   *  capped at {@link MAX_STEPS}. */
  steps: LiveStep[];
  /** Total tool calls started this turn — survives step-history eviction. */
  stepCount: number;
  /** Cumulative tokens (input + output) reported by `usage_progress` events
   *  across every LLM call this turn — the quiet "burn-down" counter shown
   *  next to the elapsed clock. A UI-only effort signal (not billing), reset
   *  to 0 at every turn start / boundary. */
  turnTokens: number;
  /** Wall-clock ms of the most recent live signal for this conversation
   *  (thinking delta, tool start/end, usage progress). Null until the first
   *  signal. The mobile watchdog uses this to detect a genuinely silent
   *  stall. */
  lastEventAt: number | null;
}

export interface LiveStatusState {
  /** Live signal keyed by conversation id. Absent key ⇒ no signal — read
   *  through `useLiveStatusForConversation` / `EMPTY_LIVE_STATUS`. */
  byConversation: Record<string, ConversationLiveStatus>;
}

/** Stop growing the buffer once the preview window is comfortably covered. */
const THINKING_TAIL_CAP = 400;

/** Bound on tracked conversations — the viewer only ever reads one slice,
 *  so a small LRU-ish window (evict oldest-inserted) keeps leaked or
 *  never-terminated background turns from growing the map unbounded. */
const MAX_TRACKED_CONVERSATIONS = 8;

export const EMPTY_LIVE_STATUS: ConversationLiveStatus = {
  turnStartedAt: null,
  thinkingTail: "",
  thinkingAt: null,
  runningTools: [],
  steps: [],
  stepCount: 0,
  turnTokens: 0,
  lastEventAt: null,
};

const INITIAL_STATE: LiveStatusState = {
  byConversation: {},
};

/**
 * Return `by` with `conversationId`'s slice replaced by `next`, evicting
 * the oldest-inserted conversation when a NEW key would exceed the cap.
 * (String-keyed object insertion order is spec-guaranteed, so `keys[0]`
 * is the least recently created slice.)
 */
function withSlice(
  by: Record<string, ConversationLiveStatus>,
  conversationId: string,
  next: ConversationLiveStatus,
): Record<string, ConversationLiveStatus> {
  if (!(conversationId in by)) {
    const keys = Object.keys(by);
    if (keys.length >= MAX_TRACKED_CONVERSATIONS) {
      const { [keys[0]!]: _evicted, ...rest } = by;
      return { ...rest, [conversationId]: next };
    }
  }
  return { ...by, [conversationId]: next };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface LiveStatusActions {
  /** A turn became active in `conversationId` — stamp the start time and
   *  drop any transient signal left over from a previous turn. Idempotent
   *  per activation: callers guard on the inactive→active transition. */
  noteTurnStart: (conversationId: string) => void;
  /** A turn finished but the queue keeps the phase active ("queued" →
   *  next turn). Re-stamps the start time and clears transient signal so
   *  the continuation reads as a fresh turn. */
  noteTurnBoundary: (conversationId: string) => void;
  /** Append a streaming thinking chunk to the conversation's current
   *  block buffer. */
  noteThinkingDelta: (conversationId: string, chunk: string) => void;
  /** Clear the conversation's thinking buffer (new LLM call / new phase
   *  of work). */
  clearThinking: (conversationId: string) => void;
  noteToolStart: (
    conversationId: string,
    run: {
      toolUseId: string;
      toolName: string;
      input?: Record<string, unknown>;
    },
  ) => void;
  noteToolEnd: (conversationId: string, toolUseId: string | undefined) => void;
  /** Accumulate a per-call token delta (`usage_progress`) into this turn's
   *  running burn-down counter. Cheap and additive; a UI-only effort signal. */
  noteUsageProgress: (
    conversationId: string,
    delta: { inputTokens: number; outputTokens: number },
  ) => void;
  /** Drop one conversation's slice (its turn reached a terminal state). */
  reset: (conversationId: string) => void;
  /** Drop everything (tests / hard teardown). */
  resetAll: () => void;
}

export type LiveStatusStore = LiveStatusState & LiveStatusActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLiveStatusStore = create<LiveStatusStore>()((set, get) => ({
  ...INITIAL_STATE,

  noteTurnStart: (conversationId) =>
    set((s) => ({
      byConversation: withSlice(s.byConversation, conversationId, {
        ...EMPTY_LIVE_STATUS,
        turnStartedAt: Date.now(),
      }),
    })),

  noteTurnBoundary: (conversationId) =>
    set((s) => ({
      byConversation: withSlice(s.byConversation, conversationId, {
        ...EMPTY_LIVE_STATUS,
        turnStartedAt: Date.now(),
      }),
    })),

  noteThinkingDelta: (conversationId, chunk) => {
    const cur = get().byConversation[conversationId] ?? EMPTY_LIVE_STATUS;
    const tail =
      cur.thinkingTail.length >= THINKING_TAIL_CAP
        ? cur.thinkingTail
        : (cur.thinkingTail + chunk).slice(0, THINKING_TAIL_CAP);
    const now = Date.now();
    set((s) => ({
      byConversation: withSlice(s.byConversation, conversationId, {
        ...cur,
        thinkingTail: tail,
        thinkingAt: now,
        lastEventAt: now,
      }),
    }));
  },

  clearThinking: (conversationId) => {
    const cur = get().byConversation[conversationId];
    if (!cur) return;
    set((s) => ({
      byConversation: withSlice(s.byConversation, conversationId, {
        ...cur,
        thinkingTail: "",
        thinkingAt: null,
      }),
    }));
  },

  noteToolStart: (conversationId, { toolUseId, toolName, input }) => {
    const cur = get().byConversation[conversationId] ?? EMPTY_LIVE_STATUS;
    const now = Date.now();
    // Restarted tool-use id (shouldn't happen, but the runningTools filter
    // guards it) — replace the step entry rather than double-counting.
    const priorSteps = cur.steps.filter((step) => step.toolUseId !== toolUseId);
    const replaced = priorSteps.length !== cur.steps.length;
    set((s) => ({
      byConversation: withSlice(s.byConversation, conversationId, {
        ...cur,
        runningTools: [
          ...cur.runningTools.filter((t) => t.toolUseId !== toolUseId),
          { toolUseId, toolName, input, startedAt: now },
        ],
        steps: [
          ...priorSteps.slice(-(MAX_STEPS - 1)),
          { toolUseId, toolName, input, startedAt: now, endedAt: null },
        ],
        stepCount: replaced ? cur.stepCount : cur.stepCount + 1,
        lastEventAt: now,
        // A tool starting marks a new phase of work — the previous thinking
        // block is done, so the next thinking preview starts fresh.
        thinkingTail: "",
        thinkingAt: null,
      }),
    }));
  },

  noteToolEnd: (conversationId, toolUseId) => {
    if (!toolUseId) return;
    const cur = get().byConversation[conversationId];
    if (!cur) return;
    const isRunning = cur.runningTools.some((t) => t.toolUseId === toolUseId);
    const hasStep = cur.steps.some(
      (step) => step.toolUseId === toolUseId && step.endedAt === null,
    );
    if (!isRunning && !hasStep) return;
    const now = Date.now();
    set((s) => ({
      byConversation: withSlice(s.byConversation, conversationId, {
        ...cur,
        runningTools: cur.runningTools.filter((t) => t.toolUseId !== toolUseId),
        steps: cur.steps.map((step) =>
          step.toolUseId === toolUseId && step.endedAt === null
            ? { ...step, endedAt: now }
            : step,
        ),
        lastEventAt: now,
      }),
    }));
  },

  noteUsageProgress: (conversationId, { inputTokens, outputTokens }) => {
    const cur = get().byConversation[conversationId] ?? EMPTY_LIVE_STATUS;
    const added = Math.max(0, inputTokens) + Math.max(0, outputTokens);
    if (added === 0) return;
    const now = Date.now();
    set((s) => ({
      byConversation: withSlice(s.byConversation, conversationId, {
        ...cur,
        turnTokens: cur.turnTokens + added,
        lastEventAt: now,
      }),
    }));
  },

  reset: (conversationId) => {
    if (!(conversationId in get().byConversation)) return;
    set((s) => {
      const { [conversationId]: _dropped, ...rest } = s.byConversation;
      return { byConversation: rest };
    });
  },

  resetAll: () => set({ byConversation: {} }),
}));

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Select one conversation's live slice — the ONLY way the status line
 * should read this store, so a background conversation's signal can never
 * bleed into the transcript being viewed. Returns the stable
 * `EMPTY_LIVE_STATUS` when the conversation has no signal (or no
 * conversation is provided), keeping referential equality for bail-outs.
 */
export function useLiveStatusForConversation(
  conversationId: string | null | undefined,
): ConversationLiveStatus {
  return useLiveStatusStore(
    (s) =>
      (conversationId ? s.byConversation[conversationId] : undefined) ??
      EMPTY_LIVE_STATUS,
  );
}

// ---------------------------------------------------------------------------
// Turn lifecycle wiring
// ---------------------------------------------------------------------------

/**
 * Mirror turn-store lifecycle transitions into this store. A single
 * module-scope subscription covers every activation/termination path
 * (composer send, surface-action send, queued continuation, SSE-driven
 * external turns, cancel/error/timeout/reset, conversation switches) so no
 * send-path call site needs editing.
 *
 * The turn reducer only ever tracks the ACTIVE conversation's turn (its
 * events are filtered upstream), so transitions are attributed to the
 * conversation-store's `activeConversationId` at transition time.
 */
useTurnStore.subscribe((state, prev) => {
  const wasActive = isSending(prev.phase);
  const nowActive = isSending(state.phase);
  const conversationId = useConversationStore.getState().activeConversationId;
  if (!conversationId) return;
  const live = useLiveStatusStore.getState();
  if (!wasActive && nowActive) {
    live.noteTurnStart(conversationId);
    return;
  }
  if (wasActive && !nowActive) {
    live.reset(conversationId);
    return;
  }
  // Turn completed but the phase stayed active because queued messages
  // remain ("queued" continuation) — treat as a fresh turn boundary.
  if (nowActive && prev.activeTurnId !== null && state.activeTurnId === null) {
    live.noteTurnBoundary(conversationId);
  }
});
