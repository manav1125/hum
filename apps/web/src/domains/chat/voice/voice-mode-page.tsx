/**
 * Voice mode route (design v0.2 §05 / DESIGN-SPEC §5).
 *
 * The standalone `/voice` screen — kept for the mobile tab bar and direct links.
 * Desktop's primary entry is now the composer mic, which opens the same
 * experience as an in-chat overlay (see {@link
 * import("@/domains/chat/components/in-chat-voice-overlay").InChatVoiceOverlay}).
 *
 * Both surfaces render the shared {@link VoiceModeSurface}; the route variant
 * passes no `conversationId` (a fresh session for the assistant) and no `onExit`
 * (no "Done" affordance — navigation, not an overlay), preserving the prior
 * full-screen behaviour exactly.
 */

import { VoiceModeSurface } from "@/domains/chat/voice/voice-mode-surface";

export function VoiceModePage() {
  return <VoiceModeSurface />;
}
