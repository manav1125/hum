/**
 * InChatVoiceOverlay — voice mode as a mode of the *current* conversation.
 *
 * Mounted by the composer when the user taps the composer mic. Renders the
 * shared {@link VoiceModeSurface} as a full-bleed ink overlay covering the chat
 * view, bound to the active `conversationId` so spoken turns land in the same
 * thread. Auto-starts a session on open and exposes a "Done" affordance that
 * stops the session and returns to the text composer.
 *
 * This overlay is the single {@link import("@/domains/chat/voice/live-voice/use-live-voice").useLiveVoice}
 * owner while open — the composer only *reads* live-voice store state (for its
 * inline transcript strip + dictation mutual-exclusion), never mounts a second
 * controller, so the live-voice controller count stays at one.
 *
 * Self-gates on the `voice-mode` flag: if it's off the overlay renders nothing
 * (the composer also hides the entry mic when off, so this is belt-and-braces).
 */

import { useEffect } from "react";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { VoiceModeSurface } from "@/domains/chat/voice/voice-mode-surface";

interface InChatVoiceOverlayProps {
  /** Active conversation the live session attaches to. */
  conversationId?: string | null;
  /** Close the overlay and return to the text composer. */
  onExit: () => void;
}

export function InChatVoiceOverlay({
  conversationId,
  onExit,
}: InChatVoiceOverlayProps) {
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();

  // Escape returns to typing (parity with the overlay's "Done" affordance).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  if (!voiceMode) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice mode"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
      }}
    >
      <VoiceModeSurface
        conversationId={conversationId}
        onExit={onExit}
        autoStart
      />
    </div>
  );
}
