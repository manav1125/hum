/**
 * VoiceFullScreen — the call screen (design v35 §V1, drawn from
 * `cue-design-answers-v35.html`; its inline styles are the spec).
 *
 * ## The one idea
 * **The mark IS the state.** Three behaviours of one element, no spinners and
 * no label doing the work the motion should do:
 *
 *  · **Listening** — the ring breathes outward, blue ripples, and the live
 *    caption shows the CURRENT SENTENCE ONLY.
 *  · **Thinking** — the ring contracts and dims to violet, one dot orbits, and
 *    the tool it is touching is named in words. See the honesty note below.
 *  · **Speaking** — a steady ring, a teal waveform, and "tap anywhere to
 *    interrupt" — which really does interrupt.
 *
 * **Exactly three controls: mute · end · collapse.** Nothing else is on this
 * screen. The engine toggle that used to live on a call surface is now Your
 * Cue → Preferences → Voice (`utils/voice-engine.ts`), because nobody
 * changes engines mid-sentence; a long-press on the call timer is the
 * engineering back door, and it too only takes effect on the NEXT call.
 *
 * ## Why there is no transcript here
 * v35: "Live captions of the current sentence only — the full transcript
 * belongs to the thread, not the call." The call lands in its thread as 🎙
 * turns while it happens, artefacts arrive there as cards, and ending a call
 * drops the user into that thread at the transcript's end. There is no separate
 * call history, so the screen a person is looking at during the call is free to
 * be a call, and nothing said in voice depends on this component to survive.
 *
 * ## The honesty rule on the thinking state
 * The tool name is a REAL tool that really started, carried by the daemon's
 * `tool_activity` frame. When nothing has been reported — the realtime engine,
 * an older daemon, or simply a moment in the turn that is not inside a tool
 * call — this says "Thinking…", which is what it knows. It never guesses an
 * activity: a caption reading "Checking the pricing model…" while the turn is
 * searching the web is a fabricated status, and a fabricated status is worse
 * than none. See `live-voice/tool-activity-words.ts`.
 *
 * ## Architecture
 * PURELY PRESENTATIONAL. It never mounts {@link
 * import("./live-voice/use-live-voice").useLiveVoice} — {@link
 * import("../components/mobile-thread-voice").MobileThreadVoice} owns the one
 * controller and renders this instead of its bar. Expanding and collapsing
 * therefore touches neither the socket nor the mic: it is a change of clothes
 * mid-sentence, not a restart.
 *
 * ## Fail open
 * Connecting, degraded, muted or failed, the end and collapse controls stay
 * live. A call whose state signal is missing is still a call you can leave.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronDown, MicOff, X } from "lucide-react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import { thinkingLabel } from "@/domains/chat/voice/live-voice/tool-activity-words";
import {
  readVoiceEngine,
  writeVoiceEngine,
  type VoiceEngine,
} from "@/utils/voice-engine";
import { useMobileOverlayTarget } from "@/domains/chat/hooks/use-mobile-overlay-target";
import { CueRing } from "@/mobile-v3/cue-ring";
import { haptic } from "@/utils/haptics";

// ---------------------------------------------------------------------------
// v35 literals (inspected from the rendered spec — see the file header)
// ---------------------------------------------------------------------------

const GROUND = "#050508";
const TEXT = "#F4F4F6";
const SOFT = "#C9C9D4";
/** The dark-ground muted ink. Never the light-ground one — see v35's backlog note. */
const MUTED = "#9A9AA8";

const BLUE = "#3D6EE8";
const BLUE_INK = "#7FA3F2";
const VIOLET = "#7F77DD";
const VIOLET_INK = "#A79FF0";
const TEAL = "#4FC7C7";

/** End is the only filled control; its ink is dark so it clears 4.5:1 on the fill. */
const END_FILL = "#E5675B";
const END_INK = "#211013";

const DISC = "linear-gradient(160deg,#1D1D26,#101016)";
const DISC_BORDER = "1px solid #2A2A35";
const CONTROL_BG = "rgba(255,255,255,.08)";
const CONTROL_BORDER = "1px solid rgba(255,255,255,.12)";

const MARK = 128;

const safeInset = (side: "top" | "bottom") =>
  `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;

/**
 * Every animation is transform/opacity only, and every one of them is switched
 * off under `prefers-reduced-motion` — where the state is still legible,
 * because each state also carries its own geometry and its own words.
 */
const FULLSCREEN_CSS = `
@keyframes cueVfsPing {
  0% { transform: scale(.82); opacity: .9 }
  100% { transform: scale(1.35); opacity: 0 }
}
@keyframes cueVfsPulse {
  0%, 100% { transform: scale(1); opacity: .82 }
  50% { transform: scale(.94); opacity: 1 }
}
@keyframes cueVfsOrbit {
  from { transform: rotate(0deg) }
  to { transform: rotate(360deg) }
}
@keyframes cueVfsBar {
  0%, 100% { transform: scaleY(.4) }
  50% { transform: scaleY(1) }
}
@keyframes cueVfsCaret { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }
@media (prefers-reduced-motion: reduce) {
  .cue-vfs-anim { animation: none !important }
}
`;

/** The three drawn states. Everything else resolves onto one of them. */
type CallState = "listening" | "thinking" | "speaking";

function drawnState(state: LiveVoiceSessionState): CallState {
  if (state === "speaking") return "speaking";
  if (state === "thinking" || state === "transcribing") return "thinking";
  return "listening";
}

export interface VoiceFullScreenProps {
  /** The conversation this call is bound to — its spoken turns land there. */
  title?: string | null;
  /**
   * The CURRENT sentence the user is saying. Not a transcript: v35 keeps the
   * record in the thread and the caption on the call.
   */
  currentUser: string;
  /** The CURRENT sentence Cue is saying. */
  currentAssistant: string;
  state: LiveVoiceSessionState;
  /**
   * Registered name of the tool this turn is executing, or `null` when the
   * client has not been told. `null` is a normal value and must render as a
   * plain wait — never as a guessed activity.
   */
  activityTool: string | null;
  muted: boolean;
  /** Epoch ms the call started. The clock is real or it is absent. */
  startedAt: number | null;
  /** Failure message when `state === "failed"`. */
  error: string | null;
  failureKind: "mic" | "session" | null;
  /** ⤓ — back to the inline bar. Same call, same socket. */
  onCollapse: () => void;
  /** Hang up. Drops into the thread, at the end of this call's transcript. */
  onEnd: () => void;
  onToggleMute: () => void;
  /** Deliberate barge-in. Only offered while Cue is actually speaking. */
  onInterrupt: () => void;
  /** Restart a failed session. */
  onRetry: () => void;
}

export function VoiceFullScreen({
  title,
  currentUser,
  currentAssistant,
  state,
  activityTool,
  muted,
  startedAt,
  error,
  failureKind,
  onCollapse,
  onEnd,
  onToggleMute,
  onInterrupt,
  onRetry,
}: VoiceFullScreenProps) {
  const target = useMobileOverlayTarget();
  const failed = state === "failed";
  const connecting = state === "connecting";
  const active = state !== "idle" && !failed && !connecting;
  const call = drawnState(state);
  const speaking = call === "speaking" && active;

  // The engine back door (v35: "long-press the call timer"). Presentation-only:
  // it writes the preference and says when it applies. It never restarts a live
  // session, because the whole reason the control left this screen is that
  // nobody changes engines mid-sentence.
  const [engineOpen, setEngineOpen] = useState(false);

  const glow =
    call === "thinking"
      ? "radial-gradient(42% 28% at 50% 42%, rgba(127,119,221,.24), transparent 66%)"
      : call === "speaking"
        ? "radial-gradient(44% 30% at 50% 42%, rgba(14,140,140,.26), transparent 66%)"
        : "radial-gradient(46% 32% at 50% 42%, rgba(61,110,232,.32), transparent 66%)";

  const view = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice call"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: GROUND,
        color: TEXT,
        fontFamily: "var(--mv3-font)",
        paddingTop: safeInset("top"),
        paddingBottom: safeInset("bottom"),
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: FULLSCREEN_CSS }} />

      {/* The state's own light. Decorative; the state is never colour alone. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: "-24%",
          background: glow,
          filter: "blur(32px)",
          pointerEvents: "none",
        }}
      />

      {/* HEADER — what this call is bound to, and how long it has run. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px 0",
          flexShrink: 0,
          position: "relative",
          zIndex: 5,
        }}
      >
        <span
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
          <span aria-hidden>▤ </span>
          {title?.trim() || "This conversation"}
        </span>
        <CallTimer
          startedAt={startedAt}
          onLongPress={() => setEngineOpen(true)}
        />
      </div>

      {/* THE MARK + THE WORDS. Tapping interrupts, but only while speaking —
          an invitation that did nothing would be exactly the fake affordance
          this surface is being rebuilt to remove. */}
      <div
        onClick={
          speaking
            ? () => {
                haptic.light();
                onInterrupt();
              }
            : undefined
        }
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
          padding: "0 28px",
          position: "relative",
          zIndex: 2,
          cursor: speaking ? "pointer" : "default",
        }}
      >
        <StateMark call={call} muted={muted} live={active} />

        {failed ? (
          <FailureBlock
            error={error}
            failureKind={failureKind}
            onRetry={onRetry}
          />
        ) : (
          <LiveWords
            call={call}
            connecting={connecting}
            muted={muted}
            currentUser={currentUser}
            currentAssistant={currentAssistant}
            activityTool={activityTool}
          />
        )}
      </div>

      {/* THE THREE CONTROLS. mute · end · collapse. Nothing else. */}
      <div
        style={{
          flexShrink: 0,
          padding: "0 24px 22px",
          position: "relative",
          zIndex: 5,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            gap: 22,
          }}
        >
          <CallControl
            label="mute"
            ariaLabel={muted ? "Unmute microphone" : "Mute microphone"}
            ariaPressed={muted}
            disabled={!active}
            onClick={onToggleMute}
          >
            <MicOff
              size={18}
              aria-hidden
              color={muted ? TEXT : SOFT}
              strokeWidth={muted ? 2.4 : 1.8}
            />
          </CallControl>

          <CallControl
            label="end"
            ariaLabel="End call"
            primary
            onClick={() => {
              haptic.medium();
              onEnd();
            }}
          >
            <X size={22} aria-hidden color={END_INK} strokeWidth={2.4} />
          </CallControl>

          <CallControl
            label="collapse"
            ariaLabel="Back to the conversation"
            onClick={onCollapse}
          >
            <ChevronDown size={18} aria-hidden color={SOFT} />
          </CallControl>
        </div>
      </div>

      {engineOpen ? (
        <EngineDebugSheet onClose={() => setEngineOpen(false)} />
      ) : null}
    </div>
  );

  return target ? createPortal(view, target) : view;
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/**
 * One element, three behaviours (v35). Geometry, motion AND the accompanying
 * words all change with the state, so nothing here is carried by colour alone.
 */
function StateMark({
  call,
  muted,
  live,
}: {
  call: CallState;
  muted: boolean;
  live: boolean;
}) {
  const thinking = call === "thinking";
  const accent = thinking ? VIOLET : call === "speaking" ? TEAL : BLUE;
  const ring = thinking ? MUTED : TEXT;
  // Thinking CONTRACTS: the disc pulls in from 14 to 22, which is the state
  // change a person actually sees before they read a word of it.
  const discInset = thinking ? 22 : 14;

  return (
    <div
      aria-hidden
      style={{
        position: "relative",
        width: MARK,
        height: MARK,
        flexShrink: 0,
      }}
    >
      {/* Listening — ripples outward. Muted keeps the ring, drops the ripples:
          a muted mic is not listening, and drawing it as if it were would be a
          status that is not true. */}
      {call === "listening" && live && !muted ? (
        <>
          <span
            className="cue-vfs-anim"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: `1.5px solid rgba(61,110,232,.55)`,
              animation: "cueVfsPing 2.2s cubic-bezier(.2,.6,.35,1) infinite",
            }}
          />
          <span
            className="cue-vfs-anim"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: `1.5px solid rgba(61,110,232,.35)`,
              animation:
                "cueVfsPing 2.2s cubic-bezier(.2,.6,.35,1) .7s infinite",
            }}
          />
        </>
      ) : null}

      {/* The halo. Absent while thinking — the state that dims. */}
      {!thinking ? (
        <span
          style={{
            position: "absolute",
            inset: call === "speaking" ? -14 : -16,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${
              call === "speaking"
                ? "rgba(79,199,199,.4)"
                : "rgba(61,110,232,.45)"
            }, transparent 62%)`,
            filter: "blur(17px)",
            opacity: muted ? 0.4 : 1,
          }}
        />
      ) : null}

      {/* The disc + the mark itself. */}
      <span
        className="cue-vfs-anim"
        style={{
          position: "absolute",
          inset: discInset,
          borderRadius: "50%",
          background: DISC,
          border: DISC_BORDER,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "inset 260ms cubic-bezier(.2,.6,.35,1)",
          ...(thinking
            ? { animation: "cueVfsPulse 1.6s ease-in-out infinite" }
            : {}),
        }}
      >
        <CueRing size={thinking ? 38 : 44} stroke={ring} dotColor={accent} />
      </span>

      {/* Thinking — one dot, orbiting. */}
      {thinking ? (
        <span
          className="cue-vfs-anim"
          style={{
            position: "absolute",
            inset: 0,
            animation: "cueVfsOrbit 2.8s linear infinite",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: "50%",
              marginLeft: -3.5,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: VIOLET_INK,
              boxShadow: `0 0 10px rgba(167,159,240,.8)`,
            }}
          />
        </span>
      ) : null}
    </div>
  );
}

/** Speaking — the teal waveform (v35's six staggered bars). */
function Waveform() {
  return (
    <span
      aria-hidden
      style={{
        display: "flex",
        gap: 3,
        alignItems: "center",
        height: 22,
        marginTop: 22,
      }}
    >
      {[0.36, 0.7, 1, 0.52, 0.84, 0.44].map((h, i) => (
        <span
          key={i}
          className="cue-vfs-anim"
          style={{
            width: 2.5,
            height: `${h * 100}%`,
            borderRadius: 99,
            background: TEAL,
            transformOrigin: "center",
            animation: `cueVfsBar .75s ease-in-out ${i * 0.1}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

function LiveWords({
  call,
  connecting,
  muted,
  currentUser,
  currentAssistant,
  activityTool,
}: {
  call: CallState;
  connecting: boolean;
  muted: boolean;
  currentUser: string;
  currentAssistant: string;
  activityTool: string | null;
}) {
  // Connecting is drawn as itself, not as a state it has not reached.
  if (connecting) {
    return <StateLine tone={MUTED} label="Connecting…" />;
  }

  if (call === "thinking") {
    return (
      <>
        {/* Named tool, or the honest wait — never a guess. */}
        <StateLine tone={VIOLET_INK} label={thinkingLabel(activityTool)} />
      </>
    );
  }

  if (call === "speaking") {
    return (
      <>
        <Waveform />
        {currentAssistant ? (
          <p
            style={{
              fontSize: 15,
              color: SOFT,
              textAlign: "center",
              margin: "16px 0 0",
              lineHeight: 1.55,
              maxWidth: 300,
            }}
          >
            &ldquo;{currentAssistant}&rdquo;
          </p>
        ) : null}
        <div style={{ fontSize: 10.5, color: MUTED, marginTop: 14 }}>
          tap anywhere to interrupt
        </div>
      </>
    );
  }

  // Listening. Muted says so — a mic that is off is not hearing you, and the
  // ripples are already gone, so the words and the motion agree.
  return (
    <>
      <StateLine
        tone={muted ? MUTED : BLUE_INK}
        label={muted ? "Muted — Cue can't hear you" : "Listening"}
      />
      {currentUser ? (
        <p
          style={{
            fontSize: 17,
            fontWeight: 600,
            textAlign: "center",
            margin: "14px 0 0",
            lineHeight: 1.4,
            letterSpacing: "-.2px",
            maxWidth: 320,
            color: TEXT,
          }}
        >
          &ldquo;{currentUser}&rdquo;
          <span
            aria-hidden
            className="cue-vfs-anim"
            style={{
              display: "inline-block",
              width: 2,
              height: 17,
              background: BLUE,
              marginLeft: 3,
              verticalAlign: -3,
              animation: "cueVfsCaret 1.1s step-end infinite",
            }}
          />
        </p>
      ) : null}
    </>
  );
}

/**
 * The one line of state copy. It is a live region so a screen reader hears the
 * state change the motion is carrying for everyone else.
 */
function StateLine({ tone, label }: { tone: string; label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: tone,
        marginTop: 26,
        textAlign: "center",
      }}
    >
      {label}
    </div>
  );
}

/**
 * A failed call. It keeps its three controls (fail open) and says the one thing
 * that matters most here: what was already said is in the thread. That is the
 * v35 transcript contract holding on the path where a call dies rather than
 * ends — nothing spoken depends on this screen to survive.
 */
function FailureBlock({
  error,
  failureKind,
  onRetry,
}: {
  error: string | null;
  failureKind: "mic" | "session" | null;
  onRetry: () => void;
}) {
  return (
    <div style={{ marginTop: 26, textAlign: "center", maxWidth: 320 }}>
      <div role="status" style={{ fontSize: 13, color: SOFT, lineHeight: 1.5 }}>
        {failureKind === "mic"
          ? "Cue can't reach your microphone."
          : (error ?? "The call dropped.")}
      </div>
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8 }}>
        What you already said is saved in this conversation.
      </div>
      <button
        type="button"
        onClick={() => {
          haptic.light();
          onRetry();
        }}
        style={{
          marginTop: 16,
          minHeight: 44,
          padding: "0 18px",
          border: CONTROL_BORDER,
          borderRadius: 99,
          background: CONTROL_BG,
          color: TEXT,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        Try again
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function CallControl({
  label,
  ariaLabel,
  ariaPressed,
  disabled = false,
  primary = false,
  onClick,
  children,
}: {
  label: string;
  ariaLabel: string;
  ariaPressed?: boolean;
  disabled?: boolean;
  primary?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const size = primary ? 60 : 48;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          if (!primary) haptic.light();
          onClick();
        }}
        disabled={disabled}
        aria-label={ariaLabel}
        {...(ariaPressed === undefined ? {} : { "aria-pressed": ariaPressed })}
        style={{
          width: size,
          height: size,
          // 48/60 already clear the 44pt floor, so the visual IS the target.
          borderRadius: "50%",
          background: primary ? END_FILL : CONTROL_BG,
          border: primary ? "none" : CONTROL_BORDER,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.45 : 1,
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {children}
      </button>
      <span style={{ fontSize: 10, color: MUTED }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The call timer (and the engine back door behind it)
// ---------------------------------------------------------------------------

/** `m:ss`, or `h:mm:ss` past an hour. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * How long this call has been running — a real elapsed time from a real start,
 * or nothing at all. There is deliberately no placeholder clock: a timer with
 * no start would be a number the screen made up.
 *
 * Long-press is the engine back door (v35). It is not discoverable by accident
 * and it changes nothing about the call in progress.
 */
function CallTimer({
  startedAt,
  onLongPress,
}: {
  startedAt: number | null;
  onLongPress: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  if (startedAt === null) return null;

  const elapsed = formatElapsed(now - startedAt);
  return (
    <button
      type="button"
      onPointerDown={() => {
        clear();
        timer.current = setTimeout(() => {
          haptic.medium();
          onLongPress();
        }, 650);
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={`Call time ${elapsed}. Press and hold for voice engine.`}
      style={{
        flexShrink: 0,
        background: "transparent",
        border: "none",
        padding: "4px 2px",
        fontFamily: "'DM Mono', ui-monospace, monospace",
        fontSize: 11,
        color: MUTED,
        cursor: "default",
        WebkitTapHighlightColor: "transparent",
        WebkitUserSelect: "none",
        userSelect: "none",
      }}
    >
      {elapsed}
    </button>
  );
}

/**
 * The engineering back door for the voice engine. Its home is Your Cue →
 * Preferences → Voice; this exists only so a build can be flipped without
 * leaving a call, and it says plainly that it applies to the NEXT call — the
 * whole point of moving it off this screen is that nobody changes engines
 * mid-sentence.
 */
function EngineDebugSheet({ onClose }: { onClose: () => void }) {
  const [engine, setEngine] = useState<VoiceEngine>(() => readVoiceEngine());

  const choose = (next: VoiceEngine) => {
    setEngine(next);
    writeVoiceEngine(next);
  };

  return (
    <div
      role="dialog"
      aria-label="Voice engine"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "flex-end",
        background: "rgba(0,0,0,.6)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          background: "#14141A",
          borderTop: "1px solid #24242E",
          borderRadius: "18px 18px 0 0",
          padding: `18px 20px calc(20px + ${safeInset("bottom")})`,
        }}
      >
        <div
          style={{
            fontFamily: "'DM Mono', ui-monospace, monospace",
            fontSize: 9.5,
            letterSpacing: ".12em",
            color: MUTED,
            marginBottom: 12,
          }}
        >
          VOICE ENGINE · DEBUG
        </div>
        {(
          [
            ["cascade", "Classic", "The full assistant. Deeper, slower."],
            ["gemini-live", "Realtime", "Speech-native. Faster, shallower."],
          ] as ReadonlyArray<[VoiceEngine, string, string]>
        ).map(([id, label, note]) => (
          <button
            key={id}
            type="button"
            onClick={() => choose(id)}
            aria-pressed={engine === id}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              minHeight: 52,
              padding: "10px 14px",
              marginBottom: 8,
              borderRadius: 12,
              border:
                engine === id
                  ? `1px solid ${BLUE}`
                  : "1px solid rgba(255,255,255,.1)",
              background:
                engine === id
                  ? "rgba(61,110,232,.16)"
                  : "rgba(255,255,255,.04)",
              color: TEXT,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
            <span
              style={{
                display: "block",
                fontSize: 11,
                color: MUTED,
                marginTop: 2,
              }}
            >
              {note}
            </span>
          </button>
        ))}
        <div
          style={{ fontSize: 11, color: MUTED, lineHeight: 1.5, marginTop: 6 }}
        >
          Applies to your next call — this one keeps the engine it started on.
          Its home is Your Cue → Preferences → Voice.
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginTop: 14,
            minHeight: 44,
            width: "100%",
            border: CONTROL_BORDER,
            borderRadius: 99,
            background: CONTROL_BG,
            color: TEXT,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
