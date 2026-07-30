/**
 * ChatsIndexPage — full-screen route mount for the mobile v3 Chats index
 * (spec frame 21) at `/assistant/conversations` (no id).
 *
 * Mobile reachability fix (UAT P1-2): the ⋯ overflow's "Chats" item needs a
 * real destination — the drawer variant only opens from inside a chat, and
 * the bare /assistant/conversations URL used to fall into the 404 catch-all.
 * This wrapper renders the SAME `Mv3ChatsIndex` the drawer uses, wired to the
 * layout-level conversation list + attention tracking ChatLayout already
 * mounts, so the two mounts stay visually and behaviorally identical.
 *
 * Desktop keeps its current behavior: the sidebar rail IS the chats index,
 * so the bare URL redirects to `/assistant` (ConversationRedirect picks the
 * most recent conversation exactly as before).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { Navigate, useNavigate } from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import {
  goBackWithFallback,
  navigateToConversation,
  navigateToNewConversation,
} from "@/domains/chat/utils/conversation-navigation";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { loadMoreConversations } from "@/utils/conversation-list-fetchers";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

import { Mv3ChatsIndex } from "./mv3-chats-index";

export function ChatsIndexPage() {
  const navigate = useNavigate();
  const isMobile = useMobileLayout();
  const queryClient = useQueryClient();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const { conversations } = useConversationListQuery(
    assistantId,
    assistantStateKind === "active",
  );
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();
  const attentionConversationIds =
    useConversationStore.use.attentionConversationIds();

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      navigateToConversation(navigate, conversationId);
    },
    [navigate],
  );

  const handleStartNewConversation = useCallback(() => {
    navigateToNewConversation(navigate);
  }, [navigate]);

  // ✕ returns to where the user came from; Today is the safe origin when
  // this was a deep-link / fresh-tab entry with no in-app history.
  const handleClose = useCallback(() => {
    goBackWithFallback(navigate, routes.hq);
  }, [navigate]);

  // The boot drain is capped (perf); older history loads on demand.
  const handleLoadMore = useCallback(() => {
    if (!assistantId) return Promise.resolve({ hasMore: false });
    return loadMoreConversations(queryClient, assistantId);
  }, [assistantId, queryClient]);

  if (!isMobile) {
    return <Navigate to={routes.assistant} replace />;
  }

  return (
    <Mv3ChatsIndex
      assistantId={assistantId}
      conversations={conversations}
      processingConversationIds={processingConversationIds}
      attentionConversationIds={attentionConversationIds}
      onSelectConversation={handleSelectConversation}
      onStartNewConversation={handleStartNewConversation}
      onClose={handleClose}
      onLoadMore={handleLoadMore}
    />
  );
}
