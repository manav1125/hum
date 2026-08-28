/**
 * Hold a key to talk — the gesture, not a toggle.
 *
 * **The mic can never outlive your finger.** A toggle leaves a live
 * microphone running in a surface you have stopped looking at, and in a panel
 * that floats over everything that is exactly the anxiety this product spends
 * its trust budget avoiding. Holding a key means release stops it — and so
 * does the window losing focus, the tab hiding, or this hook unmounting.
 *
 * Those three extra stops are not defensive padding. A key-up that never
 * arrives is the normal case when focus moves mid-hold: the browser stops
 * delivering events to a window that is no longer frontmost, so without them
 * a `⌥` press followed by a click elsewhere would leave the mic on with
 * nothing to turn it off.
 *
 * Used by the floating corner (F2·E), where no native code is needed because
 * the panel has focus while it is open. The recording itself lives in
 * {@link useTalkRecorder}, shared with the companion's pointer hold — this
 * hook is only the keyboard half.
 */

import { useEffect } from "react";

import {
  useTalkRecorder,
  type TalkRecorderState,
} from "@/hooks/use-talk-recorder";

export type HoldToTalkState = TalkRecorderState;

export function useHoldToTalk({
  assistantId,
  onTranscript,
  /** Which modifier holds the mic open. `⌥` in the corner. */
  modifier = "Alt",
}: {
  assistantId: string;
  onTranscript: (text: string) => void;
  modifier?: "Alt" | "Control" | "Shift";
}): {
  state: HoldToTalkState;
  error: string | null;
  /** Words heard so far this hold. */
  partial: string;
} {
  const { state, error, partial, begin, finish } = useTalkRecorder({
    assistantId,
    onTranscript,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // `event.repeat` fires continuously while a key is held; only the first
      // one is the gesture starting.
      if (event.key === modifier && !event.repeat) void begin();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === modifier) void finish();
    };
    /**
     * Focus moving mid-hold means the key-up will never arrive, because the
     * browser stops delivering events to a window that is not frontmost. Both
     * of these are that case, not belt-and-braces.
     */
    const onBlur = () => void finish();
    const onHidden = () => {
      if (document.hidden) void finish();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [begin, finish, modifier]);

  return { state, error, partial };
}
