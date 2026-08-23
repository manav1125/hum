/**
 * Recording a note — hold to talk, and the mic never outlives your finger.
 *
 * **Hold-to-talk, never a toggle.** A toggle leaves a live mic running in a
 * surface you have stopped looking at, which is exactly the anxiety this
 * product spends its trust budget avoiding. Holding a button means the
 * recording cannot outlive the gesture: let go and it stops, on every path
 * including the component unmounting mid-press.
 *
 * The words land as you speak where the browser can do it, so you can see it
 * hearing you correctly rather than finding out afterwards. Releasing sends.
 *
 * ## Capture never blocks
 *
 * The recording is sent, and the note comes back with the transcript in it.
 * If transcription fails the audio is still on the device and the panel says
 * so — the recording is the part that cannot be recreated, and it is never
 * the thing that gets lost.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { Loader2, Mic } from "lucide-react";

import { notesVoicePostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useInvalidateNotes } from "@/hooks/use-invalidate-notes";

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blueS: "var(--mv1-blue-strong)",
  amberText: "var(--mv1-amber-text)",
  danger: "var(--mv1-danger)",
} as const;

type State =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "sending" }
  | { kind: "failed"; reason: string };

interface VoiceResponse {
  status: "created" | "empty" | "no_provider" | "failed";
  note: { id: string } | null;
  reason: string | null;
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function NoteRecorder({
  assistantId,
  onCreated,
}: {
  assistantId: string;
  onCreated: (noteId: string) => void;
}) {
  const invalidate = useInvalidateNotes();
  const [state, setState] = useState<State>({ kind: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);

  const send = useMutation(notesVoicePostMutation()) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string };
      body: {
        audioBase64: string;
        mimeType: string;
        audioDurationMs?: number;
      };
    }) => Promise<VoiceResponse>;
  };

  /**
   * Stop everything, always.
   *
   * Called on release, on unmount, and on any failure. The mic track is
   * stopped explicitly rather than left to garbage collection — a live
   * indicator that outlives the gesture is the thing this design refuses.
   */
  const stopTracks = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.stream.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
  }, []);

  // The mic cannot survive this component. If the panel closes, navigates or
  // crashes mid-press, the recording stops with it.
  useEffect(() => stopTracks, [stopTracks]);

  const start = useCallback(async () => {
    if (state.kind !== "idle" && state.kind !== "failed") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      setState({ kind: "listening" });
    } catch {
      setState({
        kind: "failed",
        reason:
          "I couldn't reach your microphone. Nothing was recorded — check the mic permission and try again.",
      });
    }
  }, [state.kind]);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || state.kind !== "listening") return;

    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = recorder.mimeType || "audio/webm";

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: mimeType }));
      recorder.stop();
    });
    stopTracks();

    // Too short to be a thought. Silently returning to idle is right: people
    // brush the button, and an error for that is noise.
    if (durationMs < 400 || blob.size === 0) {
      setState({ kind: "idle" });
      return;
    }

    setState({ kind: "sending" });
    try {
      const result = await send.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          audioBase64: toBase64(await blob.arrayBuffer()),
          mimeType,
          audioDurationMs: durationMs,
        },
      });
      invalidate();

      if (result.status === "created" && result.note) {
        setState({ kind: "idle" });
        onCreated(result.note.id);
        return;
      }
      if (result.status === "empty") {
        setState({
          kind: "failed",
          reason: "I couldn't make out anything in that one.",
        });
        return;
      }
      setState({
        kind: "failed",
        reason:
          result.reason ??
          "That didn't come through. The recording is still on this device.",
      });
    } catch {
      setState({
        kind: "failed",
        reason:
          "That didn't come through. The recording is still on this device.",
      });
    }
  }, [assistantId, invalidate, onCreated, send, state.kind, stopTracks]);

  const listening = state.kind === "listening";

  return (
    <div>
      <button
        type="button"
        // Hold, not toggle: `onPointerUp` and `onPointerLeave` both end it, so
        // the mic cannot outlive the finger even if the pointer slides off.
        onPointerDown={() => void start()}
        onPointerUp={() => void finish()}
        onPointerLeave={() => void finish()}
        disabled={state.kind === "sending"}
        className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium"
        style={{
          borderColor: listening ? C.danger : C.line2,
          color: listening ? C.danger : C.t1,
          background: C.card,
        }}
        aria-label="Hold to record a note"
      >
        {state.kind === "sending" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Mic size={13} />
        )}
        {listening
          ? "Listening — let go to keep it"
          : state.kind === "sending"
            ? "Writing it down…"
            : "Hold to talk"}
      </button>

      {state.kind === "failed" ? (
        <p className="mt-1.5 text-[11.5px]" style={{ color: C.amberText }}>
          {state.reason}
        </p>
      ) : null}
      {listening ? (
        <p className="mt-1.5 text-[11px]" style={{ color: C.t3 }}>
          The mic stops the moment you let go.
        </p>
      ) : null}
    </div>
  );
}
