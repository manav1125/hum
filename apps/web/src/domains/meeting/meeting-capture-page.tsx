import { ApertureAvatar } from "@vellumai/design-library/components/aperture-avatar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  meetingsRecapPost,
  sttTranscribePost,
} from "@/generated/daemon/sdk.gen";
import type { MeetingsRecapPostResponses } from "@/generated/daemon/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { AuroraBackdrop, CueRing, mv3Mono, rise } from "@/mobile-v3";
import { sectionMicro } from "@/mobile-v3/work-kit";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

/** The structured recap returned by POST /v1/meetings/recap. */
type RecapJson = MeetingsRecapPostResponses[200];

/**
 * Meeting capture → recap (design v0.3 §01).
 *
 * Phase A (this file): the left "live capture" column records the room with
 * MediaRecorder and transcribes the audio through the daemon STT endpoint;
 * the transcript is then sent to POST /v1/meetings/recap, which produces a
 * structured recap and writes the action items/decisions/people into the
 * 8-type memory tagged by a new meeting conversation. The right column renders
 * that REAL recap (replacing the former static illustration) and links to the
 * meeting conversation. The visual language is the original v0.3 surface
 * (inline styles, the local `C` palette, ApertureAvatar, blinking-dot pill,
 * equalizer). Live streaming transcription is a later phase.
 */

/**
 * Theme-aware `--mv1-*` vars (src/index.css): in light themes they resolve to
 * the exact v0.3 hexes this page was designed with; under dark/velvet they
 * swap to the dark-book equivalents. `ink2` stays a literal dark hex — it is
 * a dark-panel surface color, never body text.
 */
const C = {
  ink: "var(--mv1-t1)",
  ink2: "#24303F",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  blueW: "var(--mv1-blue-wash)",
  violet: "var(--mv1-violet)",
  violetS: "var(--mv1-violet-strong)",
  bg: "var(--mv1-canvas)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  red: "var(--mv1-danger)",
} as const;
/**
 * Dark mobile tokens (README-MOBILE §1). The phone shell is full-bleed dark
 * on mobile, so the recap card and chrome read against the ink gradient rather
 * than the light desktop page. Accents (blue/lilac) are theme-invariant.
 */
const D = {
  ink: "#1A2230",
  inkDeep: "#11161F",
  inkBottom: "#0C1018",
  surface: "#212B3B",
  surface2: "#2A3547",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "rgba(61,110,232,.18)",
  lilac: "#7F77DD",
  t1: "#FFFFFF",
  t2: "#8A97AC",
  t3: "#5E6B80",
  green: "#3FB871",
  danger: "#E5634B",
  line: "rgba(255,255,255,.08)",
  line2: "rgba(255,255,255,.14)",
} as const;

const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

/* Scoped animations. Reduced-motion holds the dot solid and the bars at mid height. */
const ANIM_CSS = `
@keyframes mc-blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
@keyframes mc-eq { 0%,100% { height: 6px; } 50% { height: 22px; } }
@keyframes mc-spin { to { transform: rotate(360deg); } }
.mc-dot { animation: mc-blink 1s steps(1,end) infinite; }
.mc-bar { height: 14px; animation: mc-eq 900ms ease-in-out infinite; }
.mc-bar:nth-child(1) { animation-delay: 0ms; }
.mc-bar:nth-child(2) { animation-delay: 120ms; }
.mc-bar:nth-child(3) { animation-delay: 240ms; }
.mc-bar:nth-child(4) { animation-delay: 360ms; }
.mc-bar:nth-child(5) { animation-delay: 480ms; }
.mc-spin { animation: mc-spin 800ms linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .mc-dot { animation: none; }
  .mc-bar { animation: none; height: 14px; }
  .mc-spin { animation: none; }
}
`;

/** Format a duration in whole seconds as MM:SS. */
function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Read a Blob into a bare base64 string (strips the `data:...;base64,` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read audio"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/** True when this browser can record audio via getUserMedia + MediaRecorder. */
function recordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

type CaptureStatus =
  "idle" | "recording" | "transcribing" | "transcribed" | "creating-recap";

const PREFERRED_MIME = "audio/webm";

/** The dark "phone" frame that wraps every capture state, preserving the v0.3 look. */
function CaptureFrame({
  topLeft,
  topRight,
  children,
  caption,
}: {
  topLeft: React.ReactNode;
  topRight?: React.ReactNode;
  children: React.ReactNode;
  caption: string;
}) {
  return (
    <div>
      <div
        style={{
          // Intentionally-dark "phone" hero — stays ink navy in every theme
          // (the content on top is hardcoded light).
          background: "#1A2230",
          borderRadius: 26,
          width: 300,
          minHeight: 360,
          margin: "0 auto",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* status bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px 0",
            color: "#fff",
            minHeight: 20,
          }}
        >
          <span style={{ fontFamily: mono, fontSize: 13 }}>{topLeft}</span>
          {topRight}
        </div>

        {/* center column */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
            gap: 16,
            color: "#fff",
          }}
        >
          {children}
        </div>
      </div>

      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: C.t3,
          textAlign: "center",
          marginTop: 12,
        }}
      >
        {caption}
      </div>
    </div>
  );
}

/**
 * The blinking-REC pill, now driven by the live timer. On mobile it's a
 * larger danger-tinted chip with the danger-red (`#E5634B`) dot and a DM-Mono
 * timer, per README-MOBILE §3.6.
 */
function RecPill({
  elapsed,
  mobile = false,
}: {
  elapsed: number;
  mobile?: boolean;
}) {
  if (mobile) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: mono,
          fontSize: 12.5,
          letterSpacing: ".08em",
          color: "#fff",
          background: "rgba(229,99,75,.16)",
          border: `1px solid rgba(229,99,75,.5)`,
          padding: "6px 12px",
          borderRadius: 999,
        }}
      >
        <span
          className="mc-dot"
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: D.danger,
          }}
        />
        REC {formatDuration(elapsed)}
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontFamily: mono,
        fontSize: 11,
        color: "#fff",
        background: "rgba(226,75,74,.92)",
        padding: "3px 10px",
        borderRadius: 999,
      }}
    >
      <span
        className="mc-dot"
        style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff" }}
      />
      rec {formatDuration(elapsed)}
    </span>
  );
}

/** Spinner ring reused across the transcribing / creating-recap states. */
function Spinner({ size = 22 }: { size?: number }) {
  return (
    <span
      className="mc-spin"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid rgba(255,255,255,.25)",
        borderTopColor: "#fff",
      }}
    />
  );
}

function pillButton(primary: boolean): React.CSSProperties {
  return {
    fontFamily: mono,
    fontSize: 12,
    letterSpacing: ".02em",
    border: primary ? `1px solid ${C.blue}` : "1px solid rgba(255,255,255,.28)",
    background: primary ? C.blue : "rgba(255,255,255,.08)",
    color: "#fff",
    borderRadius: 999,
    padding: "9px 18px",
    cursor: "pointer",
  };
}

/* ==========================================================================
 * Mobile v3 reskin (spec frame 25 — "Cue sits in the room"). The mobile
 * branch renders in the mv3 native language: teal-tinted aurora, mono
 * CAPTURING header with the honest red recording dot, CAUGHT-SO-FAR
 * extraction cards typed by owner (↴ COMMITMENT · YOU blue / ◷ THEIRS violet
 * / ◈ DECISION teal), and the ■ End & summarize control. Desktop keeps the
 * original v0.3 two-column layout byte-identical below.
 *
 * DELTA vs the frame (noted for the coordinator): extraction in the shipped
 * meeting MVP is POST-HOC (record → transcribe → recap) — there is no live
 * extraction or live transcript stream, so the caught cards rise from the
 * recap once "End & summarize" completes rather than mid-call, and the
 * frame's "Flag moment" control is omitted (no marker backend exists).
 * MediaRecorder.pause()/resume() is real, so Pause IS wired.
 * ======================================================================== */

/** The v3 recording-red (frame 25; reserved for the honest capture dot). */
const V3_REC = "#E5675B";

/** Full-width v3 control button. */
function v3Btn(tone: "primary" | "neutral" | "danger"): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 600,
    border: "none",
    borderRadius: 14,
    padding: 13,
    minHeight: 48,
    flex: 1,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  };
  if (tone === "primary")
    return {
      ...base,
      background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
      color: "#fff",
      boxShadow: "var(--mv3-primary-btn-shadow)",
    };
  if (tone === "danger") return { ...base, background: V3_REC, color: "#fff" };
  return {
    ...base,
    background: "var(--mv3-btn2-bg)",
    color: "var(--mv3-text)",
    border: "1px solid var(--mv3-btn2-border)",
  };
}

/**
 * The v3 meeting shell: teal aurora (frame 25's capture tint), a header
 * block on the aurora, scrollable body, controls pinned in thumb reach.
 */
function V3Shell({
  header,
  children,
  controls,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  controls: React.ReactNode;
}) {
  return (
    <div
      data-mv3
      data-slot="mv3-meeting-capture"
      style={{
        position: "relative",
        height: "100dvh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <style>{ANIM_CSS}</style>
      <AuroraBackdrop
        style={{
          background:
            "radial-gradient(46% 36% at 50% 20%, rgba(14,140,140,.2), transparent 68%)",
        }}
      />
      <div
        style={{
          padding: "calc(env(safe-area-inset-top, 0px) + 10px) 24px 0",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        {header}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "16px 18px 12px",
          position: "relative",
          zIndex: 2,
        }}
      >
        {children}
      </div>
      <div
        style={{
          flexShrink: 0,
          padding:
            "10px 18px calc(env(safe-area-inset-bottom, 0px) + 10px)",
          position: "relative",
          zIndex: 5,
          display: "flex",
          gap: 9,
        }}
      >
        {controls}
      </div>
    </div>
  );
}

/** The frame-25 capture header: red ping dot · CAPTURING · MM:SS · Pause. */
function V3CaptureHeader({
  label,
  elapsed,
  paused,
  onTogglePause,
  sub,
}: {
  label: string;
  elapsed: number | null;
  paused?: boolean;
  onTogglePause?: () => void;
  sub: string;
}) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        {elapsed != null ? (
          <span
            aria-hidden
            style={{
              position: "relative",
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: V3_REC,
              flexShrink: 0,
              opacity: paused ? 0.5 : 1,
            }}
          >
            {!paused ? (
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "50%",
                  background: V3_REC,
                  animation: "mv3Ping 1.6s ease-out infinite",
                }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          style={{
            fontFamily: mv3Mono,
            fontSize: 10.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--mv3-muted)",
          }}
        >
          {label}
          {elapsed != null ? ` · ${formatDuration(elapsed)}` : ""}
        </span>
        {onTogglePause ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={onTogglePause}
            style={{
              marginLeft: "auto",
              fontSize: 13,
              color: "var(--mv3-micro)",
              background: "none",
              border: "none",
              padding: "10px 4px",
              margin: "-10px 0 -10px auto",
              minHeight: 44,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: "-0.6px",
          marginTop: 10,
        }}
      >
        Meeting capture
      </div>
      <div style={{ fontSize: 12.5, color: "var(--mv3-muted)", marginTop: 3 }}>
        {sub}
      </div>
    </>
  );
}

type CaughtType = "commitment" | "theirs" | "decision";

const CAUGHT_META: Record<
  CaughtType,
  { border: string; color: string; glyph: string; label: string }
> = {
  commitment: {
    border: "#3D6EE8",
    color: "var(--mv3-micro)",
    glyph: "↴",
    label: "COMMITMENT",
  },
  theirs: {
    border: "#7F77DD",
    color: "var(--mv3-violet)",
    glyph: "◷",
    label: "THEIRS",
  },
  decision: {
    border: "var(--mv3-teal)",
    color: "var(--mv3-teal)",
    glyph: "◈",
    label: "DECISION",
  },
};

/** One typed extraction card (frame 25): accent left border + mono eyebrow. */
function CaughtCard({
  type,
  owner,
  text,
  delay,
}: {
  type: CaughtType;
  owner?: string | null;
  text: string;
  delay: number;
}) {
  const meta = CAUGHT_META[type];
  return (
    <div
      style={{
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderLeft: `3px solid ${meta.border}`,
        borderRadius: 16,
        padding: "12px 14px",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        ...rise(delay),
      }}
    >
      <div
        style={{
          fontFamily: mv3Mono,
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: meta.color,
        }}
      >
        {meta.glyph} {meta.label}
        {owner ? ` · ${owner}` : ""}
      </div>
      <div style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.4 }}>
        {text}
      </div>
    </div>
  );
}

/** Owner routing: "you"/"me"/empty reads as YOUR commitment; else THEIRS. */
function caughtTypeFor(owner: string | null | undefined): {
  type: CaughtType;
  owner: string | null;
} {
  const o = owner?.trim() ?? "";
  if (!o || /^(you|me|myself)$/i.test(o))
    return { type: "commitment", owner: "YOU" };
  return { type: "theirs", owner: o.toUpperCase() };
}

function LiveCapture({
  onRecap,
  mobile,
}: {
  onRecap: (recap: RecapJson) => void;
  mobile: boolean;
}) {
  const assistantId = useActiveAssistantId();

  const [supported] = useState<boolean>(() => recordingSupported());
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  /** True while the recorder is paused (MediaRecorder.pause() — mobile v3). */
  const [paused, setPaused] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mimeTypeRef = useRef<string>(PREFERRED_MIME);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  // Clean up the timer and the mic on unmount — no leaked intervals or live tracks.
  useEffect(() => {
    return () => {
      clearTimer();
      releaseStream();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* recorder already torn down */
        }
      }
    };
  }, [clearTimer, releaseStream]);

  const transcribe = useCallback(
    async (blob: Blob, mimeType: string) => {
      setStatus("transcribing");
      setError(null);
      try {
        const audioBase64 = await blobToBase64(blob);
        const result = await sttTranscribePost({
          path: { assistant_id: assistantId },
          body: { audioBase64, mimeType, source: "meeting" },
          throwOnError: false,
        });
        const text = result.data?.text;
        if (!text) {
          setStatus("idle");
          setError(
            "Couldn't transcribe — set a speech-to-text provider in Settings → Models & Services.",
          );
          return;
        }
        setTranscript(text);
        setStatus("transcribed");
      } catch {
        setStatus("idle");
        setError(
          "Couldn't transcribe — set a speech-to-text provider in Settings → Models & Services.",
        );
      }
    },
    [assistantId],
  );

  const handleStart = useCallback(async () => {
    if (!supported) return;
    setError(null);
    setTranscript("");
    setElapsed(0);
    setPaused(false);
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(
        "Couldn't start the mic — check microphone permissions and try again.",
      );
      return;
    }
    streamRef.current = stream;

    let recorder: MediaRecorder;
    try {
      recorder = MediaRecorder.isTypeSupported(PREFERRED_MIME)
        ? new MediaRecorder(stream, { mimeType: PREFERRED_MIME })
        : new MediaRecorder(stream);
    } catch {
      // Fall back to the platform default if the preferred mimeType is rejected.
      recorder = new MediaRecorder(stream);
    }
    mimeTypeRef.current = recorder.mimeType || PREFERRED_MIME;
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      clearTimer();
      releaseStream();
      const type = mimeTypeRef.current || PREFERRED_MIME;
      const blob = new Blob(chunksRef.current, { type });
      void transcribe(blob, type);
    };

    recorder.start();
    setStatus("recording");
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  }, [supported, clearTimer, releaseStream, transcribe]);

  const handleStop = useCallback(() => {
    setPaused(false);
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop(); // onstop assembles + transcribes
    } else {
      clearTimer();
      releaseStream();
    }
  }, [clearTimer, releaseStream]);

  /** Pause/resume the live capture (real MediaRecorder API; timer follows). */
  const handleTogglePause = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      try {
        recorder.pause();
      } catch {
        return;
      }
      clearTimer();
      setPaused(true);
    } else if (recorder.state === "paused") {
      try {
        recorder.resume();
      } catch {
        return;
      }
      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
      setPaused(false);
    }
  }, [clearTimer]);

  const handleCreateRecap = useCallback(async () => {
    if (!transcript) return;
    setStatus("creating-recap");
    setError(null);
    try {
      const result = await meetingsRecapPost({
        path: { assistant_id: assistantId },
        body: { transcript },
        throwOnError: false,
      });
      const recap = result.data;
      if (!recap) {
        setStatus("transcribed");
        // 503 from the daemon means no model is configured / spend-capped.
        setError(
          result.response?.status === 503
            ? "No language model is set up for recaps yet — choose one in Settings → Models & Services, then try again."
            : "Couldn't generate the recap — please try again.",
        );
        return;
      }
      onRecap(recap);
      setStatus("transcribed");
    } catch {
      setStatus("transcribed");
      setError("Couldn't generate the recap — please try again.");
    }
  }, [assistantId, transcript, onRecap]);

  const handleReset = useCallback(() => {
    setStatus("idle");
    setTranscript("");
    setElapsed(0);
    setPaused(false);
    setError(null);
  }, []);

  // =====================================================================
  // Mobile v3 (spec frame 25): teal aurora, CAPTURING header + honest red
  // dot + real Pause, then ■ End & summarize → transcribe → recap. Live
  // extraction is post-hoc in the shipped MVP, so the caught cards land on
  // the recap screen (delta noted at the top of the v3 block).
  // =====================================================================
  if (mobile) {
    const recording = status === "recording";
    const transcribing = status === "transcribing";
    const reviewing = status === "transcribed" || status === "creating-recap";
    const creating = status === "creating-recap";

    const errorNote = error ? (
      <div
        role="alert"
        style={{
          marginTop: 14,
          fontSize: 12.5,
          color: V3_REC,
          textAlign: "center",
          lineHeight: 1.45,
        }}
      >
        {error}
      </div>
    ) : null;

    // ---- Unsupported ----
    if (!supported) {
      return (
        <V3Shell
          header={
            <V3CaptureHeader
              label="Cue · Meeting"
              elapsed={null}
              sub="Recording isn't supported here — open this on your phone."
            />
          }
          controls={
            <button
              type="button"
              disabled
              style={{ ...v3Btn("neutral"), opacity: 0.55, cursor: "default" }}
            >
              Recording unavailable
            </button>
          }
        >
          <div style={{ textAlign: "center", paddingTop: 40 }}>
            <CueRing size={96} stroke="var(--mv3-text)" />
          </div>
        </V3Shell>
      );
    }

    // ---- Recording (frame 25) ----
    if (recording) {
      return (
        <V3Shell
          header={
            <V3CaptureHeader
              label={paused ? "Paused" : "Capturing"}
              elapsed={elapsed}
              paused={paused}
              onTogglePause={() => {
                haptic.light();
                handleTogglePause();
              }}
              sub="Cue is listening on this phone"
            />
          }
          controls={
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.medium();
                handleStop();
              }}
              style={v3Btn("danger")}
            >
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: "#fff",
                }}
              />
              End &amp; summarize
            </button>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={sectionMicro}>
              Caught so far — confirm after the call
            </div>
            {/* The shipped MVP extracts post-hoc — while capturing, the room
                is honest about what's happening rather than faking live
                cards. Extraction lands after End & summarize. */}
            <div
              style={{
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 16,
                padding: "18px 14px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 14,
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 6,
                  height: 26,
                  opacity: paused ? 0.35 : 1,
                }}
              >
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className={paused ? undefined : "mc-bar"}
                    style={{
                      width: 5,
                      height: 14,
                      borderRadius: 3,
                      background: "var(--mv3-teal)",
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--mv3-muted)",
                  textAlign: "center",
                  lineHeight: 1.5,
                }}
              >
                {paused
                  ? "Paused — resume when the room does."
                  : "Listening & transcribing the room… commitments, decisions and to-dos land here after you end."}
              </div>
            </div>
            {errorNote}
          </div>
        </V3Shell>
      );
    }

    // ---- Transcribing ----
    if (transcribing) {
      return (
        <V3Shell
          header={
            <V3CaptureHeader
              label="Cue · Meeting"
              elapsed={null}
              sub="Transcribing your capture…"
            />
          }
          controls={
            <button
              type="button"
              disabled
              style={{ ...v3Btn("neutral"), opacity: 0.6, cursor: "default" }}
            >
              <Spinner size={16} /> Transcribing…
            </button>
          }
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 18,
              paddingTop: 60,
            }}
          >
            <Spinner size={34} />
          </div>
        </V3Shell>
      );
    }

    // ---- Transcript ready → summarize ----
    if (reviewing) {
      return (
        <V3Shell
          header={
            <V3CaptureHeader
              label="Cue · Meeting"
              elapsed={null}
              sub="Transcript ready — turn it into the recap"
            />
          }
          controls={
            <>
              <button
                type="button"
                className="cue-pressable"
                onClick={() => {
                  haptic.medium();
                  void handleCreateRecap();
                }}
                disabled={creating}
                style={{
                  ...v3Btn("primary"),
                  opacity: creating ? 0.75 : 1,
                  cursor: creating ? "default" : "pointer",
                }}
              >
                {creating ? <Spinner size={16} /> : null}
                {creating ? "Saving recap to memory…" : "Save recap to memory"}
              </button>
              {!creating ? (
                <button
                  type="button"
                  className="cue-pressable"
                  onClick={handleReset}
                  style={{ ...v3Btn("neutral"), flex: 0.6 }}
                >
                  Discard
                </button>
              ) : null}
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={sectionMicro}>Transcript</div>
            <div
              style={{
                background: "color-mix(in srgb, var(--mv3-text) 4%, transparent)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 14,
                padding: "11px 13px",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: "var(--mv3-muted)",
                fontStyle: "italic",
                whiteSpace: "pre-wrap",
              }}
            >
              {transcript}
            </div>
            {errorNote}
          </div>
        </V3Shell>
      );
    }

    // ---- Idle ----
    return (
      <V3Shell
        header={
          <V3CaptureHeader
            label="Cue · Meeting"
            elapsed={null}
            sub="Cue records, transcribes, then writes the recap into memory"
          />
        }
        controls={
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.medium();
              void handleStart();
            }}
            style={v3Btn("primary")}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "#fff",
              }}
            />
            Start recording
          </button>
        }
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            gap: 16,
            paddingTop: 40,
          }}
        >
          <CueRing size={110} stroke="var(--mv3-text)" />
          <div
            style={{
              fontSize: 13.5,
              color: "var(--mv3-muted)",
              lineHeight: 1.5,
              maxWidth: 290,
            }}
          >
            Commitments, decisions and to-dos are caught and typed by owner —
            yours, theirs, decided — then land in your work loop.
          </div>
          {errorNote}
        </div>
      </V3Shell>
    );
  }

  // ---- Unsupported environment -------------------------------------------
  if (!supported) {
    return (
      <CaptureFrame
        topLeft="Cue"
        caption="Live · take it into the meeting (phone now, wearable later)"
      >
        <ApertureAvatar size={104} />
        <div
          style={{
            fontSize: 12.5,
            color: "#9DB4E6",
            textAlign: "center",
            lineHeight: 1.45,
          }}
        >
          Recording isn&apos;t supported here.
        </div>
      </CaptureFrame>
    );
  }

  // ---- Recording ----------------------------------------------------------
  if (status === "recording") {
    return (
      <CaptureFrame
        topLeft="Cue"
        topRight={<RecPill elapsed={elapsed} />}
        caption="Live · take it into the meeting (phone now, wearable later)"
      >
        <ApertureAvatar state="listening" size={104} />
        <div
          style={{ display: "flex", alignItems: "center", gap: 5, height: 26 }}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="mc-bar"
              style={{ width: 4, borderRadius: 3, background: "#fff" }}
            />
          ))}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#9DB4E6",
            textAlign: "center",
            lineHeight: 1.45,
          }}
        >
          listening &amp; transcribing
        </div>
        <button type="button" onClick={handleStop} style={pillButton(false)}>
          Stop
        </button>
      </CaptureFrame>
    );
  }

  // ---- Transcribing -------------------------------------------------------
  if (status === "transcribing") {
    return (
      <CaptureFrame topLeft="Cue" caption="Transcribing your capture">
        <Spinner size={28} />
        <div
          style={{
            fontSize: 12.5,
            color: "#9DB4E6",
            textAlign: "center",
            lineHeight: 1.45,
          }}
        >
          Transcribing…
        </div>
      </CaptureFrame>
    );
  }

  // ---- Transcribed / Creating recap --------------------------------------
  if (status === "transcribed" || status === "creating-recap") {
    const creating = status === "creating-recap";
    return (
      <CaptureFrame
        topLeft="Cue"
        caption="Transcript ready · turn it into a recap"
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: "#7E8BA3",
            alignSelf: "flex-start",
          }}
        >
          Transcript →
        </div>
        <div
          style={{
            background: "rgba(255,255,255,.06)",
            borderRadius: 12,
            padding: "11px 13px",
            width: "100%",
            maxHeight: 168,
            overflowY: "auto",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "#E7ECF6",
            whiteSpace: "pre-wrap",
            borderLeft: `3px solid ${C.blue}`,
          }}
        >
          {transcript}
        </div>
        {error ? (
          <div
            style={{
              fontSize: 11.5,
              color: "#F0B7B6",
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={handleCreateRecap}
            disabled={creating}
            style={{
              ...pillButton(true),
              opacity: creating ? 0.7 : 1,
              cursor: creating ? "default" : "pointer",
            }}
          >
            {creating ? "Creating recap…" : "Create recap"}
          </button>
          {!creating ? (
            <button
              type="button"
              onClick={handleReset}
              style={pillButton(false)}
            >
              Discard
            </button>
          ) : null}
        </div>
      </CaptureFrame>
    );
  }

  // ---- Idle ---------------------------------------------------------------
  return (
    <CaptureFrame
      topLeft="Cue"
      caption="Live · take it into the meeting (phone now, wearable later)"
    >
      <ApertureAvatar size={104} />
      <div
        style={{
          fontSize: 12.5,
          color: "#9DB4E6",
          textAlign: "center",
          lineHeight: 1.45,
        }}
      >
        Cue records the room, transcribes it, and writes a recap to memory.
      </div>
      <button type="button" onClick={handleStart} style={pillButton(true)}>
        Start capture
      </button>
      {error ? (
        <div
          style={{
            fontSize: 11.5,
            color: "#F0B7B6",
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      ) : null}
    </CaptureFrame>
  );
}

/** Right column before any recap exists — describes what will appear here. */
function RecapPlaceholder() {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px dashed ${C.line2}`,
        borderRadius: 14,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        minHeight: 360,
        textAlign: "center",
      }}
    >
      <ApertureAvatar size={40} />
      <div style={{ fontWeight: 500, fontSize: 15 }}>
        Your recap appears here
      </div>
      <div
        style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5, maxWidth: 280 }}
      >
        Record the room, then choose <b>Create recap</b>. Cue writes a summary,
        action items, decisions, and people &amp; tone — and saves them into the
        8-type memory tagged to this meeting.
      </div>
    </div>
  );
}

/** The data-driven recap card, rendered from a real RecapJson. */
function Recap({
  recap,
  mobile = false,
}: {
  recap: RecapJson;
  mobile?: boolean;
}) {
  const peopleCount = recap.people.length;
  const subtitleParts = [
    peopleCount > 0
      ? `${peopleCount} ${peopleCount === 1 ? "person" : "people"}`
      : null,
    recap.tone ? `tone: ${recap.tone}` : null,
  ].filter(Boolean);

  // Theme bundle: dark surfaces/text on mobile, the original light palette on
  // desktop. The JSX below is identical for both — only these values swap.
  const tk = mobile
    ? {
        surface: D.surface,
        line: D.line,
        t1: D.t1,
        t2: D.t2,
        t3: D.t3,
        blue: D.blue,
        blueW: D.blueW,
        blueS: "#9CB7FF",
        violet: D.lilac,
        nestBg: D.surface2,
        nestLine: D.line,
        noteBg: D.surface,
        radius: mobile ? 18 : 14,
      }
    : {
        surface: C.surface,
        line: C.line,
        t1: C.t1,
        t2: C.t2,
        t3: C.t3,
        blue: C.blue,
        blueW: C.blueW,
        blueS: C.blueS,
        violet: C.violet,
        nestBg: C.surface,
        nestLine: C.line,
        noteBg: C.surface,
        radius: 14,
      };

  const cardStyle: React.CSSProperties = {
    background: tk.nestBg,
    border: `1px solid ${tk.nestLine}`,
    borderRadius: 13,
    padding: "13px 15px",
  };
  const titleStyle: React.CSSProperties = {
    fontSize: 13.5,
    fontWeight: 500,
    color: tk.t1,
  };
  const bodyStyle: React.CSSProperties = {
    fontSize: 12,
    color: tk.t2,
    marginTop: 3,
  };
  const countChip: React.CSSProperties = {
    fontFamily: mono,
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 5,
    background: tk.blueW,
    color: tk.blueS,
  };

  return (
    <div
      style={{
        background: tk.surface,
        border: `1px solid ${tk.line}`,
        borderRadius: tk.radius,
        padding: mobile ? 16 : 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        color: tk.t1,
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ApertureAvatar size={28} />
        <div>
          <div style={{ fontWeight: 500, color: tk.t1 }}>Meeting recap</div>
          {subtitleParts.length > 0 ? (
            <div style={{ fontFamily: mono, fontSize: 11, color: tk.t3 }}>
              {subtitleParts.join(" · ")}
            </div>
          ) : null}
        </div>
      </div>

      {/* summary */}
      <div style={cardStyle}>
        <div style={titleStyle}>Summary</div>
        <div style={bodyStyle}>
          {recap.summary || "No summary was produced."}
        </div>
      </div>

      {/* two-up — stacks on mobile */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: mobile ? "1fr" : "1fr 1fr",
          gap: 12,
        }}
      >
        <div style={cardStyle}>
          <div style={titleStyle}>
            Action items{" "}
            <span style={countChip}>{recap.actionItems.length}</span>
          </div>
          <div style={{ ...bodyStyle, marginTop: 6 }}>
            {recap.actionItems.length === 0 ? (
              <span style={{ color: tk.t3 }}>None captured.</span>
            ) : (
              recap.actionItems.map((item, i) => (
                <div key={i}>
                  {item.done ? "☑" : "☐"} {item.text}
                  {item.owner ? (
                    <>
                      {" — "}
                      <b style={{ color: tk.t1 }}>{item.owner}</b>
                    </>
                  ) : null}
                </div>
              ))
            )}
          </div>
          {/* Open action items became executable tasks (Activity → Cued). */}
          {recap.workItems.length > 0 ? (
            <Link
              to={routes.activity}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: 10,
                fontFamily: mono,
                fontSize: 11,
                color: mobile ? "#9CB7FF" : C.green,
                textDecoration: "none",
              }}
            >
              <span aria-hidden>✓</span>
              {recap.workItems.length === 1
                ? "Added to your tasks — open in Activity"
                : `${recap.workItems.length} added to your tasks — open in Activity`}
            </Link>
          ) : null}
        </div>
        <div style={cardStyle}>
          <div style={titleStyle}>People &amp; tone</div>
          <div style={{ ...bodyStyle, marginTop: 6 }}>
            {peopleCount === 0 ? (
              <span style={{ color: tk.t3 }}>No people identified.</span>
            ) : (
              recap.people.map((p, i) => (
                <div key={i}>
                  {p.name} — {p.tone}
                  {p.note ? `, ${p.note}` : ""}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* decisions */}
      {recap.decisions.length > 0 ? (
        <div style={cardStyle}>
          <div style={titleStyle}>
            Decisions <span style={countChip}>{recap.decisions.length}</span>
          </div>
          <div style={{ ...bodyStyle, marginTop: 6 }}>
            {recap.decisions.map((d, i) => (
              <div key={i}>• {d}</div>
            ))}
          </div>
        </div>
      ) : null}

      {/* link to the meeting conversation */}
      <div style={{ display: "flex", gap: 8 }}>
        <Link
          to={`/assistant/conversations/${recap.conversationId}`}
          style={{
            fontSize: mobile ? 14 : 12,
            fontWeight: mobile ? 600 : 400,
            border: `1px solid ${tk.blue}`,
            background: tk.blue,
            borderRadius: mobile ? 14 : 8,
            padding: mobile ? "13px 16px" : "5px 10px",
            color: "#fff",
            textDecoration: "none",
            width: mobile ? "100%" : undefined,
            textAlign: "center",
            minHeight: mobile ? 48 : undefined,
            display: mobile ? "flex" : undefined,
            alignItems: mobile ? "center" : undefined,
            justifyContent: mobile ? "center" : undefined,
          }}
        >
          Open meeting conversation
        </Link>
      </div>

      {/* note */}
      <div
        style={{
          background: tk.noteBg,
          border: `1px solid ${tk.line}`,
          borderLeft: `3px solid ${tk.violet}`,
          borderRadius: "0 12px 12px 0",
          padding: "11px 14px",
          fontSize: 13,
          color: tk.t2,
        }}
      >
        These items were written into the 8-type memory with source = this
        meeting, so they surface before your next related touchpoint.
      </div>
    </div>
  );
}

/**
 * Mobile v3 recap (frame 25's "caught" grammar, post-call): the extraction
 * cards typed by owner, the summary, and the door into the meeting thread.
 */
function V3RecapScreen({
  recap,
  onReset,
}: {
  recap: RecapJson;
  onReset: () => void;
}) {
  const navigate = useNavigate();
  let slot = 0;
  const nextDelay = () => 0.1 + 0.12 * slot++;
  return (
    <V3Shell
      header={
        <V3CaptureHeader
          label="Cue · Recap"
          elapsed={null}
          sub="Saved to memory — confirm anything Cue caught"
        />
      }
      controls={
        <>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.medium();
              navigate(routes.conversation(recap.conversationId));
            }}
            style={v3Btn("primary")}
          >
            Open meeting conversation
          </button>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              onReset();
            }}
            style={{ ...v3Btn("neutral"), flex: 0.7 }}
          >
            Capture another
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={sectionMicro}>Caught — confirm after the call</div>
        {recap.actionItems.map((item, i) => {
          const routed = caughtTypeFor(item.owner);
          return (
            <CaughtCard
              key={`a${i}`}
              type={routed.type}
              owner={routed.owner}
              text={item.text}
              delay={nextDelay()}
            />
          );
        })}
        {recap.decisions.map((d, i) => (
          <CaughtCard
            key={`d${i}`}
            type="decision"
            text={d}
            delay={nextDelay()}
          />
        ))}
        {recap.actionItems.length === 0 && recap.decisions.length === 0 ? (
          <div
            style={{
              fontSize: 13,
              color: "var(--mv3-muted)",
              padding: "6px 2px",
            }}
          >
            Nothing actionable was caught in this one.
          </div>
        ) : null}

        {recap.summary ? (
          <>
            <div style={{ ...sectionMicro, marginTop: 8 }}>Summary</div>
            <div
              style={{
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 16,
                padding: "12px 14px",
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--mv3-muted)",
                ...rise(nextDelay()),
              }}
            >
              {recap.summary}
            </div>
          </>
        ) : null}
      </div>
    </V3Shell>
  );
}

export function MeetingCapturePage() {
  const [recap, setRecap] = useState<RecapJson | null>(null);
  const isMobile = useIsMobile();

  // ---- Mobile: the v3 native capture surface (spec frame 25) --------------
  if (isMobile) {
    if (!recap) {
      return <LiveCapture onRecap={setRecap} mobile />;
    }
    return <V3RecapScreen recap={recap} onReset={() => setRecap(null)} />;
  }

  // ---- Desktop: the original two-column light layout ----------------------
  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        maxWidth: 1040,
        margin: "0 auto",
        padding: 24,
      }}
    >
      <style>{ANIM_CSS}</style>

      {/* page header */}
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Meeting capture
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 32,
            fontWeight: 400,
            letterSpacing: "-.4px",
            lineHeight: 1.1,
            marginTop: 6,
          }}
        >
          Capture → action items → memory
        </div>
        <div style={{ fontSize: 13.5, color: C.t2, marginTop: 6 }}>
          Cue listens in the room, extracts the decisions and to-dos live, then
          hands you a recap that writes itself into memory.
        </div>
      </div>

      {/* two-part responsive layout */}
      <div className="mc-grid">
        <div>
          <LiveCapture onRecap={setRecap} mobile={false} />
        </div>
        <div>{recap ? <Recap recap={recap} /> : <RecapPlaceholder />}</div>
      </div>

      <style>{`
        .mc-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .mc-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
