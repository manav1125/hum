/**
 * Voice mode route (design v0.2 §05 / DESIGN-SPEC §5).
 *
 * The standalone `/voice` screen — kept for the mobile tab bar and direct links.
 * Desktop's primary entry is now the composer mic, which opens the same
 * experience as an in-chat overlay (see {@link
 * import("@/domains/chat/components/in-chat-voice-overlay").InChatVoiceOverlay}).
 *
 * Both surfaces render the shared {@link VoiceModeSurface}. The route variant
 * passes no `conversationId` (a fresh session for the assistant) but DOES pass
 * an `onExit`: the tab bar and the legacy top banner both hide on /voice on
 * mobile, so without its own exit the screen is a trap (mobile UAT P1-10).
 * Exiting steps back to the previous screen when there is history, otherwise
 * lands on HQ (a cold deep link has nothing to go "back" to).
 */

import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

import { routes } from "@/utils/routes";

import { VoiceModeSurface } from "@/domains/chat/voice/voice-mode-surface";

export function VoiceModePage() {
  const navigate = useNavigate();
  const location = useLocation();

  // React Router stamps `location.key === "default"` on the very first entry
  // of the session — i.e. /voice was cold-loaded and back() would leave the
  // app. Everything else has an in-app history entry to return to.
  const canGoBack = location.key !== "default";

  const handleExit = useCallback(() => {
    if (canGoBack) navigate(-1);
    else void navigate(routes.hq, { replace: true });
  }, [canGoBack, navigate]);

  return <VoiceModeSurface onExit={handleExit} />;
}
