/**
 * VoiceDictationSurface — the dictation fallback for the standalone `/voice`
 * screen when full-duplex live voice (`voice-mode` flag) is OFF.
 *
 * The live-voice experience ({@link
 * import("./voice-mode-surface").VoiceModeSurface}) needs a WebSocket path to
 * velay (cloud) or a self-hosted gateway ingress. On a plain cloud self-host
 * neither is reachable, so that screen can only ever show "couldn't connect".
 *
 * This surface instead uses the **batch dictation** path — the same
 * {@link VoiceInputButton} the chat composer mounts, which records audio and
 * POSTs it to `/v1/stt/transcribe` (the user's configured STT provider, e.g.
 * Deepgram). That path has no flag gate and no WebSocket dependency, so it
 * works wherever the daemon's STT route does. On stop, the transcript is sent
 * as a fresh chat message and we navigate into the resulting conversation —
 * the "tap, talk, and Cue answers" experience the Voice tab promises, minus
 * the spoken reply.
 *
 * It renders the same calm full-bleed ink panel as the live surface so the
 * Voice tab looks identical regardless of which transport backs it.
 */

import { useCallback, useRef, useState } from "react";

import { VoiceOrb } from "@vellumai/design-library/components/voice-orb";
import { Keyboard } from "lucide-react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { postChatMessage } from "@/domains/chat/api/messages";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { formatVoiceError } from "@/domains/chat/utils/chat";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { routes } from "@/utils/routes";

const mono = "'DM Mono', ui-monospace, monospace";

const INK_GRADIENT =
  "radial-gradient(120% 70% at 50% 30%, #22324F 0%, #161E2C 50%, #0C1018 100%)";
const BLUE = "#3D6EE8";
const DANGER = "#E5634B";
const TEXT_2 = "#8A97AC";
const TEXT_3 = "#5E6B80";
const LINE_2 = "rgba(255,255,255,.14)";
const SURFACE = "#212B3B";

const safeInset = (side: "top" | "bottom" | "left" | "right") =>
  `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;

export interface VoiceDictationSurfaceProps {
  /** Renders a "Done" affordance returning to the composer (in-chat overlay). */
  onExit?: () => void;
}

export function VoiceDictationSurface({ onExit }: VoiceDictationSurfaceProps) {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const voiceInputRef = useRef<VoiceInputButtonHandle | null>(null);
  const [voiceErrorCode, setVoiceErrorCode] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const phase = useVoiceRecordingStore.use.phase();
  const interim = useVoiceRecordingStore.use.interimTranscript();
  const recording = phase === "recording";
  const processing = phase === "processing";

  // On a final transcript: show it, then auto-send into a fresh server-minted
  // conversation and navigate. Auto-send mirrors the Voice tab's "talk and Cue
  // answers" promise (the live surface auto-turns too). Posts via the same
  // `postChatMessage(null)` mint flow the dashboard query bar uses.
  const handleTranscript = useCallback(
    (text: string) => {
      const next = text.trim();
      if (!next || !assistantId) return;
      setTranscript(next);
      setSendError(null);
      setSubmitting(true);
      void (async () => {
        try {
          const result = await postChatMessage(assistantId, null, next);
          if (!result.ok) {
            setSendError(
              result.error.detail ?? "Couldn’t reach Cue — try again.",
            );
            return;
          }
          navigate(routes.conversation(result.conversationId));
        } catch {
          setSendError("Couldn’t reach Cue — try again.");
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [assistantId, navigate],
  );

  const toggle = useCallback(() => {
    if (processing || submitting) return;
    setVoiceErrorCode(null);
    if (recording) {
      voiceInputRef.current?.stop();
    } else {
      voiceInputRef.current?.start();
    }
  }, [processing, submitting, recording]);

  const errorMessage = voiceErrorCode
    ? formatVoiceError(voiceErrorCode)
    : sendError;

  const statusLabel = processing
    ? "transcribing…"
    : submitting
      ? "sending…"
      : recording
        ? "● listening"
        : "tap to talk";

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
        gap: 26,
        paddingTop: `calc(28px + ${safeInset("top")})`,
        paddingBottom: `calc(28px + ${safeInset("bottom")})`,
        paddingLeft: `calc(24px + ${safeInset("left")})`,
        paddingRight: `calc(24px + ${safeInset("right")})`,
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
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

      {/* The VoiceInputButton owns the MediaRecorder + STT lifecycle but we
          drive it imperatively via the ref and render our own big orb, so its
          own small button stays hidden. */}
      <VoiceInputButton
        ref={voiceInputRef}
        assistantId={assistantId}
        onTranscript={handleTranscript}
        onError={setVoiceErrorCode}
        renderButton={false}
      />

      <div
        style={{
          fontFamily: mono,
          fontSize: 10.5,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: recording ? BLUE : TEXT_2,
        }}
      >
        {statusLabel}
      </div>

      <div
        style={{
          maxWidth: 560,
          minHeight: 84,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        {interim ? (
          <span
            style={{
              fontSize: 20,
              fontWeight: 600,
              lineHeight: 1.4,
              letterSpacing: "-0.3px",
              color: BLUE,
            }}
          >
            {interim}
          </span>
        ) : transcript ? (
          <span
            style={{
              fontSize: 20,
              fontWeight: 600,
              lineHeight: 1.4,
              letterSpacing: "-0.3px",
            }}
          >
            {transcript}
          </span>
        ) : (
          <div style={{ fontSize: 17, lineHeight: 1.45, color: TEXT_2 }}>
            {recording
              ? "Listening — say something."
              : "Tap the mic and speak. Cue opens a conversation with the answer."}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-label={recording ? "Stop dictation" : "Start dictation"}
        disabled={processing || submitting}
        style={{
          width: 150,
          height: 150,
          flexShrink: 0,
          background: "transparent",
          border: "none",
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: processing || submitting ? "default" : "pointer",
        }}
      >
        <span
          style={{
            width: 118,
            height: 118,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: recording ? BLUE : SURFACE,
            boxShadow: recording
              ? "0 20px 50px -16px rgba(61,110,232,.7)"
              : "0 16px 40px -20px rgba(0,0,0,.8)",
            opacity: processing || submitting ? 0.6 : 1,
            transition: "background 160ms ease, opacity 160ms ease",
          }}
        >
          <VoiceOrb
            state={
              processing || submitting
                ? "thinking"
                : recording
                  ? "listening"
                  : "idle"
            }
            size={88}
          />
        </span>
      </button>

      {errorMessage ? (
        <div style={{ fontSize: 13, color: DANGER, maxWidth: 420 }}>
          {errorMessage}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: TEXT_3, maxWidth: 360 }}>
          Speech-to-text uses your configured provider (Settings → Voice).
        </div>
      )}
    </div>
  );
}
