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
import { Drama, Keyboard, Mic, MicOff, Sparkles, X } from "lucide-react";

import {
  VoiceOrb,
  type VoiceOrbState,
} from "@vellumai/design-library/components/voice-orb";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  DEFAULT_VOICE_PERSONA,
  resolveVoicePersona,
  VOICE_PERSONA_IDS,
  VOICE_PERSONA_OPTIONS,
  type VoicePersonaId,
} from "@/domains/chat/voice/live-voice/voice-personas";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";
import { CueRing } from "@/mobile-v3/cue-ring";
import { microLabel, rise } from "@/mobile-v3/mv3-kit";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { haptic } from "@/utils/haptics";
import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import {
  useLiveVoiceStore,
  type LiveVoiceCard,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { VoiceDictationSurface } from "@/domains/chat/voice/voice-dictation-surface";
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

// Design tokens (dark-v1 mobile book §1). Used as inline literals so this calm,
// full-bleed surface renders identically on the route and the in-chat overlay
// regardless of the host theme — the Voice screen is intentionally ink-only.
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

/**
 * Listening pulse rings + waveform keyframes (book §5: `cueVoiceRing`, `cueBar`).
 * Scoped to this surface and disabled under `prefers-reduced-motion`. Purely
 * presentational — no bearing on the session lifecycle.
 */
const VOICE_KEYFRAMES = `
@keyframes cueVoiceRing { 0% { transform: scale(.9); opacity: .5 } 100% { transform: scale(1.6); opacity: 0 } }
@keyframes cueBar { 0%,100% { transform: scaleY(.28) } 50% { transform: scaleY(1) } }
@keyframes cueVoiceCardIn { 0% { opacity: 0; transform: translateY(6px) scale(.98) } 100% { opacity: 1; transform: none } }
.cue-voice-card-enter { animation: cueVoiceCardIn 180ms ease-out both }
@media (prefers-reduced-motion: reduce) {
  .cue-voice-ring, .cue-voice-bar { animation: none !important }
  .cue-voice-card-enter { animation: none !important }
}
`;

/**
 * Build a `Surface` (the shape `SurfaceRouter` renders) from a live-voice card.
 * The `card` frame carries the surface fields verbatim, so this is a 1:1 map
 * plus the display-only completion defaults the router expects.
 */
function toSurface(card: LiveVoiceCard): Surface {
  return {
    surfaceId: card.surfaceId,
    surfaceType: card.surfaceType,
    data: card.data,
    ...(card.title !== undefined ? { title: card.title } : {}),
    ...(card.actions ? { actions: card.actions.map((a) => ({ ...a })) } : {}),
  };
}

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
  const isMobile = useMobileLayout();
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
  // Visual result cards for the current turn, driven by `card` server frames
  // (the `ui_show` tool output). Rendered above the orb via the shared
  // SurfaceRouter — see the card stack below.
  const cards = useLiveVoiceStore.use.cards();

  // Slice 1 cards are display-only (list/table/card), so actions don't round-trip
  // yet; wiring to the surface-action route is a later slice.
  const handleCardAction = useCallback(() => {}, []);

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

  // --- Voice engine toggle (Realtime = Gemini Live vs Classic = cascade) -----
  // Persists to the same `cue.voiceEngine` key `resolveVoiceEngine()` reads, so
  // flipping it and (re)starting a session picks the chosen engine. Visible in
  // the header because a localStorage flag is unusable inside the desktop app.
  const [engine, setEngineState] = useState<"cascade" | "gemini-live">(() => {
    try {
      return window.localStorage.getItem("cue.voiceEngine") === "gemini-live"
        ? "gemini-live"
        : "cascade";
    } catch {
      return "cascade";
    }
  });
  const toggleEngine = useCallback(() => {
    const next = engine === "gemini-live" ? "cascade" : "gemini-live";
    setEngineState(next);
    try {
      window.localStorage.setItem("cue.voiceEngine", next);
    } catch {
      // ignore locked-down storage
    }
    // Apply immediately: restart an in-flight session so the new engine takes
    // effect (the engine is chosen at session start).
    if (active || connecting) {
      void (async () => {
        await stop();
        await start(assistantId, conversationId ?? undefined);
      })();
    }
  }, [engine, active, connecting, stop, start, assistantId, conversationId]);

  // --- Persona / mode picker (Companion / Reflective / Co-founder) -----------
  // Persists to `cue.voicePersona` (the key `resolveVoicePersona()` reads), so
  // the choice is applied at the next session start. Cycles through the modes on
  // tap to match the minimal single-control aesthetic of the engine toggle.
  const [persona, setPersonaState] = useState<VoicePersonaId>(() =>
    resolveVoicePersona(),
  );
  const personaLabel =
    VOICE_PERSONA_OPTIONS.find((p) => p.id === persona)?.label ??
    DEFAULT_VOICE_PERSONA;
  const cyclePersona = useCallback(() => {
    const idx = VOICE_PERSONA_IDS.indexOf(persona);
    const next = VOICE_PERSONA_IDS[(idx + 1) % VOICE_PERSONA_IDS.length];
    setPersonaState(next);
    try {
      window.localStorage.setItem("cue.voicePersona", next);
    } catch {
      // ignore locked-down storage
    }
    // Persona is chosen at session start, so restart an in-flight session to
    // apply it immediately.
    if (active || connecting) {
      void (async () => {
        await stop();
        await start(assistantId, conversationId ?? undefined);
      })();
    }
  }, [persona, active, connecting, stop, start, assistantId, conversationId]);

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

  // MOBILE → the v3 native rendering (spec frames 2 + 24). Same controller,
  // same session logic — only the presentation branches. Desktop keeps the
  // ink-panel rendering below, byte-identical.
  if (isMobile) {
    return (
      <Mv3VoiceMobile
        state={state}
        partialTranscript={partialTranscript}
        finalTranscript={finalTranscript}
        assistantTranscript={assistantTranscript}
        error={error}
        muted={muted}
        cards={cards}
        connecting={connecting}
        active={active}
        listening={listening}
        denied={denied}
        sessionFailed={sessionFailed}
        engine={engine}
        onToggleEngine={toggleEngine}
        onToggle={handleToggle}
        onStop={() => void stop()}
        onSetMuted={setMuted}
        onExit={onExit ? handleExit : undefined}
        onCardAction={handleCardAction}
        provider={provider}
        providerOptions={providerOptions}
        onProviderChange={handleProviderChange}
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

      {/* Engine toggle — Realtime (Gemini Live) vs Classic (cascade). Top-left,
          mirroring the Done button. Visible so it's usable inside the desktop
          app where a localStorage flag can't be set. */}
      <button
        type="button"
        onClick={toggleEngine}
        aria-label={`Voice engine: ${engine === "gemini-live" ? "Realtime" : "Classic"}. Tap to switch.`}
        title={
          engine === "gemini-live"
            ? "Realtime engine (Gemini Live) — faster, speech-native. Tap for Classic."
            : "Classic engine (full assistant) — deeper, slower. Tap for Realtime."
        }
        style={{
          position: "absolute",
          top: `calc(14px + ${safeInset("top")})`,
          left: `calc(14px + ${safeInset("left")})`,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: mono,
          fontSize: 12,
          color: engine === "gemini-live" ? "#0B0B0F" : TEXT_2,
          background:
            engine === "gemini-live"
              ? "rgba(120,220,180,.92)"
              : "rgba(255,255,255,.04)",
          border: `1px solid ${LINE_2}`,
          borderRadius: 999,
          padding: "8px 14px",
          minHeight: 36,
          cursor: "pointer",
          backdropFilter: "blur(8px)",
          zIndex: 2,
        }}
      >
        <Sparkles size={14} aria-hidden />
        {engine === "gemini-live" ? "Realtime" : "Classic"}
      </button>

      {/* Persona / mode picker — below the engine toggle, same pill style. Taps
          cycle Companion → Reflective → Co-founder. Applied at session start. */}
      <button
        type="button"
        onClick={cyclePersona}
        aria-label={`Voice mode: ${personaLabel}. Tap to switch.`}
        title={
          VOICE_PERSONA_OPTIONS.find((p) => p.id === persona)?.description ??
          "Conversation mode"
        }
        style={{
          position: "absolute",
          top: `calc(58px + ${safeInset("top")})`,
          left: `calc(14px + ${safeInset("left")})`,
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
          zIndex: 2,
        }}
      >
        <Drama size={14} aria-hidden />
        {personaLabel}
      </button>

      {/* NOTE: the old "Voice mode isn't enabled" panel that used to live here
          was unreachable dead code — the `!voiceMode` early return above always
          routes to the dictation surface first — and has been removed. */}
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

        {/* Visual result cards (GPT-Live pattern) — stacked directly above the
              orb, rendered by the SAME SurfaceRouter chat uses. Scoped to the
              dark theme so the router's design-token children resolve against
              the ink panel. Cards are per-turn and replace on each new turn. */}
        {cards.length > 0 ? (
          <div
            data-theme="dark"
            style={{
              width: "100%",
              maxWidth: 560,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              overflowY: "auto",
              maxHeight: "38vh",
              textAlign: "left",
            }}
          >
            {cards.map((card) => (
              <div key={card.surfaceId} className="cue-voice-card-enter">
                <SurfaceRouter
                  surface={toSurface(card)}
                  onAction={handleCardAction}
                />
              </div>
            ))}
          </div>
        ) : null}

        {/* Big central mic — aperture orb in a tappable circle. While
              listening, two offset `cueVoiceRing` halos pulse outward. When the
              capture failed (mic-denied), the circle greys out. */}
        <button
          type="button"
          data-coach="voice-start"
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
              background: denied ? SURFACE : active && !muted ? BLUE : SURFACE,
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile v3 rendering (spec frames 2 + 24) — presentation only. All session
// logic (useLiveVoice, reconnect, engine toggle, TTS picker persistence) stays
// in VoiceModeSurface above; this component just draws the v3 native frames.
// ---------------------------------------------------------------------------

/**
 * Scoped v3-voice CSS:
 *  · the transcription caret blink (opacity-only)
 *  · result cards: `SurfaceRouter` content is kept verbatim; its
 *    SurfaceContainer chrome (`.rounded-lg.border` root) is retinted to the
 *    v3 glass material (frame 24 card: rgba(28,32,44,.85) · hairline ·
 *    radius 20 · blur 20) so the cards read as GlassCards without forking
 *    the surface components.
 * Reduced motion is handled by the shared `[data-mv3]` rule in mv3.css.
 */
const MV3_VOICE_CSS = `
@keyframes mv3vCaret { 0%,45%{opacity:1} 50%,100%{opacity:0} }
.cue-mv3-voice .mv3-voice-cards .rounded-lg.border {
  border-radius: 20px;
  background: rgba(28,32,44,.85);
  border-color: rgba(255,255,255,.1);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 20px 44px -22px rgba(0,0,0,.7);
}
`;

/** Frame 2 waveform: 16 gradient bars under the ring while listening. */
const IDLE_WAVE_HEIGHTS = [
  12, 20, 28, 16, 24, 32, 18, 26, 14, 22, 30, 17, 25, 13, 21, 27,
];

function Mv3ListeningWave() {
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        gap: 4,
        alignItems: "center",
        height: 34,
        marginTop: 34,
        ...rise(0),
      }}
    >
      {IDLE_WAVE_HEIGHTS.map((h, i) => (
        <span
          key={i}
          style={{
            width: 3.5,
            height: h,
            borderRadius: 99,
            background: "linear-gradient(180deg, #7FA3F2, #3D6EE8)",
            transformOrigin: "center",
            animation: `mv3Bar ${0.7 + (i % 4) * 0.12}s ease-in-out ${
              (i % 5) * 0.09
            }s infinite`,
          }}
        />
      ))}
    </div>
  );
}

/** Frame 24 pill-bar waveform: 5 short bars beside the live mic. */
const PILL_WAVE = [12, 20, 9, 17, 11];

function Mv3PillWave({ animate }: { animate: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "flex",
        gap: 3,
        alignItems: "center",
        height: 20,
        flex: 1,
        minWidth: 0,
      }}
    >
      {PILL_WAVE.map((h, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: h,
            borderRadius: 99,
            background: "#7FA3F2",
            transformOrigin: "center",
            opacity: animate ? 1 : 0.35,
            animation: animate
              ? `mv3Bar .8s ease-in-out ${i * 0.15}s infinite`
              : "none",
          }}
        />
      ))}
    </span>
  );
}

/** Quiet v3 pill button (engine toggle / Done) — mono microlabel chrome. */
function Mv3QuietPill({
  onClick,
  active = false,
  children,
  ariaLabel,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
  ariaLabel: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontFamily: "var(--mv3-mono)",
        fontSize: 10.5,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: active ? "#7FA3F2" : "#9A9AA8",
        background: active ? "rgba(61,110,232,.22)" : "rgba(255,255,255,.07)",
        border: `1px solid ${
          active ? "rgba(61,110,232,.45)" : "rgba(255,255,255,.1)"
        }`,
        borderRadius: 99,
        padding: "0 14px",
        minHeight: 44,
        cursor: "pointer",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {children}
    </button>
  );
}

interface Mv3VoiceMobileProps {
  state: string;
  partialTranscript: string;
  finalTranscript: string;
  assistantTranscript: string;
  error: string | null;
  muted: boolean;
  cards: LiveVoiceCard[];
  connecting: boolean;
  active: boolean;
  listening: boolean;
  denied: boolean;
  sessionFailed: boolean;
  engine: "cascade" | "gemini-live";
  onToggleEngine: () => void;
  onToggle: () => void;
  onStop: () => void;
  onSetMuted: (muted: boolean) => void;
  onExit?: () => void;
  onCardAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  provider: string;
  providerOptions: Array<{ value: string; label: string }>;
  onProviderChange: (value: string) => void;
}

function Mv3VoiceMobile({
  state,
  partialTranscript,
  finalTranscript,
  assistantTranscript,
  error,
  muted,
  cards,
  connecting,
  active,
  listening,
  denied,
  sessionFailed,
  engine,
  onToggleEngine,
  onToggle,
  onStop,
  onSetMuted,
  onExit,
  onCardAction,
  provider,
  providerOptions,
  onProviderChange,
}: Mv3VoiceMobileProps) {
  // Frame 24 ("results") takes over once the conversation has produced
  // anything — a finalized utterance, a reply, cards, or the brain thinking.
  // A brand-new session that is merely listening stays on frame 2's hero.
  const inConversation =
    active &&
    (cards.length > 0 ||
      assistantTranscript.length > 0 ||
      finalTranscript.length > 0 ||
      state === "thinking" ||
      state === "speaking");
  const idle = !active && !connecting;
  const ringDimmed = denied || sessionFailed;

  const handleRingTap = () => {
    if (connecting) return;
    if (active) haptic.medium();
    else haptic.light();
    onToggle();
  };

  const handleEnd = () => {
    haptic.medium();
    onStop();
  };

  const pillLabel =
    muted && active
      ? "muted"
      : state === "listening" || state === "transcribing"
        ? "listening"
        : state === "thinking"
          ? "thinking…"
          : state === "speaking"
            ? "speaking"
            : state === "connecting"
              ? "connecting…"
              : "";

  const spokenLine = [finalTranscript, partialTranscript]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      data-mv3
      data-theme="dark"
      className="cue-mv3-voice"
      style={{
        height: "100%",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "#050508",
        color: "#F4F4F6",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <style>{MV3_VOICE_CSS}</style>

      {/* Aurora — brightens while listening, sinks low behind the card canvas
          (frame 2: 50% 46% · frame 24: 50% 80%). Static blur, transform-only
          drift. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "-20%",
          background: `radial-gradient(46% 38% at 50% ${
            inConversation ? "80%" : "46%"
          }, rgba(61,110,232,.35), transparent 68%)`,
          filter: "blur(34px)",
          animation: "mv3Aur 10s ease-in-out infinite",
          opacity: listening || inConversation ? 1 : 0.62,
          transition: "opacity .6s",
          pointerEvents: "none",
          willChange: "transform",
        }}
      />

      {/* Top controls — engine toggle (kept: required behavior) + Done.
          The surface is mounted full-bleed (fixed inset:0 overlay / route), so
          this row must clear the iOS status bar itself via the safe-area top
          inset — otherwise the Realtime pill renders under the clock. */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `calc(10px + ${safeInset("top")}) 18px 0`,
          position: "relative",
          zIndex: 5,
        }}
      >
        <Mv3QuietPill
          onClick={onToggleEngine}
          active={engine === "gemini-live"}
          ariaLabel={`Voice engine: ${
            engine === "gemini-live" ? "Realtime" : "Classic"
          }. Tap to switch.`}
          title={
            engine === "gemini-live"
              ? "Realtime engine (Gemini Live). Tap for Classic."
              : "Classic engine (full assistant). Tap for Realtime."
          }
        >
          <Sparkles size={12} aria-hidden />
          {engine === "gemini-live" ? "Realtime" : "Classic"}
        </Mv3QuietPill>
        {onExit ? (
          /* Frame 2's exit grammar: ✕ top-right, round glass. Stops any live
             session (handleExit upstream) then hands control back — the route
             navigates away, the in-chat overlay returns to the composer. */
          <button
            type="button"
            onClick={onExit}
            aria-label="Close voice"
            title="Close voice"
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#9A9AA8",
              background: "rgba(255,255,255,.07)",
              border: "1px solid rgba(255,255,255,.1)",
              cursor: "pointer",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              WebkitTapHighlightColor: "transparent",
              padding: 0,
              flexShrink: 0,
            }}
          >
            <X size={18} aria-hidden />
          </button>
        ) : (
          <span />
        )}
      </div>

      {inConversation ? (
        /* ── Frame 24 · results layout ─────────────────────────────────── */
        <>
          {/* Transcript strip — the spoken ask, italic. */}
          {spokenLine ? (
            <div
              style={{
                padding: "8px 26px 0",
                flexShrink: 0,
                position: "relative",
                zIndex: 2,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: "#9A9AA8",
                  lineHeight: 1.5,
                  fontStyle: "italic",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                &ldquo;{spokenLine}&rdquo;
              </div>
            </div>
          ) : null}

          {/* Result canvas — the spoken reply + cards rising in. */}
          <div
            className="mv3-voice-cards"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              padding: "16px 18px 8px",
              position: "relative",
              zIndex: 2,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {assistantTranscript ? (
                <div
                  style={{
                    fontSize: 16.5,
                    fontWeight: 600,
                    lineHeight: 1.45,
                    letterSpacing: "-0.2px",
                    ...rise(0),
                  }}
                >
                  {assistantTranscript}
                </div>
              ) : state === "thinking" ? (
                <div
                  style={{
                    ...microLabel,
                    color: "#7FA3F2",
                    ...rise(0),
                  }}
                >
                  Thinking…
                </div>
              ) : null}
              {cards.map((card, i) => (
                <div
                  key={card.surfaceId}
                  style={rise(0.2 + 0.2 * Math.min(i, 3))}
                >
                  <SurfaceRouter
                    surface={toSurface(card)}
                    onAction={onCardAction}
                  />
                </div>
              ))}
              {/* Quick-reply chips (frame 24) are intentionally omitted: the
                  live-voice channel has no text-send path yet, and faking one
                  is off the table. */}
            </div>
          </div>

          {/* Live mic pill bar — mic (tap = mute), waveform, state, ✕ end. */}
          <div
            style={{
              flexShrink: 0,
              padding: `10px 18px calc(10px + ${safeInset("bottom")})`,
              position: "relative",
              zIndex: 5,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "rgba(22,26,36,.9)",
                border: "1px solid rgba(61,110,232,.4)",
                borderRadius: 26,
                padding: "6px 8px 6px 8px",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
                boxShadow: "0 0 0 4px rgba(61,110,232,.1)",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  haptic.light();
                  onSetMuted(!muted);
                }}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={muted}
                style={{
                  position: "relative",
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span
                  style={{
                    position: "relative",
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    background: muted
                      ? "rgba(255,255,255,.12)"
                      : "linear-gradient(160deg, #4E7CEC, #3560CC)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {listening && !muted ? (
                    <span
                      aria-hidden
                      style={{
                        position: "absolute",
                        inset: -4,
                        borderRadius: "50%",
                        border: "1.5px solid rgba(61,110,232,.6)",
                        animation: "mv3Ping 1.8s ease-out infinite",
                      }}
                    />
                  ) : null}
                  {muted ? (
                    <MicOff size={15} color="#F4F4F6" aria-hidden />
                  ) : (
                    <Mic size={15} color="#fff" aria-hidden />
                  )}
                </span>
              </button>
              <Mv3PillWave animate={listening && !muted} />
              <span style={{ fontSize: 12, color: "#9A9AA8", flexShrink: 0 }}>
                {pillLabel}
              </span>
              <button
                type="button"
                onClick={handleEnd}
                aria-label="End voice session"
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: "rgba(255,255,255,.08)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    color: "#F4F4F6",
                  }}
                  aria-hidden
                >
                  ✕
                </span>
              </button>
            </div>
          </div>
        </>
      ) : (
        /* ── Frame 2 · idle / first-listen layout ──────────────────────── */
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            zIndex: 2,
            padding: `0 32px calc(10px + ${safeInset("bottom")})`,
            textAlign: "center",
          }}
        >
          {/* The ring IS the mic. */}
          <button
            type="button"
            data-coach="voice-start"
            onClick={handleRingTap}
            disabled={connecting}
            aria-label={active ? "Stop listening" : "Start listening"}
            style={{
              position: "relative",
              width: 190,
              height: 190,
              flexShrink: 0,
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: connecting ? "default" : "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {listening && !muted ? (
              <>
                {[0, 0.7, 1.4].map((delay, i) => (
                  <span
                    key={delay}
                    aria-hidden
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: "50%",
                      border: `1.5px solid rgba(61,110,232,${
                        [0.7, 0.45, 0.25][i]
                      })`,
                      animation: `mv3Ping 2.2s cubic-bezier(.2,.6,.35,1) ${delay}s infinite`,
                    }}
                  />
                ))}
              </>
            ) : null}
            {!ringDimmed ? (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  inset: -26,
                  borderRadius: "50%",
                  background:
                    "radial-gradient(circle, rgba(61,110,232,.5), transparent 62%)",
                  filter: "blur(22px)",
                  animation: "mv3Glow 3.4s ease-in-out infinite",
                  opacity: active ? 1 : 0.7,
                  transition: "opacity .5s",
                }}
              />
            ) : null}
            <span
              style={{
                position: "absolute",
                inset: 22,
                borderRadius: "50%",
                background: "linear-gradient(160deg, #1D1D26, #101016)",
                border: "1px solid #2A2A35",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 30px 60px -24px rgba(0,0,0,.9)",
                opacity: ringDimmed ? 0.75 : 1,
              }}
            >
              <CueRing
                size={64}
                stroke={ringDimmed ? "#9A9AA8" : "#F4F4F6"}
                dotColor={ringDimmed ? "#5B5B68" : "#3D6EE8"}
              />
            </span>
          </button>

          {connecting ? (
            <div
              style={{
                ...microLabel,
                color: "#7FA3F2",
                marginTop: 30,
              }}
            >
              Connecting…
            </div>
          ) : null}

          {listening ? (
            /* Frame 2, listening: waveform + live transcription + status. */
            <>
              <Mv3ListeningWave />
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  letterSpacing: "-0.4px",
                  textAlign: "center",
                  marginTop: 22,
                  lineHeight: 1.35,
                  minHeight: 30,
                  ...rise(0.1),
                }}
              >
                {partialTranscript || finalTranscript ? (
                  <>
                    &ldquo;{finalTranscript}
                    {finalTranscript && partialTranscript ? " " : ""}
                    {partialTranscript}
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 2.5,
                        height: 22,
                        background: "#3D6EE8",
                        marginLeft: 4,
                        verticalAlign: -3,
                        animation: "mv3vCaret 1s step-end infinite",
                      }}
                    />
                  </>
                ) : muted ? (
                  <span style={{ color: "#9A9AA8" }}>
                    Muted — unmute to talk.
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  color: "#7FA3F2",
                  marginTop: 16,
                  ...rise(0.2),
                }}
              >
                Listening — tap to stop
              </div>
              {active ? (
                <button
                  type="button"
                  onClick={() => {
                    haptic.light();
                    onSetMuted(!muted);
                  }}
                  aria-pressed={muted}
                  style={{
                    marginTop: 18,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 12.5,
                    color: muted ? "#F4F4F6" : "#9A9AA8",
                    background: muted
                      ? "rgba(255,255,255,.14)"
                      : "rgba(255,255,255,.07)",
                    border: "1px solid rgba(255,255,255,.1)",
                    borderRadius: 99,
                    padding: "0 16px",
                    minHeight: 44,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {muted ? (
                    <MicOff size={13} aria-hidden />
                  ) : (
                    <Mic size={13} aria-hidden />
                  )}
                  {muted ? "Unmute" : "Mute"}
                </button>
              ) : null}
            </>
          ) : denied ? (
            /* Mic unavailable — the frame-23 "quiet failure" pattern: greyed
               ring, plain words, one white recovery button. No red. */
            <>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: "-0.6px",
                  marginTop: 38,
                  lineHeight: 1.25,
                }}
              >
                Cue can&rsquo;t hear you
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: "#9A9AA8",
                  marginTop: 14,
                  lineHeight: 1.55,
                }}
              >
                We couldn&rsquo;t reach your microphone.
              </div>
              <button
                type="button"
                onClick={() => {
                  try {
                    window.location.href = "app-settings:";
                  } catch {
                    /* unsupported host */
                  }
                }}
                style={{
                  marginTop: 24,
                  width: "100%",
                  maxWidth: 300,
                  background: "#F4F4F6",
                  color: "#050508",
                  border: "none",
                  borderRadius: 15,
                  padding: 15,
                  minHeight: 48,
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Enable microphone in Settings
              </button>
            </>
          ) : sessionFailed ? (
            <>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: "-0.6px",
                  marginTop: 38,
                  lineHeight: 1.25,
                }}
              >
                Voice couldn&rsquo;t connect
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: "#9A9AA8",
                  marginTop: 14,
                  lineHeight: 1.55,
                  maxWidth: 300,
                }}
              >
                {error ?? "Cue couldn't respond just now."}
              </div>
              <button
                type="button"
                onClick={handleRingTap}
                style={{
                  marginTop: 24,
                  width: "100%",
                  maxWidth: 300,
                  background: "#F4F4F6",
                  color: "#050508",
                  border: "none",
                  borderRadius: 15,
                  padding: 15,
                  minHeight: 48,
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            </>
          ) : idle ? (
            /* Frame 2, idle hero. */
            <>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: "-0.6px",
                  textAlign: "center",
                  marginTop: 38,
                  lineHeight: 1.25,
                }}
              >
                What should I
                <br />
                take off your plate?
              </div>
              <div style={{ fontSize: 14, color: "#9A9AA8", marginTop: 14 }}>
                Tap the ring and just talk.
              </div>
              {/* Suggestion chips — the live-voice channel is audio-only (no
                  text-turn path), so a chip tap starts listening for you to
                  say it rather than sending text. */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "center",
                  marginTop: 26,
                  maxWidth: 300,
                }}
              >
                {["Plan my week", "Catch me up", "Draft a reply"].map(
                  (label) => (
                    <button
                      key={label}
                      type="button"
                      onClick={handleRingTap}
                      style={{
                        fontSize: 12.5,
                        color: "#C9C9D4",
                        background: "rgba(255,255,255,.07)",
                        border: "1px solid rgba(255,255,255,.1)",
                        borderRadius: 99,
                        padding: "0 14px",
                        minHeight: 44,
                        backdropFilter: "blur(10px)",
                        WebkitBackdropFilter: "blur(10px)",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        WebkitTapHighlightColor: "transparent",
                      }}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
              {/* Voice (TTS provider) picker — same persisted setting. */}
              <div
                style={{
                  marginTop: 30,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  width: 220,
                }}
              >
                <span style={{ ...microLabel, color: "#9A9AA8" }}>Voice</span>
                <Dropdown
                  value={provider}
                  onChange={onProviderChange}
                  options={providerOptions}
                  aria-label="Voice provider"
                  menuAlign="start"
                  style={{ width: "100%" }}
                />
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
