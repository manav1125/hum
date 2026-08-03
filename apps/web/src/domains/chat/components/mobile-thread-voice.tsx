/**
 * MobileThreadVoice — the per-conversation voice orb (mobile v3 spec frame 37).
 *
 * The design decision on frame 37 is "BOTH": the Voice tab keeps the
 * open-ended full-duplex surface, and this component adds the in-thread orb —
 * a live-voice session BOUND to the current conversation, presented as a
 * compact bottom voice bar in place of the chat composer. `MobileChatView`
 * mounts it while a thread voice session is open.
 *
 * Session ownership: this component is the single {@link useLiveVoice}
 * controller while mounted (the same rule VoiceModeSurface follows — never two
 * controllers at once). It stays mounted while the user flips to typing (⌨),
 * so the session survives the flip; only the bar presentation hides. The ✕
 * affordance (or a fatal failure dismissal) ends the session and unmounts.
 *
 * Rendering (frame 37, inline styles are the spec):
 *  · live strip — the CURRENT exchange rendered as chat citizens above the
 *    bar: the user's utterance as an italic 🎙 blue-tint bubble, the reply as
 *    an assistant glass bubble, result cards via the shared SurfaceRouter
 *    (the same card path the Voice tab uses — reused, not forked).
 *  · voice bar — breathing orb (tap = mute), 4-bar waveform, ⌨ flip-to-typing
 *    (does NOT end the session), ✕ end.
 *
 * WHAT THE STRIP MAY DRAW — the thread above it is the record of the
 * conversation, and this strip must never be a second copy of it. Persisted
 * voice turns carry the durable `voiceTurn` marker and MobileChatView already
 * renders them with this component's own {@link VOICE_BUBBLE_LOOK}, so anything
 * the strip draws for an exchange the thread already holds appears twice on
 * screen. The strip therefore shows only the CURRENT exchange, and only for as
 * long as the thread does not have it:
 *
 *  · cascade — the daemon runs the turn through the normal agent loop and
 *    broadcasts the persisted user message and every assistant delta onto the
 *    conversation, so the thread streams the whole exchange live. The strip
 *    contributes only the in-flight speech recognition (the partial transcript,
 *    which never leaves the voice socket) and the thinking marker.
 *  · gemini-live — the realtime engine writes the turn to the thread only when
 *    it completes and broadcasts nothing meanwhile, so for it the strip IS the
 *    live view of the exchange, until the turn closes and the thread takes over.
 *
 * FULL SCREEN — `fullScreen` swaps the strip + bar for {@link VoiceFullScreen},
 * the same session with the chat screen taken away. It is a change of
 * presentation only: this component stays mounted and stays the single
 * controller, so expanding or collapsing mid-sentence touches neither the
 * socket nor the mic. Full screen has no thread behind it, so unlike the strip
 * it draws the whole call — see that file.
 */

import { useCallback, useEffect, useState } from "react";

import { Expand, Keyboard, Mic, MicOff, X } from "lucide-react";

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";
import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import {
  useLiveVoiceStore,
  type LiveVoiceCard,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { VOICE_BUBBLE_LOOK } from "@/domains/chat/voice/live-voice/voice-bubble-look";
import { VoiceFullScreen } from "@/domains/chat/voice/voice-fullscreen";
import { haptic } from "@/utils/haptics";

// ---------------------------------------------------------------------------
// Frame-37 literals (inspected from docs/design/mobile-v3/cue-mobile-v3.html)
// ---------------------------------------------------------------------------

/**
 * The frame-37 voice "look" lives in the voice module ({@link
 * import("@/domains/chat/voice/live-voice/voice-bubble-look")}) so the live
 * strip, MobileChatView's reloaded transcript, and the full-screen surface all
 * draw a spoken turn from one set of values. Re-exported here because
 * MobileChatView has always imported it from this file.
 */
export { VOICE_BUBBLE_LOOK };

/** Voice user bubble — italic 🎙, blue tint (frame 37). */
const VOICE_BUBBLE: React.CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "78%",
  padding: "10px 14px",
  ...VOICE_BUBBLE_LOOK,
};

/** Assistant reply bubble (frame 37). */
const REPLY_BUBBLE: React.CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "88%",
  background: "rgba(28,32,44,.85)",
  border: "1px solid rgba(255,255,255,.09)",
  borderRadius: "18px 18px 18px 6px",
  padding: "11px 14px",
  fontSize: 14,
  lineHeight: 1.5,
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  color: "var(--mv3-text)",
};

/**
 * Scoped CSS: the orb breathe (frame 37's v3Breathe — transform/opacity only)
 * and the result-card retint (the same GlassCard treatment the Voice tab's
 * mv3 rendering applies over SurfaceRouter output, so cards read as v3 glass
 * without forking the surface components). Reduced motion → static.
 */
const THREAD_VOICE_CSS = `
@keyframes mchatVoiceBreathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.07); }
}
.cue-mchat-voice-cards .rounded-lg.border {
  border-radius: 20px;
  background: rgba(28,32,44,.85);
  border-color: rgba(255,255,255,.1);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 20px 44px -22px rgba(0,0,0,.7);
}
@media (prefers-reduced-motion: reduce) {
  .cue-mchat-voice-anim { animation: none !important; }
}
`;

/**
 * Build a `Surface` from a live-voice card — same 1:1 mapping the Voice tab
 * uses before handing cards to the shared SurfaceRouter.
 */
function toSurface(card: LiveVoiceCard): Surface {
  return {
    surfaceId: card.surfaceId,
    surfaceType: card.surfaceType,
    data: card.data,
    ...(card.title !== undefined ? { title: card.title } : {}),
    ...(card.actions ? { actions: card.actions.map((a) => ({ ...a })) } : {}),
  };
}

export interface MobileThreadVoiceProps {
  assistantId: string;
  /** The conversation the session binds to — spoken turns land in this thread. */
  conversationId: string;
  /** True while the user has flipped back to typing (⌨) — the bar hides but
   *  the session (and the live strip) stays alive. */
  keyboardMode: boolean;
  /** ⌨ tapped — flip to the text composer WITHOUT ending the session. */
  onFlipToKeyboard: () => void;
  /** Session fully over (✕, or a failure dismissed) — parent unmounts us. */
  onEnded: () => void;
  /** Present the SAME session full screen instead of as a strip + bar. */
  fullScreen?: boolean;
  /** Expand ⤢ / collapse ⌄ — presentation only; the session is untouched. */
  onToggleFullScreen?: () => void;
  /** Conversation title, shown in the full-screen header. */
  conversationTitle?: string | null;
}

export function MobileThreadVoice({
  assistantId,
  conversationId,
  keyboardMode,
  onFlipToKeyboard,
  onEnded,
  fullScreen = false,
  onToggleFullScreen,
  conversationTitle,
}: MobileThreadVoiceProps) {
  const {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    error,
    failureKind,
    muted,
    start,
    stop,
    setMuted,
  } = useLiveVoice();
  const cards = useLiveVoiceStore.use.cards();
  const engine = useLiveVoiceStore.use.engine();
  const turnClosed = useLiveVoiceStore.use.turnClosed();
  const turns = useLiveVoiceStore.use.turns();

  // Cards are display-only here (Slice 1 parity with the Voice tab — actions
  // don't round-trip on the live-voice channel yet).
  const handleCardAction = useCallback(() => {}, []);

  // ── Auto-start once, bound to this conversation.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started) return;
    setStarted(true);
    void start(assistantId, conversationId);
  }, [started, start, assistantId, conversationId]);

  const listening = state === "listening" || state === "transcribing";

  // Whether this session's turns reach the thread only after they finish (see
  // the header). When they do not, the strip carries the live exchange; when
  // the thread is already streaming it, the strip stays out of the way.
  const stripOwnsExchange = engine === "gemini-live";

  // The exchange is the strip's to draw until `turnClosed` — the moment the
  // session re-arms for the next utterance, by which point the completed turn
  // is a persisted 🎙 citizen of the thread above.
  const currentUser = (
    stripOwnsExchange && !turnClosed
      ? [finalTranscript, partialTranscript].filter(Boolean).join(" ")
      : // Cascade: the finalized utterance is persisted and broadcast the
        // moment the turn starts, so only the in-flight partial — which never
        // leaves the voice socket — is ours to show.
        partialTranscript
  ).trim();
  const currentAssistant =
    stripOwnsExchange && !turnClosed ? assistantTranscript.trim() : "";
  const active =
    state !== "idle" && state !== "failed" && state !== "connecting";
  const failed = state === "failed";

  const handleEnd = useCallback(() => {
    haptic.medium();
    void stop().finally(onEnded);
  }, [stop, onEnded]);

  const handleFlip = useCallback(() => {
    haptic.light();
    onFlipToKeyboard();
  }, [onFlipToKeyboard]);

  const handleOrbTap = useCallback(() => {
    haptic.light();
    setMuted(!muted);
  }, [setMuted, muted]);

  const handleExpand = useCallback(() => {
    haptic.light();
    onToggleFullScreen?.();
  }, [onToggleFullScreen]);

  const handleRetry = useCallback(() => {
    haptic.light();
    void start(assistantId, conversationId);
  }, [start, assistantId, conversationId]);

  // FULL SCREEN — the same session, the chat screen taken away. There is no
  // thread behind it, so the "don't redraw what the thread already has"
  // reasoning above does not apply here: it draws the whole open exchange for
  // BOTH engines, on top of the session's finished turns.
  if (fullScreen) {
    return (
      <VoiceFullScreen
        title={conversationTitle ?? null}
        turns={turns}
        // `turnClosed` means this exchange has already been appended to
        // `turns`; drawing it as the open one too would show it twice.
        currentUser={
          turnClosed
            ? ""
            : [finalTranscript, partialTranscript]
                .filter(Boolean)
                .join(" ")
                .trim()
        }
        currentAssistant={turnClosed ? "" : assistantTranscript.trim()}
        cards={cards}
        state={state}
        muted={muted}
        error={error}
        failureKind={failureKind}
        onCollapse={onToggleFullScreen ?? (() => {})}
        onEnd={handleEnd}
        onToggleMute={handleOrbTap}
        onRetry={handleRetry}
      />
    );
  }

  const hasStrip =
    currentUser.length > 0 ||
    currentAssistant.length > 0 ||
    cards.length > 0 ||
    state === "thinking";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <style dangerouslySetInnerHTML={{ __html: THREAD_VOICE_CSS }} />

      {/* LIVE STRIP — this session's exchanges as chat citizens (frame 37). */}
      {hasStrip ? (
        <div
          className="cue-mchat-voice-cards"
          style={{
            maxHeight: "38vh",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            display: "flex",
            flexDirection: "column",
            gap: 11,
            padding: "10px 16px 4px",
          }}
        >
          {currentUser ? (
            <div style={VOICE_BUBBLE}>
              <span aria-hidden>🎙 </span>&ldquo;{currentUser}&rdquo;
            </div>
          ) : null}
          {currentAssistant ? (
            <div style={REPLY_BUBBLE}>{currentAssistant}</div>
          ) : state === "thinking" ? (
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--mv3-micro)",
              }}
            >
              Thinking…
            </div>
          ) : null}
          {cards.map((card) => (
            <SurfaceRouter
              key={card.surfaceId}
              surface={toSurface(card)}
              onAction={handleCardAction}
            />
          ))}
        </div>
      ) : null}

      {/* VOICE BAR — orb · waveform · ⤢ · ⌨ · ✕ (frame 37). Hidden while the
          user is typing (⌨ flip); the session stays alive.
          A FAILED session is the exception and always shows: the ⌨ flip used to
          hide the failure row along with the bar, so a call that died while the
          user was typing said nothing at all — while the header still read
          "voice active in this chat" and the composer still showed the live orb
          chip. Two surfaces claiming a session that was already dead is the
          "it just drops out" report with no way to notice or recover. */}
      {!keyboardMode || failed ? (
        <div style={{ flexShrink: 0, padding: "10px 16px 0" }}>
          {failed ? (
            /* Quiet failure row — plain words, retry + end. No red (v3 rule:
               red is reserved for true run failure, not connectivity). */
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "rgba(22,26,36,.9)",
                border: "1px solid rgba(255,255,255,.1)",
                borderRadius: 26,
                padding: "9px 8px 9px 16px",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  color: "var(--mv3-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {failureKind === "mic"
                  ? "Cue can't reach your microphone."
                  : (error ?? "Voice couldn't connect.")}
              </span>
              <button
                type="button"
                onClick={handleRetry}
                style={{
                  minHeight: 44,
                  padding: "0 14px",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 99,
                  background: "var(--mv3-btn2-bg)",
                  color: "var(--mv3-text)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                Try again
              </button>
              <EndButton onClick={handleEnd} />
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "rgba(22,26,36,.9)",
                border: "1px solid rgba(61,110,232,.4)",
                borderRadius: 26,
                padding: "9px 14px",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
              }}
            >
              {/* Orb — breathing blue sphere + ping halo (tap = mute). */}
              <button
                type="button"
                onClick={handleOrbTap}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={muted}
                disabled={!active}
                style={{
                  position: "relative",
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: active ? "pointer" : "default",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span
                  style={{
                    position: "relative",
                    width: 38,
                    height: 38,
                    flexShrink: 0,
                    display: "block",
                  }}
                >
                  {listening && !muted ? (
                    <span
                      aria-hidden
                      className="cue-mchat-voice-anim"
                      style={{
                        position: "absolute",
                        inset: -4,
                        borderRadius: "50%",
                        border: "1.5px solid rgba(61,110,232,.55)",
                        animation: "mv3Ping 2s ease-out infinite",
                      }}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    className="cue-mchat-voice-anim"
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: "50%",
                      background:
                        "radial-gradient(circle at 35% 30%, #6E9BF5, #2B53C4)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 0 18px rgba(61,110,232,.6)",
                      animation: "mchatVoiceBreathe 3s ease-in-out infinite",
                      opacity: muted ? 0.45 : 1,
                      transition: "opacity .15s ease",
                    }}
                  >
                    {muted ? (
                      <MicOff size={15} color="#F4F4F6" aria-hidden />
                    ) : null}
                  </span>
                </span>
              </button>

              {/* Waveform — 4 staggered bars (animate only while listening). */}
              <span
                aria-hidden
                style={{
                  display: "flex",
                  gap: 2.5,
                  alignItems: "center",
                  height: 16,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {[0.55, 1, 0.4, 0.8].map((h, i) => (
                  <span
                    key={i}
                    className="cue-mchat-voice-anim"
                    style={{
                      width: 2.5,
                      height: `${h * 100}%`,
                      borderRadius: 99,
                      background: "#7FA3F2",
                      transformOrigin: "center",
                      opacity: listening && !muted ? 1 : 0.35,
                      animation:
                        listening && !muted
                          ? `mv3Bar .8s ease-in-out ${i * 0.15}s infinite`
                          : "none",
                    }}
                  />
                ))}
              </span>

              {/* Session phase, quiet. */}
              <span
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  flexShrink: 0,
                }}
              >
                {state === "connecting"
                  ? "connecting…"
                  : muted
                    ? "muted"
                    : state === "thinking"
                      ? "thinking…"
                      : state === "speaking"
                        ? "speaking"
                        : listening
                          ? "listening"
                          : ""}
              </span>

              {/* ⤢ — the same session, full screen. Presentation only. */}
              {onToggleFullScreen ? (
                <button
                  type="button"
                  onClick={handleExpand}
                  aria-label="Full-screen voice"
                  style={{
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    color: "var(--mv3-muted)",
                    cursor: "pointer",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <Expand size={16} aria-hidden />
                </button>
              ) : null}

              {/* ⌨ — back to typing WITHOUT ending the session. */}
              <button
                type="button"
                onClick={handleFlip}
                aria-label="Type instead (keep voice session)"
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  color: "var(--mv3-muted)",
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <Keyboard size={17} aria-hidden />
              </button>

              <EndButton onClick={handleEnd} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** ✕ end-session circle (30px visual in a 44pt target — frame 37). */
function EndButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="End voice session"
      style={{
        width: 44,
        height: 44,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          background: "rgba(255,255,255,.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--mv3-text)",
        }}
      >
        <X size={13} />
      </span>
    </button>
  );
}

/**
 * The compact "voice active" chip shown in the composer's mic slot while the
 * session is alive but the user is typing (⌨ flip). Tapping returns to the
 * voice bar. Rendered by MobileChatView (it needs no controller state).
 */
export function ThreadVoiceActiveChip({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Return to voice"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 44,
        minHeight: 44,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "radial-gradient(circle at 35% 30%, #6E9BF5, #2B53C4)",
          boxShadow: "0 0 14px rgba(61,110,232,.55)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Mic size={14} color="#fff" />
      </span>
    </button>
  );
}
