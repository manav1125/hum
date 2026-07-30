import type { NavigateFunction } from "react-router";

import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";
import { isElectron } from "@/runtime/is-electron";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useConversationStore } from "@/stores/conversation-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";

/**
 * Navigate to an existing conversation, resetting subagent state and updating
 * the active conversation in the store.
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToConversation(
  navigate: NavigateFunction,
  conversationId: string,
): void {
  haptic.light();
  useViewerStore.getState().setMainView("chat");
  useSubagentStore.getState().reset();
  useConversationStore.getState().setActiveConversationId(conversationId);
  void navigate(routes.conversation(conversationId));
}

/**
 * Create a fresh draft conversation and navigate to it.
 *
 * Always resets subagent state (a subagent detail panel from a prior
 * conversation must not persist into the new draft). When `silent` is true
 * (e.g. fallback after archiving the active conversation), the haptic tap
 * is suppressed.
 *
 * Pure imperative function — reads stores via `.getState()`, no React hooks.
 */
export function navigateToNewConversation(
  navigate: NavigateFunction,
  options?: { silent?: boolean },
): void {
  if (!options?.silent) haptic.light();
  useViewerStore.getState().setMainView("chat");
  useSubagentStore.getState().reset();
  const draftId = createDraftConversationId();
  useConversationStore.getState().setActiveConversationId(draftId);
  void navigate(routes.conversation(draftId));
  requestComposerFocus();
}

/**
 * Post-archive landing (mobile UAT P1-9): archiving the ACTIVE conversation
 * must not auto-drop the user into the next real conversation. Mobile lands
 * on the Chats index; desktop lands on Today (HQ). `replace` so Back does
 * not return to the just-archived transcript.
 *
 * The width test carries the same `!isElectron()` platform guard as
 * {@link useMobileLayout} — `routes.conversations` mounts the phone-only mv3
 * Chats index, so this is a PHONE decision, not a viewport one. Being a plain
 * imperative function it can't call the hook, so the guard is inlined; it must
 * stay in step with `chat-layout.tsx`, whose `handlePostArchiveNavigate` is the
 * desktop caller. Without it a 720px pop-out rendered the desktop shell but
 * archiving still threw the user onto the phone Chats index.
 *
 * Pure imperative function — safe to pass where a
 * `switchConversation(key)` / `startNewConversation(opts)` callback is
 * expected (extra args are ignored).
 */
export function navigateAfterArchive(navigate: NavigateFunction): void {
  const isMobile =
    window.matchMedia(MOBILE_MEDIA_QUERY).matches && !isElectron();
  void navigate(isMobile ? routes.conversations : routes.hq, {
    replace: true,
  });
}

/**
 * Back with a safe origin: pops in-app history when it exists, otherwise
 * lands on `fallback` (default Today/HQ). Raw `navigate(-1)` on a deep-link
 * or push-notification entry (React Router history index 0) exits to a blank
 * external page — the router stamps its index on `history.state.idx`, so 0
 * means "this is the first in-app entry".
 */
export function goBackWithFallback(
  navigate: NavigateFunction,
  fallback: string = routes.hq,
): void {
  const idx =
    (window.history.state as { idx?: number } | null | undefined)?.idx ?? 0;
  if (idx > 0) {
    void navigate(-1);
  } else {
    void navigate(fallback, { replace: true });
  }
}
