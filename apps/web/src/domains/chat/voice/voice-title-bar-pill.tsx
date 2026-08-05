/**
 * VoiceTitleBarPill — rung 3 of the desktop call ladder (design v37 §W1;
 * `cue-design-answers-v37.html`, "3 · Title-bar pill" — its inline styles are
 * the spec).
 *
 * Shown when the user navigates AWAY from the call's conversation while the
 * call is live: level bars + "Cue · speaking" (the state word) + timer + ✕.
 * **Click anywhere on the pill except ✕ to return** — navigate back to the
 * conversation and promote straight to the room. Mobile's equivalent is the
 * Dynamic Island; this is the web-desktop shape, floated in the title-bar
 * region of the app shell (mounted by `voice-call-host.tsx` alongside the
 * other RootLayout overlays).
 *
 * The level bars follow the same honesty rule as the minimized bar: they
 * animate from the REAL mic amplitude in the live-voice store, never from a
 * keyframe loop. The timer is the liveness signal — it counts from the real
 * session start or is absent.
 *
 * PURELY PRESENTATIONAL — the session is owned by the host; this pill is a
 * projection, so navigating in and out never touches the socket or the mic.
 */

import { useCallClock } from "@/domains/chat/voice/call-clock";
import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

// ---------------------------------------------------------------------------
// v37 §W1 literals (inspected from the rendered frame)
// ---------------------------------------------------------------------------

const PILL_BG = "#1A2230";
const TEXT = "#F4F4F6";
const TIMER_INK = "#9DB0C8";

const BLUE = "#3D6EE8";
const VIOLET_INK = "#A79FF0";
const TEAL = "#4FC7C7";
const END_FILL = "#E5675B";
const END_INK = "#211013";

/** The frame's three resting bar heights (percent of the 10px lane). */
const BAR_HEIGHTS = [50, 100, 70] as const;

/** The state word, lower-case per the frame ("Cue · speaking"). */
function stateWord(state: LiveVoiceSessionState, muted: boolean): string {
  if (state === "connecting") return "connecting…";
  if (state === "failed") return "call dropped";
  if (muted) return "muted";
  switch (state) {
    case "thinking":
    case "transcribing":
      return "thinking";
    case "speaking":
      return "speaking";
    default:
      return "listening";
  }
}

function stateAccent(state: LiveVoiceSessionState): string {
  if (state === "thinking" || state === "transcribing") return VIOLET_INK;
  if (state === "speaking") return TEAL;
  return BLUE;
}

export interface VoiceTitleBarPillProps {
  state: LiveVoiceSessionState;
  /** REAL smoothed mic amplitude in [0, 1] — drives the level bars. */
  amplitude: number;
  muted: boolean;
  /** Epoch ms the call started; `null` renders no timer. */
  startedAt: number | null;
  /** Click anywhere except ✕ — back to the conversation, promoted to the room. */
  onReturn: () => void;
  onEnd: () => void;
}

export function VoiceTitleBarPill({
  state,
  amplitude,
  muted,
  startedAt,
  onReturn,
  onEnd,
}: VoiceTitleBarPillProps) {
  const clock = useCallClock(startedAt);
  const accent = stateAccent(state);
  const level = Math.min(1, Math.max(0, amplitude));
  const scale = 0.18 + 0.82 * Math.min(1, level * 1.6);

  return (
    <div
      style={{
        position: "fixed",
        top: "calc(6px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 60,
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        background: PILL_BG,
        borderRadius: 99,
        padding: "5px 6px 5px 10px",
        boxShadow: "0 4px 12px -5px rgba(11,23,54,.4)",
      }}
    >
      {/* Return — everything except ✕. A real button carries the affordance. */}
      <button
        type="button"
        onClick={onReturn}
        aria-label="Return to the call"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {/* Level bars — real audio only, resting stubs in silence. */}
        <span
          aria-hidden
          style={{
            display: "flex",
            gap: 2,
            alignItems: "center",
            height: 10,
          }}
        >
          {BAR_HEIGHTS.map((h, i) => (
            <span
              key={i}
              style={{
                width: 2,
                height: `${h}%`,
                borderRadius: 99,
                background: accent,
                transformOrigin: "center",
                transform: `scaleY(${muted || state === "failed" ? 0.18 : scale})`,
                transition: "transform 90ms ease-out, background 160ms ease",
              }}
            />
          ))}
        </span>
        <span
          role="status"
          aria-live="polite"
          style={{ fontSize: 10, color: TEXT, fontWeight: 600 }}
        >
          Cue · {stateWord(state, muted)}
        </span>
        {clock ? (
          <span
            style={{
              fontFamily: "'DM Mono', ui-monospace, monospace",
              fontSize: 9,
              color: TIMER_INK,
            }}
          >
            {clock}
          </span>
        ) : null}
      </button>

      {/* ✕ — the one control that does not return. */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onEnd();
        }}
        aria-label="End call"
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: END_FILL,
          border: "none",
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 9,
          color: END_INK,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}
