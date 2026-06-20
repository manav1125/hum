/**
 * Voice mode (design v0.2 §05 / DESIGN-SPEC §5).
 *
 * Full-bleed ink screen with the VoiceOrb + live transcript. Wired to the real
 * full-duplex live-voice session (`useLiveVoice`): tap the orb to start, again
 * to stop. The in-flight user phrase shows in blue, finalized text in white,
 * and Cue's reply below. Gated behind the `voice-mode` assistant flag — renders
 * a clear disabled state when it's off (matching the live-voice button's gate).
 *
 * Two controls sit alongside start/stop:
 *  - a MUTE toggle that disables the live mic's audio tracks (the session, socket
 *    and capture graph stay up — see `useLiveVoice().setMuted`); and
 *  - a VOICE picker that chooses the TTS provider. Providers come from the real
 *    `ttsProvidersGetOptions` catalog and the choice is persisted to the same
 *    `LS_TTS_PROVIDER` localStorage key the Settings → Text-to-Speech card uses,
 *    so the two surfaces stay in sync (the daemon resolves the provider from
 *    config server-side; there is no per-session provider override on the wire).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Mic, MicOff } from "lucide-react";

import { VoiceOrb, type VoiceOrbState } from "@vellumai/design-library/components/voice-orb";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { ttsProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { LS_TTS_PROVIDER, TTS_PROVIDERS } from "@/domains/settings/ai/ai-types";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  getLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";

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
  const isOrgReady = useIsOrgReady();
  const {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    error,
    muted,
    start,
    stop,
    setMuted,
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

  // --- TTS provider (voice) picker -----------------------------------------
  // Real provider catalog from the daemon; falls back to the static list while
  // loading. Selection persists to LS_TTS_PROVIDER — the exact key the Settings
  // Text-to-Speech card writes — so the two surfaces stay in sync.
  const { data: catalogData } = useQuery({
    ...ttsProvidersGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: Infinity,
  });
  const providers = catalogData?.providers ?? TTS_PROVIDERS;
  const defaultProviderId = providers[0]?.id ?? "elevenlabs";

  const [provider, setProvider] = useState<string>(() =>
    getLocalSetting(LS_TTS_PROVIDER, defaultProviderId),
  );

  // Reflect changes made elsewhere (e.g. the Settings TTS card) without a reload.
  useEffect(() => {
    return watchSetting(LS_TTS_PROVIDER, () => {
      setProvider(getLocalSetting(LS_TTS_PROVIDER, defaultProviderId));
    });
  }, [defaultProviderId]);

  const handleProviderChange = useCallback((next: string) => {
    setProvider(next);
    setLocalSetting(LS_TTS_PROVIDER, next);
  }, []);

  const providerOptions = useMemo(
    () => providers.map((p) => ({ value: p.id, label: p.displayName })),
    [providers],
  );

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
              opacity: muted && active ? 0.55 : 1,
              transition: "opacity 120ms ease",
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
                muted && active
                  ? "var(--content-on-ink-muted)"
                  : state === "listening" || state === "transcribing"
                    ? "var(--accent-cue)"
                    : "var(--content-on-ink-muted)",
            }}
          >
            {muted && active ? "muted" : stateLabel(state)}
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
                  ? muted
                    ? "Muted — unmute to talk."
                    : "Listening — say something."
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

          {/* Controls row: mute (active only) + stop (active only). */}
          {active ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setMuted(!muted)}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={muted}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: mono,
                  fontSize: 12,
                  color: muted
                    ? "var(--content-on-ink)"
                    : "var(--content-on-ink-muted)",
                  background: muted
                    ? "color-mix(in srgb, var(--content-on-ink) 14%, transparent)"
                    : "transparent",
                  border:
                    "1px solid color-mix(in srgb, var(--content-on-ink) 22%, transparent)",
                  borderRadius: 999,
                  padding: "7px 16px",
                  cursor: "pointer",
                }}
              >
                {muted ? (
                  <MicOff size={14} aria-hidden />
                ) : (
                  <Mic size={14} aria-hidden />
                )}
                {muted ? "Unmute" : "Mute"}
              </button>

              <button
                type="button"
                onClick={() => void stop()}
                style={{
                  fontFamily: mono,
                  fontSize: 12,
                  color: "var(--content-on-ink-muted)",
                  background: "transparent",
                  border:
                    "1px solid color-mix(in srgb, var(--content-on-ink) 22%, transparent)",
                  borderRadius: 999,
                  padding: "7px 18px",
                  cursor: "pointer",
                }}
              >
                Stop
              </button>
            </div>
          ) : null}

          {/* Voice / TTS-provider picker — only while idle, so a turn isn't
              interrupted; persists to the shared LS_TTS_PROVIDER key. */}
          {!active ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                width: 220,
              }}
            >
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  letterSpacing: "0.06em",
                  color: "var(--content-on-ink-muted)",
                }}
              >
                VOICE
              </span>
              <Dropdown
                value={provider}
                onChange={handleProviderChange}
                options={providerOptions}
                aria-label="Voice provider"
                menuAlign="start"
                style={{ width: "100%" }}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
