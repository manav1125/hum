import { useCallback } from "react";
import { useNavigate } from "react-router";

import { PageShell } from "@/components/page-shell";
import { stageComposerSeed } from "@/domains/create/create-composer-seed";
import { CreateView } from "@/domains/create/create-view";
import type { CreateIntent } from "@/domains/create/create-intent";
import { useConversationStore } from "@/stores/conversation-store";
import { useCreateProvenanceStore } from "@/stores/create-provenance-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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

  const handleRunPrompt = useCallback(
    (prompt: string, intent?: CreateIntent | null, file?: File) => {
      useViewerStore.getState().setMainView("chat");
      const id = newDraftConversationId();
      useConversationStore.getState().setActiveConversationId(id);
      // Stamp the origin CreateIntent against the seeding conversation so the
      // remix cluster can read real provenance once the asset is opened (the
      // opened app links back to this conversation id). Skipped for plain
      // quick-start / form runs that carry no selection.
      if (intent) {
        useCreateProvenanceStore.getState().stampIntent(id, intent);
      }
      // Canvas edits carry a SOURCE image. Attachments only ride a message
      // through the chat composer (the `?prompt=` auto-send path is text-only),
      // so stage the prompt + file into the composer for the user to send —
      // exactly the path the mobile Create sheet uses (stageComposerSeed).
      const assistantId =
        useResolvedAssistantsStore.getState().activeAssistantId;
      if (file && assistantId) {
        stageComposerSeed({ conversationId: id, assistantId, prompt, file });
        void navigate(routes.conversation(id));
        return;
      }
      void navigate(
        `${routes.conversation(id)}?prompt=${encodeURIComponent(prompt)}`,
      );
    },
    [navigate],
  );

  return (
    <PageShell>
      <CreateView onRunPrompt={handleRunPrompt} />
    </PageShell>
  );
}
