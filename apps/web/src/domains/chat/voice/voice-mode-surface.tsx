/**
 * VoiceModeSurface — the shared voice experience (orb + live transcript +
 * controls), reused by both the standalone `/voice` route ({@link
 * import("./voice-mode-page").VoiceModePage}) and the in-chat voice overlay
 * ({@link import("@/domains/chat/components/in-chat-voice-overlay").InChatVoiceOverlay}).
 *
 * It is the single owner of the {@link useLiveVoice} controller while mounted —
 * there must never be two `useLiveVoice()` instances live at once (each owns an
 * unmount-teardown effect on the shared store, so two would race). The composer
 * reads live-voice state via the store's per-field selectors; it does NOT mount
 * a controller, so mounting this surface (route or overlay) keeps the count at
 * one.
 *
 * Behaviour matches the previous full-screen page exactly:
 *  - Full-bleed ink panel with the VoiceOrb; tap the orb to start/stop.
 *  - In-flight user phrase in blue, finalized text in white, Cue's reply below.
 *  - Gated behind the `voice-mode` assistant flag — a clear disabled state when
 *    off (mirrors the live-voice button's gate).
 *  - MUTE toggle (disables the mic's audio tracks; session/socket stay up).
 *  - VOICE picker for the TTS provider, persisted to the shared
 *    `LS_TTS_PROVIDER` key so Settings → Text-to-Speech stays in sync.
 *
 * Two parameters extend it for the in-chat use:
 *  - `conversationId` binds a started session to the active conversation so the
 *    spoken turns land in the same thread (the route passes nothing → a fresh
 *    session for the assistant, as before).
 *  - `onExit` renders a "Done" affordance that returns to the text composer;
 *    when omitted (the route) no exit control is shown. Exiting stops any active
 *    session first so the mic/socket are released.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Keyboard, Mic, MicOff } from "lucide-react";

import {
  VoiceOrb,
  type VoiceOrbState,
} from "@vellumai/design-library/components/voice-orb";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import { VoiceDictationSurface } from "@/domains/chat/voice/voice-dictation-surface";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { ttsProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
// eslint-disable-next-line local/no-cross-domain-imports -- pre-existing; settings TTS types reused by the voice surface
import { LS_TTS_PROVIDER, TTS_PROVIDERS } from "@/domains/settings/ai/ai-types";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  getLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";

const mono = "'DM Mono', ui-monospace, monospace";

// Design tokens (dark-v1 mobile book §1). Used as inline literals so this calm,
// full-bleed surface renders identically on the route and the in-chat overlay
// regardless of the host theme — the Voice screen is intentionally ink-only.
const INK_GRADIENT =
  "radial-gradient(120% 70% at 50% 30%, #22324F 0%, #161E2C 50%, #0C1018 100%)";
const BLUE = "#3D6EE8";
const DANGER = "#E5634B";
const TEXT_2 = "#8A97AC";
const TEXT_3 = "#5E6B80";
const LINE = "rgba(255,255,255,.08)";
const LINE_2 = "rgba(255,255,255,.14)";
const SURFACE = "#212B3B";

const safeInset = (side: "top" | "bottom" | "left" | "right") =>
  `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;

/**
 * Listening pulse rings + waveform keyframes (book §5: `cueVoiceRing`, `cueBar`).
 * Scoped to this surface and disabled under `prefers-reduced-motion`. Purely
 * presentational — no bearing on the session lifecycle.
 */
const VOICE_KEYFRAMES = `
@keyframes cueVoiceRing { 0% { transform: scale(.9); opacity: .5 } 100% { transform: scale(1.6); opacity: 0 } }
@keyframes cueBar { 0%,100% { transform: scaleY(.28) } 50% { transform: scaleY(1) } }
@media (prefers-reduced-motion: reduce) {
  .cue-voice-ring, .cue-voice-bar { animation: none !important }
}
`;

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

export interface VoiceModeSurfaceProps {
  /**
   * Conversation the started session attaches to, so spoken turns land in the
   * same thread. Omitted on the standalone route → a fresh session for the
   * assistant.
   */
  conversationId?: string | null;
  /**
   * When provided, renders a "Done" affordance (keyboard icon) that returns to
   * the text composer. Used by the in-chat overlay; the standalone route omits
   * it. Exiting stops any active session first.
   */
  onExit?: () => void;
  /**
   * Auto-start a session on mount (used by the in-chat overlay so tapping the
   * composer mic drops straight into a live session). The route defaults to
   * tap-to-start. Auto-start respects the flag + assistant readiness.
   */
  autoStart?: boolean;
}

export function VoiceModeSurface({
  conversationId,
  onExit,
  autoStart = false,
}: VoiceModeSurfaceProps) {
  const assistantId = useActiveAssistantId();
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const isOrgReady = useIsOrgReady();
  const {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    inputAmplitude,
    error,
    failureKind,
    muted,
    start,
    stop,
    setMuted,
  } = useLiveVoice();

  const connecting = state === "connecting";
  const active =
    state !== "idle" && state !== "failed" && state !== "connecting";
  // Presentation-only flags derived from existing state. A failure is split by
  // `failureKind`: a genuine mic/permission problem (`"mic"`) gets the
  // "enable microphone" recovery; any other failure (provider rate-limit,
  // network, daemon error — `"session"`) shows its own message instead of a
  // misleading mic prompt.
  const listening = state === "listening" || state === "transcribing";
  const denied = state === "failed" && failureKind === "mic";
  const sessionFailed = state === "failed" && failureKind !== "mic";

  const handleToggle = useCallback(() => {
    if (connecting) return;
    if (active) {
      void stop();
    } else {
      void start(assistantId, conversationId ?? undefined);
    }
  }, [active, connecting, start, stop, assistantId, conversationId]);

  // Auto-start once on mount when requested (in-chat overlay). Guarded on the
  // flag + a non-empty assistant id; only fires from idle so a re-render can't
  // restart a live or failed session.
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    if (!autoStart || autoStarted) return;
    if (!voiceMode || !assistantId) return;
    if (state !== "idle") return;
    setAutoStarted(true);
    void start(assistantId, conversationId ?? undefined);
  }, [
    autoStart,
    autoStarted,
    voiceMode,
    assistantId,
    state,
    start,
    conversationId,
  ]);

  // Exit: stop any active session (release mic/socket) then hand control back.
  const handleExit = useCallback(() => {
    if (active || connecting) void stop();
    onExit?.();
  }, [active, connecting, stop, onExit]);

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

  // Full-duplex live voice is OFF for this assistant (the `voice-mode` flag,
  // default off) — and on a plain cloud self-host the live-voice WebSocket
  // (velay / a gateway ingress) isn't reachable even when it IS on. Rather
  // than a dead "Voice mode isn't enabled" panel, fall back to the dictation
  // experience: record → transcribe via the configured STT provider (e.g.
  // Deepgram) → send as a chat message. This has no WebSocket dependency and
  // no flag gate, so the Voice tab actually works wherever STT does. All hooks
  // above run unconditionally so this early return keeps hook order stable;
  // the idle `useLiveVoice` controller is harmless when never started.
  if (!voiceMode) {
    return <VoiceDictationSurface onExit={onExit} />;
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
      <style>{VOICE_KEYFRAMES}</style>

      {/* Exit affordance — only when an onExit handler is supplied (in-chat). */}
      {onExit ? (
        <button
          type="button"
          onClick={handleExit}
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

      {!voiceMode ? (
        <div
          style={{
            maxWidth: 320,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            style={{
              width: 118,
              height: 118,
              borderRadius: "50%",
              background: SURFACE,
              border: `1px solid ${LINE}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: 0.6,
            }}
          >
            <VoiceOrb state="idle" size={84} />
          </div>
          <div
            style={{
              fontSize: 19,
              fontWeight: 600,
              letterSpacing: "-0.3px",
              marginTop: 26,
            }}
          >
            Voice mode isn't enabled
          </div>
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.5,
              color: TEXT_2,
              marginTop: 10,
            }}
          >
            Turn on voice mode for this assistant (Settings → Models &amp;
            Services → Voice) and set a speech-to-text provider to talk to Cue
            hands-free.
          </div>
        </div>
      ) : (
        <>
          {/* Status eyebrow (DM Mono) — the design's top-of-screen state line. */}
          <div
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color:
                muted && active
                  ? TEXT_2
                  : listening
                    ? BLUE
                    : denied || sessionFailed
                      ? DANGER
                      : TEXT_2,
            }}
          >
            {muted && active
              ? "muted"
              : denied
                ? "microphone unavailable"
                : sessionFailed
                  ? "voice unavailable"
                  : stateLabel(state)}
          </div>

          {/* Live transcript: finalized (white) + in-flight (blue) + reply. */}
          <div
            style={{
              maxWidth: 560,
              minHeight: 84,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            {finalTranscript ? (
              <span
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  lineHeight: 1.4,
                  letterSpacing: "-0.3px",
                }}
              >
                {finalTranscript}{" "}
              </span>
            ) : null}
            {partialTranscript ? (
              <span
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  lineHeight: 1.4,
                  letterSpacing: "-0.3px",
                  color: BLUE,
                }}
              >
                {partialTranscript}
              </span>
            ) : null}
            {!finalTranscript && !partialTranscript && !assistantTranscript ? (
              <div
                style={{
                  fontSize: 17,
                  lineHeight: 1.45,
                  color: denied ? TEXT_3 : TEXT_2,
                }}
              >
                {denied
                  ? "We couldn't reach your microphone."
                  : active
                    ? muted
                      ? "Muted — unmute to talk."
                      : "Listening — say something."
                    : "Hold to talk, or tap the mic to start."}
              </div>
            ) : null}
            {assistantTranscript ? (
              <div
                style={{
                  fontSize: 15.5,
                  lineHeight: 1.5,
                  color: TEXT_2,
                  marginTop: 14,
                }}
              >
                {assistantTranscript}
              </div>
            ) : null}
            {sessionFailed ? (
              <div
                style={{
                  fontSize: 17,
                  lineHeight: 1.45,
                  color: TEXT_2,
                  marginTop: 12,
                }}
              >
                Cue couldn&rsquo;t respond just now. Tap the orb to try again.
              </div>
            ) : null}
          </div>

          {/* Big central mic — aperture orb in a tappable circle. While
              listening, two offset `cueVoiceRing` halos pulse outward. When the
              capture failed (mic-denied), the circle greys out. */}
          <button
            type="button"
            onClick={handleToggle}
            aria-label={active ? "Stop voice mode" : "Start voice mode"}
            disabled={connecting}
            style={{
              position: "relative",
              width: 150,
              height: 150,
              flexShrink: 0,
              background: "transparent",
              border: "none",
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: connecting ? "default" : "pointer",
              transition: "opacity 120ms ease",
            }}
          >
            {listening && !muted ? (
              <>
                <span
                  className="cue-voice-ring"
                  aria-hidden
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    border: `2px solid ${BLUE}80`,
                    animation: "cueVoiceRing 1.8s ease-out infinite",
                  }}
                />
                <span
                  className="cue-voice-ring"
                  aria-hidden
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    border: `2px solid ${BLUE}80`,
                    animation: "cueVoiceRing 1.8s ease-out .9s infinite",
                  }}
                />
              </>
            ) : null}
            <span
              style={{
                width: 118,
                height: 118,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: denied
                  ? SURFACE
                  : active && !muted
                    ? BLUE
                    : SURFACE,
                border: denied ? `1px solid ${LINE_2}` : "none",
                boxShadow:
                  active && !muted && !denied
                    ? "0 20px 50px -16px rgba(61,110,232,.7)"
                    : "0 16px 40px -20px rgba(0,0,0,.8)",
                opacity: denied || (muted && active) ? 0.5 : 1,
                transition: "background 160ms ease, opacity 160ms ease",
              }}
            >
              {denied ? (
                <MicOff size={40} color={TEXT_2} aria-hidden />
              ) : (
                <VoiceOrb
                  state={orbState(state)}
                  size={88}
                  amplitude={inputAmplitude}
                />
              )}
            </span>
          </button>

          {/* Mic-denied recovery: deep-link to the OS settings (book §3.3). */}
          {denied ? (
            <button
              type="button"
              onClick={() => {
                // Best-effort native deep-link; a no-op on web. Presentational —
                // no permission API is invoked here.
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
          ) : error && !denied ? (
            <div
              style={{
                fontSize: 13,
                color: DANGER,
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
                  color: muted ? "#FFFFFF" : TEXT_2,
                  background: muted ? "rgba(255,255,255,.14)" : "transparent",
                  border: `1px solid ${LINE_2}`,
                  borderRadius: 999,
                  padding: "11px 18px",
                  minHeight: 44,
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
                aria-label="Stop voice mode"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: mono,
                  fontSize: 12,
                  color: DANGER,
                  background: `${DANGER}1A`,
                  border: `1px solid ${DANGER}59`,
                  borderRadius: 999,
                  padding: "11px 20px",
                  minHeight: 44,
                  cursor: "pointer",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: DANGER,
                  }}
                />
                Stop
              </button>
            </div>
          ) : null}

          {/* Voice / TTS-provider picker — only while idle, so a turn isn't
              interrupted; persists to the shared LS_TTS_PROVIDER key. Hidden in
              the mic-denied state so the recovery CTA stays the focus. */}
          {!active && !denied ? (
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
                  letterSpacing: "0.1em",
                  color: TEXT_3,
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
