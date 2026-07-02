import { ApertureAvatar } from "@vellumai/design-library/components/aperture-avatar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { meetingsRecapPost, sttTranscribePost } from "@/generated/daemon/sdk.gen";
import type { MeetingsRecapPostResponses } from "@/generated/daemon/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
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
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio"));
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
  | "idle"
  | "recording"
  | "transcribing"
  | "transcribed"
  | "creating-recap";

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
function RecPill({ elapsed, mobile = false }: { elapsed: number; mobile?: boolean }) {
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
          style={{ width: 9, height: 9, borderRadius: "50%", background: D.danger }}
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

/**
 * Full-width, ≥44pt touch target for the mobile bottom-third controls.
 * `tone`: primary (blue) · neutral (glass) · danger (stop).
 */
function mobileButton(tone: "primary" | "neutral" | "danger"): React.CSSProperties {
  const bg =
    tone === "primary" ? D.blue : tone === "danger" ? "rgba(229,99,75,.16)" : "rgba(255,255,255,.06)";
  const border =
    tone === "primary"
      ? `1px solid ${D.blue}`
      : tone === "danger"
        ? `1px solid rgba(229,99,75,.55)`
        : `1px solid ${D.line2}`;
  return {
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: ".01em",
    border,
    background: bg,
    color: tone === "danger" ? "#FFD9CF" : "#fff",
    borderRadius: 14,
    minHeight: 52,
    padding: "0 18px",
    width: "100%",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  };
}

/**
 * The mobile phone shell: a full-bleed dark ink gradient with safe-area
 * insets. `content` fills the upper area (scrollable); `controls` is pinned to
 * the bottom third for thumb reach (README-MOBILE §3.6 / §1).
 */
function MobileShell({
  topBar,
  content,
  controls,
}: {
  topBar: React.ReactNode;
  content: React.ReactNode;
  controls: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: `linear-gradient(180deg, ${D.ink} 0%, ${D.inkDeep} 72%, ${D.inkBottom} 100%)`,
        color: D.t1,
        display: "flex",
        flexDirection: "column",
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}
    >
      <style>{ANIM_CSS}</style>
      {/* top bar — eyebrow + REC indicator, padded for the notch */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "calc(env(safe-area-inset-top, 0px) + 16px) 20px 8px",
          flexShrink: 0,
        }}
      >
        {topBar}
      </div>

      {/* scrollable capture / recap body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "8px 20px 12px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {content}
      </div>

      {/* bottom-third controls — pinned within thumb reach */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "14px 20px calc(env(safe-area-inset-bottom, 0px) + 18px)",
          borderTop: `1px solid ${D.line}`,
          background: "rgba(12,16,24,.55)",
        }}
      >
        {controls}
      </div>
    </div>
  );
}

function LiveCapture({ onRecap, mobile }: { onRecap: (recap: RecapJson) => void; mobile: boolean }) {
  const assistantId = useActiveAssistantId();

  const [supported] = useState<boolean>(() => recordingSupported());
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
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
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Couldn't start the mic — check microphone permissions and try again.");
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
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop(); // onstop assembles + transcribes
    } else {
      clearTimer();
      releaseStream();
    }
  }, [clearTimer, releaseStream]);

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
    setError(null);
  }, []);

  // =====================================================================
  // Mobile (README-MOBILE §3.6): full-bleed dark phone shell, the flow
  // record → live transcript → recap, REC indicator up top, Stop & Save
  // controls pinned in the bottom third for thumb reach.
  // =====================================================================
  if (mobile) {
    const recording = status === "recording";
    const transcribing = status === "transcribing";
    const reviewing = status === "transcribed" || status === "creating-recap";
    const creating = status === "creating-recap";

    const topBar = (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: ".12em", color: D.t2 }}>
            CUE · MEETING
          </span>
        </div>
        {recording ? <RecPill elapsed={elapsed} mobile /> : null}
      </>
    );

    const errorNote = error ? (
      <div
        style={{
          marginTop: 14,
          fontSize: 12.5,
          color: "#F3B8AC",
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
        <MobileShell
          topBar={topBar}
          content={
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                gap: 16,
                padding: "0 8px",
              }}
            >
              <ApertureAvatar size={96} />
              <div style={{ fontSize: 14, color: D.t2, lineHeight: 1.5, maxWidth: 280 }}>
                Recording isn&apos;t supported here. Open Meeting capture on your phone to record the
                room.
              </div>
            </div>
          }
          controls={
            <button type="button" disabled style={{ ...mobileButton("neutral"), opacity: 0.55, cursor: "default" }}>
              Recording unavailable
            </button>
          }
        />
      );
    }

    // ---- Recording ----
    if (recording) {
      return (
        <MobileShell
          topBar={topBar}
          content={
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                gap: 22,
              }}
            >
              <ApertureAvatar state="listening" size={132} />
              <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 30 }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className="mc-bar" style={{ width: 5, borderRadius: 3, background: "#fff" }} />
                ))}
              </div>
              <div style={{ fontSize: 14, color: D.t2, lineHeight: 1.5 }}>
                Listening &amp; transcribing the room…
              </div>
            </div>
          }
          controls={
            <button type="button" onClick={handleStop} style={mobileButton("danger")}>
              <span style={{ width: 11, height: 11, borderRadius: 3, background: D.danger }} />
              Stop &amp; transcribe
            </button>
          }
        />
      );
    }

    // ---- Transcribing ----
    if (transcribing) {
      return (
        <MobileShell
          topBar={topBar}
          content={
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                gap: 18,
              }}
            >
              <Spinner size={34} />
              <div style={{ fontSize: 14, color: D.t2 }}>Transcribing your capture…</div>
            </div>
          }
          controls={
            <button type="button" disabled style={{ ...mobileButton("neutral"), opacity: 0.6, cursor: "default" }}>
              Transcribing…
            </button>
          }
        />
      );
    }

    // ---- Transcript ready → create recap ----
    if (reviewing) {
      return (
        <MobileShell
          topBar={topBar}
          content={
            <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>
              <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: ".06em", color: D.t3 }}>
                TRANSCRIPT
              </div>
              <div
                style={{
                  background: D.surface,
                  border: `1px solid ${D.line}`,
                  borderLeft: `3px solid ${D.blue}`,
                  borderRadius: 16,
                  padding: "14px 16px",
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: "#E7ECF6",
                  whiteSpace: "pre-wrap",
                }}
              >
                {transcript}
              </div>
              {errorNote}
            </div>
          }
          controls={
            <>
              <button
                type="button"
                onClick={handleCreateRecap}
                disabled={creating}
                style={{ ...mobileButton("primary"), opacity: creating ? 0.75 : 1, cursor: creating ? "default" : "pointer" }}
              >
                {creating ? <Spinner size={18} /> : null}
                {creating ? "Saving recap to memory…" : "Save recap to memory"}
              </button>
              {!creating ? (
                <button type="button" onClick={handleReset} style={mobileButton("neutral")}>
                  Discard
                </button>
              ) : null}
            </>
          }
        />
      );
    }

    // ---- Idle ----
    return (
      <MobileShell
        topBar={topBar}
        content={
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              gap: 18,
              padding: "0 6px",
            }}
          >
            <ApertureAvatar size={132} />
            <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-.3px", lineHeight: 1.25 }}>
              Capture the room
            </div>
            <div style={{ fontSize: 14, color: D.t2, lineHeight: 1.5, maxWidth: 290 }}>
              Cue records, transcribes live, then writes a recap — summary, action items, decisions —
              into memory.
            </div>
            {errorNote}
          </div>
        }
        controls={
          <button type="button" onClick={handleStart} style={mobileButton("primary")}>
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#fff" }} />
            Start recording
          </button>
        }
      />
    );
  }

  // ---- Unsupported environment -------------------------------------------
  if (!supported) {
    return (
      <CaptureFrame topLeft="Cue" caption="Live · take it into the meeting (phone now, wearable later)">
        <ApertureAvatar size={104} />
        <div style={{ fontSize: 12.5, color: "#9DB4E6", textAlign: "center", lineHeight: 1.45 }}>
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
        <div style={{ display: "flex", alignItems: "center", gap: 5, height: 26 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="mc-bar" style={{ width: 4, borderRadius: 3, background: "#fff" }} />
          ))}
        </div>
        <div style={{ fontSize: 12, color: "#9DB4E6", textAlign: "center", lineHeight: 1.45 }}>
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
        <div style={{ fontSize: 12.5, color: "#9DB4E6", textAlign: "center", lineHeight: 1.45 }}>
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
        <div style={{ fontFamily: mono, fontSize: 11, color: "#7E8BA3", alignSelf: "flex-start" }}>
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
          <div style={{ fontSize: 11.5, color: "#F0B7B6", textAlign: "center", lineHeight: 1.4 }}>
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={handleCreateRecap}
            disabled={creating}
            style={{ ...pillButton(true), opacity: creating ? 0.7 : 1, cursor: creating ? "default" : "pointer" }}
          >
            {creating ? "Creating recap…" : "Create recap"}
          </button>
          {!creating ? (
            <button type="button" onClick={handleReset} style={pillButton(false)}>
              Discard
            </button>
          ) : null}
        </div>
      </CaptureFrame>
    );
  }

  // ---- Idle ---------------------------------------------------------------
  return (
    <CaptureFrame topLeft="Cue" caption="Live · take it into the meeting (phone now, wearable later)">
      <ApertureAvatar size={104} />
      <div style={{ fontSize: 12.5, color: "#9DB4E6", textAlign: "center", lineHeight: 1.45 }}>
        Cue records the room, transcribes it, and writes a recap to memory.
      </div>
      <button type="button" onClick={handleStart} style={pillButton(true)}>
        Start capture
      </button>
      {error ? (
        <div style={{ fontSize: 11.5, color: "#F0B7B6", textAlign: "center", lineHeight: 1.4 }}>
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
      <div style={{ fontWeight: 500, fontSize: 15 }}>Your recap appears here</div>
      <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5, maxWidth: 280 }}>
        Record the room, then choose <b>Create recap</b>. Cue writes a summary, action items,
        decisions, and people &amp; tone — and saves them into the 8-type memory tagged to this
        meeting.
      </div>
    </div>
  );
}

/** The data-driven recap card, rendered from a real RecapJson. */
function Recap({ recap, mobile = false }: { recap: RecapJson; mobile?: boolean }) {
  const peopleCount = recap.people.length;
  const subtitleParts = [
    peopleCount > 0 ? `${peopleCount} ${peopleCount === 1 ? "person" : "people"}` : null,
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
  const titleStyle: React.CSSProperties = { fontSize: 13.5, fontWeight: 500, color: tk.t1 };
  const bodyStyle: React.CSSProperties = { fontSize: 12, color: tk.t2, marginTop: 3 };
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
        <div style={bodyStyle}>{recap.summary || "No summary was produced."}</div>
      </div>

      {/* two-up — stacks on mobile */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 12 }}>
        <div style={cardStyle}>
          <div style={titleStyle}>
            Action items <span style={countChip}>{recap.actionItems.length}</span>
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
        These items were written into the 8-type memory with source = this meeting, so they surface
        before your next related touchpoint.
      </div>
    </div>
  );
}

export function MeetingCapturePage() {
  const [recap, setRecap] = useState<RecapJson | null>(null);
  const isMobile = useIsMobile();

  // ---- Mobile: full-bleed dark phone surface ------------------------------
  if (isMobile) {
    // Before a recap exists, LiveCapture owns the whole dark shell (record →
    // transcript → save). Once a recap lands, render it in a matching dark
    // shell with a bottom-third "Capture another meeting" control.
    if (!recap) {
      return <LiveCapture onRecap={setRecap} mobile />;
    }
    return (
      <MobileShell
        topBar={
          <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: ".12em", color: D.t2 }}>
            CUE · RECAP
          </span>
        }
        content={
          <div style={{ paddingTop: 4 }}>
            <Recap recap={recap} mobile />
          </div>
        }
        controls={
          <button type="button" onClick={() => setRecap(null)} style={mobileButton("neutral")}>
            Capture another meeting
          </button>
        }
      />
    );
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
        <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-.4px", marginTop: 6 }}>
          Capture → action items → memory
        </div>
        <div style={{ fontSize: 13.5, color: C.t2, marginTop: 6 }}>
          Cue listens in the room, extracts the decisions and to-dos live, then hands you a recap
          that writes itself into memory.
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
