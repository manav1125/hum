/**
 * Composer seeding for Create runs that carry a FILE (canvas image edits).
 *
 * Why not `?prompt=` auto-send: the auto-send path (use-auto-send-effects)
 * sends CONTENT ONLY — attachments ride a message exclusively through the
 * chat composer's submit (use-composer-submit reads the composer store's
 * uploaded ids). And the composer store can't be staged BEFORE navigation:
 * `chat-session-store.switchToConversation` calls `resetAttachments()` when
 * the new conversation activates, wiping anything staged early.
 *
 * So instead of auto-sending, this stages the run INTO the composer — prompt
 * text + attachment upload via the exact store/upload path the chat composer
 * uses (`addFiles` → uploadChatAttachment) — once the conversation switch has
 * completed AND settled. Settling matters: the switch effect
 * (use-conversation-history) can run more than once for one navigation
 * (React StrictMode double-effects in dev, assistant-state transitions), and
 * every run calls `resetAttachments()`, which cancels in-flight uploads. We
 * debounce until the store goes quiet, then stage; a late safety re-check
 * re-stages once if a straggler reset still wiped the file. The user reviews
 * and taps send; the message then carries the image for real.
 */

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useComposerStore } from "@/domains/chat/composer-store";

/** Quiet window after the last store change before staging the attachment. */
const SETTLE_MS = 450;
/** One late re-check for a straggler reset that wiped the staged file. */
const RECHECK_MS = 2_000;
/** Give up entirely if the navigation never lands. */
const ABANDON_MS = 15_000;

export function stageComposerSeed({
  conversationId,
  assistantId,
  prompt,
  file,
}: {
  conversationId: string;
  assistantId: string;
  prompt: string;
  file: File;
}): void {
  let finished = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const applyText = () => {
    const composer = useComposerStore.getState();
    composer.setInput(prompt);
    // Persist as the conversation's draft too, so a later away-and-back
    // switch restores the text instead of losing it.
    composer.saveDraft(conversationId, prompt);
  };

  const applyFile = () => {
    useComposerStore.getState().addFiles([file], assistantId);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    unsubscribe();
    applyText();
    applyFile();
    // Straggler guard: if one more switch reset wiped the staged file after
    // the quiet window, put it back once (the wipe also cancelled the upload
    // before it posted, so re-adding never double-uploads).
    setTimeout(() => {
      const composer = useComposerStore.getState();
      const stillOurs =
        useChatSessionStore.getState().previousConversationId ===
        conversationId;
      if (stillOurs && composer.attachments.length === 0) {
        composer.setInput(prompt);
        applyFile();
      }
    }, RECHECK_MS);
  };

  const arm = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(finish, SETTLE_MS);
  };

  const unsubscribe = useChatSessionStore.subscribe((state) => {
    if (finished) return;
    // `previousConversationId` is set at the END of switchToConversation
    // (after its resetAttachments), so every notification with our id marks
    // "a switch for our conversation just ran" — re-arm the quiet window.
    if (state.previousConversationId === conversationId) arm();
  });

  // Already landed (shouldn't happen for a fresh draft, but safe).
  if (
    useChatSessionStore.getState().previousConversationId === conversationId
  ) {
    arm();
  }

  // Safety valve: if the navigation never lands (user bailed), stop waiting
  // so the subscription doesn't fire against a much-later visit.
  setTimeout(() => {
    if (!finished) {
      finished = true;
      unsubscribe();
      if (settleTimer) clearTimeout(settleTimer);
    }
  }, ABANDON_MS);
}
