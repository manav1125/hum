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
 * the panel has focus while it is open.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { notesVoicePost } from "@/generated/daemon/sdk.gen";

export type HoldToTalkState = "idle" | "listening" | "transcribing";

/** Below this it is a stray keypress, not a sentence. */
const MIN_HOLD_MS = 400;

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function useHoldToTalk({
  assistantId,
  onTranscript,
  /** Which modifier holds the mic open. `⌥` in the corner. */
  modifier = "Alt",
}: {
  assistantId: string;
  onTranscript: (text: string) => void;
  modifier?: "Alt" | "Control" | "Shift";
}): { state: HoldToTalkState; error: string | null } {
  const [state, setState] = useState<HoldToTalkState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  /** Guards against a key-repeat storm starting a second recorder. */
  const startingRef = useRef(false);

  const hardStop = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    startingRef.current = false;
    if (!recorder) return null;
    recorder.stream.getTracks().forEach((track) => track.stop());
    return recorder;
  }, []);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = recorder.mimeType || "audio/webm";
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: mimeType }));
      recorder.stop();
    });
    hardStop();

    // A brush of the key is not a sentence. Silently returning to idle is
    // right here — an error for that is noise.
    if (durationMs < MIN_HOLD_MS || blob.size === 0) {
      setState("idle");
      return;
    }

    setState("transcribing");
    try {
      const result = await notesVoicePost({
        path: { assistant_id: assistantId },
        body: {
          audioBase64: toBase64(await blob.arrayBuffer()),
          mimeType,
          audioDurationMs: durationMs,
        },
      });
      const data = result.data as
        | {
            status: string;
            note?: { body?: string } | null;
            reason?: string | null;
          }
        | undefined;

      if (data?.status === "created" && data.note?.body) {
        onTranscript(data.note.body);
        setError(null);
      } else if (data?.status === "empty") {
        setError("I couldn't make out anything in that.");
      } else {
        setError(data?.reason ?? "That didn't come through.");
      }
    } catch {
      setError("That didn't come through.");
    } finally {
      setState("idle");
    }
  }, [assistantId, hardStop, onTranscript]);

  const begin = useCallback(async () => {
    if (recorderRef.current || startingRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The key may already be back up by the time permission resolves. Do
      // not open a mic nobody is holding.
      if (!startingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      startingRef.current = false;
      setState("listening");
    } catch {
      startingRef.current = false;
      setError("I couldn't reach your microphone. Nothing was recorded.");
    }
  }, []);

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
      // The mic cannot survive this hook. If the panel closes mid-hold, the
      // recording stops with it.
      hardStop();
    };
  }, [begin, finish, hardStop, modifier]);

  return { state, error };
}
