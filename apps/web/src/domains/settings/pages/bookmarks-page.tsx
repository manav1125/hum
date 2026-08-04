/**
 * Settings → Bookmarks — every bookmarked message in the workspace, newest
 * first, with a jump-to-conversation action and a remove action.
 *
 * Web sibling of the macOS `SettingsBookmarksTab`: same content per row
 * (conversation title, message snippet, bookmark/sent timestamps, Open +
 * Remove), presented in the `ArchivePage` card-list shell so the two
 * settings lists read as one family.
 *
 * Feature-flag gated (`bookmarks` client flag); a deep link with the flag
 * off lands on the settings index instead.
 */

import { AlertTriangle, Bookmark, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  useBookmarkStore,
  type BookmarkSummary,
} from "@/stores/bookmark-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";
import { toast } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";

function formatBookmarkDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function EmptyState() {
  return (
    <Card>
      <div className="flex min-h-[400px] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-base)]">
          <Bookmark className="h-6 w-6 text-[var(--content-disabled)] dark:text-[var(--content-default)]" />
        </div>
        <h2 className="mt-4 text-title-small text-[var(--content-default)]">
          No bookmarks
        </h2>
        <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
          Hover any message and click the bookmark icon to save it here.
        </p>
      </div>
    </Card>
  );
}

function BookmarkRow({
  bookmark,
  isFirst,
  onOpen,
  onRemove,
  isPending,
}: {
  bookmark: BookmarkSummary;
  isFirst: boolean;
  onOpen: () => void;
  onRemove: () => void;
  isPending: boolean;
}) {
  const title =
    bookmark.conversationTitle && bookmark.conversationTitle.trim().length > 0
      ? bookmark.conversationTitle
      : "Untitled conversation";
  const bookmarkedAt = formatBookmarkDate(bookmark.createdAt);
  const sentAt = formatBookmarkDate(bookmark.messageCreatedAt);
  const meta = [
    bookmarkedAt ? `Bookmarked ${bookmarkedAt}` : null,
    sentAt ? `Sent ${sentAt}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`flex items-center gap-3 py-3 ${
        isFirst ? "" : "border-t border-[var(--border-base)]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-medium-default text-[var(--content-default)]">
          {title}
        </div>
        {bookmark.messagePreview ? (
          <p className="mt-0.5 line-clamp-2 text-body-small-default text-[var(--content-secondary)]">
            {bookmark.messagePreview}
          </p>
        ) : null}
        <p className="mt-0.5 truncate text-body-small-default text-[var(--content-tertiary)]">
          {meta}
        </p>
      </div>
      <Button variant="outlined" onClick={onOpen} className="shrink-0">
        Open
      </Button>
      <Button
        variant="dangerGhost"
        onClick={onRemove}
        disabled={isPending}
        title="Remove bookmark"
        aria-label="Remove bookmark"
        className="shrink-0"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <X className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

export function BookmarksPage() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();
  const bookmarksEnabled = useClientFeatureFlagStore.use.bookmarks();

  const bookmarks = useBookmarkStore.use.bookmarks();
  const isLoading = useBookmarkStore.use.isLoading();
  const loadFailed = useBookmarkStore.use.loadFailed();
  const loadedAssistantId = useBookmarkStore.use.loadedAssistantId();

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  useEffect(() => {
    if (bookmarksEnabled && assistantId) {
      void useBookmarkStore
        .getState()
        .loadBookmarks(assistantId, { force: true });
    }
  }, [bookmarksEnabled, assistantId]);

  const handleRetryLoad = useCallback(() => {
    if (!assistantId) return;
    void useBookmarkStore
      .getState()
      .loadBookmarks(assistantId, { force: true });
  }, [assistantId]);

  const handleOpen = useCallback(
    (conversationId: string) => {
      void navigate(routes.conversation(conversationId));
    },
    [navigate],
  );

  const handleRemove = useCallback(
    async (messageId: string) => {
      if (!assistantId) return;
      setPendingRemoveId(messageId);
      try {
        const ok = await useBookmarkStore
          .getState()
          .removeBookmark(assistantId, messageId);
        if (!ok) toast.error("Failed to remove bookmark.");
      } finally {
        setPendingRemoveId(null);
      }
    },
    [assistantId],
  );

  if (!bookmarksEnabled) {
    return <Navigate to={routes.settings.root} replace />;
  }

  if (isLoading || loadedAssistantId !== assistantId) {
    return (
      <div className="w-full">
        <div className="flex min-h-[400px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--content-disabled)]" />
        </div>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="w-full">
        <Card>
          <div className="flex min-h-[400px] flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--system-error-lighter)]">
              <AlertTriangle className="h-6 w-6 text-[var(--system-error-default)]" />
            </div>
            <h2 className="mt-4 text-title-small text-[var(--content-default)]">
              Failed to load bookmarks
            </h2>
            <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
              Something went wrong. Please try again.
            </p>
            <Button
              variant="outlined"
              onClick={handleRetryLoad}
              className="mt-4"
            >
              <RotateCcw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (bookmarks.length === 0) {
    return (
      <div className="w-full">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="w-full">
      <Card noPadding className="px-4">
        {bookmarks.map((bookmark, index) => (
          <BookmarkRow
            key={bookmark.id}
            bookmark={bookmark}
            isFirst={index === 0}
            onOpen={() => handleOpen(bookmark.conversationId)}
            onRemove={() => void handleRemove(bookmark.messageId)}
            isPending={pendingRemoveId === bookmark.messageId}
          />
        ))}
      </Card>
    </div>
  );
}
