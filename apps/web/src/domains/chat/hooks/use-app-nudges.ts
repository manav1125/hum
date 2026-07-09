import { useEffect, useState } from "react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useIsIOSWeb, useIsMacOSWeb } from "@/runtime/platform-detection";
import {
  readIOSAssistantTurnsSeen,
  incrementIOSAssistantTurnsSeen,
  useIOSNudgeState,
  IOS_APP_BANNER_MIN_TURNS,
} from "@/hooks/use-ios-app-nudge";
import {
  readMacOsAssistantTurnsSeen,
  incrementMacOsAssistantTurnsSeen,
  useMacOsNudgeState,
  MAC_APP_BANNER_MIN_TURNS,
} from "@/hooks/use-macos-app-nudge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlatformNudgeState {
  bannerShouldShow: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
}

/**
 * Aggregated nudge visibility and handlers for the platform app-download
 * nudge surface (iOS/macOS).
 *
 * Mutual-exclusivity rules:
 * 1. Only one platform nudge shows at a time (iOS xor macOS).
 */
export interface AppNudgesState {
  /** True when the current browser is iOS Safari (non-native). */
  isOnIOS: boolean;
  /** True when the current browser is macOS Safari or Chrome (non-native). */
  isOnMacOS: boolean;
  /** True when any platform app-download nudge could apply. */
  isOnNudgePlatform: boolean;

  /** The active platform nudge (iOS or macOS). Handlers are platform-specific. */
  nudge: PlatformNudgeState;
  /** Whether the main-area app-download banner should render. */
  showBanner: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages the platform app-download nudge (iOS/macOS). Tracks completed
 * assistant turns to gate the nudge behind a minimum-turn threshold, then
 * shows a single platform nudge (iOS xor macOS).
 *
 * @param messages - Current transcript messages (used to count completed assistant turns).
 * @param liveAssistantMessageId - Id of the currently-live assistant row, or
 *   `null` when nothing is streaming. Derived from message position and the
 *   conversation's processing state.
 */
export function useAppNudges(
  messages: readonly DisplayMessage[],
  liveAssistantMessageId: string | null,
): AppNudgesState {
  // -------------------------------------------------------------------------
  // Platform detection
  // -------------------------------------------------------------------------
  const isOnIOS = useIsIOSWeb();
  const isOnMacOS = useIsMacOSWeb();
  const isOnNudgePlatform = isOnIOS || isOnMacOS;
  const nudgeMinTurns = isOnIOS
    ? IOS_APP_BANNER_MIN_TURNS
    : MAC_APP_BANNER_MIN_TURNS;

  // -------------------------------------------------------------------------
  // Turn counting — gate the platform nudge behind a minimum-turn threshold
  // -------------------------------------------------------------------------
  const [assistantTurnsSeen, setAssistantTurnsSeen] = useState(0);

  useEffect(() => {
    setAssistantTurnsSeen(
      isOnIOS ? readIOSAssistantTurnsSeen() : readMacOsAssistantTurnsSeen(),
    );
  }, [isOnIOS]);

  useEffect(() => {
    if (!isOnNudgePlatform) return;
    if (assistantTurnsSeen >= nudgeMinTurns) return;

    let newlyCompleted = 0;
    const streamingIds = useChatSessionStore.getState().streamingMessageIds;
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "assistant") {
        continue;
      }
      if (m.id === liveAssistantMessageId) {
        toAdd.push(m.id);
      } else if (streamingIds.has(m.id)) {
        toRemove.push(m.id);
        newlyCompleted++;
      } else {
        break;
      }
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      useChatSessionStore
        .getState()
        .batchUpdateStreamingMessageIds(toAdd, toRemove);
    }

    if (newlyCompleted > 0) {
      if (isOnIOS) {
        incrementIOSAssistantTurnsSeen(newlyCompleted);
      } else {
        incrementMacOsAssistantTurnsSeen(newlyCompleted);
      }
      setAssistantTurnsSeen((current) => current + newlyCompleted);
    }
  }, [
    messages,
    liveAssistantMessageId,
    isOnNudgePlatform,
    isOnIOS,
    assistantTurnsSeen,
    nudgeMinTurns,
  ]);

  const bannerEligible = assistantTurnsSeen >= nudgeMinTurns;

  // -------------------------------------------------------------------------
  // Platform nudge (iOS xor macOS)
  // -------------------------------------------------------------------------
  const iosNudge = useIOSNudgeState();
  const macNudge = useMacOsNudgeState();
  const nudge = isOnIOS ? iosNudge : macNudge;

  const showBanner =
    isOnNudgePlatform && bannerEligible && nudge.bannerShouldShow;

  return {
    isOnIOS,
    isOnMacOS,
    isOnNudgePlatform,
    nudge,
    showBanner,
  };
}
