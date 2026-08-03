/**
 * MobileChatView — the mobile v3 `/conversations/:id` chat screen (spec
 * frames 8 dark / 13b light).
 *
 * This is the MOBILE presentation branch for chat (rendered by `ChatMainPanel`
 * when `useMobileLayout()` is true). The desktop chat path (ChatBody + ChatComposer)
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
  LibraryBig,
  Menu as MenuIcon,
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
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  SLASH_PREFIX_RE,
  filteredCommands,
  selectedInputText,
  type SlashCommand,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { hasSomethingToSend } from "@/domains/chat/components/chat-composer/chat-composer-utils";
import { useTextPopup } from "@/domains/chat/components/chat-composer/use-text-popup";
import {
  HEADER_CONTROL,
  HEADER_GAP,
  HEADER_GUTTER,
  HEADER_LEADING_PULL,
  HEADER_TRAILING_PULL,
} from "@/components/nav/conversation-header-metrics";
import { RecentThreadsSheet } from "@/components/nav/recent-threads-sheet";
import {
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useConversationThing } from "@/domains/chat/partner/use-conversation-thing";
import { goBackWithFallback } from "@/domains/chat/utils/conversation-navigation";
import { PhoneChatFrame } from "@/mobile-v3/chats/phone-chat-frame";
import { composerFieldHeight } from "@/mobile-v3/chats/phone-keyboard";
import { usePhoneKeyboard } from "@/mobile-v3/chats/use-phone-keyboard";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";
import {
  workitemsByIdRunPostMutation,
  workitemsGetOptions,
  workitemsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { SpawnedWorkSlot } from "@/domains/chat/components/spawned-work-slot";
import { AuroraBackdrop } from "@/mobile-v3/aurora-backdrop";
import { FailureCard } from "@/mobile-v3/failure-card";
import { ComposerAffordance } from "@/mobile-v3/chats/composer-affordance";
import { ComposerCreateEntry } from "@/mobile-v3/chats/composer-create-entry";
import {
  LibraryReferenceSheet,
  withReference,
} from "@/mobile-v3/chats/library-reference-sheet";
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

/**
 * Composer field metrics. The 16px floor is a build rule (anything smaller
 * triggers iOS focus-zoom, which moves the window — the exact thing G3
 * forbids); 1.4 is the line-height it renders at, and 20 is the field's own
 * vertical padding. Five of these lines is the growth cap (spec 7).
 */
const COMPOSER_FONT_SIZE_PX = 16;
const COMPOSER_LINE_HEIGHT_PX = Math.round(COMPOSER_FONT_SIZE_PX * 1.4);
const COMPOSER_FIELD_PADDING_PX = 20;

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
  const [focused, setFocused] = useState(false);
  const inputElRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // THE KEYBOARD (v25 · G3). The window does not move; the thread's height is
  // the only thing that changes. All of the geometry — including the "has an
  // ancestor already absorbed the keyboard?" question that made the previous
  // version lift the composer twice — lives in `usePhoneKeyboard`, and the
  // column that consumes it is `PhoneChatFrame`. Nothing in this file
  // translates, scrolls the window, or reserves a keyboard by hand.
  const handleKeyboardDismiss = useCallback(() => {
    inputElRef.current?.blur();
  }, []);
  const {
    frame,
    shellRef,
    headerRef,
    composerRef,
    dragHandlers,
  } = usePhoneKeyboard({ onDismiss: handleKeyboardDismiss });
  const keyboardOpen = frame.keyboardOpen;

  // Power-feature sheets (composer settings ⋅ conversation actions) — the
  // v3-skinned mounts of the desktop menus (mobile-chat-menus.tsx).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  // ☰ — the thread switcher. Same control, same glyph and same sheet as the
  // corner chrome carries on HQ / Work / the chats index; here it is inline
  // because on a conversation route that fixed chrome does not render.
  const [threadsOpen, setThreadsOpen] = useState(false);

  // ▦ Library opens a sheet over this thread (G6). ✎ Create owns its own
  // open state inside ComposerCreateEntry — see that file for why the Create
  // sheet cannot be mounted from this domain.
  const [libraryOpen, setLibraryOpen] = useState(false);

  const activeConversationId = useConversationStore.use.activeConversationId();

  // ── In-thread voice orb (spec frame 37). The session is BOUND to this
  // conversation (start(assistantId, conversationId) — spoken turns persist
  // into the same thread). `keyboard` flips back to typing WITHOUT ending the
  // session (⌨); ✕ ends it. Gated on the same `voice-mode` flag the Voice
  // tab / desktop overlay use, and on an existing conversation to bind to.
  const voiceModeFlag = useAssistantFeatureFlagStore.use.voiceMode();
  const [threadVoiceOpen, setThreadVoiceOpen] = useState(false);
  const [threadVoiceKeyboard, setThreadVoiceKeyboard] = useState(false);
  // ⤢ presents the SAME session full screen (MobileThreadVoice stays mounted
  // and stays the controller), so expanding never restarts the call.
  const [threadVoiceFullScreen, setThreadVoiceFullScreen] = useState(false);
  const canThreadVoice = Boolean(
    voiceModeFlag && assistantId && activeConversationId,
  );
  const handleStartThreadVoice = useCallback(() => {
    haptic.medium();
    setThreadVoiceKeyboard(false);
    setThreadVoiceFullScreen(false);
    setThreadVoiceOpen(true);
  }, []);
  const handleThreadVoiceEnded = useCallback(() => {
    setThreadVoiceOpen(false);
    setThreadVoiceKeyboard(false);
    setThreadVoiceFullScreen(false);
  }, []);
  // Read-only: MobileThreadVoice owns the one live-voice controller; this is
  // just the phase, so the header and the composer's orb chip can stop claiming
  // a session that has already failed.
  const liveVoicePhase = useLiveVoiceStore.use.state();
  const handleToggleThreadVoiceFullScreen = useCallback(() => {
    setThreadVoiceFullScreen((open) => {
      // Coming back down from full screen lands on the voice bar, never on the
      // keyboard flip — the user was talking, not typing.
      if (open) setThreadVoiceKeyboard(false);
      return !open;
    });
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

  // ── The thing this conversation belongs to (`▤ Renew Acme`). Derived from
  // the work this thread actually spawned — never invented; a thread that has
  // filed nothing, or filed into two things, shows no chip. See
  // `useConversationThing`.
  const thing = useConversationThing(assistantId, activeConversationId);

  // The header's second line, in priority order. The thing chip is the one
  // design specified (it is what makes output file itself, and what tells you
  // which conversation you're in); the live lines supersede it only while
  // something is genuinely happening, because a live signal beats a static one.
  //
  // "voice active" has to mean active. A dropped session left the panel open
  // with the phase at `failed`, and this line went on announcing a call that
  // had already died — so the one place the user looks to see whether Cue is
  // listening was the place that lied to them.
  const statusLine = threadVoiceOpen
    ? liveVoicePhase === "failed"
      ? "voice ended — tap Try again"
      : "voice active in this chat"
    : runningCount > 0
      ? `working on ${runningCount} ${runningCount === 1 ? "thing" : "things"}`
      : null;

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

  // An attachment on its own IS a message — "here, look at this" is how people
  // send a photo. This composer required text as well, so picking a file and
  // tapping send did nothing at all: no send, no error, no explanation. Same
  // policy as the desktop composer's `canSendAttachments`, including the wait
  // for uploads to finish (sending an id that isn't stored yet drops the file).
  const attachmentsUploadingCount = useMemo(
    () => selectUploadingCount(chatAttachments),
    [chatAttachments],
  );
  const canSendAttachments = useMemo(
    () =>
      attachmentsUploadingCount === 0 &&
      selectUploadedIds(chatAttachments).length > 0,
    [attachmentsUploadingCount, chatAttachments],
  );

  const trimmed = input.trim();
  const canSend =
    hasSomethingToSend({ input, canSendAttachments }) && !sendDisabled;

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

  // Spec 7 — the field grows to five lines, then scrolls internally. The
  // thread shrinks to pay for it (the frame's flex column does that on its
  // own); the header and the composer's own chrome do not move.
  useEffect(() => {
    const el = inputElRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${composerFieldHeight(
      el.scrollHeight,
      COMPOSER_LINE_HEIGHT_PX,
      COMPOSER_FIELD_PADDING_PX,
    )}px`;
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
  // A ready attachment reveals the send circle even with the composer blurred
  // and empty — otherwise the one control that would send the file is the one
  // control that isn't on screen.
  const showSend =
    focused || trimmed.length > 0 || canSendAttachments || canStopGenerating;

  // ── HEADER (spec 5) — title + thing chip + actions, one line, pinned.
  //
  // It compacts rather than disappearing: with the keyboard up the vertical
  // padding halves and the status-bar inset is no longer paid (the notch is
  // above a viewport that has already been resized), so the line stays put
  // while the thread gets the room. It NEVER scrolls off, because it is not
  // inside a scroller — see PhoneChatFrame.
  //
  // Four elements: ‹ back · ☰ your chats · title · ⋯ actions.
  //
  // The frame draws ☰ · title · avatar. On this route the ☰ CORNER chrome does
  // not render (`overflowVisible` is exact-match on the tab landings), so for a
  // release the leading slot held only the ‹ back — and the screen had no door
  // to the thread list at all. The owner found that on his own phone: 151
  // conversations, and nothing in this header that opened them.
  //
  // So ☰ joins ‹ rather than replacing it. They are different exits: ‹ pops to
  // wherever this thread was opened FROM (Today, a project, a notification),
  // and ☰ opens the other threads. Collapsing them would have quietly deleted
  // one. The cost is 50px of title, budgeted and asserted in
  // `conversation-header-metrics.ts` — the paddings below come from there so
  // the test and the DOM cannot describe different headers. An avatar would be
  // a FIFTH element whose destination is one back-swipe away; it still isn't
  // here.
  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: HEADER_GAP,
        padding: keyboardOpen
          ? `2px ${HEADER_GUTTER}px 6px`
          : `calc(4px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px))) ${HEADER_GUTTER}px 12px`,
        borderBottom: "1px solid var(--mv3-line)",
        background: "var(--mv3-bg)",
        transition: "padding 0.25s cubic-bezier(0.42, 0, 0.58, 1)",
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
          width: HEADER_CONTROL,
          height: HEADER_CONTROL,
          border: "none",
          background: "transparent",
          color: "var(--mv3-micro)",
          cursor: "pointer",
          padding: 0,
          marginLeft: -HEADER_LEADING_PULL,
          flexShrink: 0,
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <ChevronLeft size={22} />
      </button>
      {/* ☰ — your chats. The one control the report asked for, in the corner
          the report named. Opens over the thread instead of navigating: you
          come back to a switcher, not to a screen. */}
      <button
        type="button"
        data-slot="mv3-thread-switcher"
        onClick={() => {
          haptic.light();
          setThreadsOpen(true);
        }}
        aria-label="Your chats"
        aria-haspopup="dialog"
        aria-expanded={threadsOpen}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: HEADER_CONTROL,
          height: HEADER_CONTROL,
          border: "none",
          background: "transparent",
          color: "var(--mv3-micro)",
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <MenuIcon size={19} aria-hidden />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--mv3-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {conversationTitle?.trim() || "Cue"}
        </div>
        {/* The thing chip — `▤ Renew Acme`. Real link or nothing; a live line
            supersedes it while something is actually happening. */}
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
        ) : thing ? (
          <div
            style={{
              fontSize: 11,
              color: "var(--mv3-teal-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden>{thing.emoji ?? "▤"}</span> {thing.title}
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
            width: HEADER_CONTROL,
            height: HEADER_CONTROL,
            border: "none",
            background: "transparent",
            color: "var(--mv3-micro)",
            cursor: "pointer",
            padding: 0,
            marginRight: -HEADER_TRAILING_PULL,
            flexShrink: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <MoreHorizontal size={20} aria-hidden />
        </button>
      ) : null}
    </div>
  );

  // ── THREAD — v3 greeting while empty; otherwise the reused live transcript
  // (streamed output + tool/step chips + subagents + surfaces + confirmations
  // all preserved, retinted via .cue-mchat).
  const thread = isEmptyConversation ? (
    <GreetingState
      greeting={greeting}
      starters={starters}
      onSelectStarter={onSelectStarter}
    />
  ) : (
    <Transcript ref={transcriptRef} {...transcriptProps} />
  );

  const dock = (
    <>
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
          {/* LONG WORK LEAVES THE CHAT (§2). Anything over ~30s becomes a
              task with a live line rather than a spinner, and this strip is
              where that line lives — "you started this here", with its real
              status and, once finished, where to read it. It was already
              built and tested (`partner/long-work.test.tsx`) but only
              rendered on the desktop path via ChatBody, so on the phone a
              long-running request left the thread saying nothing at all.
              Zero props by design: it reads the active assistant and
              conversation from their stores, and renders null when this
              conversation has spawned nothing. */}
          <SpawnedWorkSlot />
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
            fullScreen={threadVoiceFullScreen}
            onToggleFullScreen={handleToggleThreadVoiceFullScreen}
            conversationTitle={conversationTitle}
          />
        </div>
      ) : null}
    </>
  );

  // ── COMPOSER — v3 glass field + the four affordances (frames G1/G2).
  //
  // Its bottom inset is owned by PhoneChatFrame: with the keyboard up the
  // composer sits on the keys, with it down it sits on the home indicator.
  // Nothing here translates. The old `translateY(-keyboardHeight)` is the bug
  // design named — it moved the composer over the newest message instead of
  // taking the room from the thread, and it stacked with the root layout's own
  // viewport resize.
  const composer = (
    <div
      style={{
        // Full screen covers the whole screen, so the composer under it is
        // hidden regardless of the ⌨ flip — a full-screen CALL must not have a
        // typing surface's CTAs behind it.
        display:
          threadVoiceOpen && (threadVoiceFullScreen || !threadVoiceKeyboard)
            ? "none"
            : undefined,
        // No safe-area inset here. The app shell already pads its bottom by
        // it while the keyboard is down (root-layout), and the tab bar claws
        // that padding back and repaints it as its own ground when it is
        // present — so adding it a third time here paid for the home
        // indicator twice on a device and never showed up in a browser, where
        // the inset is 0.
        padding: "10px 16px",
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
                    color: "var(--mv3-accent-text)",
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
        {/* THE COMPOSER, AND ITS FOUR MODES (v25 · G1/G6).
            Field on top; ＋ attach · ✎ Create · ▦ Library · mic underneath.
            All four are states of THIS composer — same thread, same thing
            chip — which is why none of them is a tab. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: "var(--mv3-glass)",
            border: `1px solid ${composerBorder}`,
            borderRadius: 22,
            padding: "10px 12px 6px 15px",
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
            placeholder="Ask, or tell Cue what to take on"
            style={{
              width: "100%",
              resize: "none",
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--mv3-text)",
              // ≥16px (build rules): anything smaller triggers iOS focus-zoom,
              // which moves the window — the exact thing G3 forbids.
              fontSize: COMPOSER_FONT_SIZE_PX,
              lineHeight: 1.4,
              fontFamily: "inherit",
              padding: "0 0 4px",
              // Spec 7 — five lines, then the FIELD scrolls. Nothing else moves.
              maxHeight:
                COMPOSER_LINE_HEIGHT_PX * 5 + COMPOSER_FIELD_PADDING_PX,
              minWidth: 0,
            }}
          />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginTop: 6,
              paddingTop: 6,
              borderTop: "1px solid var(--mv3-line)",
            }}
          >
            {/* ＋ attach (hidden picker into the shared composer store). */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handlePickFiles}
              style={{ display: "none" }}
              aria-hidden
              tabIndex={-1}
            />
            <ComposerAffordance
              label="Add attachment"
              onPress={() => fileInputRef.current?.click()}
            >
              <Plus size={16} aria-hidden />
            </ComposerAffordance>

            {/* ✎ Create — a sheet over the composer, not a destination. */}
            <ComposerCreateEntry />

            {/* ▦ Library — pick a file to reference in what you're saying. */}
            {assistantId ? (
              <ComposerAffordance
                label="Reference a file from your library"
                expanded={libraryOpen}
                onPress={() => setLibraryOpen(true)}
              >
                <LibraryBig size={15} aria-hidden />
              </ComposerAffordance>
            ) : null}

            {/* Tune — composer settings (model profile + autonomy threshold),
                the v3 sheet mount of the desktop ComposerSettingsMenu. */}
            {assistantId ? (
              <ComposerAffordance
                label="Conversation settings"
                expanded={settingsOpen}
                onPress={() => setSettingsOpen(true)}
              >
                <SlidersHorizontal size={15} aria-hidden />
              </ComposerAffordance>
            ) : null}

            <span style={{ flex: 1 }} />

            {/* ◎ Voice — the mark IS the mic (frame G5). A live session bound
                to THIS conversation; spoken turns land in this thread. */}
            {canThreadVoice && !threadVoiceOpen && !showSend ? (
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
                  marginRight: -4,
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "var(--mv3-plus-shadow)",
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
          ) : threadVoiceOpen && liveVoicePhase !== "failed" ? (
            /* Voice session alive but the user flipped to typing (⌨) — the
               mic slot becomes the "voice active" orb chip that returns to
               the voice bar. Dictation is unavailable during a live session
               (single audio owner), so it can't collide.
               A FAILED session drops back to the plain mic: a glowing blue orb
               over a call that has already died is the chip promising
               something it cannot deliver. */
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
    </div>
  );

  return (
    <PhoneChatFrame
      frame={frame}
      shellRef={shellRef}
      headerRef={headerRef}
      composerRef={composerRef}
      dragHandlers={dragHandlers}
      header={header}
      thread={thread}
      dock={dock}
      composer={composer}
      className="cue-mchat"
      shellProps={{ "data-mv3": true }}
      style={{
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: MCHAT_TRANSCRIPT_THEME }} />
      <AuroraBackdrop />

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

      {/* ☰ THREAD SWITCHER — the same sheet the corner chrome opens on the tab
          landings, so "top-left is my chats" holds on every phone surface.
          It portals itself (SheetShell), so mounting it here costs nothing
          while closed. */}
      <RecentThreadsSheet
        open={threadsOpen}
        onClose={() => setThreadsOpen(false)}
        assistantId={assistantId}
      />


      {/* ▦ LIBRARY — pick a file to reference in what you're saying. Leads
          with what this conversation itself made. */}
      {assistantId ? (
        <LibraryReferenceSheet
          open={libraryOpen}
          onClose={() => setLibraryOpen(false)}
          assistantId={assistantId}
          conversationId={activeConversationId}
          onPick={(reference) => {
            setInput(withReference(input, reference));
            inputElRef.current?.focus();
          }}
        />
      ) : null}
    </PhoneChatFrame>
  );
}
