/**
 * Bookmark toggle rendered inside a message's hover-action row.
 *
 * Feature-flag gated (`bookmarks` client flag) and only shown for persisted
 * rows — an optimistic id can't be bookmarked because the daemon validates
 * the message exists in the conversation. Reads everything it needs from
 * stores (active assistant, active conversation, bookmark mirror) so the
 * transcript prop chain stays untouched.
 */

import { Bookmark } from "lucide-react";
import { useCallback, useEffect } from "react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { useBookmarkStore } from "@/stores/bookmark-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { toast } from "@vellumai/design-library";

export function BookmarkToggle({ message }: { message: DisplayMessage }) {
  const bookmarksEnabled = useClientFeatureFlagStore.use.bookmarks();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const messageId = message.id;
  const isBookmarked = useBookmarkStore((s) =>
    s.bookmarkedMessageIds.has(messageId),
  );

  // Warm the mirror once per assistant; `loadBookmarks` no-ops when it (or an
  // in-flight load) already covers this assistant, so per-row mounts are cheap.
  useEffect(() => {
    if (bookmarksEnabled && assistantId) {
      void useBookmarkStore.getState().loadBookmarks(assistantId);
    }
  }, [bookmarksEnabled, assistantId]);

  const handleToggle = useCallback(() => {
    const conversationId = useConversationStore.getState().activeConversationId;
    if (!assistantId || !conversationId) return;
    void useBookmarkStore
      .getState()
      .toggleBookmark(assistantId, messageId, conversationId)
      .then((ok) => {
        if (!ok) toast.error("I couldn't update that bookmark. Try again?");
      });
  }, [assistantId, messageId]);

  if (!bookmarksEnabled || !messageId || message.isOptimistic || !assistantId) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
      aria-pressed={isBookmarked}
      className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-active)] ${
        isBookmarked
          ? "text-[var(--content-default)]"
          : "text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
      }`}
    >
      <Bookmark
        className="h-3.5 w-3.5"
        fill={isBookmarked ? "currentColor" : "none"}
      />
    </button>
  );
}
