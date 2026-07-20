/**
 * MobileChatView — the mobile v3 `/conversations/:id` chat screen (spec
 * frames 8 dark / 13b light).
 *
 * This is the MOBILE presentation branch for chat (rendered by `ChatMainPanel`
 * when `useIsMobile()` is true). The desktop chat path (ChatBody + ChatComposer)
 * is left entirely unchanged.
 *
 * It is a pure restyle/restructure: it REUSES the live message-stream wiring —
 * the same `Transcript` component (so streamed output, tool/step chips,
 * subagent cards, surfaces, confirmations all keep working), the same
 * `submitMessage` / `input` / `setInput` send path, the same `VoiceInputButton`,
 * and the same streaming/stop flags that the desktop path uses. Only the chrome
 * is v3: aurora over `--mv3-bg`, the ‹ Cue header with a live "working on N
 * things" status, blue-gradient user bubbles, the amber needs-you approval
 * card retinted in place, a v3 glass composer with mic and "+", and the
 * FailureCard for this conversation's failed runs.
 *
 * The transcript renders inside a scoped `.cue-mchat` wrapper that rebinds the
 * design-library semantic CSS variables to the `--mv3-*` tokens, so the reused
 * transcript rows / markdown / tool chips read correctly on the v3 canvas
 * without forking any of those components. Two scoped retints ride the same
 * trick (as the previous version did for the user bubble):
 *   · the user bubble (`--surface-lift` aligned end) → frame 8's blue gradient
 *   · the approval card (`border-l-[var(--accent-cue)]` root) → the amber
 *     needs-you treatment (frame 8/13b), Approve button included
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  ArrowUp,
  AudioLines,
  ChevronLeft,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  Square,
} from "lucide-react";

import {
  Transcript,
  type TranscriptHandle,
  type TranscriptProps,
} from "@/domains/chat/transcript/transcript";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { ChatAttachmentsStrip } from "@/domains/chat/components/chat-attachments/chat-attachments";
import {
  MobileComposerSettingsSheet,
  MobileConversationActionsSheet,
} from "@/domains/chat/components/mobile-chat-menus";
import { MobileLiveActivity } from "@/domains/chat/components/mobile-live-activity";
import { MobileTurnErrorCard } from "@/domains/chat/components/mobile-turn-error-card";
import {
  MobileThreadVoice,
  ThreadVoiceActiveChip,
  VOICE_BUBBLE_LOOK,
} from "@/domains/chat/components/mobile-thread-voice";
import {
  SLASH_PREFIX_RE,
  filteredCommands,
  selectedInputText,
  type SlashCommand,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { useTextPopup } from "@/domains/chat/components/chat-composer/use-text-popup";
import { useComposerStore } from "@/domains/chat/composer-store";
import { goBackWithFallback } from "@/domains/chat/utils/conversation-navigation";
import { useVisibleViewport } from "@/hooks/use-visible-viewport";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";
import {
  workitemsByIdRunPostMutation,
  workitemsGetOptions,
  workitemsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { AuroraBackdrop } from "@/mobile-v3/aurora-backdrop";
import { CueRing } from "@/mobile-v3/cue-ring";
import { FailureCard } from "@/mobile-v3/failure-card";
import { GlassCard } from "@/mobile-v3/glass-card";
import { microLabel } from "@/mobile-v3/mv3-kit";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

/**
 * Scoped theme for the reused transcript + the in-thread work citizens.
 * Rebinds the design-library semantic tokens to the mv3 layer, recolours the
 * user bubble to frame 8's blue gradient, and retints the approval card
 * (Transcript's confirmation prompt) to the amber needs-you treatment.
 */
const MCHAT_TRANSCRIPT_THEME = `
.cue-mchat {
  --background: transparent;
  --surface-base: var(--mv3-bg);
  --surface-lift: var(--mv3-card);
  --surface-overlay: var(--mv3-glass);
  --content-default: var(--mv3-text);
  --content-secondary: var(--mv3-muted);
  --content-tertiary: var(--mv3-faint);
  --border-base: var(--mv3-line);
}
/* User bubble → frame 8: blue gradient, 20/20/6/20 radius, soft blue shadow.
   The transcript user bubble is the only --surface-lift element aligned to the
   end of the row; scope by alignment (carried over from the mv1 reskin). */
.cue-mchat .self-end .bg-\\[var\\(--surface-lift\\)\\],
.cue-mchat .items-end > .bg-\\[var\\(--surface-lift\\)\\] {
  background: linear-gradient(160deg, #4E7CEC, #3560CC) !important;
  color: #fff !important;
  border-radius: 20px 20px 6px 20px !important;
  box-shadow: 0 10px 24px -12px rgba(61, 110, 232, 0.5);
}
/* Voice-originated user turn (wire \`voiceTurn\`, marked by the transcript's
   user bubble as data-voice-turn) → the frame-37 live-voice treatment: italic
   🎙 blue-tint bubble, sourced from the same VOICE_BUBBLE_LOOK values
   MobileThreadVoice renders live turns with. Placed after the gradient rule
   above so the equal-specificity override wins by order. */
.cue-mchat .self-end [data-voice-turn="true"],
.cue-mchat .items-end > [data-voice-turn="true"] {
  background: ${VOICE_BUBBLE_LOOK.background} !important;
  border: ${VOICE_BUBBLE_LOOK.border};
  border-radius: ${VOICE_BUBBLE_LOOK.borderRadius} !important;
  color: ${VOICE_BUBBLE_LOOK.color} !important;
  font-style: ${VOICE_BUBBLE_LOOK.fontStyle};
  box-shadow: none;
}
/* The bubble's text runs carry their own size utility (text-[15px]) — bring
   them down to the frame-37 type scale; italic inherits from the bubble. */
.cue-mchat [data-voice-turn="true"] .break-words {
  font-size: ${VOICE_BUBBLE_LOOK.fontSize}px;
  line-height: ${VOICE_BUBBLE_LOOK.lineHeight};
}
/* 🎙 prefix on the first prose line (the live strip renders it in JSX). */
.cue-mchat [data-voice-turn="true"] p:first-of-type::before {
  content: "🎙 ";
}
/* Approval card (needs-you) → the amber chat citizen (frames 8 + 13b).
   Retint in place: same component, same actions — the accent/primary tokens it
   reads are rebound to amber so "Approve" fills amber too. */
.cue-mchat .border-l-\\[var\\(--accent-cue\\)\\] {
  --accent-cue: var(--mv3-amber);
  --accent-cue-strong: var(--mv3-amber);
  --primary-base: var(--mv3-amber);
  --content-inset: var(--mv3-amber-btn-text);
  background: var(--mv3-amber-card-bg) !important;
  border-color: var(--mv3-amber-card-border) !important;
  border-left-color: var(--mv3-amber) !important;
  border-radius: 18px;
  box-shadow: var(--mv3-amber-card-shadow);
}
/* The desktop transcript pins the assistant avatar (+ its status line) below
   the latest reply — on mobile that reads as a dangling empty block after the
   last message, and the live-turn signal already lives in the
   MobileLiveActivity strip pinned above the composer. Hide the slot here. */
.cue-mchat [data-latest-assistant-avatar="true"] {
  display: none;
}
/* Slash-command list rising above the composer (transform/opacity only). */
@keyframes mchatRise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .cue-mchat [data-mchat-rise] { animation: none !important; }
}
`;

/** "11:42"-style time for the failure card's header. */
function clockLabel(epochMs: number | undefined): string | undefined {
  if (!epochMs) return undefined;
  const then = new Date(epochMs);
  const sameDay = then.toDateString() === new Date().toDateString();
  if (sameDay) {
    return then.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface MobileChatViewProps {
  /** The exact transcript props the desktop path assembles — reused verbatim so
   *  the message stream (streamed output, tool/step chips, subagents, surfaces,
   *  confirmations) behaves identically. */
  transcriptProps: TranscriptProps;
  /** Shared transcript handle (owned by ActiveChatView for scroll/debug). */
  transcriptRef: React.RefObject<TranscriptHandle | null>;
  /** Conversation title shown as the header subtitle (e.g. "Acme renewal"). */
  conversationTitle?: string | null;

  // New-conversation greeting state — shown in place of the transcript while the
  // thread is empty. V3 re-types the greeting to the SF Pro system stack.
  /** True when the active conversation has no messages yet. */
  isEmptyConversation: boolean;
  /** Personalized greeting line (daemon-generated; falls back to a default). */
  greeting?: string;
  /** Strongest-first conversation starters rendered as suggestion cards. */
  starters: readonly ConversationStarter[];
  /** Send a starter's prompt (mirrors the desktop chip behaviour). */
  onSelectStarter: (starter: ConversationStarter) => void;

  // Composer wiring — the same send path the desktop composer uses.
  input: string;
  setInput: (value: string) => void;
  onSubmit: (text?: string) => void | Promise<void>;
  sendDisabled: boolean;
  typingDisabled: boolean;

  // Turn state — drives the send↔stop swap, matching the desktop composer.
  canStopGenerating: boolean;
  onStopGenerating: () => void | Promise<void>;

  // Voice input — reuses the real VoiceInputButton handlers.
  voiceInputRef: React.RefObject<VoiceInputButtonHandle | null>;
  onVoiceTranscript: (text: string) => void | Promise<void>;
  onVoiceInterimTranscript: (text: string) => void;
  onVoiceError: (error: string | null) => void;
  onVoiceBeforeStart?: () => boolean | Promise<boolean>;
  voiceInterim?: string;

  assistantId: string | null;
}

/** The header mark: the Cue ring in a small squircle chip + presence dot. */
function HeaderMark() {
  return (
    <span
      style={{
        position: "relative",
        width: 34,
        height: 34,
        borderRadius: 11,
        background: "var(--mv3-chip-bg)",
        border: "1px solid var(--mv3-card-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <CueRing size={20} stroke="var(--mv3-text)" />
      <span
        aria-hidden
        style={{
          position: "absolute",
          right: -2,
          bottom: -2,
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "var(--mv3-green)",
          border: "2px solid var(--mv3-bg)",
        }}
      />
    </span>
  );
}

/**
 * The new-conversation greeting shown while the thread is empty — re-typed to
 * the v3 system stack (SF Pro, frame-2 hero scale) over v3 glass starter rows.
 */
function GreetingState({
  greeting,
  starters,
  onSelectStarter,
}: {
  greeting?: string;
  starters: readonly ConversationStarter[];
  onSelectStarter: (starter: ConversationStarter) => void;
}) {
  const visible = starters.slice(0, 4);
  const heading = greeting?.trim() || DEFAULT_EMPTY_STATE_GREETING;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 22,
        padding: "24px 20px 32px",
        position: "relative",
        zIndex: 2,
      }}
    >
      <div>
        <div
          style={{
            ...microLabel,
            fontSize: 11,
            letterSpacing: "0.12em",
            color: "var(--mv3-micro)",
            marginBottom: 10,
          }}
        >
          New conversation
        </div>
        <h1
          style={{
            fontFamily: "var(--mv3-font)",
            fontSize: 26,
            lineHeight: 1.25,
            fontWeight: 700,
            letterSpacing: "-0.6px",
            color: "var(--mv3-text)",
            margin: 0,
          }}
        >
          {heading}
        </h1>
      </div>

      {visible.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.map((starter, i) => (
            <GlassCard
              key={starter.id}
              radius={18}
              padding={0}
              blur={i < 3}
            >
              <button
                type="button"
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  onSelectStarter(starter);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  width: "100%",
                  minHeight: 44,
                  textAlign: "left",
                  padding: "14px 16px",
                  border: "none",
                  background: "transparent",
                  color: "var(--mv3-text)",
                  fontFamily: "inherit",
                  fontSize: 14,
                  lineHeight: 1.35,
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span style={{ minWidth: 0 }}>{starter.label}</span>
                <ArrowUp
                  size={16}
                  style={{
                    color: "var(--mv3-micro)",
                    flexShrink: 0,
                    rotate: "45deg",
                  }}
                />
              </button>
            </GlassCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MobileChatView({
  transcriptProps,
  transcriptRef,
  conversationTitle,
  isEmptyConversation,
  greeting,
  starters,
  onSelectStarter,
  input,
  setInput,
  onSubmit,
  sendDisabled,
  typingDisabled,
  canStopGenerating,
  onStopGenerating,
  voiceInputRef,
  onVoiceTranscript,
  onVoiceInterimTranscript,
  onVoiceError,
  onVoiceBeforeStart,
  voiceInterim,
  assistantId,
}: MobileChatViewProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const viewport = useVisibleViewport();
  const keyboardHeight = viewport?.keyboardHeight ?? 0;
  const keyboardOpen = keyboardHeight > 0;
  const [focused, setFocused] = useState(false);
  const inputElRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Power-feature sheets (composer settings ⋅ conversation actions) — the
  // v3-skinned mounts of the desktop menus (mobile-chat-menus.tsx).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const activeConversationId = useConversationStore.use.activeConversationId();

  // ── In-thread voice orb (spec frame 37). The session is BOUND to this
  // conversation (start(assistantId, conversationId) — spoken turns persist
  // into the same thread). `keyboard` flips back to typing WITHOUT ending the
  // session (⌨); ✕ ends it. Gated on the same `voice-mode` flag the Voice
  // tab / desktop overlay use, and on an existing conversation to bind to.
  const voiceModeFlag = useAssistantFeatureFlagStore.use.voiceMode();
  const [threadVoiceOpen, setThreadVoiceOpen] = useState(false);
  const [threadVoiceKeyboard, setThreadVoiceKeyboard] = useState(false);
  const canThreadVoice = Boolean(
    voiceModeFlag && assistantId && activeConversationId,
  );
  const handleStartThreadVoice = useCallback(() => {
    haptic.medium();
    setThreadVoiceKeyboard(false);
    setThreadVoiceOpen(true);
  }, []);
  const handleThreadVoiceEnded = useCallback(() => {
    setThreadVoiceOpen(false);
    setThreadVoiceKeyboard(false);
  }, []);

  // ── Live status line: "working on N things" (frame 8's header). Same
  // work-item source HQ/Today use; TanStack dedupes across consumers.
  const runningQuery = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { status: "running" },
    }),
    enabled: Boolean(assistantId),
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const runningCount = (runningQuery.data?.items ?? []).length;
  // Frame 37: while the in-thread voice session is alive the header status
  // becomes "voice active in this chat" (microlabel blue), superseding the
  // working-on-N line.
  const statusLine = threadVoiceOpen
    ? "voice active in this chat"
    : runningCount > 0
      ? `working on ${runningCount} ${runningCount === 1 ? "thing" : "things"}`
      : (conversationTitle ?? null);

  // ── Failed runs for THIS conversation → FailureCard (frame 29's chat use).
  const failedQuery = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { status: "failed" },
    }),
    enabled: Boolean(assistantId),
    staleTime: 15_000,
  });
  const failedHere = useMemo(
    () =>
      ((failedQuery.data?.items ?? []) as HqWorkItem[])
        .filter(
          (item) =>
            activeConversationId != null &&
            item.lastRunConversationId === activeConversationId,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [failedQuery.data, activeConversationId],
  );
  const retryRun = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSuccess: () => {
      haptic.success();
      if (assistantId) {
        void queryClient.invalidateQueries({
          queryKey: workitemsGetQueryKey({
            path: { assistant_id: assistantId },
            query: { status: "failed" },
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: workitemsGetQueryKey({
            path: { assistant_id: assistantId },
            query: { status: "running" },
          }),
        });
      }
    },
  });

  // ── Attachments — the "+" rides the SAME composer store the desktop
  // composer drains on submit, so picked files genuinely send.
  const chatAttachments = useComposerStore.use.attachments();
  const removeAttachment = useComposerStore.use.removeAttachment();
  const handlePickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        useComposerStore.getState().addFiles(files, assistantId);
      }
      e.target.value = "";
    },
    [assistantId],
  );

  // Keyboard-aware composer: when the soft keyboard opens, lift the pinned
  // composer to sit directly above it. `useVisibleViewport` already
  // normalises iOS Safari vs. WKWebView.
  const composerLift = keyboardOpen ? keyboardHeight : 0;

  const trimmed = input.trim();
  const canSend = trimmed.length > 0 && !sendDisabled;

  const handleSend = useCallback(() => {
    if (canStopGenerating) {
      void onStopGenerating();
      return;
    }
    if (!canSend) return;
    haptic.medium();
    void onSubmit();
  }, [canStopGenerating, onStopGenerating, canSend, onSubmit]);

  // ── Slash commands — the SAME derived-from-input mechanism the desktop
  // composer uses (useTextPopup + slash-command-catalog), rendered as a v3
  // glass list rising above the composer.
  const slash = useTextPopup({
    text: input,
    trigger: SLASH_PREFIX_RE,
    search: filteredCommands,
  });
  const slashDismiss = slash.dismiss;
  const handleSlashSelect = useCallback(
    (command: SlashCommand) => {
      haptic.light();
      const next = selectedInputText(command);
      if (command.selectionBehavior === "autoSend") {
        // submitMessage(override) sends the command text and clears the
        // shared composer-store input — same net effect as the desktop
        // flushSync(setInput) + submit dance.
        slashDismiss();
        void onSubmit(next);
      } else {
        setInput(next);
        inputElRef.current?.focus();
      }
    },
    [slashDismiss, onSubmit, setInput],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends (no Shift) — matches the native single-line composer feel.
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        // With the slash list open, Enter selects the highlighted command
        // (hardware-keyboard parity with the desktop composer).
        if (slash.show) {
          const cmd = slash.items[slash.selectedIndex];
          if (cmd) {
            handleSlashSelect(cmd);
            return;
          }
        }
        handleSend();
      }
    },
    [handleSend, slash.show, slash.items, slash.selectedIndex, handleSlashSelect],
  );

  // Auto-grow the textarea up to a few lines.
  useEffect(() => {
    const el = inputElRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const handleBack = useCallback(() => {
    haptic.light();
    // Back ‹ returns to where you came from; Today is the safe origin when
    // this chat was the FIRST in-app entry (deep link / push notification —
    // `history.length` counts external entries, so it lies there; the
    // router's own `state.idx` doesn't). See goBackWithFallback.
    goBackWithFallback(navigate, routes.hq);
  }, [navigate]);

  const handleTellCue = useCallback(
    (item: HqWorkItem) => {
      haptic.light();
      setInput(
        `"${item.title}" couldn't finish — what happened, and what should we do next?`,
      );
      inputElRef.current?.focus();
    },
    [setInput],
  );

  // Composer focus ring lights accent; send arrow appears on focus/typing.
  const composerBorder =
    focused || keyboardOpen
      ? "var(--mv3-accent)"
      : "var(--mv3-glass-border)";
  const showSend = focused || trimmed.length > 0 || canStopGenerating;

  return (
    <div
      data-mv3
      className="cue-mchat"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        // `clip` (both axes — a lone overflow-x:clip computes back to hidden
        // next to overflow-y:hidden) forbids programmatic scroll: `hidden`
        // still let focus / streaming autoscroll drift `scrollLeft` sideways
        // and stick (P1: the 546px aurora overhang). The aurora is
        // paint-contained, so engines without `clip` degrade safely.
        overflow: "clip",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: MCHAT_TRANSCRIPT_THEME }} />

      <AuroraBackdrop />

      {/* HEADER — ‹ back + ring chip + "Cue" / live status (frame 8).
          Top padding carries the iOS status-bar inset — the mobile chat
          route renders edge-to-edge (chat-layout's <main> adds no inset),
          so without this the header sits under the clock/notch. */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding:
            "calc(4px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px))) 20px 12px",
          borderBottom: "1px solid var(--mv3-line)",
          position: "relative",
          zIndex: 2,
        }}
      >
        <button
          type="button"
          onClick={handleBack}
          aria-label="Back"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
            border: "none",
            background: "transparent",
            color: "var(--mv3-micro)",
            cursor: "pointer",
            padding: 0,
            marginLeft: -14,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <ChevronLeft size={22} />
        </button>
        <HeaderMark />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--mv3-text)",
            }}
          >
            Cue
          </div>
          {statusLine ? (
            <div
              style={{
                fontSize: 11,
                color: "var(--mv3-micro)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {statusLine}
            </div>
          ) : null}
        </div>
        {/* ⋯ — conversation actions (v3 sheet mount of the desktop header
            menu). Only meaningful once the conversation exists. */}
        {activeConversationId ? (
          <button
            type="button"
            onClick={() => {
              haptic.light();
              setActionsOpen(true);
            }}
            aria-label="Conversation actions"
            aria-haspopup="dialog"
            aria-expanded={actionsOpen}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              border: "none",
              background: "transparent",
              color: "var(--mv3-micro)",
              cursor: "pointer",
              padding: 0,
              marginRight: -12,
              flexShrink: 0,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <MoreHorizontal size={20} aria-hidden />
          </button>
        ) : null}
      </div>

      {/* THREAD — v3 greeting while empty; otherwise the reused live
          transcript (streamed output + tool/step chips + subagents +
          surfaces + confirmations all preserved, retinted via .cue-mchat). */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          zIndex: 2,
        }}
      >
        {isEmptyConversation ? (
          <GreetingState
            greeting={greeting}
            starters={starters}
            onSelectStarter={onSelectStarter}
          />
        ) : (
          <Transcript ref={transcriptRef} {...transcriptProps} />
        )}
      </div>

      {/* LIVE ACTIVITY — the "Cue is genuinely working" block pinned above
          the composer while a turn is in flight: current step + counter +
          elapsed + latest-steps mini-stream + the long-silence "Check
          status" rescue. Hidden while the in-thread voice session owns the
          bottom of the screen (it has its own live strip). Renders null
          when idle. */}
      {!threadVoiceOpen ? (
        <div
          // `empty:hidden` — both children render null when idle/error-free,
          // and the collapsed wrapper must not leave dead padding above the
          // composer.
          className="empty:hidden"
          style={{
            flexShrink: 0,
            padding: "0 16px 8px",
            position: "relative",
            zIndex: 2,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <MobileLiveActivity
            // `liveStatusFallbackActive` (showThinking) misses a real
            // mid-turn state: once a streaming assistant row exists, the
            // restored-processing OR goes false — and the turn reducer can
            // sit idle mid-turn (draft→server conversation-id switch resets
            // it; external-channel turns never activate it). In that state
            // `canStopGenerating` is the surviving local proof of an active
            // turn (conversation processing flag / live transcript row), so
            // OR it in — otherwise the block goes dark exactly during the
            // long waits it exists for.
            fallbackActive={
              Boolean(transcriptProps.liveStatusFallbackActive) ||
              canStopGenerating
            }
          />
          {/* Quiet error surface — vision degrade card + generic failed-turn
              card. */}
          <MobileTurnErrorCard />
        </div>
      ) : null}

      {/* FAILED RUNS in this conversation — the only red (frame 29). */}
      {failedHere.length > 0 ? (
        <div
          style={{
            flexShrink: 0,
            padding: "0 16px 8px",
            position: "relative",
            zIndex: 2,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {failedHere.slice(0, 2).map((item) => (
            <FailureCard
              key={item.id}
              title={item.title}
              timeLabel={clockLabel(item.updatedAt)}
              agentName={
                item.assignee && item.assignee !== "you"
                  ? item.assignee
                  : "Cue"
              }
              primaryLabel="Retry"
              primaryDisabled={retryRun.isPending}
              onPrimary={() => {
                haptic.medium();
                if (!assistantId) return;
                retryRun.mutate({
                  path: { assistant_id: assistantId, id: item.id },
                });
              }}
              onSecondary={() => handleTellCue(item)}
            />
          ))}
        </div>
      ) : null}

      {/* IN-THREAD VOICE (frame 37) — live strip + voice bar. Mounted while
          the session is open (it owns the single useLiveVoice controller);
          the bar hides on the ⌨ flip but the session + strip persist. */}
      {threadVoiceOpen && assistantId && activeConversationId ? (
        <div
          style={{
            flexShrink: 0,
            position: "relative",
            zIndex: 5,
            paddingBottom: threadVoiceKeyboard
              ? 0
              : "calc(10px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
          }}
        >
          <MobileThreadVoice
            assistantId={assistantId}
            conversationId={activeConversationId}
            keyboardMode={threadVoiceKeyboard}
            onFlipToKeyboard={() => setThreadVoiceKeyboard(true)}
            onEnded={handleThreadVoiceEnded}
          />
        </div>
      ) : null}

      {/* COMPOSER — v3 glass field + "+" + mic/send (frames 8 + 13b). Hidden
          while the voice bar is showing (frame 37); the ⌨ flip brings it back
          with the session still alive. */}
      <div
        style={{
          display: threadVoiceOpen && !threadVoiceKeyboard ? "none" : undefined,
          flexShrink: 0,
          padding: "10px 16px",
          paddingBottom: keyboardOpen
            ? 10
            : "calc(10px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
          position: "relative",
          zIndex: 5,
          transform: composerLift
            ? `translateY(-${composerLift}px)`
            : undefined,
          transition: "transform .18s ease",
        }}
      >
        {voiceInterim ? (
          <div
            style={{
              fontFamily: "var(--mv3-mono)",
              fontSize: 11,
              color: "var(--mv3-micro)",
              padding: "0 4px 6px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {voiceInterim}
          </div>
        ) : null}
        {chatAttachments.length > 0 ? (
          <ChatAttachmentsStrip
            attachments={chatAttachments}
            onRemove={removeAttachment}
          />
        ) : null}
        {/* SLASH COMMANDS — rising v3 glass list (desktop SlashCommandPopup
            equivalent; same catalog + selection behaviour). */}
        {slash.show ? (
          <div
            role="listbox"
            aria-label="Commands"
            data-mchat-rise
            style={{
              marginBottom: 8,
              borderRadius: 18,
              overflow: "hidden",
              background: "var(--mv3-glass)",
              border: "1px solid var(--mv3-glass-border)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              boxShadow: "var(--mv3-glass-shadow)",
              animation: "mchatRise .18s ease both",
            }}
          >
            {slash.items.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                role="option"
                aria-selected={i === slash.selectedIndex}
                className="cue-pressable"
                onClick={() => handleSlashSelect(cmd)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  minHeight: 44,
                  padding: "10px 16px",
                  border: "none",
                  background:
                    i === slash.selectedIndex
                      ? "var(--mv3-btn2-bg)"
                      : "transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--mv3-mono)",
                    fontSize: 13,
                    color: "var(--mv3-accent)",
                    flexShrink: 0,
                  }}
                >
                  /{cmd.name}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    color: "var(--mv3-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cmd.description}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 6,
            background: "var(--mv3-glass)",
            border: `1px solid ${composerBorder}`,
            borderRadius: 24,
            padding: "4px 4px 4px 17px",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            boxShadow: "var(--mv3-glass-shadow)",
            transition: "border-color .15s ease",
          }}
        >
          <textarea
            ref={(el) => {
              inputElRef.current = el;
            }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={typingDisabled}
            rows={1}
            placeholder="Message Cue…"
            style={{
              flex: 1,
              resize: "none",
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--mv3-text)",
              // ≥16px (build rules): prevents iOS focus-zoom.
              fontSize: 16,
              lineHeight: 1.4,
              fontFamily: "inherit",
              padding: "10px 0",
              maxHeight: 120,
              minWidth: 0,
            }}
          />

          {/* Tune — composer settings (model profile + autonomy threshold),
              the v3 sheet mount of the desktop ComposerSettingsMenu. */}
          {assistantId ? (
            <button
              type="button"
              onClick={() => {
                haptic.light();
                setSettingsOpen(true);
              }}
              aria-label="Conversation settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              style={{
                width: 44,
                height: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
                flexShrink: 0,
                color: "var(--mv3-muted)",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <SlidersHorizontal size={17} aria-hidden />
            </button>
          ) : null}

          {/* "+" — attach (hidden picker into the shared composer store). */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handlePickFiles}
            style={{ display: "none" }}
            aria-hidden
            tabIndex={-1}
          />
          <button
            type="button"
            onClick={() => {
              haptic.light();
              fileInputRef.current?.click();
            }}
            aria-label="Add attachment"
            style={{
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              flexShrink: 0,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "var(--mv3-btn2-bg)",
                border: "1px solid var(--mv3-btn2-border)",
                color: "var(--mv3-muted)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Plus size={16} aria-hidden />
            </span>
          </button>

          {/* Voice orb entry (frame 37) — starts a live-voice session bound
              to THIS conversation. Distinct from the dictation mic below;
              gated on the voice-mode flag like the desktop overlay entry. */}
          {canThreadVoice && !threadVoiceOpen ? (
            <button
              type="button"
              onClick={handleStartThreadVoice}
              aria-label="Talk in this chat (voice)"
              style={{
                width: 44,
                height: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
                flexShrink: 0,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  color: "var(--mv3-micro)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AudioLines size={16} aria-hidden />
              </span>
            </button>
          ) : null}

          {showSend ? (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canStopGenerating && !canSend}
              aria-label={
                canStopGenerating ? "Stop generating" : "Send message"
              }
              style={{
                width: 44,
                height: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                background: "transparent",
                padding: 0,
                cursor:
                  canStopGenerating || canSend ? "pointer" : "default",
                flexShrink: 0,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  // Stop = quiet chrome (red stays reserved for failure);
                  // send = the frame-8 blue gradient circle.
                  background: canStopGenerating
                    ? "var(--mv3-btn2-bg)"
                    : canSend
                      ? "linear-gradient(160deg, #4E7CEC, #3560CC)"
                      : "var(--mv3-btn2-bg)",
                  border: canStopGenerating
                    ? "1px solid var(--mv3-btn2-border)"
                    : "none",
                  color:
                    !canStopGenerating && canSend
                      ? "#fff"
                      : "var(--mv3-text)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow:
                    !canStopGenerating && canSend
                      ? "0 8px 18px -6px rgba(61,110,232,.6)"
                      : "none",
                  opacity: !canStopGenerating && !canSend ? 0.55 : 1,
                }}
              >
                {canStopGenerating ? (
                  <Square size={13} fill="currentColor" aria-hidden />
                ) : (
                  <ArrowUp size={18} aria-hidden />
                )}
              </span>
            </button>
          ) : threadVoiceOpen ? (
            /* Voice session alive but the user flipped to typing (⌨) — the
               mic slot becomes the "voice active" orb chip that returns to
               the voice bar. Dictation is unavailable during a live session
               (single audio owner), so it can't collide. */
            <ThreadVoiceActiveChip
              onClick={() => {
                haptic.light();
                setThreadVoiceKeyboard(false);
              }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 44,
                minHeight: 44,
                flexShrink: 0,
                color: "var(--mv3-muted)",
              }}
            >
              {/* Mic when idle/empty. VoiceInputButton renders null when STT
                  is unsupported — the send circle appears on focus, so the
                  composer never reads as broken. */}
              <VoiceInputButton
                ref={voiceInputRef}
                onTranscript={onVoiceTranscript}
                onInterimTranscript={onVoiceInterimTranscript}
                onError={onVoiceError}
                onBeforeStart={onVoiceBeforeStart}
                assistantId={assistantId ?? undefined}
              />
            </div>
          )}
        </div>
      </div>

      {/* POWER-FEATURE SHEETS — portal into #viewport-overlays (SheetShell). */}
      {assistantId ? (
        <MobileComposerSettingsSheet
          assistantId={assistantId}
          conversationId={activeConversationId ?? undefined}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      <MobileConversationActionsSheet
        assistantId={assistantId}
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
      />
    </div>
  );
}
