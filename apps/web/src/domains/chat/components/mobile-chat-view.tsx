/**
 * MobileChatView — the design-book `/conversations/:id` chat screen.
 *
 * This is the MOBILE presentation branch for chat (rendered by `ChatMainPanel`
 * when `useIsMobile()` is true). The desktop chat path (ChatBody + ChatComposer)
 * is left entirely unchanged.
 *
 * It is a pure restyle/restructure: it REUSES the live message-stream wiring —
 * the same `Transcript` component (so streamed output, tool/step chips,
 * subagent cards, surfaces, confirmations all keep working), the same
 * `submitMessage` / `input` / `setInput` send path, the same `VoiceInputButton`,
 * and the same streaming/stop flags that the desktop path uses. Nothing about
 * the data layer is reinvented here; only the chrome (dark canvas, header,
 * message-bubble theming, pinned keyboard-aware composer) is built to the
 * mobile design book (`Cue Mobile.dc.html`, README §3.5 + Dark v1 tokens).
 *
 * The transcript is rendered inside a scoped `.cue-mchat` wrapper that rebinds
 * the design-library semantic CSS variables to the dark-v1 palette, so the
 * reused transcript rows / markdown / chips read correctly on the dark canvas
 * without forking any of those components. The user bubble is recoloured to the
 * book's blue via a scoped rule on its `--surface-lift` background.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowUp, ChevronLeft, Square } from "lucide-react";

import { Transcript, type TranscriptHandle, type TranscriptProps } from "@/domains/chat/transcript/transcript";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { useVisibleViewport } from "@/hooks/use-visible-viewport";
import { routes } from "@/utils/routes";

// Dark-v1 mobile tokens — mirrors the inline hexes in `Cue Mobile.dc.html`
// (README §1, Dark). Kept local so the mobile chat reads as one coherent dark
// surface independent of the light desktop canvas, matching `TodayMobile`.
const M = {
  ink: "#1A2230",
  inkDeep: "#11161F",
  inkBottom: "#0C1018",
  surface: "#212B3B",
  surface2: "#2A3547",
  blue: "#3D6EE8",
  blueEyebrow: "#86A9F2",
  t1: "#FFFFFF",
  t2: "#8A97AC",
  t3: "#5E6B80",
  danger: "#E5634B",
  line: "rgba(255,255,255,.08)",
  markChip: "#0F1620",
} as const;

const mono = "'DM Mono', ui-monospace, monospace";

const MCHAT_KEYFRAMES = `
@keyframes cueLook{0%,100%{transform:rotate(40deg)}50%{transform:rotate(64deg)}}
@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}
@media (prefers-reduced-motion: reduce){.cue-mchat-anim *{animation:none !important}}
`;

// Scoped dark theme for the reused transcript. We rebind the design-library
// semantic tokens (read by transcript rows / markdown / tool chips) to the
// dark-v1 palette, and recolour the user bubble (which uses --surface-lift) to
// the design book's blue. This keeps the transcript a single reused component.
const MCHAT_TRANSCRIPT_THEME = `
.cue-mchat {
  --background: ${M.ink};
  --surface-base: ${M.ink};
  --surface-lift: ${M.surface};
  --surface-overlay: ${M.surface2};
  --content-default: ${M.t1};
  --content-secondary: ${M.t2};
  --content-tertiary: ${M.t3};
  --border-base: ${M.line};
}
/* User bubble → design-book blue. The transcript user bubble is the only
   --surface-lift element aligned to the end of the row; scope by alignment. */
.cue-mchat .self-end .bg-\\[var\\(--surface-lift\\)\\],
.cue-mchat .items-end > .bg-\\[var\\(--surface-lift\\)\\] {
  background: ${M.blue} !important;
  color: #fff !important;
}
`;

export interface MobileChatViewProps {
  /** The exact transcript props the desktop path assembles — reused verbatim so
   *  the message stream (streamed output, tool/step chips, subagents, surfaces,
   *  confirmations) behaves identically. */
  transcriptProps: TranscriptProps;
  /** Shared transcript handle (owned by ActiveChatView for scroll/debug). */
  transcriptRef: React.RefObject<TranscriptHandle | null>;
  /** Conversation title shown as the header subtitle (e.g. "Acme renewal"). */
  conversationTitle?: string | null;

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

/** The aperture mark chip used in the header (dark chip + light ring + blue dot). */
function ApertureMark() {
  return (
    <span
      style={{
        position: "relative",
        width: 28,
        height: 28,
        borderRadius: 8,
        background: M.markChip,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          boxShadow: "0 0 0 2.4px #EEF2F7 inset",
          WebkitMask: "radial-gradient(circle,transparent 56%,#000 57%)",
          mask: "radial-gradient(circle,transparent 56%,#000 57%)",
          transform: "rotate(40deg)",
          animation: "cueLook 6s ease-in-out infinite",
          position: "relative",
          display: "block",
        }}
      >
        <span
          style={{
            position: "absolute",
            borderRadius: "50%",
            background: M.blue,
            width: "26%",
            height: "26%",
            top: "8%",
            left: "8%",
            animation: "cueBlink 4s infinite",
            display: "block",
          }}
        />
      </span>
    </span>
  );
}

export function MobileChatView({
  transcriptProps,
  transcriptRef,
  conversationTitle,
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
  const viewport = useVisibleViewport();
  const keyboardHeight = viewport?.keyboardHeight ?? 0;
  const keyboardOpen = keyboardHeight > 0;
  const [focused, setFocused] = useState(false);
  const inputElRef = useRef<HTMLTextAreaElement | null>(null);

  // Keyboard-aware composer: when the soft keyboard opens, lift the pinned
  // composer to sit directly above it (README §3.5 "the #1 native feel").
  // `useVisibleViewport` already normalises iOS Safari vs. WKWebView.
  const composerLift = keyboardOpen ? keyboardHeight : 0;

  const trimmed = input.trim();
  const canSend = trimmed.length > 0 && !sendDisabled;

  const handleSend = useCallback(() => {
    if (canStopGenerating) {
      void onStopGenerating();
      return;
    }
    if (!canSend) return;
    void onSubmit();
  }, [canStopGenerating, onStopGenerating, canSend, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends (no Shift) — matches the native single-line composer feel.
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-grow the textarea up to a few lines, like the design-book composer.
  useEffect(() => {
    const el = inputElRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const handleBack = useCallback(() => {
    // Back ‹ returns to where you came from (README §3.5). The conversation
    // list is the safe origin when there's no history to pop.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(routes.home);
    }
  }, [navigate]);

  // Border lights blue + send arrow appears on focus (the book's "Keyboard"
  // state). The mic shows when idle / empty.
  const composerBorder = focused || keyboardOpen ? M.blue : M.line;
  const showSend = focused || trimmed.length > 0 || canStopGenerating;

  return (
    <div
      className="cue-mchat cue-mchat-anim"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: `linear-gradient(180deg, ${M.ink} 0%, ${M.inkDeep} 90%, ${M.inkBottom} 100%)`,
        color: M.t1,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: MCHAT_KEYFRAMES + MCHAT_TRANSCRIPT_THEME }} />

      {/* HEADER — back ‹ + aperture + Cue / conversation subtitle. */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px 10px",
          borderBottom: `1px solid ${M.line}`,
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
            width: 36,
            height: 36,
            border: "none",
            background: "transparent",
            color: M.blueEyebrow,
            cursor: "pointer",
            padding: 0,
            marginLeft: -6,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <ChevronLeft size={22} />
        </button>
        <ApertureMark />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: M.t1 }}>Cue</div>
          {conversationTitle ? (
            <div
              style={{
                fontFamily: mono,
                fontSize: 9,
                color: M.t2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {conversationTitle}
            </div>
          ) : null}
        </div>
      </div>

      {/* THREAD — the reused live transcript (streamed output + tool/step chips
          + subagents + surfaces + confirmations all preserved). */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Transcript ref={transcriptRef} {...transcriptProps} />
      </div>

      {/* COMPOSER — pinned, rises to sit above the keyboard. "Message Cue…" + mic. */}
      <div
        style={{
          flexShrink: 0,
          padding: "9px 14px",
          paddingBottom: keyboardOpen
            ? 9
            : "calc(9px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
          background: "rgba(12,16,24,.55)",
          backdropFilter: "blur(8px)",
          transform: composerLift ? `translateY(-${composerLift}px)` : undefined,
          transition: "transform .18s ease",
        }}
      >
        {voiceInterim ? (
          <div
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: M.blueEyebrow,
              padding: "0 4px 6px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {voiceInterim}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 9,
            background: M.surface,
            border: `1px solid ${composerBorder}`,
            borderRadius: 16,
            padding: "6px 7px 6px 14px",
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
              color: M.t1,
              fontSize: 14,
              lineHeight: 1.4,
              fontFamily: "inherit",
              padding: "7px 0",
              maxHeight: 120,
              minWidth: 0,
            }}
          />
          {showSend ? (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canStopGenerating && !canSend}
              aria-label={canStopGenerating ? "Stop generating" : "Send message"}
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: "none",
                background: canStopGenerating
                  ? M.danger
                  : canSend
                    ? M.blue
                    : M.surface2,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: canStopGenerating || canSend ? "pointer" : "default",
                flexShrink: 0,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {canStopGenerating ? (
                <Square size={13} fill="currentColor" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                color: M.t2,
              }}
            >
              {/* Mic when idle/empty (README §3.5). VoiceInputButton renders
                  null when STT is unsupported — the design-book send circle is
                  the fallback affordance so the composer never reads as broken. */}
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
}
