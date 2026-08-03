/**
 * VoiceFullScreen — the full-screen presentation of an in-thread voice call.
 *
 * The owner asked for both: "i do like the real life voice mode like chat back
 * and forth but if its hard we could consider full screen lets find a way to do
 * both". So the inline strip + voice bar stays the default, and this is the
 * same session with the chat screen taken away.
 *
 * The rule that makes "both" possible without two sessions racing: this
 * component is PURELY PRESENTATIONAL. It never mounts {@link
 * import("./live-voice/use-live-voice").useLiveVoice} — {@link
 * import("../components/mobile-thread-voice").MobileThreadVoice} owns the one
 * controller and simply renders this instead of its bar. Expanding and
 * collapsing therefore does not touch the socket, the mic, or the turn state:
 * it is a change of clothes mid-sentence, not a restart.
 *
 * What full screen is FOR, and what it must not show: the report that prompted
 * it was "when in a voice mode it doesn't really show a conversation thread it
 * still shows the cta's". So this surface draws the spoken exchange as it
 * happens — every turn of THIS call, oldest first, with the open one live at
 * the bottom — and there is deliberately no text composer, no `+`, no Create,
 * no library, no send button. The only controls are the ones a call has: mute,
 * collapse back into the thread, and hang up.
 *
 * Where its history comes from: the live-voice store's `turns`. The inline
 * strip must never draw those (the chat thread underneath already holds them,
 * and drawing both is what put every turn on screen twice), but this surface
 * covers the thread completely, so here they are the conversation.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { ChevronDown, Mic, MicOff, X } from "lucide-react";

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";
import type {
  LiveVoiceCard,
  LiveVoiceSessionState,
  LiveVoiceTurn,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  VOICE_BUBBLE_LOOK,
  VOICE_REPLY_LOOK,
} from "@/domains/chat/voice/live-voice/voice-bubble-look";
import { useMobileOverlayTarget } from "@/domains/chat/hooks/use-mobile-overlay-target";
import { haptic } from "@/utils/haptics";

/** Ink field (dark-v1 §1) — the calm, full-bleed voice ground. */
const INK_GRADIENT =
  "radial-gradient(120% 70% at 50% 30%, #22324F 0%, #161E2C 50%, #0C1018 100%)";

const safeInset = (side: "top" | "bottom") =>
  `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;

const FULLSCREEN_CSS = `
@keyframes cueVoiceFsBreathe { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.07) } }
@keyframes cueVoiceFsRise { 0% { opacity: 0; transform: translateY(6px) } 100% { opacity: 1; transform: none } }
.cue-voice-fs-turn { animation: cueVoiceFsRise 180ms ease-out both }
.cue-voice-fs-cards .rounded-lg.border {
  border-radius: 20px;
  background: rgba(28,32,44,.85);
  border-color: rgba(255,255,255,.1);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}
@media (prefers-reduced-motion: reduce) {
  .cue-voice-fs-anim, .cue-voice-fs-turn { animation: none !important }
}
`;

const USER_BUBBLE: React.CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "80%",
  padding: "10px 14px",
  ...VOICE_BUBBLE_LOOK,
};

const REPLY_BUBBLE: React.CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "88%",
  padding: "11px 14px",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  ...VOICE_REPLY_LOOK,
};

function toSurface(card: LiveVoiceCard): Surface {
  return {
    surfaceId: card.surfaceId,
    surfaceType: card.surfaceType,
    data: card.data,
    ...(card.title !== undefined ? { title: card.title } : {}),
    ...(card.actions ? { actions: card.actions.map((a) => ({ ...a })) } : {}),
  };
}

export interface VoiceFullScreenProps {
  /** Header line — the conversation this call is bound to. */
  title?: string | null;
  /** Finished exchanges of THIS session, oldest first. */
  turns: readonly LiveVoiceTurn[];
  /** The open exchange: what the user is saying / has just said. */
  currentUser: string;
  /** The open exchange: what Cue is answering. */
  currentAssistant: string;
  /** Result cards for the current turn. */
  cards: readonly LiveVoiceCard[];
  state: LiveVoiceSessionState;
  muted: boolean;
  /** Failure message when `state === "failed"`. */
  error: string | null;
  failureKind: "mic" | "session" | null;
  /** Back to the inline strip + bar. The session keeps running. */
  onCollapse: () => void;
  /** Hang up. */
  onEnd: () => void;
  onToggleMute: () => void;
  /** Restart a failed session. */
  onRetry: () => void;
}

export function VoiceFullScreen({
  title,
  turns,
  currentUser,
  currentAssistant,
  cards,
  state,
  muted,
  error,
  failureKind,
  onCollapse,
  onEnd,
  onToggleMute,
  onRetry,
}: VoiceFullScreenProps) {
  const target = useMobileOverlayTarget();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest words in view — the point of the surface is watching the
  // exchange happen, and a transcript that scrolls off the bottom defeats it.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, currentUser, currentAssistant, cards.length]);

  const listening = state === "listening" || state === "transcribing";
  const failed = state === "failed";
  const active = state !== "idle" && state !== "failed" && state !== "connecting";

  const phase = failed
    ? "voice ended"
    : state === "connecting"
      ? "connecting…"
      : muted
        ? "muted"
        : state === "thinking"
          ? "thinking…"
          : state === "speaking"
            ? "speaking"
            : listening
              ? "listening"
              : "";

  const empty =
    turns.length === 0 &&
    currentUser.length === 0 &&
    currentAssistant.length === 0 &&
    cards.length === 0;

  const view = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation, full screen"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: INK_GRADIENT,
        color: "var(--mv3-text, #F4F4F6)",
        fontFamily: "var(--mv3-font)",
        paddingTop: safeInset("top"),
        paddingBottom: safeInset("bottom"),
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: FULLSCREEN_CSS }} />

      {/* HEADER — collapse is the way back in, and it is the first thing in
          the tab order, because a full-screen surface with no obvious exit is
          a trap. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px 10px",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => {
            haptic.light();
            onCollapse();
          }}
          aria-label="Back to the conversation"
          style={{
            width: 44,
            height: 44,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            padding: 0,
            color: "var(--mv3-muted, #8A97AC)",
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <ChevronDown size={22} aria-hidden />
        </button>
        <div style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title?.trim() || "Voice"}
          </div>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--mv3-micro, #5E6B80)",
            }}
          >
            {phase}
          </div>
        </div>
        {/* Balances the collapse button so the title sits centred. */}
        <span aria-hidden style={{ width: 44, height: 44, flexShrink: 0 }} />
      </div>

      {/* THE EXCHANGE — every turn of this call, oldest first. */}
      <div
        ref={scrollerRef}
        className="cue-voice-fs-cards"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          display: "flex",
          flexDirection: "column",
          gap: 11,
          padding: "4px 16px 16px",
        }}
      >
        {empty ? (
          <div
            style={{
              margin: "auto",
              textAlign: "center",
              fontSize: 13,
              color: "var(--mv3-micro, #5E6B80)",
            }}
          >
            {failed ? "" : "Start talking — what you both say shows up here."}
          </div>
        ) : null}

        {turns.map((turn) => (
          <TurnBubbles
            key={turn.id}
            user={turn.user}
            assistant={turn.assistant}
          />
        ))}

        {currentUser || currentAssistant ? (
          <TurnBubbles user={currentUser} assistant={currentAssistant} />
        ) : null}

        {state === "thinking" && !currentAssistant ? (
          <div
            style={{
              alignSelf: "flex-start",
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--mv3-micro, #5E6B80)",
            }}
          >
            Thinking…
          </div>
        ) : null}

        {cards.map((card) => (
          <SurfaceRouter
            key={card.surfaceId}
            surface={toSurface(card)}
            onAction={() => {}}
          />
        ))}
      </div>

      {/* CALL CONTROLS — a call's controls, not a composer's. Nothing here
          types, attaches, or sends. */}
      <div style={{ flexShrink: 0, padding: "8px 16px 14px" }}>
        {failed ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(22,26,36,.9)",
              border: "1px solid rgba(255,255,255,.1)",
              borderRadius: 26,
              padding: "9px 8px 9px 16px",
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                color: "var(--mv3-muted, #8A97AC)",
              }}
            >
              {failureKind === "mic"
                ? "Cue can't reach your microphone."
                : (error ?? "Voice couldn't connect.")}
            </span>
            <button
              type="button"
              onClick={() => {
                haptic.light();
                onRetry();
              }}
              style={{
                minHeight: 44,
                padding: "0 14px",
                border: "1px solid var(--mv3-btn2-border, rgba(255,255,255,.14))",
                borderRadius: 99,
                background: "var(--mv3-btn2-bg, rgba(255,255,255,.06))",
                color: "inherit",
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              Try again
            </button>
            <EndButton onClick={onEnd} />
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 28,
            }}
          >
            <button
              type="button"
              onClick={() => {
                haptic.light();
                onToggleMute();
              }}
              disabled={!active}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              aria-pressed={muted}
              style={{
                width: 64,
                height: 64,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: active ? "pointer" : "default",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span
                aria-hidden
                className="cue-voice-fs-anim"
                style={{
                  width: 58,
                  height: 58,
                  borderRadius: "50%",
                  background:
                    "radial-gradient(circle at 35% 30%, #6E9BF5, #2B53C4)",
                  boxShadow: "0 0 26px rgba(61,110,232,.6)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: muted ? 0.45 : 1,
                  animation:
                    listening && !muted
                      ? "cueVoiceFsBreathe 3s ease-in-out infinite"
                      : "none",
                }}
              >
                {muted ? (
                  <MicOff size={22} color="#F4F4F6" />
                ) : (
                  <Mic size={22} color="#F4F4F6" />
                )}
              </span>
            </button>
            <EndButton onClick={onEnd} large />
          </div>
        )}
      </div>
    </div>
  );

  return target ? createPortal(view, target) : view;
}

function TurnBubbles({
  user,
  assistant,
}: {
  user: string;
  assistant: string;
}) {
  return (
    <>
      {user ? (
        <div className="cue-voice-fs-turn" style={USER_BUBBLE}>
          <span aria-hidden>🎙 </span>&ldquo;{user}&rdquo;
        </div>
      ) : null}
      {assistant ? (
        <div className="cue-voice-fs-turn" style={REPLY_BUBBLE}>
          {assistant}
        </div>
      ) : null}
    </>
  );
}

function EndButton({
  onClick,
  large = false,
}: {
  onClick: () => void;
  large?: boolean;
}) {
  const size = large ? 58 : 30;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="End voice session"
      style={{
        width: large ? 64 : 44,
        height: large ? 64 : 44,
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
          width: size,
          height: size,
          borderRadius: "50%",
          background: large ? "#E5634B" : "rgba(255,255,255,.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
        }}
      >
        <X size={large ? 24 : 13} />
      </span>
    </button>
  );
}
