import { ApertureAvatar } from "@vellumai/design-library/components/aperture-avatar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { meetingsRecapPost, sttTranscribePost } from "@/generated/daemon/sdk.gen";
import type { MeetingsRecapPostResponses } from "@/generated/daemon/types.gen";

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

const C = {
  ink: "#1A2230",
  ink2: "#24303F",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
  red: "#E24B4A",
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

const card = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 13,
  padding: "13px 15px",
} as const;
const cardTitle = { fontSize: 13.5, fontWeight: 500 } as const;
const cardBody = { fontSize: 12, color: C.t2, marginTop: 3 } as const;
const chipBase = {
  fontSize: 12,
  border: `1px solid ${C.line2}`,
  background: C.surface,
  borderRadius: 8,
  padding: "5px 10px",
  color: C.t1,
} as const;

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
          background: C.ink,
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

/** The blinking-rec pill from the original design, now driven by the live timer. */
function RecPill({ elapsed }: { elapsed: number }) {
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

function LiveCapture({ onRecap }: { onRecap: (recap: RecapJson) => void }) {
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
function Recap({ recap }: { recap: RecapJson }) {
  const peopleCount = recap.people.length;
  const subtitleParts = [
    peopleCount > 0 ? `${peopleCount} ${peopleCount === 1 ? "person" : "people"}` : null,
    recap.tone ? `tone: ${recap.tone}` : null,
  ].filter(Boolean);

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ApertureAvatar size={28} />
        <div>
          <div style={{ fontWeight: 500 }}>Meeting recap</div>
          {subtitleParts.length > 0 ? (
            <div style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
              {subtitleParts.join(" · ")}
            </div>
          ) : null}
        </div>
      </div>

      {/* summary */}
      <div style={card}>
        <div style={cardTitle}>Summary</div>
        <div style={cardBody}>{recap.summary || "No summary was produced."}</div>
      </div>

      {/* two-up */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={card}>
          <div style={cardTitle}>
            Action items{" "}
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 5,
                background: C.blueW,
                color: C.blueS,
              }}
            >
              {recap.actionItems.length}
            </span>
          </div>
          <div style={{ ...cardBody, marginTop: 6 }}>
            {recap.actionItems.length === 0 ? (
              <span style={{ color: C.t3 }}>None captured.</span>
            ) : (
              recap.actionItems.map((item, i) => (
                <div key={i}>
                  {item.done ? "☑" : "☐"} {item.text}
                  {item.owner ? (
                    <>
                      {" — "}
                      <b>{item.owner}</b>
                    </>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
        <div style={card}>
          <div style={cardTitle}>People &amp; tone</div>
          <div style={{ ...cardBody, marginTop: 6 }}>
            {peopleCount === 0 ? (
              <span style={{ color: C.t3 }}>No people identified.</span>
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
        <div style={card}>
          <div style={cardTitle}>
            Decisions{" "}
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 5,
                background: C.blueW,
                color: C.blueS,
              }}
            >
              {recap.decisions.length}
            </span>
          </div>
          <div style={{ ...cardBody, marginTop: 6 }}>
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
            ...chipBase,
            background: C.blue,
            borderColor: C.blue,
            color: "#fff",
            textDecoration: "none",
          }}
        >
          Open meeting conversation
        </Link>
      </div>

      {/* note */}
      <div
        style={{
          background: "#fff",
          border: `1px solid ${C.line}`,
          borderLeft: `3px solid ${C.violet}`,
          borderRadius: "0 12px 12px 0",
          padding: "11px 14px",
          fontSize: 13,
          color: C.t2,
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
          <LiveCapture onRecap={setRecap} />
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
