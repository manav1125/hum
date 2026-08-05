/**
 * Desktop voice-call LADDER state (design v37 §W1: room → bar → pill).
 *
 * This store answers exactly two questions the live-voice store cannot:
 *
 *  1. **Is there a desktop call, and to which conversation is it bound?**
 *     (`session` — the request that keeps {@link
 *     import("./voice-call-host").VoiceCallHost}'s controller mounted.)
 *  2. **Which rung of the ladder did the user choose in the conversation
 *     view?** (`minimized` — room vs bar. The third rung, the title-bar
 *     pill, is not stored: it is DERIVED from the route, because "the user
 *     is somewhere else" is a fact the router already owns.)
 *
 * It deliberately lives beside — not inside — `live-voice/live-voice-store.ts`.
 * That store is the observable projection of a live session's *audio state*
 * and is shared with every other voice surface (mobile bar, /voice route);
 * ladder position is desktop presentation state, and a concurrent workstream
 * owns the transport files, so the ladder keeps its own file.
 *
 * ## Why the session request lives here (the architectural point of V-2)
 * `useLiveVoice()` tears the session down when its owning component unmounts.
 * Every earlier desktop surface mounted the controller inside the
 * conversation view, so navigating away KILLED the call. The ladder needs the
 * opposite: demotion/promotion must never touch the socket or the mic. So the
 * controller's owner ({@link import("./voice-call-host").VoiceCallHost}) is
 * mounted at the app-shell level, ABOVE the route switch, and is driven by
 * `session` here; the room / bar / pill are all controller-less projections.
 * Collapsing, expanding, or navigating changes which projection is on screen
 * — never the component that owns the socket.
 *
 * `controls` is how the presentation layer reaches the controller: the host
 * registers the imperative handles (`end`, `setMuted`, `interrupt`, `retry`)
 * plus the reactive `muted` flag, and the room/bar/pill call through them.
 * `null` means the host has not (re)registered yet — surfaces render but
 * their controls no-op rather than pretend.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The call the desktop ladder is running, and where its turns land. */
export interface VoiceCallSession {
  assistantId: string;
  /** The conversation the call is bound to — the pill navigates back here. */
  conversationId: string;
  /**
   * Epoch ms the call was requested. Owned here — not by any surface — for
   * the same reason mobile puts it on the component that outlives the
   * presentation swap: a clock owned by the room would restart on every
   * collapse/expand, which is a wrong number rendered confidently.
   */
  startedAt: number;
}

/**
 * Imperative handles into the live controller, registered by the host.
 * `muted` rides along because it is `useLiveVoice`'s own reactive state (not
 * a live-voice-store field), and the bar/room need it to draw the mute
 * control truthfully.
 */
export interface VoiceCallControls {
  /** Hang up: stop the session (socket + mic) and clear the ladder. */
  end: () => void;
  setMuted: (muted: boolean) => void;
  muted: boolean;
  /** Deliberate barge-in — no-op unless Cue is actually speaking. */
  interrupt: () => void;
  /** Restart a failed session on the same conversation. */
  retry: () => void;
}

export interface VoiceCallState {
  /** The active desktop call request, or `null` when no call is running. */
  session: VoiceCallSession | null;
  /**
   * `true` after ⤓ — the conversation view shows the minimized bar instead
   * of the room. Meaningless while `session` is `null`.
   */
  minimized: boolean;
  /** Controller handles registered by the host; `null` until it mounts. */
  controls: VoiceCallControls | null;
}

export interface VoiceCallActions {
  /**
   * Begin a call bound to a conversation. If a call is already running for
   * the SAME conversation this promotes it back to the room (tapping the
   * composer mic mid-call is a "show me the call" gesture, not a second
   * call); a call bound to a different conversation is left untouched —
   * there is exactly one session, and its pill is already on screen.
   */
  startCall: (assistantId: string, conversationId: string) => void;
  /** Clear the ladder after the session has been stopped. */
  endCall: () => void;
  /** ⤓ room → bar. Presentation only. */
  collapse: () => void;
  /** ⤢ bar → room (also the pill's promote path). Presentation only. */
  expand: () => void;
  registerControls: (controls: VoiceCallControls | null) => void;
}

export type VoiceCallStore = VoiceCallState & VoiceCallActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const INITIAL_STATE: VoiceCallState = {
  session: null,
  minimized: false,
  controls: null,
};

const useVoiceCallStoreBase = create<VoiceCallStore>()((set) => ({
  ...INITIAL_STATE,

  startCall: (assistantId, conversationId) =>
    set((s) => {
      if (s.session) {
        // One session, ever. Same conversation → promote to the room.
        return s.session.conversationId === conversationId
          ? { minimized: false }
          : {};
      }
      return {
        session: { assistantId, conversationId, startedAt: Date.now() },
        minimized: false,
      };
    }),
  endCall: () => set({ ...INITIAL_STATE }),
  collapse: () => set({ minimized: true }),
  expand: () => set({ minimized: false }),
  registerControls: (controls) => set({ controls }),
}));

export const useVoiceCallStore = createSelectors(useVoiceCallStoreBase);
