/**
 * VoiceMinimizedBar — rung 2 of the desktop call ladder (design v37 §W1;
 * `cue-design-answers-v37.html`, "2 · Minimized bar" — its inline styles are
 * the spec).
 *
 * The bar sits ABOVE A FULLY USABLE COMPOSER — typing mid-call is a feature,
 * not an edge case — so this component renders in the normal layout flow of
 * the conversation view (never as an overlay) and owns nothing but its own
 * row. It keeps, per the frame: the mark + ripple, the level bars, the state
 * word, the ▤ thing chip, the timer, and the same three controls the room has
 * (mute · end · ⤢ expand — ⤢ standing in for the room's ⤓).
 *
 * ## The honesty rule for sound
 * The level bars animate from REAL audio levels — the smoothed mic amplitude
 * the capture worklet already publishes into the live-voice store — never
 * from a keyframe loop. One signal, one motion: silence renders as resting
 * stubs, not as pretend activity. (v37: "Bars animate from real audio levels
 * … it's the honesty rule for sound.")
 *
 * PURELY PRESENTATIONAL — it never mounts the live-voice controller. The
 * session is owned above the route switch by `voice-call-host.tsx`; this bar
 * is one of its projections, so collapsing/expanding never touches the
 * socket or the mic.
 *
 * Fail open: a failed session replaces the row's middle with the failure in
 * plain words plus a retry, and end stays live — a call that died while
 * minimized must say so, never keep breathing.
 */

import { Maximize2, Mic, MicOff, X } from "lucide-react";

import { useCallClock } from "@/domains/chat/voice/call-clock";
import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import { CueRing } from "@/mobile-v3/cue-ring";

// ---------------------------------------------------------------------------
// v37 §W1 literals (inspected from the rendered frame)
// ---------------------------------------------------------------------------

const TEXT = "#F4F4F6";
/** Dark-ground muted ink (v35 backlog: never the light-ground value). */
const MUTED = "#9A9AA8";

const BLUE = "#3D6EE8";
const BLUE_INK = "#7FA3F2";
const VIOLET_INK = "#A79FF0";
const TEAL = "#4FC7C7";
const END_FILL = "#E5675B";
const END_INK = "#211013";

/** The frame's four resting bar heights (percent of the 16px lane). */
const BAR_HEIGHTS = [42, 88, 60, 100] as const;

const BAR_CSS = `
@keyframes cueVbarPing {
  0% { transform: scale(.85); opacity: .55 }
  80%, 100% { transform: scale(1.9); opacity: 0 }
}
@media (prefers-reduced-motion: reduce) {
  .cue-vbar-anim { animation: none !important }
}
`;

/** The three drawn call states; everything else resolves onto one of them. */
function stateWord(state: LiveVoiceSessionState, muted: boolean): string {
  if (state === "connecting") return "Connecting…";
  if (muted) return "Muted";
  switch (state) {
    case "thinking":
    case "transcribing":
      return "Thinking";
    case "speaking":
      return "Speaking";
    default:
      return "Listening";
  }
}

/** The state's accent — the same blue/violet/teal system the room uses. */
function stateAccent(state: LiveVoiceSessionState): string {
  if (state === "thinking" || state === "transcribing") return VIOLET_INK;
  if (state === "speaking") return TEAL;
  return BLUE;
}

export interface VoiceMinimizedBarProps {
  state: LiveVoiceSessionState;
  /** REAL smoothed mic amplitude in [0, 1] — drives the level bars. */
  amplitude: number;
  muted: boolean;
  /** Epoch ms the call started; `null` renders no timer (no made-up clock). */
  startedAt: number | null;
  /**
   * The ▤ thing chip's label: the current card/surface title when one exists,
   * else the conversation title. `null` hides the chip label entirely.
   */
  thingLabel: string | null;
  /** Failure message when `state === "failed"`. */
  error: string | null;
  failureKind: "mic" | "session" | null;
  /** ▤ — open the current card/surface (promotes to the room, which shows it). */
  onOpenThing: () => void;
  onToggleMute: () => void;
  onEnd: () => void;
  /** ⤢ — back to the room. Same call, same socket. */
  onExpand: () => void;
  onRetry: () => void;
}

export function VoiceMinimizedBar({
  state,
  amplitude,
  muted,
  startedAt,
  thingLabel,
  error,
  failureKind,
  onOpenThing,
  onToggleMute,
  onEnd,
  onExpand,
  onRetry,
}: VoiceMinimizedBarProps) {
  const clock = useCallClock(startedAt);
  const failed = state === "failed";
  const listening = state === "listening" || state === "transcribing";
  const accent = stateAccent(state);
  // Real level → one scale for the whole rank. Silence rests at a stub; only
  // actual signal moves the bars.
  const level = Math.min(1, Math.max(0, amplitude));
  const scale = 0.18 + 0.82 * Math.min(1, level * 1.6);

  return (
    <div
      role="region"
      aria-label="Voice call"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "linear-gradient(160deg,#161A26,#10131C)",
        border: "1px solid rgba(61,110,232,.4)",
        borderRadius: 14,
        padding: "10px 13px",
        boxShadow: "0 10px 26px -14px rgba(61,110,232,.5)",
        color: TEXT,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: BAR_CSS }} />

      {/* The mark + ripple (30px, per the frame). Ripple only while the mic
          is actually listening — a muted mic is not listening. */}
      <span
        aria-hidden
        style={{ position: "relative", width: 30, height: 30, flexShrink: 0 }}
      >
        {listening && !muted && !failed ? (
          <span
            className="cue-vbar-anim"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "1.5px solid rgba(61,110,232,.5)",
              animation: "cueVbarPing 2.2s ease-out infinite",
            }}
          />
        ) : null}
        <span
          style={{
            position: "absolute",
            inset: 3,
            borderRadius: "50%",
            background: "#14141C",
            border: "1px solid #2A2A35",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CueRing size={15} stroke={TEXT} strokeWidth={46} dotRadius={34} />
        </span>
      </span>

      {failed ? (
        /* Fail open: the words, a retry, and end. No pretend levels. */
        <>
          <span
            role="status"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: MUTED,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {failureKind === "mic"
              ? "Cue can't reach your microphone."
              : (error ?? "The call dropped.")}
          </span>
          <button
            type="button"
            onClick={onRetry}
            style={{
              minHeight: 30,
              padding: "0 12px",
              border: "1px solid rgba(255,255,255,.13)",
              borderRadius: 99,
              background: "rgba(255,255,255,.07)",
              color: TEXT,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </>
      ) : (
        <>
          {/* Level bars — real audio only. */}
          <span
            aria-hidden
            style={{
              display: "flex",
              gap: 2.5,
              alignItems: "center",
              height: 16,
              flexShrink: 0,
            }}
          >
            {BAR_HEIGHTS.map((h, i) => (
              <span
                key={i}
                style={{
                  width: 2.5,
                  height: `${h}%`,
                  borderRadius: 99,
                  background: accent,
                  transformOrigin: "center",
                  transform: `scaleY(${muted ? 0.18 : scale})`,
                  transition: "transform 90ms ease-out, background 160ms ease",
                }}
              />
            ))}
          </span>

          {/* State word + the ▤ thing chip · timer line. */}
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              role="status"
              aria-live="polite"
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1.25,
              }}
            >
              {stateWord(state, muted)}
            </span>
            <span
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 4,
                fontSize: 10,
                color: MUTED,
                lineHeight: 1.3,
                minWidth: 0,
              }}
            >
              {thingLabel ? (
                <button
                  type="button"
                  onClick={onOpenThing}
                  aria-label={`Open ${thingLabel}`}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    color: "inherit",
                    cursor: "pointer",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  <span aria-hidden>▤ </span>
                  {thingLabel}
                </button>
              ) : null}
              {clock ? (
                <span
                  style={{
                    fontFamily: "'DM Mono', ui-monospace, monospace",
                    flexShrink: 0,
                  }}
                >
                  {thingLabel ? "· " : ""}
                  {clock}
                </span>
              ) : null}
            </span>
          </span>

          {/* mute — same control the room has, bar-sized. */}
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={muted}
            style={{
              width: 30,
              height: 30,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: muted ? "rgba(255,255,255,.14)" : "transparent",
              border: "none",
              borderRadius: "50%",
              padding: 0,
              color: muted ? TEXT : MUTED,
              cursor: "pointer",
            }}
          >
            {muted ? (
              <MicOff size={14} aria-hidden />
            ) : (
              <Mic size={14} aria-hidden />
            )}
          </button>
        </>
      )}

      {/* end — the one filled control, dark ink on the fill. */}
      <button
        type="button"
        onClick={onEnd}
        aria-label="End call"
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          background: END_FILL,
          border: "none",
          padding: 0,
          color: END_INK,
          cursor: "pointer",
        }}
      >
        <X size={14} aria-hidden />
      </button>

      {/* ⤢ — expand back to the room. Presentation only. */}
      {!failed ? (
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand the call"
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            padding: 0,
            color: BLUE_INK,
            cursor: "pointer",
          }}
        >
          <Maximize2 size={14} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
