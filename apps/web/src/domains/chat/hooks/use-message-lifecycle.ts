/**
 * Orchestrates the message pipeline: reconciliation, stream event
 * handling, SSE subscription, active-conversation message sync, and
 * latest-message refresh.
 *
 * These hooks form a strict dependency chain where intermediate values
 * (handleStreamEvent) never escape to the parent. Only the values
 * needed by external consumers are exposed.
 */

import { type Dispatch, type SetStateAction, useCallback, useEffect } from "react";

import { useNavigate } from "react-router";

import { useIsNativePlatform } from "@/runtime/native-auth";
import {
  registerActiveReconciler,
  settleTurnLivenessAgainstServer,
} from "@/domains/chat/foreground-reconcile";
import { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { recordDiagnostic } from "@/lib/diagnostics";
import { getClientId } from "@/lib/telemetry/client-identity";
import { parseConversationSyncTag } from "@/lib/sync/types";
import { useConversationStore } from "@/stores/conversation-store";
import type { UseAssistantReachabilityResult } from "@/assistant/use-assistant-reachability";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseMessageLifecycleParams {
  assistantId: string | null;
  assistantStateKind: string;
  activeConversationId: string | null;
  conversationExistsOnServer: boolean;
  latestPageOldestTimestamp: number | null;
  reachability: UseAssistantReachabilityResult;
  setAssetsRefreshKey: Dispatch<SetStateAction<number>>;
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

export interface UseMessageLifecycleReturn {
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMessageLifecycle({
  assistantId,
  assistantStateKind,
  activeConversationId,
  conversationExistsOnServer,
  latestPageOldestTimestamp,
  reachability,
  setAssetsRefreshKey,
}: UseMessageLifecycleParams): UseMessageLifecycleReturn {
  const navigate = useNavigate();
  const isNative = useIsNativePlatform();

  // Thin wrapper matching StreamHandlerContext.router.push signature.
  const push = useCallback(
    (url: string) => {
      void navigate(url);
    },
    [navigate],
  );

  // 1. Reconciliation — owns the merge loop that replays optimistic
  //    messages against the server transcript on reconnect.
  const {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  } = useMessageReconciliation({
    latestPageOldestTimestamp,
  });

  // 2. Stream event handler — routes incoming SSE events to domain
  //    handler functions (message, error, tool-call, metadata, etc.).
  const { handleStreamEvent } = useStreamEventHandler({
    push,
    isNative,
    cancelReconciliation,
    startReconciliationLoop,
    setAssetsRefreshKey,
  });

  // 3. SSE subscription lifecycle — subscribes, filters, and tears down
  //    the bus-owned SSE for the active conversation.
  useEventStream({
    assistantStateKind,
    assistantId,
    activeConversationId,
    conversationExistsOnServer,
    handleStreamEvent,
    reconcileActiveConversation,
    startReconciliationLoop,
    cancelReconciliation,
    reachabilityProbe: reachability.probe,
    reachabilityPhase: reachability.state.phase,
    reachabilityReset: reachability.reset,
  });

  // 4. Active-conversation `:messages` sync — when another client writes
  //    to the active conversation, a `sync_changed` event carries a
  //    `conversation:<id>:messages` tag. Reconcile the active conversation
  //    so the user sees the new messages without a manual refresh.
  //    Self-echo suppression mirrors the guard in useConversationSync.
  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId) return;
    const event = envelope.message;
    if (event.type !== "sync_changed") return;
    if (event.originClientId && event.originClientId === getClientId()) return;
    const currentActiveId =
      useConversationStore.getState().activeConversationId;
    if (!currentActiveId) return;
    for (const tag of event.tags) {
      const parsed = parseConversationSyncTag(tag);
      if (
        parsed &&
        parsed.resource === "messages" &&
        parsed.conversationId === currentActiveId
      ) {
        void reconcileActiveConversation();
        return;
      }
    }
  });

  // 5. Foreground reconcile — belt-and-braces for turns whose terminal
  //    event was lost while the app was backgrounded (iOS freezes the
  //    WKWebView JS runtime; SSE silently dies; the turn completes
  //    server-side but the client keeps spinning). The SSE service DOES
  //    reopen on `app.resume` and `reconcile-on-reopen` runs then, but
  //    that path depends on the reopen succeeding + the `sse.opened`
  //    dispatch; this direct reconcile has no such dependency. Only fires
  //    while a turn looks in flight, so an idle foreground is free.
  useBusSubscription("app.resume", () => {
    if (!isSending(useTurnStore.getState().phase)) return;
    if (!useConversationStore.getState().activeConversationId) return;
    recordDiagnostic("foreground_reconcile_triggered", {});
    void reconcileActiveConversation()
      .catch(() => {
        // Transient fetch failure — the SSE-reopen reconcile and the
        // polling loop are the fallbacks; nothing to surface here.
      })
      // Then the lost-terminal settle: the messages reconcile alone can't
      // clear a spinner whose reply fully arrived before the SSE died
      // (changed:false defeats the structural rescue) — the conversation
      // row's `isProcessing` is the authoritative tiebreak.
      .then(() => settleTurnLivenessAgainstServer())
      .catch(() => {});
  });

  // 6. Expose the reconcile function to out-of-tree affordances (the
  //    mobile live-activity "check status" watchdog).
  useEffect(
    () => registerActiveReconciler(reconcileActiveConversation),
    [reconcileActiveConversation],
  );

  return {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  };
}
