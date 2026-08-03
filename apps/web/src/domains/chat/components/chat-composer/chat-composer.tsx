import { ArrowUp, Square } from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  AttachFileButton,
  ChatAttachmentsStrip,
} from "@/domains/chat/components/chat-attachments/chat-attachments";
import {
  type ChatAttachment,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { StreamingWaveform } from "@/domains/chat/components/chat-composer/streaming-waveform";
import { ComposerModeChips } from "@/domains/chat/components/chat-composer/composer-mode-chips";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { type TurnPhase, useTurnStore } from "@/domains/chat/turn-store";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useAudioAmplitude } from "@/domains/chat/voice/use-audio-amplitude";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { isPointerCoarse } from "@/utils/pointer";
import { Button, Popover } from "@vellumai/design-library";

import {
  NON_VISION_IMAGE_NOTICE,
  attachDisabledReason,
  computeGhostSuffix,
  partitionAttachableFiles,
  shouldSubmitOnEnter,
} from "@/domains/chat/components/chat-composer/chat-composer-utils";
import {
  EMOJI_MIN_FILTER_LENGTH,
  EMOJI_TRIGGER_RE,
  type EmojiEntry,
  useEmojiSearch,
} from "@/domains/chat/components/chat-composer/emoji-catalog";
import { EmojiPickerPopup } from "@/domains/chat/components/chat-composer/emoji-picker-popup";
import {
  applyMarkdownFormatting,
  matchFormattingShortcut,
} from "@/domains/chat/components/chat-composer/markdown-formatting";
import {
  SLASH_PREFIX_RE,
  type SlashCommand,
  filteredCommands,
  selectedInputText,
  stripBackgroundCommand,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { SlashCommandPopup } from "@/domains/chat/components/chat-composer/slash-command-popup";
import { useTextPopup } from "@/domains/chat/components/chat-composer/use-text-popup";
import { BackgroundRunNotice } from "@/domains/chat/components/chat-composer/background-run-notice";
import { SendModeMenu } from "@/domains/chat/components/chat-composer/send-mode-menu";
import { useBackgroundRun } from "@/domains/chat/components/chat-composer/use-background-run";
import { isMacOSBrowser } from "@/runtime/platform-detection";

/**
 * Controlled composer used at the bottom of the chat (main variant) and inside
 * the app-editing split layout. The two call sites previously inlined the
 * composer JSX; this component is the consolidated version.
 *
 * The optional slots/voice props exist because the app-editing variant does
 * NOT render a voice button, threshold picker, context-window indicator, or
 * the notice banners above the form — only the main variant does. Passing
 * those as `undefined` keeps the app-editing layout byte-identical.
 */
export interface ChatComposerProps {
  // text + form
  input: string;
  /**
   * Accepts both a plain setter (`setInput("foo")`) and the React-state
   * updater form (`setInput((current) => …)`). The voice transcript handler
   * relies on the updater form; the rest of the composer only writes plain
   * strings.
   */
  setInput: Dispatch<SetStateAction<string>>;
  placeholder?: string;
  onSubmit: (event: FormEvent) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  typingDisabled: boolean;
  sendDisabled: boolean;
  attachmentsUploadingCount: number;
  canSendAttachments: boolean;

  // attachments
  chatAttachments: ChatAttachment[];
  onAddAttachmentFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;

  // voice — optional; when `voiceInputRef` is omitted the voice button is
  // skipped entirely (matches the app-editing variant which has no voice).
  voiceInputRef?: RefObject<VoiceInputButtonHandle | null>;
  onVoiceTranscript?: (text: string) => void;
  onVoiceInterimTranscript?: (text: string) => void;
  /** Live partial transcript shown as ghost text below the waveform while recording. */
  voiceInterim?: string;
  onVoiceError?: (code: string | null) => void;
  onVoiceBeforeStart?: () => boolean | Promise<boolean>;

  onStopGenerating: () => void;
  /**
   * Whether the active assistant turn can be cancelled. Computed by the
   * parent from {@link canStopGeneration} which accounts for server-side
   * processing state (survives page refresh), external-channel streaming,
   * and the local turn phase. The composer must not derive this locally
   * because the turn store resets to idle on refresh.
   */
  canStopGenerating: boolean;

  // assistant id used by AttachFileButton's disabled guard
  assistantId: string | null;

  // Active conversation the live-voice session should attach to. Optional —
  // when absent (e.g. the empty/new-conversation state) live voice still
  // starts a fresh session for the assistant. The app-editing variant, which
  // has no voice, leaves this undefined.
  conversationId?: string | null;

  /**
   * Enter in-chat voice mode (opens the orb overlay on the current
   * conversation). Wired by {@link import("@/domains/chat/components/chat-body").ChatBody},
   * which owns the overlay's open-state. When omitted (e.g. the app-editing
   * variant, which has no voice) the composer mic is not rendered. The mic also
   * self-gates on the `voice-mode` assistant flag — see the button below.
   */
  onEnterVoiceMode?: () => void;

  /**
   * Whether the currently-active inference model accepts **image** input.
   * Sourced at runtime from the daemon config API — defaults to `true`
   * (fail-open) when the daemon hasn't surfaced the flag yet.
   *
   * When `false`, images are filtered out of a pick/paste/drop and the user is
   * told why. It does NOT disable the paperclip: every other kind of file
   * reaches the model as a `file` block that providers serialize as extracted
   * text, so a text-only model (DeepSeek V4, MiniMax, Fireworks Kimi, several
   * OpenRouter models) has no opinion about a PDF. Disabling the button here
   * is what "I can't upload a file" meant on the desktop home screen.
   */
  modelSupportsVision?: boolean;

  // chrome surfacing existing buttons (rendered in the form's bottom-left row)
  thresholdPickerSlot?: ReactNode;
  contextWindowIndicatorSlot?: ReactNode;

  // Slot rendered above the form (between the max-width wrapper and the form).
  // The main variant uses this for attachment-error / voice-error / disk-pressure
  // notices and the live voice-interim preview. The app-editing variant omits it.
  noticesAboveFormSlot?: ReactNode;

  // When true, the form's top border-radius is removed so the billing banner
  // (which has only top corners rounded) sits flush against the form,
  // forming a single continuous card.
  hasBillingBanner?: boolean;

  // Cap for the textarea's auto-grow height in pixels. The empty state passes a
  // larger value so the user can compose long first messages without the box
  // clipping.
  textareaMaxHeightPx?: number;

  // When true, only Cmd+Enter (Mac) or Ctrl+Enter (Win/Linux) submits the
  // message; plain Enter inserts a newline. Defaults to false (Enter submits).
  cmdEnterMode?: boolean;

  // Ghost text autocomplete — shown as a dimmed suffix in the textarea when
  // the suggestion endpoint returns a completion for the current conversation.
  suggestion?: string | null;

  // Edit-message recall — up-arrow on empty input recalls last user message.
  onRecallLastMessage?: () => void;
  onCancelEdit?: () => void;
}

export function ChatComposer({
  input,
  setInput,
  placeholder = "What would you like to do?",
  onSubmit,
  inputRef,
  typingDisabled,
  sendDisabled,
  attachmentsUploadingCount,
  canSendAttachments,
  chatAttachments,
  onAddAttachmentFiles,
  onRemoveAttachment,
  voiceInputRef,
  onVoiceTranscript,
  onVoiceInterimTranscript,
  voiceInterim,
  onVoiceError,
  onVoiceBeforeStart,
  onStopGenerating,
  canStopGenerating,
  assistantId,
  // ChatBody reads `conversationId` to bind the in-chat voice overlay to the
  // active thread; entering voice mode itself is delegated to the overlay via
  // `onEnterVoiceMode`. The composer consumes it only to stamp a background
  // run's originating thread, so the item lands in that thread's spawned-work
  // strip rather than the queue with a null origin.
  conversationId,
  onEnterVoiceMode,
  thresholdPickerSlot,
  contextWindowIndicatorSlot,
  noticesAboveFormSlot,
  hasBillingBanner = false,
  textareaMaxHeightPx = 240,
  cmdEnterMode = false,
  suggestion,
  modelSupportsVision = true,
  onRecallLastMessage,
  onCancelEdit,
}: ChatComposerProps) {
  const voicePhase = useVoiceRecordingStore.use.phase();
  const isVoiceActive =
    voicePhase === "recording" || voicePhase === "processing";
  // Holds the MediaStream opened by VoiceInputButton so we can reuse it for
  // amplitude analysis rather than opening a second getUserMedia request.
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const { amplitude } = useAudioAmplitude({
    active: voicePhase === "recording" && voiceStream !== null,
    stream: voiceStream,
  });
  const setVoiceAudioLevel = useVoiceRecordingStore.use.setAudioLevel();
  useEffect(() => {
    if (!voiceStream) return;
    setVoiceAudioLevel(amplitude);
  }, [amplitude, voiceStream, setVoiceAudioLevel]);
  const showVoiceInput =
    voiceInputRef !== undefined && onVoiceTranscript !== undefined;

  /**
   * Whether this is the main composer rather than the app-editing side panel.
   *
   * The same signal the voice mic already used: the app-editing variant passes
   * no `voiceInputRef`/`onVoiceTranscript`, and its layout is documented as
   * byte-identical when the optional props are omitted. Create rides that gate
   * too — a split editing pane is not where "make me something new" belongs.
   */
  const showModeChips = showVoiceInput && Boolean(assistantId);

  // ---- Live voice (full-duplex conversation) ----------------------------
  // The composer's Voice chip (`ComposerModeChips`) self-gates on the
  // `voice-mode` flag and merely *enters* in-chat voice mode (it asks ChatBody to open the orb
  // overlay, whose `VoiceModeSurface` is the single `useLiveVoice` owner). The
  // composer itself never mounts a `useLiveVoice()` controller — it only *reads*
  // the projected session state from the store for its inline transcript strip
  // and the dictation mutual-exclusion below, so there is never a second
  // controller racing teardown on the shared store. The transcript surface and
  // the mutual-exclusion wiring must also no-op when the flag is off so the
  // composer is byte-identical for users without the flag.
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const liveVoiceEligible = voiceMode && showVoiceInput && !!assistantId;
  // Atomic per-field selectors re-render only on the fields they read.
  const liveVoiceState = useLiveVoiceStore.use.state();
  const liveVoicePartial = useLiveVoiceStore.use.partialTranscript();
  const liveVoiceFinal = useLiveVoiceStore.use.finalTranscript();
  const liveVoiceAssistant = useLiveVoiceStore.use.assistantTranscript();
  // Anything but idle/failed counts as an active session; while active the
  // dictation mic is disabled so the two capture flows never run at once.
  // `failed` is a retryable/inactive state in `useLiveVoice`, so we treat it as
  // inactive — otherwise dictation stays disabled and the (empty) transcript
  // surface stays mounted after a failed start.
  const isLiveVoiceActive =
    liveVoiceEligible &&
    liveVoiceState !== "idle" &&
    liveVoiceState !== "failed";

  const pointerCoarse = useMemo(() => isPointerCoarse(), []);
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();
  const isElectronHost = isElectron();

  // ---- Background runs ---------------------------------------------------
  // "Just go do this, I'll read it later" is the product's differentiator, and
  // until now it was only reachable from Home feed cards. Two entry points
  // land here: the send-button split menu, and the `/background` (`/later`)
  // slash command, which is stripped client-side and never sent as chat text.
  const backgroundRun = useBackgroundRun(assistantId, conversationId);
  const backgroundRunState = backgroundRun.state;
  const dispatchBackgroundRun = backgroundRun.dispatch;
  const rejectBackgroundRun = backgroundRun.reject;

  /** Null when a hand-off is possible; otherwise the human-readable blocker. */
  const backgroundDisabledReason = useMemo(() => {
    if (!assistantId) return "no assistant is connected";
    // A work item carries text only — silently dropping the user's files would
    // be worse than refusing the hand-off.
    if (chatAttachments.length > 0) return "attachments can't come along";
    if (backgroundRunState.kind === "dispatching")
      return "one is already being handed off";
    return null;
  }, [assistantId, chatAttachments.length, backgroundRunState.kind]);

  const runInBackground = useCallback(
    (text: string) => {
      const task = text.trim();
      if (task.length === 0) {
        rejectBackgroundRun("Say what you want done after /background.");
        return;
      }
      // Clear optimistically (the message is leaving this thread), and put it
      // back verbatim if nothing was actually created.
      setInput("");
      void dispatchBackgroundRun(task).then((created) => {
        if (!created) setInput(text);
      });
    },
    [dispatchBackgroundRun, rejectBackgroundRun, setInput],
  );

  /**
   * Submit interceptor. A message that opens with `/background` or `/later` is
   * dispatched as an autonomous run instead of a foreground turn; everything
   * else falls through to the parent's `onSubmit` untouched.
   */
  const handleSubmit = useCallback(
    (event: FormEvent) => {
      const commandTask = stripBackgroundCommand(input);
      if (commandTask === null) {
        onSubmit(event);
        return;
      }
      event.preventDefault();
      if (backgroundDisabledReason) {
        rejectBackgroundRun(
          `Can't run this in the background — ${backgroundDisabledReason}.`,
        );
        return;
      }
      runInBackground(commandTask);
    },
    [
      input,
      onSubmit,
      backgroundDisabledReason,
      rejectBackgroundRun,
      runInBackground,
    ],
  );

  /** Modifier that hands the current message off without opening the menu. */
  const backgroundShortcutHint = useMemo(
    () => (isMacOSBrowser() ? "⌘⇧↵" : "Ctrl+⇧+↵"),
    [],
  );

  // Stable ref so the autoSend paths always call the latest RAW onSubmit even
  // after flushSync triggers a synchronous re-render. Deliberately the parent's
  // handler, not `handleSubmit`: both callers below have already resolved
  // whether this is a background hand-off, so re-running the interceptor on
  // text they just rewrote would be wrong.
  const onSubmitRef = useRef(onSubmit);
  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
  });

  /**
   * "Send now" from the split menu. On an ordinary draft this is just submit.
   * On a `/background …` draft it means "send the TASK as a normal turn" — so
   * the command prefix is stripped first, rather than shipping the literal
   * `/background` text to a daemon that has no such command.
   */
  const sendNow = useCallback(() => {
    const commandTask = stripBackgroundCommand(input);
    const submitEvent = () => new Event("submit") as unknown as FormEvent;
    if (commandTask === null) {
      onSubmitRef.current(submitEvent());
      return;
    }
    if (commandTask.length === 0) {
      rejectBackgroundRun("Say what you want done after /background.");
      return;
    }
    flushSync(() => setInput(commandTask));
    onSubmitRef.current(submitEvent());
  }, [input, setInput, rejectBackgroundRun]);

  // Cursor position at the time of the last text change, used to derive the
  // emoji popup's trigger text. Updated in onChange and programmatic setInput
  // calls; defaults to end-of-input for the initial render.
  const cursorRef = useRef(input.length);

  // Slash and emoji popups — state is derived from the input text, not stored.
  const slash = useTextPopup({
    text: input,
    trigger: SLASH_PREFIX_RE,
    search: filteredCommands,
  });

  // Cursor position is a DOM property tracked via onSelect; using state
  // would re-render on every cursor movement.
  // eslint-disable-next-line react-hooks/refs
  const textBeforeCursor = input.slice(0, cursorRef.current);
  const searchEmoji = useEmojiSearch();
  const emoji = useTextPopup({
    text: textBeforeCursor,
    trigger: EMOJI_TRIGGER_RE,
    search: searchEmoji,
    minFilterLength: EMOJI_MIN_FILTER_LENGTH,
  });

  const handleSlashCommandSelect = useCallback(
    (command: SlashCommand) => {
      const newInput = selectedInputText(command);
      if (command.selectionBehavior === "autoSend") {
        // Suppress before flushSync so the synchronous re-render derives
        // show=false instead of briefly flashing the popup.
        slash.dismiss();
        flushSync(() => setInput(newInput));
        onSubmitRef.current(new Event("submit") as unknown as FormEvent);
      } else {
        cursorRef.current = newInput.length;
        setInput(newInput);
        inputRef.current?.focus();
      }
    },
    [setInput, inputRef, slash.dismiss],
  );

  const insertEmoji = useCallback(
    (entry: EmojiEntry) => {
      const el = inputRef.current;
      const cursorPos = el?.selectionStart ?? input.length;
      const colonPos = cursorPos - emoji.filter.length - 1;
      const newInput =
        input.slice(0, colonPos) + entry.emoji + input.slice(cursorPos);
      const newCursor = colonPos + entry.emoji.length;
      cursorRef.current = newCursor;
      setInput(newInput);
      requestAnimationFrame(() => {
        if (el) {
          el.setSelectionRange(newCursor, newCursor);
          el.focus();
        }
      });
    },
    [emoji.filter, input, inputRef, setInput],
  );

  const phase: TurnPhase = useTurnStore.use.phase();
  const isLocallyGenerating =
    phase === "queued" || phase === "thinking" || phase === "streaming";
  const showInlineVoicePreview =
    isVoiceActive && !isLocallyGenerating && !isElectronHost;
  const hideTextareaForVoice = isNative && showInlineVoicePreview;

  // ---- Attachments -------------------------------------------------------
  /**
   * Every way a file enters the composer — the paperclip, a paste, a drop —
   * ends here. It used to be three rules: paste filtered images and explained
   * itself, the drop zone did the same in `chat-route-content`, and the picker
   * did neither because the paperclip was simply *disabled* whenever the model
   * could not read images. On a text-only brain (the prod default; see the
   * daemon's `agent/vision-tier.ts`) that turned "this one PNG won't be read"
   * into "you cannot attach anything at all" — a PDF, a CSV and a `.txt` never
   * go near the vision path, and the picker refused them anyway.
   *
   * Same lesson as `hasSomethingToSend`: one helper, so the paths cannot
   * diverge again.
   */
  const acceptFiles = useCallback(
    (files: FileList | File[]) => {
      const { accepted, blockedImages } = partitionAttachableFiles(
        Array.from(files),
        modelSupportsVision,
      );
      // A no-op is not a success: if every file was an image the model can't
      // read, the user must be told, not left staring at an empty strip.
      if (blockedImages > 0) {
        useComposerStore.setState({
          attachmentLastError: NON_VISION_IMAGE_NOTICE,
        });
      }
      if (accepted.length > 0) onAddAttachmentFiles(accepted);
    },
    [modelSupportsVision, onAddAttachmentFiles],
  );

  /** Null when the paperclip is usable; otherwise the tooltip saying why not. */
  const attachDisabled = attachDisabledReason({ typingDisabled, assistantId });

  const ghostSuffix = useMemo(
    () =>
      computeGhostSuffix({
        pointerCoarse,
        suggestion: suggestion ?? null,
        input,
        hasAttachments: chatAttachments.length > 0,
      }),
    [pointerCoarse, suggestion, input, chatAttachments],
  );

  return (
    <>
      {noticesAboveFormSlot}
      <BackgroundRunNotice
        state={backgroundRunState}
        onDismiss={backgroundRun.dismiss}
      />
      <Popover.Root open={emoji.show || slash.show}>
        <Popover.Anchor asChild>
          <form
            onSubmit={handleSubmit}
            className={`overflow-hidden bg-[var(--surface-lift)] shadow-[0px_2px_2px_rgba(0,0,0,0.05)] ${
              hasBillingBanner ? "rounded-b-[10px]" : "rounded-[10px]"
            }`}
          >
            <ChatAttachmentsStrip
              attachments={chatAttachments}
              onRemove={onRemoveAttachment}
            />
            {/* CSS Grid hidden-mirror technique for auto-growing textarea.
            A hidden div mirrors the textarea content in the same grid cell.
            The grid auto-sizes to max(mirror_height, textarea_intrinsic_height),
            so the textarea stretches to fit — no JS height measurement needed.
            This avoids the iOS WKWebView re-dispatch bug entirely: no DOM
            geometry mutation means no re-fired input events.
            Reference: https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/ */}
            <div className={hideTextareaForVoice ? "hidden" : "grid"}>
              <div
                aria-hidden
                className="pointer-events-none col-start-1 row-start-1 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 pb-2 text-chat"
                style={{
                  fontFamily: "inherit",
                  letterSpacing: "inherit",
                  maxHeight: `${textareaMaxHeightPx}px`,
                }}
              >
                <span className="invisible">{input}</span>
                {ghostSuffix && (
                  <span className="text-[var(--content-disabled)]">
                    {ghostSuffix}
                  </span>
                )}
                <span className="invisible"> </span>
              </div>
              <textarea
                ref={inputRef}
                data-coach="chat-composer"
                value={input}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                onChange={(e) => {
                  const value = e.target.value;
                  cursorRef.current = e.target.selectionStart ?? value.length;
                  setInput(value);
                }}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const files: File[] = [];
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item?.kind === "file") {
                      const file = item.getAsFile();
                      if (file) files.push(file);
                    }
                  }
                  if (files.length > 0) {
                    e.preventDefault();
                    acceptFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (slash.show) {
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      slash.moveUp();
                      return;
                    }
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      slash.moveDown();
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      e.preventDefault();
                      const cmd = slash.items[slash.selectedIndex];
                      if (cmd) handleSlashCommandSelect(cmd);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      slash.dismiss();
                      setInput("");
                      return;
                    }
                  }

                  if (emoji.show) {
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      emoji.moveUp();
                      return;
                    }
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      emoji.moveDown();
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const selected = emoji.items[emoji.selectedIndex];
                      if (selected) insertEmoji(selected);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      emoji.dismiss();
                      return;
                    }
                  }

                  // Cmd/Ctrl + Shift + Enter — hand the current message off to
                  // a background run without opening the send-options menu.
                  // Always intercepted when there is text, so the modifier can
                  // never quietly fall through to an ordinary foreground send.
                  if (
                    e.key === "Enter" &&
                    e.shiftKey &&
                    (e.metaKey || e.ctrlKey) &&
                    !e.nativeEvent.isComposing &&
                    input.trim()
                  ) {
                    e.preventDefault();
                    if (backgroundDisabledReason) {
                      rejectBackgroundRun(
                        `Can't run this in the background — ${backgroundDisabledReason}.`,
                      );
                      return;
                    }
                    runInBackground(stripBackgroundCommand(input) ?? input);
                    return;
                  }

                  if (
                    e.key === "ArrowUp" &&
                    !input.trim() &&
                    onRecallLastMessage
                  ) {
                    e.preventDefault();
                    onRecallLastMessage();
                    return;
                  }

                  if (e.key === "Escape" && onCancelEdit) {
                    e.preventDefault();
                    onCancelEdit();
                    return;
                  }

                  const marker = matchFormattingShortcut(e);
                  if (marker) {
                    e.preventDefault();
                    const el = inputRef.current;
                    const start = el?.selectionStart ?? input.length;
                    const end = el?.selectionEnd ?? start;
                    const result = applyMarkdownFormatting(
                      input,
                      start,
                      end,
                      marker,
                    );
                    cursorRef.current = result.selectionStart;
                    setInput(result.text);
                    requestAnimationFrame(() => {
                      if (el) {
                        el.setSelectionRange(
                          result.selectionStart,
                          result.selectionEnd,
                        );
                        el.focus();
                      }
                    });
                    return;
                  }

                  if (e.key === "Tab" && ghostSuffix) {
                    e.preventDefault();
                    const accepted = input + ghostSuffix;
                    cursorRef.current = accepted.length;
                    setInput(accepted);
                    return;
                  }
                  const decision = shouldSubmitOnEnter(
                    {
                      key: e.key,
                      shiftKey: e.shiftKey,
                      metaKey: e.metaKey,
                      ctrlKey: e.ctrlKey,
                      isComposing: e.nativeEvent.isComposing,
                      keyCode: e.keyCode,
                    },
                    pointerCoarse,
                    {
                      input,
                      canSendAttachments,
                      sendDisabled,
                      attachmentsUploadingCount,
                      cmdEnterMode,
                    },
                  );
                  if (decision === "ignore") {
                    return;
                  }
                  e.preventDefault();
                  if (decision === "submit") {
                    handleSubmit(e as unknown as FormEvent);
                  }
                }}
                placeholder={ghostSuffix ? "" : placeholder}
                disabled={typingDisabled}
                rows={1}
                className="col-start-1 row-start-1 w-full resize-none overflow-y-auto border-none bg-transparent px-4 pt-3 pb-2 text-chat text-[var(--content-default)] placeholder:text-[var(--content-disabled)] focus:outline-none disabled:opacity-50"
                style={{ maxHeight: `${textareaMaxHeightPx}px` }}
              />
            </div>
            {showInlineVoicePreview && (
              // Non-Electron fallback: Electron uses the shared top-center
              // dictation overlay for both focused and global recording.
              // Browser/iOS hosts keep this inline waveform because the
              // overlay bridge no-ops there.
              <div
                className={hideTextareaForVoice ? "px-2 pt-3" : "px-2"}
                aria-label={
                  voicePhase === "processing" ? "Transcribing" : "Recording"
                }
                aria-live="polite"
              >
                <StreamingWaveform
                  amplitude={amplitude}
                  paused={voicePhase === "processing"}
                />
                {voicePhase === "processing" ? (
                  <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
                    Transcribing…
                  </p>
                ) : (
                  voiceInterim && (
                    // Partial transcript ghost text — mirrors macOS composerTextField
                    // showing interim results in the input binding while speaking.
                    <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
                      {voiceInterim}
                    </p>
                  )
                )}
              </div>
            )}
            {isLiveVoiceActive && (
              // Live-voice transcript surface — distinct from the dictation
              // interim preview above, which only exists while the dictation
              // recorder is running. Shows the user's partial/final speech and
              // the streaming assistant reply for the in-flight turn.
              <div
                className="px-4 pb-1 space-y-0.5"
                aria-label="Live voice transcript"
                aria-live="polite"
              >
                {(liveVoicePartial || liveVoiceFinal) && (
                  <p className="truncate text-[11px] text-[var(--content-secondary)]">
                    {liveVoicePartial || liveVoiceFinal}
                  </p>
                )}
                {liveVoiceAssistant && (
                  <p className="truncate text-[11px] italic text-[var(--content-tertiary)]">
                    {liveVoiceAssistant}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between px-2 pb-2">
              <div className="flex min-w-0 items-center gap-1">
                {/* Create + Voice — v15 README l.64, "Create and Voice stay
                composer chips". Left group, away from the icon cluster on the
                right, because the previous version put an unlabelled mic
                beside the dictation mic and the affordance disappeared into
                the row. Rendered on the main composer only: the app-editing
                side panel passes no voice props (`showVoiceInput` false) and
                stays byte-identical, which is the invariant that variant has
                had since the composer was extracted. */}
                {showModeChips && (
                  <ComposerModeChips
                    onEnterVoiceMode={onEnterVoiceMode}
                    // `canStopGenerating` is included so the chip is present
                    // but inert mid-turn. The icon it replaced was *absent*
                    // mid-turn; keeping it visible holds the composer's
                    // geometry still (§8 — the composer is fixed furniture)
                    // without granting an entry point that did not exist.
                    voiceDisabled={
                      typingDisabled || isVoiceActive || canStopGenerating
                    }
                  />
                )}
                {thresholdPickerSlot}
                {contextWindowIndicatorSlot}
              </div>
              <div className="flex items-center gap-1">
                {canStopGenerating ? (
                  <>
                    {/* Desktop: always show stop. Mobile: show stop only when user has no input. */}
                    {(!isMobile || (!input.trim() && !canSendAttachments)) && (
                      <Button
                        variant="primary"
                        iconOnly={
                          <Square className="h-3 w-3" fill="currentColor" />
                        }
                        onClick={onStopGenerating}
                        aria-label="Stop generating"
                      />
                    )}
                    {/* Mobile: show send instead of stop when user has typed input (for message queueing). */}
                    {isMobile && (input.trim() || canSendAttachments) && (
                      <Button
                        variant="primary"
                        iconOnly={
                          <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                        }
                        type="submit"
                        disabled={sendDisabled || attachmentsUploadingCount > 0}
                        title={
                          sendDisabled
                            ? "Type a message to send"
                            : attachmentsUploadingCount > 0
                              ? "Uploading attachments…"
                              : "Send message"
                        }
                        aria-label="Send message"
                      />
                    )}
                  </>
                ) : (
                  <>
                    <AttachFileButton
                      disabled={attachDisabled !== null}
                      onFilesSelected={acceptFiles}
                      title={attachDisabled ?? undefined}
                    />
                    {showVoiceInput && (
                      <VoiceInputButton
                        ref={voiceInputRef}
                        dataCoach="chat-voice"
                        assistantId={assistantId}
                        // Mutual exclusion: an active live-voice session
                        // disables the dictation mic so the two capture flows
                        // never run simultaneously.
                        disabled={typingDisabled || isLiveVoiceActive}
                        onTranscript={onVoiceTranscript}
                        onInterimTranscript={onVoiceInterimTranscript}
                        onError={onVoiceError}
                        onBeforeStart={onVoiceBeforeStart}
                        onStreamReady={(stream: MediaStream | null) => {
                          voiceStreamRef.current = stream;
                          setVoiceStream(stream);
                        }}
                      />
                    )}
                    {/* Split half of the send button — "run this in the
                    background" lives here rather than as another naked icon in
                    an already-crowded row. Appears only once there is text to
                    hand off, so the resting composer is unchanged. */}
                    {!isVoiceActive && (
                      <SendModeMenu
                        visible={
                          !!assistantId && !sendDisabled && !!input.trim()
                        }
                        disabledReason={backgroundDisabledReason}
                        shortcutHint={backgroundShortcutHint}
                        onSendNow={sendNow}
                        onRunInBackground={() =>
                          runInBackground(
                            stripBackgroundCommand(input) ?? input,
                          )
                        }
                      />
                    )}
                    {/* macOS parity: the send button is hidden during recording
                    and while transcription is being processed. Only the voice
                    button (mic / stop / spinner) is shown. */}
                    {!isVoiceActive && (
                      <Button
                        variant="primary"
                        iconOnly={
                          <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                        }
                        type="submit"
                        disabled={
                          sendDisabled ||
                          attachmentsUploadingCount > 0 ||
                          (!input.trim() && !canSendAttachments)
                        }
                        title={
                          sendDisabled || (!input.trim() && !canSendAttachments)
                            ? "Type a message to send"
                            : attachmentsUploadingCount > 0
                              ? "Uploading attachments…"
                              : "Send message"
                        }
                        aria-label="Send message"
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          </form>
        </Popover.Anchor>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] rounded-none bg-transparent p-0 shadow-none"
          onOpenAutoFocus={(e: Event) => e.preventDefault()}
          onCloseAutoFocus={(e: Event) => e.preventDefault()}
          onInteractOutside={(e: Event) => e.preventDefault()}
          onEscapeKeyDown={(e: Event) => e.preventDefault()}
          onPointerDownOutside={(e: Event) => e.preventDefault()}
        >
          {emoji.show && (
            <EmojiPickerPopup
              entries={emoji.items}
              selectedIndex={emoji.selectedIndex}
              onSelect={insertEmoji}
            />
          )}
          {slash.show && (
            <SlashCommandPopup
              commands={slash.items}
              selectedIndex={slash.selectedIndex}
              onSelect={handleSlashCommandSelect}
            />
          )}
        </Popover.Content>
      </Popover.Root>
    </>
  );
}
