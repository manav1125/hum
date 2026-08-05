/**
 * The conversation view's two rungs of the desktop call ladder (v37 §W1):
 *
 *  - {@link ConversationVoiceRoomOverlay} — the ROOM (v35 §V1), covering the
 *    chat panel while the call is expanded. It reuses {@link VoiceFullScreen}
 *    — the same v35-exact call screen mobile ships — in `layout="fill"` so
 *    desktop and mobile can never drift on the room's three states.
 *  - {@link ConversationVoiceBar} — the MINIMIZED BAR, rendered in normal
 *    flow directly above the composer, which stays fully usable (typing
 *    mid-call is a feature).
 *
 * Both are controller-less projections: the session is owned by
 * `voice-call-host.tsx` above the route switch, and these components reach
 * it only through the `controls` the host registers. Mounting/unmounting
 * either of them (collapse, expand, navigation) therefore never touches the
 * socket or the mic.
 *
 * Both render `null` unless the active call is bound to THIS conversation —
 * a call bound elsewhere is the title-bar pill's business, not this view's.
 */

import { useCallback, useEffect } from "react";

import {
  useLiveVoiceStore,
  type LiveVoiceCard,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoiceCallStore } from "@/domains/chat/voice/voice-call-store";
import { VoiceFullScreen } from "@/domains/chat/voice/voice-fullscreen";
import { VoiceMinimizedBar } from "@/domains/chat/voice/voice-minimized-bar";

interface ConversationVoiceSlotProps {
  /** The conversation this view renders; `null`/`undefined` never matches. */
  conversationId: string | null | undefined;
  /** Conversation title — the room header and the bar's ▤ chip fallback. */
  conversationTitle?: string | null;
}

/** Whether the active desktop call is bound to this conversation. */
function useCallBoundHere(conversationId: string | null | undefined): boolean {
  const session = useVoiceCallStore.use.session();
  return Boolean(
    session && conversationId && session.conversationId === conversationId,
  );
}

/**
 * The room, as an overlay covering the chat panel (the parent must be
 * `position: relative`; ChatBody's root is). Escape collapses to the bar —
 * a non-destructive exit that keeps the call running.
 */
export function ConversationVoiceRoomOverlay({
  conversationId,
  conversationTitle,
}: ConversationVoiceSlotProps) {
  const boundHere = useCallBoundHere(conversationId);
  const session = useVoiceCallStore.use.session();
  const minimized = useVoiceCallStore.use.minimized();
  const controls = useVoiceCallStore.use.controls();

  const state = useLiveVoiceStore.use.state();
  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const assistantTranscript = useLiveVoiceStore.use.assistantTranscript();
  const turnClosed = useLiveVoiceStore.use.turnClosed();
  const activityTool = useLiveVoiceStore.use.activityTool();
  const cards = useLiveVoiceStore.use.cards();
  const error = useLiveVoiceStore.use.error();
  const failureKind = useLiveVoiceStore.use.failureKind();

  const open = boundHere && !minimized;

  // Escape ⤓ collapses (never ends — Escape must not hang up a call).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        useVoiceCallStore.getState().collapse();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Cards are display-only in the room for now (parity with the previous
  // desktop surface — actions don't round-trip on the live-voice channel).
  const handleCardAction = useCallback(() => {}, []);

  if (!open || !session) return null;

  const muted = controls?.muted ?? false;

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 40 }}>
      <VoiceFullScreen
        layout="fill"
        title={conversationTitle ?? null}
        // v35: live captions of the CURRENT sentence only — a closed turn is
        // already a 🎙 citizen of the thread underneath this overlay.
        currentUser={
          turnClosed
            ? ""
            : [finalTranscript, partialTranscript]
                .filter(Boolean)
                .join(" ")
                .trim()
        }
        currentAssistant={turnClosed ? "" : assistantTranscript.trim()}
        state={state}
        activityTool={activityTool}
        muted={muted}
        startedAt={session.startedAt}
        error={error}
        failureKind={failureKind}
        cards={cards}
        onCardAction={handleCardAction}
        onCollapse={() => useVoiceCallStore.getState().collapse()}
        onEnd={() => controls?.end()}
        onToggleMute={() => controls?.setMuted(!muted)}
        onInterrupt={() => controls?.interrupt()}
        onRetry={() => controls?.retry()}
      />
    </div>
  );
}

/** The current card's title, else the conversation's — the ▤ chip label. */
function thingLabelFor(
  cards: LiveVoiceCard[],
  conversationTitle: string | null | undefined,
): string | null {
  const cardTitle = cards.at(-1)?.title?.trim();
  if (cardTitle) return cardTitle;
  const title = conversationTitle?.trim();
  return title || null;
}

/**
 * The minimized bar, rendered in normal flow directly above the composer.
 */
export function ConversationVoiceBar({
  conversationId,
  conversationTitle,
}: ConversationVoiceSlotProps) {
  const boundHere = useCallBoundHere(conversationId);
  const session = useVoiceCallStore.use.session();
  const minimized = useVoiceCallStore.use.minimized();
  const controls = useVoiceCallStore.use.controls();

  const state = useLiveVoiceStore.use.state();
  const inputAmplitude = useLiveVoiceStore.use.inputAmplitude();
  const error = useLiveVoiceStore.use.error();
  const failureKind = useLiveVoiceStore.use.failureKind();
  const cards = useLiveVoiceStore.use.cards();

  if (!boundHere || !minimized || !session) return null;

  const expand = () => useVoiceCallStore.getState().expand();

  return (
    <div style={{ marginBottom: 8 }}>
      <VoiceMinimizedBar
        state={state}
        amplitude={inputAmplitude}
        muted={controls?.muted ?? false}
        startedAt={session.startedAt}
        thingLabel={thingLabelFor(cards, conversationTitle)}
        error={error}
        failureKind={failureKind}
        // The room is where the current card/surface is drawn, so "open the
        // thing" and "expand" both promote — the chip just names WHY.
        onOpenThing={expand}
        onExpand={expand}
        onToggleMute={() => controls?.setMuted(!(controls?.muted ?? false))}
        onEnd={() => controls?.end()}
        onRetry={() => controls?.retry()}
      />
    </div>
  );
}
