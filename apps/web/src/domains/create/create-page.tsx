import { useCallback } from "react";
import { useNavigate } from "react-router";

import { PageShell } from "@/components/page-shell";
import { CreateView } from "@/domains/create/create-view";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

/**
 * Generates a fresh draft conversation id. Mirrors
 * `domains/chat/utils/conversation-selection.createDraftConversationId`
 * (a plain UUID) — inlined here so the Create domain stays free of a
 * cross-domain import into chat (see CONVENTIONS.md).
 */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Create page — hosts the "What do you want to get done?" mode picker.
 *
 * Reuses the exact thread-seeding path the Home surface uses: create a draft
 * conversation, set it active, then navigate to it with the template prompt
 * in `?prompt=`. The chat route's `useAutoSendEffects` hook auto-sends that
 * prompt once the conversation mounts, so the backing skill actually runs and
 * produces the asset.
 */
export function CreatePage() {
  const navigate = useNavigate();

  const handleSelectTemplate = useCallback(
    (prompt: string) => {
      useViewerStore.getState().setMainView("chat");
      const id = newDraftConversationId();
      useConversationStore.getState().setActiveConversationId(id);
      void navigate(
        `${routes.conversation(id)}?prompt=${encodeURIComponent(prompt)}`,
      );
    },
    [navigate],
  );

  return (
    <PageShell>
      <CreateView onSelectTemplate={handleSelectTemplate} />
    </PageShell>
  );
}
