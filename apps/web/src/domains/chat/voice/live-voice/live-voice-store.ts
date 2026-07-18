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

import type { LiveVoiceCardServerFrame } from "@/domains/chat/voice/live-voice/protocol";
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

export interface LiveVoiceState {
  /** Current phase of the session lifecycle. */
  state: LiveVoiceSessionState;
  /** In-flight partial transcript of the user's current utterance. */
  partialTranscript: string;
  /** Last finalized user transcript. */
  finalTranscript: string;
  /** Accumulated assistant response text for the current turn. */
  assistantTranscript: string;
  /** Smoothed RMS mic amplitude in [0, 1] for UI / barge-in. */
  inputAmplitude: number;
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
}

export interface LiveVoiceActions {
  /** Replace the session phase. */
  setState: (state: LiveVoiceSessionState) => void;
  setPartialTranscript: (text: string) => void;
  setFinalTranscript: (text: string) => void;
  /** Append a delta to the accumulated assistant transcript. */
  appendAssistantTranscript: (delta: string) => void;
  /** Reset the assistant transcript ahead of a new response. */
  clearAssistantTranscript: () => void;
  setInputAmplitude: (amplitude: number) => void;
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
  /** Reset every field back to the idle defaults. */
  reset: () => void;
}

export type LiveVoiceStore = LiveVoiceState & LiveVoiceActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const INITIAL_STATE: LiveVoiceState = {
  state: "idle",
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  inputAmplitude: 0,
  error: null,
  failureKind: null,
  cards: [],
};

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
  setPartialTranscript: (partialTranscript) => set({ partialTranscript }),
  setFinalTranscript: (finalTranscript) => set({ finalTranscript }),
  appendAssistantTranscript: (delta) =>
    set((s) => ({ assistantTranscript: s.assistantTranscript + delta })),
  clearAssistantTranscript: () => set({ assistantTranscript: "" }),
  setInputAmplitude: (inputAmplitude) => set({ inputAmplitude }),
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
  reset: () => set({ ...INITIAL_STATE }),
}));

export const useLiveVoiceStore = createSelectors(useLiveVoiceStoreBase);
