/**
 * Voice mode (design v0.2 §05 / DESIGN-SPEC §5).
 *
 * Full-bleed ink screen with the VoiceOrb + live transcript. Wired to the real
 * full-duplex live-voice session (`useLiveVoice`): tap the orb to start, again
 * to stop. The in-flight user phrase shows in blue, finalized text in white,
 * and Cue's reply below. Gated behind the `voice-mode` assistant flag — renders
 * a clear disabled state when it's off (matching the live-voice button's gate).
 */

import { useCallback } from "react";

import { VoiceOrb, type VoiceOrbState } from "@vellumai/design-library/components/voice-orb";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

const mono = "'DM Mono', ui-monospace, monospace";

/** Map the live-voice session phase onto the orb's four visual states. */
function orbState(state: string): VoiceOrbState {
  switch (state) {
    case "listening":
    case "transcribing":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    default:
      return "idle";
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "connecting":
      return "connecting…";
    case "listening":
    case "transcribing":
      return "● listening";
    case "thinking":
      return "thinking…";
    case "speaking":
      return "speaking";
    case "ending":
      return "ending…";
    case "failed":
      return "couldn't connect";
    default:
      return "tap to talk";
  }
}

export function VoiceModePage() {
  const assistantId = useActiveAssistantId();
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    error,
    start,
    stop,
  } = useLiveVoice();

  const connecting = state === "connecting";
  const active =
    state !== "idle" && state !== "failed" && state !== "connecting";

  const handleToggle = useCallback(() => {
    if (connecting) return;
    if (active) {
      void stop();
    } else {
      void start(assistantId, undefined);
    }
  }, [active, connecting, start, stop, assistantId]);

  return (
    <div
      style={{
        height: "100%",
        background: "var(--surface-ink)",
        color: "var(--content-on-ink)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: 24,
        textAlign: "center",
      }}
    >
      {!voiceMode ? (
        <div style={{ maxWidth: 360 }}>
          <VoiceOrb state="idle" size={120} />
          <div style={{ fontSize: 17, fontWeight: 500, marginTop: 24 }}>
            Voice mode isn't enabled
          </div>
          <div
            style={{
              fontSize: 13.5,
              color: "var(--content-on-ink-muted)",
              marginTop: 8,
            }}
          >
            Turn on voice mode for this assistant (Settings → Models &amp;
            Services → Voice) and set a speech-to-text provider to talk to Cue
            hands-free.
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={handleToggle}
            aria-label={active ? "Stop voice mode" : "Start voice mode"}
            disabled={connecting}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: connecting ? "default" : "pointer",
            }}
          >
            <VoiceOrb state={orbState(state)} size={160} />
          </button>

          <div
            style={{
              fontFamily: mono,
              fontSize: 12.5,
              letterSpacing: "0.06em",
              color:
                state === "listening" || state === "transcribing"
                  ? "var(--accent-cue)"
                  : "var(--content-on-ink-muted)",
            }}
          >
            {stateLabel(state)}
          </div>

          {/* Live transcript: finalized (white) + in-flight (blue) + reply. */}
          <div style={{ maxWidth: 560, minHeight: 80 }}>
            {finalTranscript ? (
              <span style={{ fontSize: 18, lineHeight: 1.5 }}>
                {finalTranscript}{" "}
              </span>
            ) : null}
            {partialTranscript ? (
              <span
                style={{
                  fontSize: 18,
                  lineHeight: 1.5,
                  color: "var(--accent-cue)",
                }}
              >
                {partialTranscript}
              </span>
            ) : null}
            {!finalTranscript && !partialTranscript && !assistantTranscript ? (
              <div
                style={{
                  fontSize: 15,
                  color: "var(--content-on-ink-muted)",
                }}
              >
                {active
                  ? "Listening — say something."
                  : "Tap the orb and start talking."}
              </div>
            ) : null}
            {assistantTranscript ? (
              <div
                style={{
                  fontSize: 15,
                  lineHeight: 1.5,
                  color: "var(--content-on-ink-muted)",
                  marginTop: 14,
                }}
              >
                {assistantTranscript}
              </div>
            ) : null}
          </div>

          {error ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--system-negative-hover, #E86B40)",
                maxWidth: 420,
              }}
            >
              {error}
            </div>
          ) : null}

          {active ? (
            <button
              type="button"
              onClick={() => void stop()}
              style={{
                fontFamily: mono,
                fontSize: 12,
                color: "var(--content-on-ink-muted)",
                background: "transparent",
                border: "1px solid color-mix(in srgb, var(--content-on-ink) 22%, transparent)",
                borderRadius: 999,
                padding: "7px 18px",
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
