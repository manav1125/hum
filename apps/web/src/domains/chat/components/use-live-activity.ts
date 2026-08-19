/**
 * useLiveActivity — the "is Cue actually working?" signal, surface-agnostic.
 *
 * Every piece of state behind the live-activity block is presentation-free:
 * the ticking clock, the turn-start stamp for restored/external turns, the
 * silence watchdog and its manual reconcile. Only the markup differs between
 * mobile and desktop, so only the markup lives in the components.
 *
 * This exists because the mobile block was the ONLY surface with a live
 * signal. Desktop showed its status line inside the transcript, where it
 * scrolls out of sight — so a long turn on desktop looked identical to a
 * dead one, and the honest answer to "is this stuck?" was to reload. Sharing
 * the logic rather than reimplementing it means the two surfaces cannot
 * disagree about whether work is happening.
 */

import { useEffect, useState } from "react";

import { requestActiveReconcileAndSettle } from "@/domains/chat/foreground-reconcile";
import {
  useLiveStatusForConversation,
  useLiveStatusStore,
  type LiveStep,
} from "@/domains/chat/live-status-store";
import {
  deriveLiveStatus,
  formatElapsed,
  formatTokens,
} from "@/domains/chat/transcript/live-turn-status";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";

/** No thinking/tool signal for this long ⇒ offer the check-status rescue. */
export const WATCHDOG_SILENCE_MS = 120_000;

/** How many recent steps the mini-stream shows. */
export const VISIBLE_STEPS = 3;

export interface LiveActivity {
  /** Derived status view, or null when there is nothing to show. */
  view: ReturnType<typeof deriveLiveStatus>;
  /** Waiting on the user (a question is pending) rather than working. */
  isWaiting: boolean;
  /** Newest-last slice of the step history. */
  visibleSteps: LiveStep[];
  /** "Step 4 · 1m 12s · 12k tokens" parts, already filtered. */
  subParts: string[];
  /** Silent long enough to offer the manual reconcile. */
  showWatchdog: boolean;
  /** How long since any signal — copy for the watchdog line. */
  silentFor: number;
  /** A manual check is in flight. */
  checking: boolean;
  /** Re-fetch and settle the turn. Never cancels anything. */
  checkStatus: () => void;
}

export function useLiveActivity(fallbackActive = false): LiveActivity {
  const phase = useTurnStore.use.phase();
  const statusText = useTurnStore.use.statusText();
  const pendingQueuedCount = useTurnStore.use.pendingQueuedCount();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const {
    turnStartedAt,
    thinkingTail,
    thinkingAt,
    runningTools,
    steps,
    stepCount,
    turnTokens,
    lastEventAt,
  } = useLiveStatusForConversation(activeConversationId);
  const sseConnected = useSSEConnectedStore.use.isConnected();

  const active = isSending(phase) || fallbackActive;

  // Ticking clock — lazy init + interval; Date.now() never runs in render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);

  // Restored/external turns have no start stamp — take one on first sight
  // (idempotent with the identical effect in LiveTurnStatus).
  useEffect(() => {
    if (active && activeConversationId && turnStartedAt === null) {
      useLiveStatusStore.getState().noteTurnStart(activeConversationId);
    }
  }, [active, activeConversationId, turnStartedAt]);

  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  useEffect(() => {
    // Reset the affordance across turns.
    if (!active) {
      setChecking(false);
      setCheckedAt(null);
    }
  }, [active]);

  const view = deriveLiveStatus({
    phase,
    statusText,
    pendingQueuedCount,
    thinkingTail,
    thinkingAt,
    runningTools,
    turnStartedAt,
    now,
    fallbackActive,
    sseConnected,
  });

  const elapsedMs = turnStartedAt !== null ? now - turnStartedAt : 0;
  const lastSignalAt = Math.max(
    turnStartedAt ?? 0,
    lastEventAt ?? 0,
    thinkingAt ?? 0,
    checkedAt ?? 0,
  );
  const silentFor = lastSignalAt > 0 ? now - lastSignalAt : 0;
  const showWatchdog = sseConnected && silentFor >= WATCHDOG_SILENCE_MS;

  const isWaiting = view?.state === "waiting";

  // Effort read (step / elapsed / token burn-down) belongs to a live run,
  // never to "Waiting on you" — there it would read as ongoing work.
  const subParts: string[] = [];
  if (!isWaiting) {
    if (stepCount > 0) subParts.push(`Step ${stepCount}`);
    if (elapsedMs >= 3_000) subParts.push(formatElapsed(elapsedMs));
    if (turnTokens > 0) subParts.push(`${formatTokens(turnTokens)} tokens`);
  }

  const checkStatus = () => {
    if (checking) return;
    setChecking(true);
    void requestActiveReconcileAndSettle().finally(() => {
      setChecking(false);
      // Quiets the watchdog for another window if the turn is genuinely
      // still running (reconcile found no missed terminal state).
      setCheckedAt(Date.now());
    });
  };

  return {
    view,
    isWaiting,
    visibleSteps: steps.slice(-VISIBLE_STEPS),
    subParts,
    showWatchdog,
    silentFor,
    checking,
    checkStatus,
  };
}
