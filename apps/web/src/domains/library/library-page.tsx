import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { LibraryView } from "@/domains/library/library-view";
import { routes } from "@/utils/routes";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * Local draft-conversation id, mirroring `domains/create/create-page.tsx`.
 * Duplicated deliberately rather than imported from chat — same cross-domain
 * import convention that file cites (CONVENTIONS.md).
 */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function LibraryPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const handleNewConversation = useCallback(
    (initialMessage?: string) => {
      // Seed the prompt the same way Create does: mint a draft conversation and
      // hand the text over on `?prompt=`, which `useAutoSendEffects` auto-sends
      // on arrival. Previously the argument was dropped, so "test this app" →
      // type a prompt → landed in an empty chat with the message gone.
      if (!initialMessage?.trim()) {
        void navigate(routes.assistant);
        return;
      }
      const id = newDraftConversationId();
      useConversationStore.getState().setActiveConversationId(id);
      void navigate(
        `${routes.conversation(id)}?prompt=${encodeURIComponent(initialMessage)}`,
      );
    },
    [navigate],
  );

  const handleOpenDocument = useCallback(
    (documentSurfaceId: string) => {
      void navigate(routes.document(documentSurfaceId));
    },
    [navigate],
  );

  // Clicking an app navigates to /assistant/library/:appId, where
  // LibraryDetailPage handles the dedicated load/render/error UI.
  const handleOpenApp = useCallback(
    (appIdToOpen: string) => {
      void navigate(routes.library.app(appIdToOpen));
    },
    [navigate],
  );

  return (
    <PageShell>
      <LibraryView
        assistantId={assistantId}
        title="Library"
        onNewConversation={handleNewConversation}
        onOpenDocument={handleOpenDocument}
        onOpenApp={handleOpenApp}
      />
    </PageShell>
  );
}
