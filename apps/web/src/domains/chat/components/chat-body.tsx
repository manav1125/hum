import {
  type DragEventHandler,
  type ReactNode,
  useCallback,
  useState,
} from "react";

import { Eye, Paperclip, Square } from "lucide-react";

import {
  ChatComposer,
  type ChatComposerProps,
} from "@/domains/chat/components/chat-composer/chat-composer";
import { InChatVoiceOverlay } from "@/domains/chat/components/in-chat-voice-overlay";
import {
  ConversationVoiceBar,
  ConversationVoiceRoomOverlay,
} from "@/domains/chat/voice/voice-call-conversation-slot";
import { useVoiceCallStore } from "@/domains/chat/voice/voice-call-store";
import { QuestionPromptSlot } from "@/domains/chat/components/question-prompt-slot";
import { canvasElement } from "@/domains/chat/home-canvas/home-canvas-model";
import { SpawnedWorkSlot } from "@/domains/chat/components/spawned-work-slot";
import {
  ChatScrollArea,
  type ChatScrollAreaProps,
} from "@/domains/chat/components/chat-scroll-area";
import { ScrollToLatestButton } from "@/domains/chat/components/scroll-to-latest-button";
import {
  RefreshFeedbackPill,
  type RefreshFeedback,
} from "@/domains/chat/refresh-feedback-pill";
import { Button, Notice } from "@vellumai/design-library";

/**
 * Single composition of a chat panel: a scrollable messages/empty-state
 * area on top, and a composer stack underneath.
 *
 * **Empty‑state centering (LUM-1566):** When the empty state is visible,
 * the outer container switches to `justify-content: safe center` +
 * `overflow-y-auto` and the scroll area drops its `flex-1`. This lets
 * the greeting, composer, and conversation-starter chips center as a
 * single visual group — matching the original centered layout — while
 * the composer **stays at the same position in the React tree** so its
 * state (focus, draft text, attachments) is preserved across the
 * empty→active transition. `safe center` falls back to start-alignment
 * when the group overflows (e.g. iOS with the soft keyboard open).
 *
 * See [React — Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)
 * and [MDN — `justify-content: safe center`](https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content).
 *
 * Both the main chat path and the app-editing side panel render this
 * exact component. Differences between the two — mobile-app nudge
 * banners, the queued-messages drawer, container variant — are passed in
 * as optional slot props or a `variant` enum, so the composer itself is
 * a single mounted instance across both paths (LUM-1516).
 *
 * The component is purely presentational: all state, handlers, and
 * derived flags are owned by the parent page. This keeps the chat-body
 * surface framework-agnostic and free of routing or page-level
 * concerns.
 */
export interface ChatBodyDragHandlers {
  onDragEnter: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
}

export interface ChatBodyProps {
  /**
   * `"main"` — main chat panel; outer container uses `flex-1` so the
   * panel grows to fill the available height.
   * `"side-panel"` — used inside a resizable side pane (e.g. the
   * app-editing layout); outer container uses `h-full` so the panel
   * fills the resizable pane's height.
   */
  variant: "main" | "side-panel";

  /** Props forwarded to {@link ChatScrollArea}. */
  scrollAreaProps: ChatScrollAreaProps;

  /** Props forwarded to {@link ChatComposer}. */
  composerProps: ChatComposerProps;

  /** Drag handlers attached to the outer container for attachment drag-and-drop. */
  dragHandlers: ChatBodyDragHandlers;
  /** True when an attachment drag is active; shows a drop-target overlay. */
  isAttachmentDragOver: boolean;

  /** True when the "Go to Newest" pill should be shown above the composer. */
  showScrollToLatest: boolean;
  /** Click handler for the "Go to Newest" pill. */
  onScrollToLatest: () => void;
  /** True when an assistant response is currently streaming — drives the
   *  animated dots indicator inside the "Go to Newest" pill. */
  isStreaming?: boolean;

  /** Active refresh-feedback pill, or `null` when no pill is shown. */
  refreshFeedback: RefreshFeedback | null;
  /** Dismiss handler for {@link refreshFeedback}. */
  onDismissRefreshFeedback: () => void;
  /** Retry handler for {@link refreshFeedback}. */
  onRetryRefresh: () => void;

  /** Generic chat error rendered above the composer, or `null` when none. */
  genericChatError: { message: string; actions?: ReactNode } | null;

  /** When true, a read-only banner replaces the composer entirely. */
  isChannelReadonly: boolean;
  /**
   * True when the read-only banner should expose the active turn
   * cancellation control.
   */
  canStopGenerating?: boolean;

  /**
   * Optional pre-rendered banner stack (mobile-app nudge / GitHub / Discord)
   * rendered alongside the scroll-to-latest button in the absolute-positioned
   * overlay above the composer. Omitted by the app-editing side panel.
   */
  bannerSlot?: ReactNode;

  /**
   * Optional pre-rendered queued-messages drawer rendered inside the
   * max-width wrapper above the composer. Omitted by the app-editing
   * side panel.
   */
  queuedDrawerSlot?: ReactNode;

  /**
   * Optional pre-rendered footer rendered inside the max-width wrapper
   * immediately above the composer or read-only banner.
   */
  channelFooterSlot?: ReactNode;

  /**
   * Optional replacement for the generic read-only banner. Used by channel
   * surfaces that can provide a native "open there" action.
   */
  readonlyBannerSlot?: ReactNode;

  /**
   * Title of the active conversation, for the desktop voice-call surfaces
   * (the room's header and the minimized bar's ▤ chip fallback). Optional —
   * side panels omit it.
   */
  conversationTitle?: string | null;

  /**
   * The conversation a voice call started from here should be BOUND to —
   * including one the server has not materialized yet.
   *
   * `composerProps.conversationId` cannot serve: it is looked up in the
   * server's conversation list, so on a thread whose first message has not
   * been sent it is `undefined`, and a fresh chat is where the app lands by
   * default. The consequence was not a missing binding but a wrong one: the
   * daemon falls back to the session id, so every call from the home canvas
   * minted its own orphan thread — two calls thirty seconds apart produced two
   * separate conversations, neither of them the one on screen, and the
   * thread-context the model is given read a conversation with no history in
   * it. Text send has always used this same (draft) id and the daemon
   * materializes the thread under it, so passing it here simply makes voice
   * land where typing already lands.
   *
   * Falls back to `composerProps.conversationId`; `null`/`undefined` on both
   * means there is genuinely no thread to join and the call may open one.
   */
  voiceConversationId?: string | null;

  /**
   * Optional conversation-starter chip grid rendered inside the max-width
   * wrapper directly below the composer. Visible only on the empty state;
   * the parent passes `undefined` once messages arrive. Rendered as a
   * slot (like {@link bannerSlot}) so `ChatBody` stays agnostic of the
   * starter data model.
   */
  startersSlot?: ReactNode;
}

/**
 * Read-only composer replacement shown when the active conversation is
 * bound to an external channel (Slack, Telegram, voice/phone, etc.).
 * Mirrors the macOS read-only banner in `ChatView.swift`.
 */
function ChatReadonlyBanner({
  canStopGenerating = false,
  onStopGenerating,
}: {
  canStopGenerating?: boolean;
  onStopGenerating: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3 py-4 text-body-small-default text-[var(--content-tertiary)]">
      <div className="flex items-center gap-2">
        <Eye size={14} />
        <span>Read-only conversation</span>
      </div>
      {canStopGenerating && (
        <Button
          variant="primary"
          iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
          onClick={onStopGenerating}
          aria-label="Stop generating"
          title="Stop generation"
        />
      )}
    </div>
  );
}

export function ChatBody({
  variant,
  scrollAreaProps,
  composerProps,
  dragHandlers,
  isAttachmentDragOver,
  showScrollToLatest,
  onScrollToLatest,
  isStreaming = false,
  refreshFeedback,
  onDismissRefreshFeedback,
  onRetryRefresh,
  genericChatError,
  isChannelReadonly,
  canStopGenerating,
  bannerSlot,
  queuedDrawerSlot,
  channelFooterSlot,
  readonlyBannerSlot,
  conversationTitle,
  voiceConversationId,
  startersSlot,
}: ChatBodyProps) {
  const isEmptyState = scrollAreaProps.showEmptyState;

  // In-chat voice mode. Two paths behind the composer mic:
  //
  //  · Main panel with a conversation → the v37 call LADDER. (`ChatBody` is
  //    the desktop composition — the mobile main chat is `MobileChatView`,
  //    which keeps its own thread-voice bar.) The mic asks the
  //    app-shell-level `VoiceCallHost` (via the voice-call store) to start a
  //    session bound to this conversation; this component then merely
  //    PROJECTS the call — the room overlay while expanded, the minimized
  //    bar above a fully usable composer while collapsed. The controller
  //    lives above the route switch, so navigating away demotes to the
  //    title-bar pill instead of hanging up.
  //  · A panel with no conversation id yet → the legacy full-panel overlay,
  //    which owns its own controller for exactly as long as it is open.
  //
  // Both paths self-gate on the `voice-mode` flag via the composer mic.
  // App-editing side panels never pass `onEnterVoiceMode`, so neither
  // appears there.
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);
  const { assistantId } = composerProps;
  // Which conversation a call from here belongs to — the draft-aware id when
  // the parent supplies one, otherwise the server-materialized one. See
  // {@link ChatBodyProps.voiceConversationId}: taking the server-side id alone
  // sent every call from an unsent thread into a conversation of its own.
  const conversationId = voiceConversationId ?? composerProps.conversationId;
  const usesCallLadder =
    variant === "main" && !!assistantId && !!conversationId;
  const handleEnterVoiceMode = useCallback(() => {
    if (usesCallLadder && assistantId && conversationId) {
      useVoiceCallStore.getState().startCall(assistantId, conversationId);
      return;
    }
    setVoiceOverlayOpen(true);
  }, [usesCallLadder, assistantId, conversationId]);
  const handleExitVoiceMode = useCallback(() => setVoiceOverlayOpen(false), []);
  const supportsVoiceMode =
    !!composerProps.onVoiceTranscript && !!composerProps.assistantId;

  // When the empty state is visible, center greeting + composer + starters
  // as one group. `safe center` falls back to start-alignment when the
  // content overflows the container (e.g. iOS soft keyboard open).
  // `overflow-y-auto` enables scrolling in that overflow case.
  const baseClass =
    variant === "main"
      ? "relative flex min-h-0 flex-1 flex-col"
      : "relative flex h-full min-h-0 flex-col";

  const outerClass = isEmptyState
    ? `${baseClass} overflow-y-auto [justify-content:safe_center]`
    : baseClass;

  // Suppress the absolutely-positioned overlay on the empty state: its
  // `bottom-full` positioning would overlap the greeting when the outer
  // container centers greeting + composer + starters as a group.
  // Banners (app-download nudge, GitHub star, Discord) show once the
  // user sends a message and the empty state clears. `showScrollToLatest`
  // is already false on the empty state (gated on `messages.length > 0`
  // at the call site), so this only affects `bannerSlot`.
  const hasOverlay =
    !isEmptyState && (showScrollToLatest || Boolean(bannerSlot));

  return (
    <div
      className={outerClass}
      onDragEnter={dragHandlers.onDragEnter}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      <ChatScrollArea {...scrollAreaProps} />

      {/* Composer stack — stays at the same tree position across the
          empty→active transition so React preserves its state (focus,
          draft text, attachments) and iOS Safari does not blur the input
          on first send (LUM-1506 / LUM-1516). */}
      <div className="relative px-3 pt-2 pb-2 sm:px-6 sm:pb-0">
        {refreshFeedback && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 flex justify-center pb-2">
            <RefreshFeedbackPill
              feedback={refreshFeedback}
              onDismiss={onDismissRefreshFeedback}
              onRetry={onRetryRefresh}
            />
          </div>
        )}
        {hasOverlay && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 flex flex-col items-center">
            {showScrollToLatest && (
              <div className="pointer-events-auto pb-2.5">
                <ScrollToLatestButton
                  onClick={onScrollToLatest}
                  isStreaming={isStreaming}
                />
              </div>
            )}
            {bannerSlot}
          </div>
        )}
        <div className="mx-auto max-w-[var(--chat-max-width)]">
          {genericChatError && (
            <div className="mb-2">
              <Notice tone="error" actions={genericChatError.actions}>
                {genericChatError.message}
              </Notice>
            </div>
          )}
          {queuedDrawerSlot}
          <SpawnedWorkSlot />
          <QuestionPromptSlot />
          {channelFooterSlot}
          {/* v37 §W1 rung 2 — the minimized call bar, above a composer that
              stays FULLY usable (typing mid-call is a feature). Renders null
              unless the active call is bound to this conversation and
              collapsed. */}
          {usesCallLadder ? (
            <ConversationVoiceBar
              conversationId={conversationId}
              conversationTitle={conversationTitle}
            />
          ) : null}
          {isChannelReadonly ? (
            readonlyBannerSlot ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">{readonlyBannerSlot}</div>
                {canStopGenerating ? (
                  <Button
                    variant="primary"
                    iconOnly={
                      <Square className="h-3 w-3" fill="currentColor" />
                    }
                    onClick={composerProps.onStopGenerating}
                    aria-label="Stop generating"
                    title="Stop generation"
                  />
                ) : null}
              </div>
            ) : (
              <ChatReadonlyBanner
                canStopGenerating={canStopGenerating}
                onStopGenerating={composerProps.onStopGenerating}
              />
            )
          ) : (
            // Position 2 of the home canvas — the composer, which §8 lists as
            // an invariant because it has been accidentally dropped twice.
            // The wrapper is unstyled and always present on this branch, so
            // the composer keeps its position in the React tree (and with it
            // its focus, draft text and attachments) across empty→active.
            <div {...canvasElement("composer")}>
              <ChatComposer
                {...composerProps}
                onEnterVoiceMode={
                  supportsVoiceMode ? handleEnterVoiceMode : undefined
                }
              />
            </div>
          )}
          {startersSlot}
        </div>
      </div>
      {voiceOverlayOpen && (
        <InChatVoiceOverlay
          conversationId={conversationId}
          onExit={handleExitVoiceMode}
        />
      )}
      {/* v37 §W1 rung 1 — the room, covering this chat panel while the call
          is expanded. A projection of the app-shell-owned session: mounting
          and unmounting it never touches the socket or the mic. */}
      {usesCallLadder ? (
        <ConversationVoiceRoomOverlay
          conversationId={conversationId}
          conversationTitle={conversationTitle}
        />
      ) : null}
      {isAttachmentDragOver && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[10px] border-2 border-dashed border-[var(--ring)] bg-[var(--surface-lift)]/80 backdrop-blur-sm"
        >
          <div className="flex flex-col items-center gap-2 text-[var(--content-default)]">
            <Paperclip className="h-6 w-6" />
            <span className="text-body-medium-default">
              Drop files to attach
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
