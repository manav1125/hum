import { useCallback, useEffect, useRef, useState } from "react";

import {
  startDictationStream,
  type DictationStreamHandle,
} from "@/domains/chat/voice/dictation-stream";

/**
 * The words landing while you hold.
 *
 * Both capture surfaces — the corner's `⌥`-hold and the Notes recorder's
 * press-and-hold — record with `MediaRecorder` and only learn what was said
 * once the upload comes back. The design does not allow that: F2·E is
 * explicit that **"words land as you speak so you can see it hearing you
 * correctly"**, and S1·B draws the transcript under a "Listening" label. A
 * mic icon that changes colour is not evidence that anything was heard, and
 * without it the hold is a leap of faith — which is exactly what Manav
 * reported as "no real engagement / clear view of what's going on".
 *
 * This is display only, and deliberately so. The recording itself is
 * untouched and remains the sole authority for the text that gets saved;
 * these partials are a mirror held up during the hold. That split is what
 * lets the whole thing fail open: `startDictationStream` returns `null` on a
 * cloud assistant, a browser without AudioWorklet, or any capture failure,
 * and every one of those cases simply means no live words — never a capture
 * that refuses to run. **A transcript that cannot be shown must never cost
 * someone their note.**
 */
export interface LiveTranscript {
  /** Heard so far this hold. Empty when streaming is unavailable. */
  text: string;
  /** Whether a session actually went live — the caller can label honestly. */
  isLive: boolean;
  /** Begin. Safe to call unconditionally; never throws. */
  start: () => void;
  /** End and reset. Idempotent. */
  stop: () => void;
}

export function useLiveTranscript(): LiveTranscript {
  const [text, setText] = useState("");
  const [isLive, setIsLive] = useState(false);
  const handleRef = useRef<DictationStreamHandle | null>(null);

  const stop = useCallback(() => {
    const handle = handleRef.current;
    handleRef.current = null;
    setIsLive(false);
    setText("");
    try {
      handle?.stop();
    } catch {
      // Teardown of a display-only mirror is never worth surfacing, and the
      // recording this ran beside has already been handled by its own path.
    }
  }, []);

  const start = useCallback(() => {
    if (handleRef.current) return;
    setText("");
    try {
      const handle = startDictationStream({ onPartial: setText });
      handleRef.current = handle;
      setIsLive(Boolean(handle));
    } catch {
      // No ingress, no worklet, no mic for a second capture — all mean the
      // same thing here: hold without live words, exactly as before.
      handleRef.current = null;
      setIsLive(false);
    }
  }, []);

  // A hold interrupted by an unmount (the corner closes on `esc` mid-sentence)
  // must not leave a socket and a mic open behind it.
  useEffect(() => stop, [stop]);

  return { text, isLive, start, stop };
}
