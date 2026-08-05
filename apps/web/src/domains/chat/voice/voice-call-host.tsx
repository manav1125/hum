/**
 * VoiceCallHost — the desktop call's SESSION OWNER, mounted in `RootLayout`
 * above the route switch. This is the piece that makes the v37 ladder
 * possible: demotion (room → bar → title-bar pill) and promotion back up are
 * pure presentation swaps, because the one `useLiveVoice()` controller lives
 * HERE and survives every navigation. Nothing on the ladder ever touches the
 * socket or the mic.
 *
 * ## Ownership contract
 * `useLiveVoice()` tears its session down when its owning component unmounts,
 * and there must never be two live controllers at once. So:
 *
 *  - The controller mounts only while `voice-call-store`'s `session` request
 *    exists, and unmounts (tearing down socket + mic) only when the call
 *    actually ends — never on a route change, collapse, or expand.
 *  - The room / bar (rendered inside the conversation view, see
 *    `voice-call-conversation-slot.tsx`) and the pill (rendered here) are all
 *    controller-less projections of the live-voice store; they reach the
 *    session through the imperative `controls` this host registers.
 *  - Entry points (the composer mic; `/voice`'s orb) must check the call
 *    store before starting their own controller — see `startCall`'s one-
 *    session guard and the `/voice` guard in `voice-mode-surface.tsx`.
 *
 * The host stays mounted across viewport changes (a mid-call window resize
 * must not hang up); only the PILL is desktop-presentation and gates on the
 * desktop layout.
 *
 * ## The pill rung
 * v37 §W1: navigating away from the call's conversation demotes to the
 * title-bar pill; clicking anywhere on it except ✕ returns — navigate back
 * AND promote to the room. Whether the user is "away" is derived from the
 * router, not stored: the route is already the truth about where they are.
 */

import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  useLiveVoice,
  type UseLiveVoiceOptions,
} from "@/domains/chat/voice/live-voice/use-live-voice";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  useVoiceCallStore,
  type VoiceCallSession,
} from "@/domains/chat/voice/voice-call-store";
import { VoiceTitleBarPill } from "@/domains/chat/voice/voice-title-bar-pill";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

export interface VoiceCallHostProps {
  /**
   * Injectable `useLiveVoice` options — tests supply mock transport/audio
   * factories here, which is the controller boundary the ladder tests mock
   * at (the ladder itself always runs real).
   */
  liveVoiceOptions?: UseLiveVoiceOptions;
}

export function VoiceCallHost({ liveVoiceOptions }: VoiceCallHostProps) {
  const session = useVoiceCallStore.use.session();
  if (!session) return null;
  return (
    <VoiceCallSessionHost
      // Remount per call so per-session effects (auto-start) reset cleanly.
      key={`${session.conversationId}:${session.startedAt}`}
      session={session}
      liveVoiceOptions={liveVoiceOptions}
    />
  );
}

/**
 * Mounted for exactly the lifetime of one call. Owns the controller, keeps
 * the store's `controls` registration fresh, and renders the pill rung.
 */
function VoiceCallSessionHost({
  session,
  liveVoiceOptions,
}: {
  session: VoiceCallSession;
  liveVoiceOptions?: UseLiveVoiceOptions;
}) {
  const { state, inputAmplitude, muted, start, stop, setMuted, interrupt } =
    useLiveVoice(liveVoiceOptions);
  const isMobile = useMobileLayout();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const { assistantId, conversationId, startedAt } = session;

  // ── Start once for this call. The key on the mount resets this per call.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start(assistantId, conversationId);
  }, [start, assistantId, conversationId]);

  // ── Register the imperative handles the projections call through.
  // Re-registered when `muted` flips so the bar/room draw the mute control
  // truthfully; cleared on unmount.
  useEffect(() => {
    const register = useVoiceCallStore.getState().registerControls;
    register({
      end: () => {
        void stop().finally(() => useVoiceCallStore.getState().endCall());
      },
      setMuted,
      muted,
      interrupt,
      retry: () => {
        void start(assistantId, conversationId);
      },
    });
    return () => register(null);
  }, [stop, setMuted, muted, interrupt, start, assistantId, conversationId]);

  // ── The reveal (v37 §W2, "voice announces, screen follows"): a
  // `minimize_room` frame — which the daemon sends only AFTER the announcing
  // reply's tts_done — demotes room → bar so the revealed surface takes the
  // space. Demotion only, on each seq increment: promotion back is the
  // user's (⤢ on the bar), and if they are scrolling the surface the room
  // never fights for the space back.
  const roomMinimizeSeq = useLiveVoiceStore.use.roomMinimizeSeq();
  const seenMinimizeSeqRef = useRef(0);
  useEffect(() => {
    if (roomMinimizeSeq > seenMinimizeSeqRef.current) {
      seenMinimizeSeqRef.current = roomMinimizeSeq;
      useVoiceCallStore.getState().collapse();
    }
  }, [roomMinimizeSeq]);

  // ── The mid-call approval (v37 §W2): on `approval_pending` the room
  // minimizes IMMEDIATELY (approval ≠ reveal — no waiting for the sentence
  // to end) and the approval card renders in the conversation view (see
  // voice-call-conversation-slot). When the approval stops being featured —
  // decided, presentation-expired, or "Ask me after" — the ladder returns to
  // the rung it held before the approval, unless the user already promoted
  // it back themselves mid-wait.
  const pendingApproval = useLiveVoiceStore.use.pendingApproval();
  const approvalReturnRef = useRef<{ returnToRoom: boolean } | null>(null);
  useEffect(() => {
    const ladder = useVoiceCallStore.getState();
    if (pendingApproval) {
      if (approvalReturnRef.current === null) {
        approvalReturnRef.current = { returnToRoom: !ladder.minimized };
        ladder.collapse();
      }
      return;
    }
    if (approvalReturnRef.current !== null) {
      const { returnToRoom } = approvalReturnRef.current;
      approvalReturnRef.current = null;
      if (returnToRoom && useVoiceCallStore.getState().minimized) {
        useVoiceCallStore.getState().expand();
      }
    }
  }, [pendingApproval]);

  // ── If the session lands back on `idle` after it actually left it (a
  // clean server close, a teardown path that didn't go through our `end`),
  // the call is over: clear the ladder rather than leave a bar/pill claiming
  // a session that no longer exists. Guarded on having OBSERVED a non-idle
  // state — at mount the store still reads `idle` for one render while
  // `start()` is kicking off, and ending there would kill the call at birth.
  // `failed` deliberately KEEPS the ladder — the surfaces show the failure
  // and offer retry (fail open).
  const sawLiveRef = useRef(false);
  useEffect(() => {
    if (state !== "idle") {
      sawLiveRef.current = true;
      return;
    }
    if (sawLiveRef.current) useVoiceCallStore.getState().endCall();
  }, [state]);

  // ── The pill rung: away from the call's conversation → title-bar pill.
  const conversationPath = routes.conversation(conversationId);
  const away = pathname !== conversationPath;
  if (isMobile || !away) return null;

  return (
    <VoiceTitleBarPill
      state={state}
      amplitude={inputAmplitude}
      muted={muted}
      startedAt={startedAt}
      onReturn={() => {
        // Back to the conversation, promoted straight to the room (v37).
        useVoiceCallStore.getState().expand();
        void navigate(conversationPath);
      }}
      onEnd={() => {
        void stop().finally(() => useVoiceCallStore.getState().endCall());
      }}
    />
  );
}
