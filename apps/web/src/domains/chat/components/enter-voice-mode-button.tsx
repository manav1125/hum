/**
 * `EnterVoiceModeButton` — composer mic that enters in-chat voice mode.
 *
 * Replaces the older inline {@link import("./live-voice-button").LiveVoiceButton}
 * as the composer's voice entry point. Tapping it does NOT start a live session
 * in place; it asks the parent ({@link import("@/domains/chat/components/chat-body").ChatBody})
 * to open the orb overlay on the current conversation, where the single
 * {@link import("@/domains/chat/voice/live-voice/use-live-voice").useLiveVoice}
 * controller lives and auto-starts.
 *
 * Self-gates on the `voice-mode` assistant flag: renders `null` when off, so
 * the flag-off composer is byte-identical (no mic, no layout shift) — matching
 * the gate the voice page/surface uses.
 */

import { Mic } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

interface EnterVoiceModeButtonProps {
  /** Open the in-chat voice overlay. */
  onClick: () => void;
  /** Disable entry (e.g. while dictation is recording, or the composer is busy). */
  disabled?: boolean;
}

export function EnterVoiceModeButton({
  onClick,
  disabled = false,
}: EnterVoiceModeButtonProps) {
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  if (!voiceMode) return null;

  return (
    <Button
      variant="ghost"
      iconOnly={<Mic strokeWidth={2} />}
      onClick={onClick}
      disabled={disabled}
      aria-label="Start voice mode"
      title="Start voice mode"
      className="[--vbtn-fg:var(--content-secondary)]"
    />
  );
}
