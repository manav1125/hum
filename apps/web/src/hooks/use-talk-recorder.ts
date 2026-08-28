/**
 * The mic, as a pair of verbs — the engine under every hold-to-talk gesture.
 *
 * Split out of {@link useHoldToTalk} when the companion needed the same
 * recording from a *pointer* hold rather than a key hold. The gesture differs;
 * the promise underneath does not, and two copies of "open a mic, stop it on
 * every path that could strand it" is two chances to leave a microphone
 * running in a panel that floats over everything.
 *
 * **The mic can never outlive the hold.** Whatever starts it, these are the
 * stops: `finish`, an unmount, and — for the caller to wire — the window
 * losing focus or hiding. Those last two are not padding: a hold that ends
 * because focus moved never delivers its own end event, so without them a
 * press followed by a click elsewhere would leave the mic on with nothing to
 * turn it off.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useLiveTranscript } from "@/hooks/use-live-transcript";

import { notesVoicePost } from "@/generated/daemon/sdk.gen";

export type TalkRecorderState = "idle" | "listening" | "transcribing";

/** Below this it is a stray press, not a sentence. */
export const MIN_HOLD_MS = 400;

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export interface TalkRecorder {
  state: TalkRecorderState;
  error: string | null;
  /** Words heard so far this hold — see {@link useLiveTranscript}. */
  partial: string;
  /** Open the mic. Safe to call twice; the second call is a no-op. */
  begin: () => Promise<void>;
  /** Close it and transcribe. Safe to call when nothing is open. */
  finish: () => Promise<void>;
  /** Drop everything without transcribing. Used by unmount and by `esc`. */
  abandon: () => void;
  /**
   * Put the last failure away.
   *
   * The consumer's call, not this hook's: the corner shows an error in a
   * panel where it costs nothing, while the companion shows it on the pill —
   * where it sits on top of the affordances, so one that never expired would
   * be a hover pill with nothing in it.
   */
  dismissError: () => void;
}

export function useTalkRecorder({
  assistantId,
  onTranscript,
}: {
  assistantId: string;
  onTranscript: (text: string) => void;
}): TalkRecorder {
  const [state, setState] = useState<TalkRecorderState>("idle");
  const live = useLiveTranscript();
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  /** Guards against a key-repeat storm, or a double press, starting a second recorder. */
  const startingRef = useRef(false);

  const hardStop = useCallback(() => {
    live.stop();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    startingRef.current = false;
    if (!recorder) return null;
    recorder.stream.getTracks().forEach((track) => track.stop());
    return recorder;
  }, [live]);

  const abandon = useCallback(() => {
    hardStop();
    setState("idle");
  }, [hardStop]);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    // A release with nothing open is the normal case for every extra stop the
    // caller wires (blur, hide, unmount). It is not an error.
    if (!recorder) {
      startingRef.current = false;
      return;
    }

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
      // The hold may already be over by the time permission resolves. Do not
      // open a mic nobody is holding.
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
      // Display only, and started AFTER the recorder so a streaming failure can
      // never cost the recording. See `useLiveTranscript`.
      live.start();
      setState("listening");
    } catch {
      startingRef.current = false;
      setError("I couldn't reach your microphone. Nothing was recorded.");
    }
  }, [live]);

  /**
   * The mic cannot survive this hook. If the surface closes mid-hold, the
   * recording stops with it.
   *
   * Through a ref, and with an empty dependency list, because `hardStop`'s
   * identity changes whenever its own dependencies re-render — and an effect
   * that lists it tears down and re-runs on those renders, which means the
   * cleanup fires *during* the hold and kills the recording a few
   * milliseconds after it starts. Unmount is the only thing that may stop it
   * here.
   */
  const hardStopRef = useRef(hardStop);
  useEffect(() => {
    hardStopRef.current = hardStop;
  }, [hardStop]);
  useEffect(() => () => void hardStopRef.current(), []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    state,
    error,
    partial: live.text,
    begin,
    finish,
    abandon,
    dismissError,
  };
}
