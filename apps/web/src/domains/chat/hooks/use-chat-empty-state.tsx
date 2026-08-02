/**
 * Empty-state data for the chat — greeting text, the home canvas below the
 * composer, and the avatar render function.
 *
 * ## The home canvas
 *
 * On the desktop landing surface this hook no longer assembles a slot from
 * whatever components happened to want a place. It renders exactly one thing,
 * {@link HomeCanvasRegion}, which draws positions 3 and 4 of the six-element
 * canvas ruled in `docs/design/handoff-2026-08-02/FINAL-NAV-BRIEF.md` §4 and
 * enforced in `home-canvas-model.ts`.
 *
 * Three things used to render here and no longer do:
 *
 * - `ChatLauncher` — six hardcoded capability pills, plus "Before you start —
 *   N things need you" over up to three action cards. Needs-you is in the rail
 *   **and** in HQ, so §4's test answers `true` and it is off the canvas.
 * - `RecentThreadsStrip` — "PICK UP WHERE YOU LEFT OFF". The same
 *   conversations are in the sidebar three inches to the left; the canvas was
 *   rendering the sidebar's contents twice.
 * - `ConversationStarterGrid` fed by `GET /conversation-starters` — not
 *   state-derived (see `use-canvas-prompts.ts`), so it is not what §4 means by
 *   prompts that prove Cue knows things.
 *
 * The starter grid survives for **app editing**, which is a different surface
 * with a different empty state: its four chips are built locally from the
 * opened app and name a real thing the user is looking at.
 */

import { type ReactNode, useMemo } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import { HomeCanvasRegion } from "@/domains/chat/home-canvas/home-canvas";
import { useConversationStarters } from "@/domains/chat/hooks/use-conversation-starters";
import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";
import {
  buildEditAppGreeting,
  buildEditAppStarters,
} from "@/domains/chat/utils/edit-app-empty-state";
import { pickRandomPlaceholder } from "@/domains/chat/utils/empty-state-constants";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import type { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseChatEmptyStateParams {
  assistantId: string | null;
  isEmptyConversation: boolean;
  avatar: ReturnType<typeof useAssistantAvatar>;
  /** Current main view from viewer-store. */
  mainView: string;
  /** Opened app state from viewer-store (non-null when editing an app). */
  openedAppState: { name: string; dirName?: string } | null;
  isAssistantStreaming: boolean;
  activeConversationIsProcessing: boolean;
  /**
   * Widened to the one field every caller actually reads. The home canvas
   * hands over a {@link CanvasPrompt} (which carries the id of the work item,
   * mission or calendar block it came from); app editing hands over a
   * {@link ConversationStarter}. Neither shape needs to be known here.
   */
  onSelectStarter: (starter: { prompt: string }) => void;
  /**
   * Whether the daemon's generic starter list is worth fetching.
   *
   * Only the mobile greeting screen still renders it, so the desktop landing
   * surface stops polling an endpoint whose output it no longer draws.
   */
  wantsDaemonStarters: boolean;
}

export interface ChatEmptyStateResult {
  emptyStateProps: ChatEmptyStateProps;
  startersSlot: ReactNode | undefined;
  renderAvatar: (() => ReactNode) | undefined;
  emptyStatePlaceholder: string;
  /** Raw starter objects (strongest-first) — the mobile greeting state renders
   *  its own suggestion cards from these rather than the desktop `startersSlot`. */
  starters: readonly ConversationStarter[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatEmptyState({
  assistantId,
  isEmptyConversation,
  avatar,
  mainView,
  openedAppState,
  isAssistantStreaming,
  activeConversationIsProcessing,
  onSelectStarter,
  wantsDaemonStarters,
}: UseChatEmptyStateParams): ChatEmptyStateResult {
  const {
    components: avatarComponents,
    traits: avatarTraits,
    customImageUrl: avatarImageUrl,
  } = avatar;

  const emptyStatePlaceholder = useMemo(() => pickRandomPlaceholder(), []);
  const emptyStateGreeting = useEmptyStateGreeting(assistantId);

  // Gate the daemon fetch by `isEmptyConversation` so non-empty chats stop
  // polling for data that's never rendered — and by `wantsDaemonStarters`, so
  // the desktop canvas (which draws state-derived chips instead) stops paying
  // for a list it does not draw.
  const { starters: conversationStarters } = useConversationStarters(
    isEmptyConversation && wantsDaemonStarters ? assistantId : null,
  );

  const editingApp =
    mainView === "app-editing" && openedAppState
      ? { name: openedAppState.name, dirName: openedAppState.dirName }
      : null;

  const emptyStateProps: ChatEmptyStateProps = {
    avatarSlot:
      avatarComponents || avatarImageUrl ? (
        <ChatAvatar
          components={avatarComponents}
          traits={avatarTraits}
          customImageUrl={avatarImageUrl}
          size={40}
          interactive
          isProcessing={activeConversationIsProcessing}
        />
      ) : null,
    greeting: editingApp
      ? buildEditAppGreeting(editingApp)
      : emptyStateGreeting,
  };

  const emptyStateStarters = editingApp
    ? buildEditAppStarters(editingApp)
    : conversationStarters;

  /**
   * What renders below the composer.
   *
   * Two surfaces, not one, and they are kept apart on purpose:
   *
   * - **App editing** keeps its locally-built starter grid. It is not the home
   *   canvas — it is a side panel about one opened app, and its chips already
   *   name a real thing (that app).
   * - **The home canvas** renders {@link HomeCanvasRegion} and nothing else.
   *   Not "the region plus whatever else this hook felt like adding": the
   *   region takes no children, and everything it draws comes off the
   *   six-element manifest.
   */
  const startersSlot = editingApp ? (
    isEmptyConversation && emptyStateStarters.length > 0 ? (
      <div className="mt-4">
        <ConversationStarterGrid
          starters={emptyStateStarters}
          onSelect={onSelectStarter}
        />
      </div>
    ) : undefined
  ) : isEmptyConversation ? (
    <HomeCanvasRegion
      assistantId={assistantId}
      onSelectPrompt={onSelectStarter}
    />
  ) : undefined;

  // Stable callback so the latest-turn avatar slot isn't rebuilt on every
  // transcript render. Paired with `memo(ChatAvatar)`, the avatar
  // re-renders only when its inputs actually change.
  const renderAvatar = useMemo(
    () =>
      avatarComponents || avatarImageUrl
        ? () => (
            <ChatAvatar
              components={avatarComponents}
              traits={avatarTraits}
              customImageUrl={avatarImageUrl}
              size={56}
              interactive
              isStreaming={isAssistantStreaming}
              isProcessing={activeConversationIsProcessing}
            />
          )
        : undefined,
    [
      avatarComponents,
      avatarImageUrl,
      avatarTraits,
      isAssistantStreaming,
      activeConversationIsProcessing,
    ],
  );

  return {
    emptyStateProps,
    startersSlot,
    renderAvatar,
    emptyStatePlaceholder,
    starters: emptyStateStarters,
  };
}
