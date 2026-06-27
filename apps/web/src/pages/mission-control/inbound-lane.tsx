/**
 * Inbound lane body — Home's action-board feed, re-housed as the triage column
 * of Mission Control.
 *
 * Reuses the exact data + card components Home uses: `useHomeFeedQuery` for the
 * feed (+ its `updateStatus` / `triggerAction` mutations) and `HomeFeedList`
 * for the cards, so triage controls (Run via the card's action, Snooze = mark
 * seen, Dismiss) behave identically to Home and stay wired to the same
 * endpoints. Selecting a card opens its originating thread (the board is a
 * triage surface, not a detail surface — detail lives on Home).
 *
 * Freshness comes from the page-level `useActivitySync`, which invalidates the
 * shared `homeFeedGet` cache on `home_feed_updated` / `surface_action_completed`.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router";

import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";

import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
import { HomeFeedList } from "@/domains/home/home-feed-list";
import { C } from "@/domains/activity/theme";

export function InboundLane({
  assistantId,
  validConversationIds,
}: {
  assistantId: string;
  validConversationIds?: Set<string>;
}) {
  const navigate = useNavigate();
  const feedQuery = useHomeFeedQuery(assistantId);

  // Open the card's thread; mark it seen on the way (matches Home).
  const handleSelectItem = useCallback(
    (item: FeedItem) => {
      if (item.status === "new") {
        feedQuery.updateStatus.mutate({ itemId: item.id, status: "seen" });
      }
      if (item.conversationId) {
        navigate(`/assistant/conversations/${item.conversationId}`);
      }
    },
    [feedQuery.updateStatus, navigate],
  );

  const handleDismissItem = useCallback(
    (itemId: string) => {
      feedQuery.updateStatus.mutate({ itemId, status: "dismissed" });
    },
    [feedQuery.updateStatus],
  );

  const handleRestoreItem = useCallback(
    (itemId: string) => {
      feedQuery.updateStatus.mutate({ itemId, status: "seen" });
    },
    [feedQuery.updateStatus],
  );

  const handleUpdateStatus = useCallback(
    (itemId: string, status: FeedItemStatus) => {
      feedQuery.updateStatus.mutate({ itemId, status });
    },
    [feedQuery.updateStatus],
  );

  const handleGoToThread = useCallback(
    (conversationId: string) => {
      navigate(`/assistant/conversations/${conversationId}`);
    },
    [navigate],
  );

  if (feedQuery.isLoading) {
    return <LaneNote>Loading what came in…</LaneNote>;
  }
  if (feedQuery.isError) {
    return <LaneNote tone="danger">Couldn’t load the inbound feed.</LaneNote>;
  }

  return (
    <HomeFeedList
      items={feedQuery.data?.items ?? []}
      validConversationIds={validConversationIds}
      onSelectItem={handleSelectItem}
      onDismissItem={handleDismissItem}
      onRestoreItem={handleRestoreItem}
      onToggleRead={handleUpdateStatus}
      onGoToThread={handleGoToThread}
    />
  );
}

function LaneNote({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "danger";
}) {
  return (
    <div
      style={{
        fontSize: 13,
        color: tone === "danger" ? C.danger : C.t2,
        padding: "10px 4px",
      }}
    >
      {children}
    </div>
  );
}
