/**
 * Zustand store holding the observable state of a single live-voice session.
 *
 * Web-app counterpart to the `@Observable` fields on the macOS
 * `LiveVoiceChannelManager` (`clients/macos/.../LiveVoiceChannelManager.swift`).
 * The {@link useLiveVoice} controller owns the session lifecycle and writes here
 * through the actions; UI subscribes via per-field selectors so it only
 * re-renders on the fields it reads.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * **Primary API** — per-field selectors:
 * ```ts
 * const state = useLiveVoiceStore.use.state();
 * ```
 *
 * **Non-React code** — use `.getState()` in callbacks, effects, handlers:
 * ```ts
 * const { state } = useLiveVoiceStore.getState();
 * ```
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import type {
  LiveVoiceApprovalPendingServerFrame,
  LiveVoiceCardServerFrame,
} from "@/domains/chat/voice/live-voice/protocol";
import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Phase of the live-voice session. Mirrors the macOS
 * `LiveVoiceChannelManager.State` enum 1:1.
 *
 * - `idle` — no session (or a finished one cleaned up).
 * - `connecting` — minting a token / opening the socket, before `ready`.
 * - `listening` — mic is capturing and streaming PCM to the server.
 * - `transcribing` — push-to-talk released; waiting on the final transcript.
 * - `thinking` — server is generating the assistant response.
 * - `speaking` — TTS audio is queued/playing.
 * - `ending` — graceful teardown in progress.
 * - `failed` — the session failed; `error` carries the message.
 */
export type LiveVoiceSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ending"
  | "failed";

/**
 * A visual result card surfaced during the current turn — the exact fields
 * `SurfaceRouter` needs, carried verbatim from a `card` server frame. Ordered
 * by first appearance and keyed by `surfaceId` (an `op:update` merges into the
 * same entry; a new turn replaces the stack — see {@link LiveVoiceActions.clearCards}).
 */
export interface LiveVoiceCard {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: LiveVoiceCardServerFrame["actions"];
  turnId?: string;
}

/**
 * The mid-call approval the session is currently featuring (design v37 §W2):
 * carried verbatim from an `approval_pending` frame. `null` when nothing is
 * waiting. Cleared by `approval_resolved`, by a local "Ask me after"
 * deferral (which sends NOTHING on the voice socket — the chat approval card
 * stays pending), and by session reset / turn cancellation.
 */
export interface LiveVoicePendingApproval {
  requestId: string;
  toolName: string;
  summary?: string;
  riskLevel?: string;
  /** The one line of trust language the card renders, from the wire. */
  trustLine?: string;
  turnId?: string;
}

/**
 * One finished spoken exchange of the CURRENT session, in the order it happened.
 *
 * Only surfaces with no conversation behind them need this. Inside a chat thread
 * the thread itself is the record — persisted voice turns carry the durable
 * `voiceTurn` marker and are drawn there — so drawing this list as well would
 * put every finished turn on screen twice, which is the bug 45104f5e2d fixed.
 * The full-screen voice surface covers the thread completely, so for it this
 * list IS the conversation, and no duplication is possible.
 */
export interface LiveVoiceTurn {
  /** Stable key for rendering; monotonic within a session. */
  id: number;
  /** What the user said (the finalized transcript). */
  user: string;
  /** What Cue answered. */
  assistant: string;
}

export interface LiveVoiceState {
  /** Current phase of the session lifecycle. */
  state: LiveVoiceSessionState;
  /**
   * Which server engine the active session negotiated. `"cascade"` runs the
   * turn through the normal agent loop, so the daemon broadcasts the persisted
   * user message and every assistant delta onto the conversation itself;
   * `"gemini-live"` is speech-native and only writes the turn to the thread
   * once it completes. Consumers that render inside a chat thread need this to
   * know whether the thread is already showing the exchange.
   */
  engine: "cascade" | "gemini-live";
  /** In-flight partial transcript of the user's current utterance. */
  partialTranscript: string;
  /** Last finalized user transcript. */
  finalTranscript: string;
  /** Accumulated assistant response text for the current turn. */
  assistantTranscript: string;
  /**
   * Whether the exchange currently held in `finalTranscript` /
   * `assistantTranscript` is FINISHED — the assistant stopped speaking and the
   * session re-armed for the next utterance.
   *
   * This is the per-turn boundary. Without it the only thing that ever reset
   * `assistantTranscript` was the server's `thinking` frame, which the cascade
   * sends and the realtime engine does not — so on the realtime engine every
   * reply was appended to the previous one and a new turn opened by repeating
   * the answer to the PREVIOUS question. The flag makes the boundary the
   * client's own, independent of any server frame: the next transcript or
   * delta that arrives opens a new turn and replaces, instead of appending.
   *
   * The text is deliberately kept on screen while closed — surfaces with no
   * conversation behind them (the /voice route) show the last exchange until
   * the next one starts.
   */
  turnClosed: boolean;
  /** Smoothed RMS mic amplitude in [0, 1] for UI / barge-in. */
  inputAmplitude: number;
  /**
   * The mic is delivering DEAD silence: capture is running and unmuted, yet no
   * amplitude sample has cleared a tiny epsilon for a sustained window. The
   * macOS/Chrome TCC failure mode — `getUserMedia` "succeeds" with no OS mic
   * permission and streams exact-zero samples, no prompt, no error — lands
   * exactly here, with the room sitting in "Listening" looking healthy but
   * deaf. Real rooms have a noise floor, so a live mic clears the epsilon
   * within the window. Informational and fail-open: surfaces caption it, the
   * call is never ended or altered. Cleared by any real sample, and reset with
   * the rest of the session state.
   */
  micSilent: boolean;
  /** Human-readable error message when `state === "failed"`, `null` otherwise. */
  error: string | null;
  /**
   * What kind of failure occurred, so the UI can distinguish a genuine mic /
   * permission problem (show the "enable microphone" recovery) from a session
   * failure like a provider/network error (show the actual message, not a
   * misleading mic prompt). `null` unless `state === "failed"`.
   */
  failureKind: "mic" | "session" | null;
  /**
   * Visual result cards for the current turn, ordered by first appearance.
   * Replaced each turn (cleared on `thinking`) so the orb reflects one live
   * exchange; the running history lives in the persisted chat thread.
   */
  cards: LiveVoiceCard[];
  /**
   * The exchanges this session has already finished, oldest first — appended by
   * {@link LiveVoiceActions.closeTurn}. See {@link LiveVoiceTurn} for who may
   * draw it (only surfaces that hide the thread).
   */
  turns: LiveVoiceTurn[];
  /**
   * Whether the active session is running hands-free (server-side VAD owns
   * utterance boundaries via `speech_started` / `utterance_end` frames)
   * rather than the client's own silence-detection auto-release. Set on
   * `ready` — a daemon that ignored the requested `server_vad` mode reverts
   * this to `false` and the session runs with full client-side VAD.
   */
  handsFree: boolean;
  /**
   * The REGISTERED NAME of the tool the open turn is executing right now, from
   * the daemon's `tool_activity` frame — or `null` when nothing is known.
   *
   * `null` is the normal, honest resting value, and it means exactly one thing:
   * the client has not been told. That happens on the realtime engine (whose
   * function calls never leave the provider session), against a daemon too old
   * to send the frame, and during every part of a turn that is not inside a
   * tool call. A surface must render the not-known case as a wait with no
   * claim in it — never as a guessed activity, because a caption that says
   * "checking the pricing model" while the turn is searching the web is a
   * fabricated status, and a fabricated status is worse than no status.
   *
   * Cleared whenever a new turn opens, so one turn's tool can never be shown
   * as the next turn's work.
   */
  activityTool: string | null;
  /**
   * Count of `minimize_room` frames received this session — the daemon asking
   * for the room to demote so the screen behind it is visible (a revealed
   * surface, v37 §W2). A counter rather than a boolean because the ladder
   * position itself belongs to presentation stores (`voice-call-store` on
   * desktop, the fullscreen flag on mobile): consumers watch the seq and
   * demote ON each increment, and the user promoting back afterwards is never
   * fought (user scroll wins — no auto-promotion).
   */
  roomMinimizeSeq: number;
  /** The mid-call approval currently featured, or `null`. */
  pendingApproval: LiveVoicePendingApproval | null;
  /**
   * Assistant the active session was started for, `null` when idle. What the
   * room's camera uploads photos against (`uploadChatAttachment` needs an
   * assistant id, and the room is a controller-less projection that must not
   * be handed one through props from three different owners).
   */
  sessionAssistantId: string | null;
  /**
   * Whether the session's `ready` frame advertised the `attach_image`
   * capability. The camera UI renders ONLY when this is true: an older
   * daemon answers the frame with a session-fatal `unknown_type`, so a
   * camera shown against one would lose the photo AND kill the call.
   */
  attachImageSupported: boolean;
  /**
   * Bumped each time the daemon refuses a photo the transport had already
   * accepted. A counter rather than a flag or a payload because the room's
   * only use is "another one just failed": consecutive rejections must each
   * register, and there is nothing about a rejection worth carrying beyond
   * the fact of it.
   */
  photoRejectedSeq: number;
  /** Why the last photo was refused, for the room's wording. */
  photoRejectedReason: "unsupported" | "failed" | null;
  /**
   * The active session's `attachImage` control, registered by the owning
   * controller (`useLiveVoice`) once the session is ready — or `null` when no
   * session can take a photo. Returns whether the frame actually went out
   * (false during a reconnect gap), which the camera must surface rather
   * than treat as sent. A store-registered delegate, like the voice-call
   * ladder's `controls`, because the room is a controller-less projection.
   */
  attachImage: ((attachmentId: string) => boolean) | null;
}

export interface LiveVoiceActions {
  /** Replace the session phase. */
  setState: (state: LiveVoiceSessionState) => void;
  /** Record which engine the active session negotiated. */
  setEngine: (engine: "cascade" | "gemini-live") => void;
  /** Record whether the session negotiated hands-free (server VAD) mode. */
  setHandsFree: (handsFree: boolean) => void;
  setPartialTranscript: (text: string) => void;
  setFinalTranscript: (text: string) => void;
  /** Append a delta to the accumulated assistant transcript. */
  appendAssistantTranscript: (delta: string) => void;
  /** Reset the assistant transcript ahead of a new response. */
  clearAssistantTranscript: () => void;
  /**
   * Mark the displayed exchange as finished (see {@link LiveVoiceState.turnClosed}).
   * Called when the session re-arms for the next utterance. A closed exchange
   * that actually said something is also pushed onto {@link LiveVoiceState.turns}.
   */
  closeTurn: () => void;
  setInputAmplitude: (amplitude: number) => void;
  /** Record whether the mic is delivering dead silence (see {@link LiveVoiceState.micSilent}). */
  setMicSilent: (micSilent: boolean) => void;
  /** Transition to `failed` with a message and a failure kind (default `session`). */
  fail: (message: string, kind?: "mic" | "session") => void;
  /** Upsert a card by `surfaceId` (appends when new, replaces the entry when seen). */
  showCard: (frame: LiveVoiceCardServerFrame) => void;
  /** Merge `data` into an existing card by `surfaceId`; no-op if unknown. */
  updateCard: (frame: LiveVoiceCardServerFrame) => void;
  /** Remove a card by `surfaceId`. */
  dismissCard: (surfaceId: string) => void;
  /** Drop every card (called at the start of each new turn and on reset). */
  clearCards: () => void;
  /**
   * Record the tool the open turn has started executing (raw registered name),
   * or `null` to go back to "not known".
   */
  setActivityTool: (toolName: string | null) => void;
  /** A `minimize_room` frame arrived: bump the seq so ladder owners demote. */
  requestRoomMinimize: () => void;
  /** An `approval_pending` frame arrived: feature this approval. */
  setPendingApproval: (frame: LiveVoiceApprovalPendingServerFrame) => void;
  /**
   * Stop featuring the approval. With a `requestId` (an `approval_resolved`
   * frame) it clears only a matching approval; without one (local "Ask me
   * after" deferral, turn cancellation) it clears whatever is featured.
   */
  clearPendingApproval: (requestId?: string) => void;
  /** Record which assistant the active session serves (cleared by reset). */
  setSessionAssistantId: (assistantId: string | null) => void;
  /** Record the ready frame's `attachImage` capability advertise. */
  setAttachImageSupported: (supported: boolean) => void;
  /** Record that the daemon refused a photo. See {@link LiveVoiceState.photoRejectedSeq}. */
  notePhotoRejected: (reason: "unsupported" | "failed") => void;
  /** Register (or clear) the active session's attach-image control. */
  setAttachImageDelegate: (
    attachImage: ((attachmentId: string) => boolean) | null,
  ) => void;
  /** Reset every field back to the idle defaults. */
  reset: () => void;
}

export type LiveVoiceStore = LiveVoiceState & LiveVoiceActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const INITIAL_STATE: LiveVoiceState = {
  state: "idle",
  engine: "cascade",
  handsFree: false,
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  turnClosed: false,
  inputAmplitude: 0,
  micSilent: false,
  error: null,
  failureKind: null,
  cards: [],
  turns: [],
  activityTool: null,
  roomMinimizeSeq: 0,
  pendingApproval: null,
  sessionAssistantId: null,
  attachImageSupported: false,
  photoRejectedSeq: 0,
  photoRejectedReason: null,
  attachImage: null,
};

/**
 * The fields a new turn starts from. Applied lazily by the transcript setters
 * the moment something arrives while the previous exchange is closed, so the
 * finished exchange stays on screen until its replacement actually exists.
 */
const OPEN_TURN = {
  turnClosed: false,
  finalTranscript: "",
  assistantTranscript: "",
  // A new turn knows nothing about what it will touch. Carrying the previous
  // turn's tool across the boundary would caption the new question with the
  // old answer's work.
  activityTool: null,
} as const;

/** Build a `LiveVoiceCard` from a `card` server frame, defaulting opaque data. */
function cardFromFrame(frame: LiveVoiceCardServerFrame): LiveVoiceCard {
  return {
    surfaceId: frame.surfaceId,
    surfaceType: frame.surfaceType ?? "card",
    title: frame.title,
    data: frame.data ?? {},
    actions: frame.actions,
    turnId: frame.turnId,
  };
}

const useLiveVoiceStoreBase = create<LiveVoiceStore>()((set) => ({
  ...INITIAL_STATE,

  setState: (state) => set({ state }),
  setEngine: (engine) => set({ engine }),
  setHandsFree: (handsFree) => set({ handsFree }),
  // The three transcript writers below all open a new turn when the previous
  // exchange is closed, so whichever of them the engine happens to send first
  // (the cascade leads with `stt_*`, the realtime engine can lead with a
  // delta) starts the turn cleanly instead of extending the last one.
  setPartialTranscript: (partialTranscript) =>
    set((s) =>
      s.turnClosed && partialTranscript.length > 0
        ? { ...OPEN_TURN, partialTranscript }
        : { partialTranscript },
    ),
  setFinalTranscript: (finalTranscript) =>
    set((s) =>
      s.turnClosed ? { ...OPEN_TURN, finalTranscript } : { finalTranscript },
    ),
  appendAssistantTranscript: (delta) =>
    set((s) =>
      s.turnClosed
        ? // A reply arriving with no new user transcript still starts a new
          // turn: replace the finished reply rather than growing it. Keeping
          // the previous answer as a prefix is what made Cue appear to answer
          // a question it was never asked.
          { turnClosed: false, assistantTranscript: delta }
        : { assistantTranscript: s.assistantTranscript + delta },
    ),
  clearAssistantTranscript: () =>
    set({ assistantTranscript: "", turnClosed: false, activityTool: null }),
  closeTurn: () =>
    set((s) => {
      if (s.turnClosed) return { turnClosed: true, activityTool: null };
      const user = s.finalTranscript.trim();
      const assistant = s.assistantTranscript.trim();
      // A turn that said nothing (a cough the daemon closed without an answer)
      // is not an exchange; recording it would put an empty pair of bubbles in
      // the full-screen transcript.
      if (!user && !assistant) return { turnClosed: true, activityTool: null };
      return {
        turnClosed: true,
        activityTool: null,
        turns: [
          ...s.turns,
          { id: (s.turns.at(-1)?.id ?? 0) + 1, user, assistant },
        ],
      };
    }),
  setInputAmplitude: (inputAmplitude) => set({ inputAmplitude }),
  setMicSilent: (micSilent) => set({ micSilent }),
  fail: (message, kind = "session") =>
    set({ state: "failed", error: message, failureKind: kind }),
  showCard: (frame) =>
    set((s) => {
      const card = cardFromFrame(frame);
      const idx = s.cards.findIndex((c) => c.surfaceId === card.surfaceId);
      if (idx === -1) return { cards: [...s.cards, card] };
      const next = s.cards.slice();
      next[idx] = card;
      return { cards: next };
    }),
  updateCard: (frame) =>
    set((s) => {
      const idx = s.cards.findIndex((c) => c.surfaceId === frame.surfaceId);
      if (idx === -1) return {};
      const existing = s.cards[idx]!;
      const next = s.cards.slice();
      next[idx] = {
        ...existing,
        ...(frame.surfaceType ? { surfaceType: frame.surfaceType } : {}),
        ...(frame.title !== undefined ? { title: frame.title } : {}),
        data: { ...existing.data, ...(frame.data ?? {}) },
        ...(frame.actions !== undefined ? { actions: frame.actions } : {}),
      };
      return { cards: next };
    }),
  dismissCard: (surfaceId) =>
    set((s) => ({ cards: s.cards.filter((c) => c.surfaceId !== surfaceId) })),
  clearCards: () => set({ cards: [] }),
  setActivityTool: (activityTool) => set({ activityTool }),
  requestRoomMinimize: () =>
    set((s) => ({ roomMinimizeSeq: s.roomMinimizeSeq + 1 })),
  setPendingApproval: (frame) =>
    set({
      pendingApproval: {
        requestId: frame.requestId,
        toolName: frame.toolName,
        ...(frame.summary !== undefined ? { summary: frame.summary } : {}),
        ...(frame.riskLevel !== undefined
          ? { riskLevel: frame.riskLevel }
          : {}),
        ...(frame.trustLine !== undefined
          ? { trustLine: frame.trustLine }
          : {}),
        turnId: frame.turnId,
      },
    }),
  clearPendingApproval: (requestId) =>
    set((s) =>
      s.pendingApproval === null ||
      (requestId !== undefined && s.pendingApproval.requestId !== requestId)
        ? {}
        : { pendingApproval: null },
    ),
  setSessionAssistantId: (sessionAssistantId) => set({ sessionAssistantId }),
  setAttachImageSupported: (attachImageSupported) =>
    set({ attachImageSupported }),
  notePhotoRejected: (reason) =>
    set((s) => ({
      photoRejectedSeq: s.photoRejectedSeq + 1,
      photoRejectedReason: reason,
    })),
  setAttachImageDelegate: (attachImage) => set({ attachImage }),
  reset: () => set({ ...INITIAL_STATE }),
}));

export const useLiveVoiceStore = createSelectors(useLiveVoiceStoreBase);

/**
 * Hand the active session a photo the user took mid-call, by attachment id.
 * Returns whether it reached the session: false when no session exists or the
 * transport is mid-reconnect, which the caller must surface (the shutter has
 * already fired) rather than treat as sent. Module-level so the camera hook
 * needs no session prop plumbing.
 */
export function attachLiveVoiceImage(attachmentId: string): boolean {
  return useLiveVoiceStore.getState().attachImage?.(attachmentId) ?? false;
}
