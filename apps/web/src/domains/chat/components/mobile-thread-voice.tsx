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
 * HONEST LIMIT (persistence marker): the daemon persists voice turns into the
 * conversation with no voice marker — the cascade engine stamps
 * `sourceInterface: "macos"` (assistant/src/live-voice/live-voice-session.ts)
 * and the Gemini path plain `addMessage` (live-voice-thread.ts) — so persisted
 * voice turns are indistinguishable from typed ones after reload. The italic
 * 🎙 treatment is therefore applied to the LIVE session's turns only (tracked
 * locally per turn); once the thread is reloaded from history those turns
 * render as regular bubbles. Styling them retroactively would require a
 * server-side marker that doesn't exist yet.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Keyboard, Mic, MicOff, X } from "lucide-react";

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";
import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import {
  useLiveVoiceStore,
  type LiveVoiceCard,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { haptic } from "@/utils/haptics";

// ---------------------------------------------------------------------------
// Frame-37 literals (inspected from docs/design/mobile-v3/cue-mobile-v3.html)
// ---------------------------------------------------------------------------

/**
 * The frame-37 voice "look" (surface + type treatment), split from the
 * strip-local layout below so MobileChatView can retint PERSISTED voice turns
 * (wire `voiceTurn`) in the reused transcript with the exact same values —
 * single source, no drift between live and reloaded voice bubbles.
 */
export const VOICE_BUBBLE_LOOK = {
  background: "rgba(61,110,232,.2)",
  border: "1px solid rgba(61,110,232,.35)",
  borderRadius: "18px 18px 6px 18px",
  fontSize: 13.5,
  lineHeight: 1.45,
  fontStyle: "italic",
  color: "#C7D6F5",
} as const;

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

/** A completed exchange within the live session (kept locally — see header). */
interface ThreadVoiceTurn {
  user: string;
  assistant: string;
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
}

export function MobileThreadVoice({
  assistantId,
  conversationId,
  keyboardMode,
  onFlipToKeyboard,
  onEnded,
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

  // ── Session-local turn history (see the honesty note in the header): when a
  // full-duplex turn completes (speaking → listening re-arm), archive the
  // exchange so it stays visible as 🎙 bubbles while the session continues.
  const [turns, setTurns] = useState<ThreadVoiceTurn[]>([]);
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (prev === "speaking" && state === "listening") {
      const store = useLiveVoiceStore.getState();
      const user = store.finalTranscript.trim();
      const assistant = store.assistantTranscript.trim();
      if (user || assistant) {
        setTurns((t) => [...t, { user, assistant }]);
      }
    }
  }, [state]);

  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;

  // Current-exchange text, deduped against the archived last turn (the store
  // keeps finalTranscript/assistantTranscript until the NEXT turn resets them).
  const currentUser =
    finalTranscript.trim() === (lastTurn?.user ?? "").trim()
      ? partialTranscript.trim()
      : [finalTranscript, partialTranscript].filter(Boolean).join(" ").trim();
  const currentAssistant =
    assistantTranscript.trim() === (lastTurn?.assistant ?? "").trim()
      ? ""
      : assistantTranscript.trim();

  const listening = state === "listening" || state === "transcribing";
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

  const handleRetry = useCallback(() => {
    haptic.light();
    void start(assistantId, conversationId);
  }, [start, assistantId, conversationId]);

  const hasStrip =
    turns.length > 0 ||
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
          {turns.map((turn, i) => (
            <TurnBubbles key={i} user={turn.user} assistant={turn.assistant} />
          ))}
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

      {/* VOICE BAR — orb · waveform · ⌨ · ✕ (frame 37). Hidden while the user
          is typing (⌨ flip); the session stays alive. */}
      {!keyboardMode ? (
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

/** One archived exchange — 🎙 user bubble + assistant reply bubble. */
function TurnBubbles({ user, assistant }: { user: string; assistant: string }) {
  return (
    <>
      {user ? (
        <div style={VOICE_BUBBLE}>
          <span aria-hidden>🎙 </span>&ldquo;{user}&rdquo;
        </div>
      ) : null}
      {assistant ? <div style={REPLY_BUBBLE}>{assistant}</div> : null}
    </>
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
