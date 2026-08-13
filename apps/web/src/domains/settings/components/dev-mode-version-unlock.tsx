import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

/**
 * The version value in General settings, and the gesture that unlocks the
 * developer panels behind it.
 *
 * Debug / Advanced / Developer are engineering surfaces, not user settings, so
 * they stay off every nav until the `settings-developer-nav` assistant flag is
 * on. Hiding them is deliberate. Hiding the way to REACH them was not: the
 * gesture worked, but it was seven taps on an unremarkable string with no
 * feedback until the seventh, which is indistinguishable from a dead control.
 * The owner tried twice and gave up.
 *
 * So the gesture now narrates itself:
 *
 *  · taps 1–2 do nothing visible — a stray double-click must not advertise a
 *    developer surface to someone who was only selecting the version text;
 *  · from tap 3 a quiet line counts down the taps that remain;
 *  · the seventh confirms in words, and says where the panels appeared.
 *
 * The counter is deliberately NOT on a timer. A gesture that silently expires
 * mid-way is the same dead end in a new costume, and the hint is only truthful
 * if it describes the state the next tap will actually act on.
 *
 * `?locked=developer` is the other half. `/assistant/settings/developer`
 * redirects here when the flag is off, and that redirect used to land on a
 * page that said nothing — the exact dead end. The developer page now tags the
 * redirect, and this row answers it.
 */

export const TAP_THRESHOLD = 7;
/** Taps before the gesture admits it exists. */
export const HINT_AFTER_TAPS = 3;
const MESSAGE_DURATION_MS = 6000;

/** The search param the developer page's redirect carries. */
export const LOCKED_PANEL_PARAM = "locked";

/**
 * The countdown line for a gesture in progress, or null when there is nothing
 * honest to say — before the gesture is unambiguous, and after it has fired.
 */
export function unlockProgressHint(
  taps: number,
  threshold: number = TAP_THRESHOLD,
  hintAfter: number = HINT_AFTER_TAPS,
): string | null {
  if (taps < hintAfter || taps >= threshold) {
    return null;
  }
  const remaining = threshold - taps;
  return `${remaining} more tap${remaining === 1 ? "" : "s"} to unlock developer settings`;
}

/** What the seventh tap says, in the direction it just moved. */
export function unlockResultMessage(nowEnabled: boolean): string {
  return nowEnabled
    ? // Deliberately does not enumerate the panels. Which ones actually
      // appear depends on the surface: mobile always prunes Advanced, and a
      // self-host session also prunes Debug (see mobile/mobile-settings.tsx),
      // so naming all three told a phone owner to look for two panels that
      // were never going to show up.
      "Developer settings unlocked — they're in the settings list now."
    : "Developer settings hidden again. Tap 7× to bring them back.";
}

export interface DevModeVersionUnlockProps {
  version: string | null;
  loading: boolean;
  /**
   * Active assistant id for PATCH'ing the `settingsDeveloperNav`
   * override server-side. `null` when the parent panel hasn't resolved
   * the active assistant yet — toggle is still functional client-side,
   * the server PATCH is just skipped.
   */
  assistantId: string | null;
}

export function DevModeVersionUnlock({
  version,
  loading,
  assistantId,
}: DevModeVersionUnlockProps) {
  const [searchParams] = useSearchParams();
  const developerNav = useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const [taps, setTaps] = useState(0);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // The count lives in a ref and is MIRRORED into state for the hint. Running
  // it as a `setTaps` updater instead would put the flag write and the message
  // inside a function React is free to call during render — which it does, and
  // which React warns about, because an updater has to be pure.
  const tapsRef = useRef(0);

  const handleClick = useCallback(() => {
    const next = tapsRef.current + 1;
    if (next < TAP_THRESHOLD) {
      tapsRef.current = next;
      setTaps(next);
      return;
    }
    tapsRef.current = 0;
    setTaps(0);
    const store = useAssistantFeatureFlagStore.getState();
    const nowEnabled = !store.settingsDeveloperNav;
    store.setFlag("settingsDeveloperNav", nowEnabled, assistantId);
    setMessage(unlockResultMessage(nowEnabled));
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = setTimeout(() => {
      setMessage(null);
      dismissTimerRef.current = null;
    }, MESSAGE_DURATION_MS);
  }, [assistantId]);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) {
        clearTimeout(dismissTimerRef.current);
      }
    },
    [],
  );

  if (loading) {
    return (
      <span className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading version...
      </span>
    );
  }

  if (!version) {
    return (
      <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
        —
      </span>
    );
  }

  const hint = unlockProgressHint(taps);
  // Only shown to someone who has just been bounced off the developer page —
  // the panels themselves stay hidden, but the door stops being invisible.
  const redirected =
    searchParams.get(LOCKED_PANEL_PARAM) === "developer" && !developerNav;
  const note =
    message ??
    hint ??
    (redirected
      ? "Developer settings are locked. Tap the version above 7× to unlock them."
      : null);

  return (
    <div>
      <button
        type="button"
        className="break-all text-left text-body-medium-lighter text-[var(--content-default)]"
        onClick={handleClick}
      >
        {version}
      </button>
      {/*
        One live region for all three states, so a screen reader hears the
        countdown and the confirmation the same way a sighted user sees them.
        It is always mounted: a live region inserted at the same moment as its
        first text is announced unreliably.
      */}
      <p
        aria-live="polite"
        className={
          message
            ? "mt-1 text-body-small-default text-[var(--content-accent)]"
            : "mt-1 text-body-small-default text-[var(--content-tertiary)]"
        }
      >
        {note}
      </p>
    </div>
  );
}
