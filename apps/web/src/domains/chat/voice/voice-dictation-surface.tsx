/**
 * VoiceDictationSurface — the Voice screen, drawn to DESIGN-SPEC
 * "/Users/manavgupta/Downloads/Cue-Surfaces.html" §S2 "Voice": a dark aperture
 * panel with the mic orb, a serif promise, and a live-transcription card that
 * emits action-item chips ("Reply drafted", "Task queued") carrying ⟡ project
 * tags.
 *
 * This is the batch-dictation experience — the same {@link VoiceInputButton} the
 * chat composer mounts (record → POST `/v1/stt/transcribe` via the user's STT
 * provider, e.g. Deepgram) — so it works wherever the daemon's STT route does,
 * with no `voice-mode` flag and no live-voice WebSocket dependency. It backs the
 * standalone `/voice` route (and is the fallback the live {@link
 * import("./voice-mode-surface").VoiceModeSurface} delegates to when full-duplex
 * voice is off).
 *
 * The pipeline is REUSED, not rebuilt: on a final transcript we call the existing
 * {@link postVoiceIntake} → the daemon extracts the action items, mints an
 * executable work item per item (Activity → Cued, tagged `voice`), and writes
 * Cue's read-back into a fresh thread. Rather than navigating away instantly, we
 * settle into a **results state** that renders that intake as the S2 card + chips
 * (see {@link VoiceIntakeResults}) — so the "talk → action items → filed work"
 * flow is visible — and each chip's primary action opens the real destination
 * (the thread, or Activity where the queued task lives).
 *
 * States, all designed:
 *  - idle          orb at rest, "Tap to talk" affordance + the serif promise.
 *  - listening     orb lit, pulse rings + waveform, the interim transcript.
 *  - transcribing  orb thinking, "transcribing…".
 *  - organizing    intake in flight, "organizing…".
 *  - results       the transcription card with the captured action-item chips.
 *  - error         mic-denied / STT-unavailable handled gracefully (recovery CTA).
 *
 * The panel is intentionally ink-only (the spec calls Voice a dark surface), so
 * the aperture colours are fixed literals. The one seam that overlaps app chrome
 * — the "Done" affordance the in-chat overlay renders — stays neutral-glass so it
 * reads on either theme.
 */

import { useCallback, useRef, useState } from "react";

import { ArrowUp, Keyboard, Settings, Square, X } from "lucide-react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import {
  postVoiceIntake,
  type VoiceIntakeResponse,
} from "@/domains/chat/voice/voice-intake-api";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { VoiceIntakeResults } from "@/domains/chat/voice/voice-intake-results";
import {
  formatVoiceError,
  isMicPermissionError,
  isMicPermissionPermanentError,
} from "@/domains/chat/utils/chat";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { routes } from "@/utils/routes";

const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', ui-serif, Georgia, serif";

// S2 ink-panel palette (spec literals). Voice is intentionally a dark surface,
// so these are fixed rather than themed.
const INK_GRADIENT =
  "radial-gradient(120% 90% at 50% 20%, #16202E 0%, #0C121B 60%, #080C12 100%)";
const HERO = "#EAF0FE";
const HERO_ACCENT = "#9DB8F4";
const EYEBROW = "rgba(255,255,255,.4)";
const FOOTER = "rgba(255,255,255,.4)";
const FOOTER_LINK = "rgba(157,184,244,.9)";
const DANGER = "#E5634B";
const TEXT_2 = "#8A97AC";
const LINE_2 = "rgba(255,255,255,.14)";
const BLUE = "#3D6EE8";

const safeInset = (side: "top" | "bottom" | "left" | "right") =>
  `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;

/**
 * S2 aperture keyframes (spec: `s6Ring`, `s6Breathe`, `s6Bar`). Scoped to this
 * surface and silenced under reduced-motion. Purely presentational.
 */
const APERTURE_KEYFRAMES = `
@keyframes cueApBreathe { 0%,100% { transform: scale(1); opacity: .9 } 50% { transform: scale(1.06); opacity: 1 } }
@keyframes cueApRing { 0% { transform: scale(.6); opacity: .5 } 100% { transform: scale(1.9); opacity: 0 } }
@keyframes cueApBar { 0%,100% { height: 8px } 50% { height: 26px } }
/* m6-tuned mobile aperture (spec §2): rings .55→1.9, bars 9→30px. */
@keyframes cueApBreatheM { 0%,100% { transform: scale(1); opacity: .92 } 50% { transform: scale(1.06); opacity: 1 } }
@keyframes cueApRingM { 0% { transform: scale(.55); opacity: .55 } 100% { transform: scale(1.9); opacity: 0 } }
@keyframes cueApBarM { 0%,100% { height: 9px } 50% { height: 30px } }
@media (prefers-reduced-motion: reduce) {
  .cue-ap-core, .cue-ap-ring, .cue-ap-bar { animation: none !important }
}
`;

const BAR_DELAYS = [0, 0.12, 0.24, 0.36, 0.48];

/**
 * The living aperture orb (spec §S2): pulse rings + a radial glow behind a
 * gradient core that breathes and shows a five-bar waveform while listening. At
 * rest the rings and waveform are stilled and the core dims.
 */
function ApertureOrb({
  active,
  mobile = false,
}: {
  active: boolean;
  mobile?: boolean;
}) {
  // Mobile uses the m6-tuned dimensions from the standalone mock (§2): a 210pt
  // zone, 170pt rings on the m6Ring curve, a 116pt core, and a 34pt-tall
  // 5-bar waveform on the m6Bar curve. Desktop keeps its established sizes.
  const zone = mobile ? 210 : 220;
  const ring = mobile ? 170 : 180;
  const glow = mobile ? 150 : 150;
  const core = mobile ? 116 : 104;
  const barW = mobile ? 4 : 3.5;
  const waveH = mobile ? 34 : 30;
  const ringKf = mobile ? "cueApRingM" : "cueApRing";
  const breatheKf = mobile ? "cueApBreatheM" : "cueApBreathe";
  const barKf = mobile ? "cueApBarM" : "cueApBar";
  return (
    <div
      style={{
        position: "relative",
        width: zone,
        height: zone,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {active ? (
        <>
          <span
            className="cue-ap-ring"
            aria-hidden
            style={{
              position: "absolute",
              width: ring,
              height: ring,
              borderRadius: "50%",
              border: "1px solid rgba(91,134,240,.35)",
              animation: `${ringKf} 3s ease-out infinite`,
            }}
          />
          <span
            className="cue-ap-ring"
            aria-hidden
            style={{
              position: "absolute",
              width: ring,
              height: ring,
              borderRadius: "50%",
              border: `1px solid rgba(91,134,240,${mobile ? ".22" : ".25"})`,
              animation: `${ringKf} 3s ease-out 1.5s infinite`,
            }}
          />
        </>
      ) : null}
      <span
        aria-hidden
        style={{
          position: "absolute",
          width: glow,
          height: glow,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 50% 40%, rgba(91,134,240,.28), transparent 70%)",
          opacity: active ? 1 : 0.5,
          transition: "opacity 200ms ease",
        }}
      />
      <div
        className="cue-ap-core"
        style={{
          width: core,
          height: core,
          borderRadius: "50%",
          background: "linear-gradient(155deg, #5B86F0, #2B53C4)",
          boxShadow: mobile
            ? "0 22px 54px -12px rgba(61,110,232,.75), inset 0 2px 7px rgba(255,255,255,.35)"
            : "0 20px 50px -12px rgba(61,110,232,.7), inset 0 2px 6px rgba(255,255,255,.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: active ? 1 : 0.72,
          filter: active ? "none" : "saturate(.7)",
          animation: active ? `${breatheKf} 3.4s ease-in-out infinite` : "none",
          transition: "opacity 200ms ease, filter 200ms ease",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: mobile ? 4.5 : 4,
            height: waveH,
          }}
        >
          {BAR_DELAYS.map((delay, i) => (
            <span
              key={i}
              className="cue-ap-bar"
              aria-hidden
              style={{
                width: barW,
                height: mobile ? 9 : 8,
                background: "rgba(255,255,255,.92)",
                borderRadius: 3,
                animation: active
                  ? `${barKf} 1s ${delay}s ease-in-out infinite`
                  : "none",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A round dock button (mic dock, spec §2). */
function DockButton({
  label,
  size,
  onClick,
  disabled,
  primary = false,
  children,
}: {
  label: string;
  size: number;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#FFFFFF",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        flexShrink: 0,
        // Primary is the red stop/record button (spec: #F0603E→#DA491A + glow).
        background: primary
          ? "linear-gradient(155deg, #F0603E, #DA491A)"
          : "rgba(255,255,255,.08)",
        boxShadow: primary ? "0 16px 36px -10px rgba(218,73,26,.7)" : "none",
        WebkitBackdropFilter: primary ? "none" : "blur(8px)",
        backdropFilter: primary ? "none" : "blur(8px)",
      }}
    >
      {children}
    </button>
  );
}

interface MobileVoiceTakeoverProps {
  orbActive: boolean;
  recording: boolean;
  processing: boolean;
  submitting: boolean;
  showResults: boolean;
  denied: boolean;
  interim: string;
  monoState: string;
  errorMessage: string | null;
  intake: VoiceIntakeResponse | null;
  transcript: string;
  voiceInputRef: React.RefObject<VoiceInputButtonHandle | null>;
  assistantId: string | null;
  onTranscript: (text: string) => void;
  onError: (code: string | null) => void;
  onToggle: () => void;
  onClose: () => void;
  onKeyboard: () => void;
  onOpenThread: () => void;
  onOpenActivity: () => void;
}

/**
 * The mobile Voice takeover (spec §2) — a dark, full-bleed `fixed inset:0`
 * surface that covers the app's chat header. Layout: a 44pt top bar (`✕` / mono
 * state / `⚙`), a scrollable body (serif hero → aperture orb → transcript card
 * + captured-context chips), a three-circle mic dock, and a home-indicator
 * gutter. Reuses {@link ApertureOrb} (mobile-tuned) and {@link
 * VoiceIntakeResults}; all session state/handlers are owned by the parent.
 */
function MobileVoiceTakeover({
  orbActive,
  recording,
  processing,
  submitting,
  showResults,
  denied,
  interim,
  monoState,
  errorMessage,
  intake,
  transcript,
  voiceInputRef,
  assistantId,
  onTranscript,
  onError,
  onToggle,
  onClose,
  onKeyboard,
  onOpenThread,
  onOpenActivity,
}: MobileVoiceTakeoverProps) {
  const busy = processing || submitting;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: INK_GRADIENT,
        color: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        paddingTop: safeInset("top"),
        paddingBottom: safeInset("bottom"),
        paddingLeft: safeInset("left"),
        paddingRight: safeInset("right"),
      }}
    >
      <style>{APERTURE_KEYFRAMES}</style>

      {/* The VoiceInputButton owns the MediaRecorder + STT lifecycle; we drive
          it imperatively via the ref and render our own chrome. */}
      <VoiceInputButton
        ref={voiceInputRef}
        assistantId={assistantId}
        onTranscript={onTranscript}
        onError={onError}
        renderButton={false}
      />

      {/* Top bar: ✕ / mono state / ⚙ */}
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 18px",
        }}
      >
        <button
          type="button"
          aria-label="Close voice"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,.7)",
            cursor: "pointer",
            display: "inline-flex",
            padding: 6,
            margin: -6,
          }}
        >
          <X size={22} aria-hidden />
        </button>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.24em",
            textTransform: "uppercase",
            color: recording ? HERO_ACCENT : "rgba(255,255,255,.45)",
          }}
        >
          {monoState}
        </span>
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            color: "rgba(255,255,255,.7)",
            padding: 6,
            margin: -6,
          }}
        >
          <Settings size={18} />
        </span>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "8px 26px 0",
          overflowY: "auto",
        }}
      >
        {/* Serif hero — idle; swapped for the interim transcript while speaking,
            hidden once the results card takes over. */}
        {!showResults ? (
          <div
            style={{
              fontFamily: interim ? "'DM Sans', sans-serif" : serif,
              fontSize: interim ? 20 : 25,
              fontWeight: interim ? 600 : 400,
              lineHeight: 1.28,
              color: interim ? HERO_ACCENT : HERO,
              textAlign: "center",
              marginTop: 16,
              minHeight: 36,
            }}
          >
            {interim ? (
              interim
            ) : recording ? (
              "Listening — say what's on your mind."
            ) : (
              <>
                Talk. Cue opens a thread with your action items —{" "}
                <span style={{ fontStyle: "italic", color: HERO_ACCENT }}>
                  ready to run.
                </span>
              </>
            )}
          </div>
        ) : null}

        {/* Aperture orb — tappable. */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={recording ? "Stop dictation" : "Start dictation"}
          disabled={busy}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            margin: showResults ? "12px 0" : "38px 0",
            flexShrink: 0,
            cursor: busy ? "default" : "pointer",
          }}
        >
          <ApertureOrb active={orbActive} mobile />
        </button>

        {/* Results — transcript card + captured-context chips. */}
        {showResults && intake ? (
          <div style={{ width: "100%" }}>
            <VoiceIntakeResults
              result={intake}
              transcript={transcript}
              onOpenThread={onOpenThread}
              onOpenActivity={onOpenActivity}
            />
          </div>
        ) : null}

        {/* Mic-denied recovery / STT error. */}
        {denied ? (
          <button
            type="button"
            onClick={() => {
              try {
                window.location.href = "app-settings:";
              } catch {
                /* ignore — unsupported host */
              }
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontFamily: mono,
              fontSize: 12,
              color: "#FFFFFF",
              background: BLUE,
              border: "none",
              borderRadius: 999,
              padding: "11px 20px",
              minHeight: 44,
              marginTop: 16,
              cursor: "pointer",
            }}
          >
            Enable microphone in Settings
          </button>
        ) : errorMessage ? (
          <div style={{ fontSize: 13, color: DANGER, marginTop: 16 }}>
            {errorMessage}
          </div>
        ) : null}
      </div>

      {/* Mic dock: ⌨ (52) / stop ◼ or record ⏺ (74, red) / send ↑ (52). */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          padding: "14px 0 8px",
        }}
      >
        <DockButton label="Type instead" size={52} onClick={onKeyboard}>
          <Keyboard size={19} aria-hidden />
        </DockButton>
        <DockButton
          label={recording ? "Stop dictation" : "Start dictation"}
          size={74}
          primary
          disabled={busy}
          onClick={onToggle}
        >
          {recording ? (
            <Square size={26} fill="#FFFFFF" aria-hidden />
          ) : (
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "#FFFFFF",
              }}
            />
          )}
        </DockButton>
        <DockButton
          label="Send"
          size={52}
          disabled={!recording}
          onClick={onToggle}
        >
          <ArrowUp size={19} aria-hidden />
        </DockButton>
      </div>

      {/* Home-indicator gutter. */}
      <div
        style={{
          flexShrink: 0,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 134,
            height: 5,
            borderRadius: 3,
            background: "rgba(255,255,255,.3)",
          }}
        />
      </div>
    </div>
  );
}

export interface VoiceDictationSurfaceProps {
  /** Renders a "Done" affordance returning to the composer (in-chat overlay). */
  onExit?: () => void;
}

export function VoiceDictationSurface({ onExit }: VoiceDictationSurfaceProps) {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const isMobile = useMobileLayout();
  const voiceInputRef = useRef<VoiceInputButtonHandle | null>(null);
  const [voiceErrorCode, setVoiceErrorCode] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [intake, setIntake] = useState<VoiceIntakeResponse | null>(null);

  const phase = useVoiceRecordingStore.use.phase();
  const interim = useVoiceRecordingStore.use.interimTranscript();
  const recording = phase === "recording";
  const processing = phase === "processing";

  // The orb is "active" (lit, breathing, pulsing) whenever the mic is live or a
  // turn is in flight; at rest otherwise.
  const orbActive = recording || processing || submitting;

  // On a final transcript: run the existing voice-intake pipeline — Cue extracts
  // the action items, mints a runnable work item per item, and writes the
  // read-back into a fresh thread. We hold on the results state (card + chips)
  // rather than navigating away, so the "talk → action items → filed work" flow
  // is visible; chips then open the real destinations.
  const handleTranscript = useCallback(
    (text: string) => {
      const next = text.trim();
      if (!next || !assistantId) return;
      setTranscript(next);
      setSendError(null);
      setIntake(null);
      setSubmitting(true);
      void (async () => {
        try {
          const result = await postVoiceIntake(assistantId, next);
          if (!result.ok) {
            setSendError(result.error);
            return;
          }
          setIntake(result.data);
        } catch {
          setSendError("Couldn’t reach Cue — try again.");
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [assistantId],
  );

  const toggle = useCallback(() => {
    if (processing || submitting) return;
    setVoiceErrorCode(null);
    if (recording) {
      voiceInputRef.current?.stop();
    } else {
      // Starting a new capture clears any prior result so the card doesn't
      // linger over a fresh listen.
      setIntake(null);
      setTranscript("");
      setSendError(null);
      voiceInputRef.current?.start();
    }
  }, [processing, submitting, recording]);

  const openThread = useCallback(() => {
    if (intake) navigate(routes.conversation(intake.conversationId));
  }, [intake, navigate]);

  const openActivity = useCallback(() => {
    navigate(routes.activity);
  }, [navigate]);

  // Mobile ✕ closes the takeover: return to the composer when we're an in-chat
  // overlay (onExit), otherwise step back out of the /voice route.
  const handleClose = useCallback(() => {
    if (onExit) onExit();
    else navigate(-1);
  }, [onExit, navigate]);

  const errorMessage = voiceErrorCode
    ? formatVoiceError(voiceErrorCode)
    : sendError;

  // Mic-denied is a distinct, recoverable state (STT permission blocked or no
  // capture device). Uses the shared classifier so it stays in sync with the
  // composer's mic-permission handling.
  const denied =
    isMicPermissionError(voiceErrorCode) ||
    isMicPermissionPermanentError(voiceErrorCode) ||
    voiceErrorCode === "audio-capture";

  const showResults = Boolean(intake) && !recording && !submitting;

  const statusLabel = processing
    ? "transcribing…"
    : submitting
      ? "organizing…"
      : recording
        ? "● listening"
        : showResults
          ? "ready to run"
          : "tap to talk";

  // Mono top-bar state label for the mobile takeover (spec §2: "LISTENING" /
  // "TAP TO TALK"), extended to cover the transcribe/organize/results states.
  const monoState = recording
    ? "LISTENING"
    : processing
      ? "TRANSCRIBING"
      : submitting
        ? "ORGANIZING"
        : showResults
          ? "READY TO RUN"
          : denied
            ? "MIC BLOCKED"
            : "TAP TO TALK";

  // ── Mobile: dark full-screen takeover (spec §2) ──────────────────────────
  // Fixed inset:0 so it covers the app's light chat header (the tab bar is
  // hidden separately). Vertical stack: top bar → body (hero · orb · transcript)
  // → mic dock → home-indicator gutter. Desktop keeps the centred panel below.
  if (isMobile) {
    return (
      <MobileVoiceTakeover
        orbActive={orbActive}
        recording={recording}
        processing={processing}
        submitting={submitting}
        showResults={showResults}
        denied={denied}
        interim={interim}
        monoState={monoState}
        errorMessage={errorMessage}
        intake={intake}
        transcript={transcript}
        voiceInputRef={voiceInputRef}
        assistantId={assistantId}
        onTranscript={handleTranscript}
        onError={setVoiceErrorCode}
        onToggle={toggle}
        onClose={handleClose}
        onKeyboard={handleClose}
        onOpenThread={openThread}
        onOpenActivity={openActivity}
      />
    );
  }

  return (
    <div
      style={{
        height: "100%",
        background: INK_GRADIENT,
        color: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        paddingTop: `calc(40px + ${safeInset("top")})`,
        paddingBottom: `calc(40px + ${safeInset("bottom")})`,
        paddingLeft: `calc(24px + ${safeInset("left")})`,
        paddingRight: `calc(24px + ${safeInset("right")})`,
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <style>{APERTURE_KEYFRAMES}</style>

      {onExit ? (
        <button
          type="button"
          onClick={onExit}
          aria-label="Return to typing"
          title="Return to typing"
          style={{
            position: "absolute",
            top: `calc(14px + ${safeInset("top")})`,
            right: `calc(14px + ${safeInset("right")})`,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontFamily: mono,
            fontSize: 12,
            color: TEXT_2,
            background: "rgba(255,255,255,.04)",
            border: `1px solid ${LINE_2}`,
            borderRadius: 999,
            padding: "8px 14px",
            minHeight: 36,
            cursor: "pointer",
            backdropFilter: "blur(8px)",
          }}
        >
          <Keyboard size={14} aria-hidden />
          Done
        </button>
      ) : null}

      {/* The VoiceInputButton owns the MediaRecorder + STT lifecycle; we drive it
          imperatively via the ref and render our own aperture, so its own button
          stays hidden. */}
      <VoiceInputButton
        ref={voiceInputRef}
        assistantId={assistantId}
        onTranscript={handleTranscript}
        onError={setVoiceErrorCode}
        renderButton={false}
      />

      {/* Status eyebrow (DM Mono, wide-tracked) — the spec's top-of-panel line. */}
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.28em",
          textTransform: "uppercase",
          color: recording ? HERO_ACCENT : EYEBROW,
        }}
      >
        {statusLabel}
      </div>

      {/* Serif promise (idle) — swapped for the interim transcript once the user
          is speaking, and hidden once the results card takes the stage. */}
      {!showResults ? (
        <div
          style={{
            fontFamily: interim ? "'DM Sans', sans-serif" : serif,
            fontSize: interim ? 22 : 29,
            fontWeight: interim ? 600 : 400,
            lineHeight: 1.28,
            color: interim ? HERO_ACCENT : HERO,
            textAlign: "center",
            maxWidth: 520,
            minHeight: 40,
            letterSpacing: interim ? "-0.3px" : "normal",
          }}
        >
          {interim ? (
            interim
          ) : recording ? (
            "Listening — say what's on your mind."
          ) : (
            <>
              Tap the mic and talk. Cue opens a thread with your action items —{" "}
              <span style={{ fontStyle: "italic", color: HERO_ACCENT }}>
                ready to run.
              </span>
            </>
          )}
        </div>
      ) : null}

      {/* Aperture orb — tappable. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={recording ? "Stop dictation" : "Start dictation"}
        disabled={processing || submitting}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          margin: "12px 0",
          flexShrink: 0,
          cursor: processing || submitting ? "default" : "pointer",
        }}
      >
        <ApertureOrb active={orbActive} />
      </button>

      {/* Results — the live-transcription card with captured action-item chips. */}
      {showResults && intake ? (
        <VoiceIntakeResults
          result={intake}
          transcript={transcript}
          onOpenThread={openThread}
          onOpenActivity={openActivity}
        />
      ) : null}

      {/* Mic-denied recovery (STT permission blocked). */}
      {denied ? (
        <button
          type="button"
          onClick={() => {
            try {
              window.location.href = "app-settings:";
            } catch {
              /* ignore — unsupported host */
            }
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontFamily: mono,
            fontSize: 12,
            color: "#FFFFFF",
            background: BLUE,
            border: "none",
            borderRadius: 999,
            padding: "11px 20px",
            minHeight: 44,
            cursor: "pointer",
          }}
        >
          Enable microphone in Settings
        </button>
      ) : errorMessage ? (
        <div style={{ fontSize: 13, color: DANGER, maxWidth: 420 }}>
          {errorMessage}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: FOOTER, marginTop: 2 }}>
          Speech-to-text uses your configured provider ·{" "}
          <span style={{ color: FOOTER_LINK }}>Settings → Voice</span>
        </div>
      )}
    </div>
  );
}
