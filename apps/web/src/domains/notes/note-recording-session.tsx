import { useCallback, useEffect, useRef, useState } from "react";

import { Lock } from "lucide-react";

import { useLiveTranscript } from "@/hooks/use-live-transcript";
import type { NoteExtraction } from "@/types/notes";

import {
  useCreateNote,
  useDeleteNote,
  useUpdateNote,
} from "@/hooks/use-note-capture";

import { useReadNote } from "./use-notes";

/**
 * Recording a note — the surface from design `01b`.
 *
 * **This is a session, not a hold.** The screen shows a running timer at
 * 04:18, "Capturing the room · mic only", and a "Stop & write it up" button;
 * `N3` shows an 8:22 recording. The build previously used hold-to-talk here,
 * which is `F2·E` — the CORNER's mic, for a one-line thought — and applying
 * it to Notes is what produced "it auto holds and there is no way to cancel
 * it". You start it, you watch it, you stop it.
 *
 * Three things happen while you talk, and all three are the point:
 *
 *   · **LIVE** — the words arrive as you say them, the sentence still in
 *     flight rendered apart from the ones already committed.
 *   · **FORMING AS YOU TALK** — extractions land DURING the recording, not
 *     after. "Recording, wait, transcript appears later" misses the feature.
 *   · **WHERE IT'LL GO** — the project is guessed live and shows its
 *     evidence, so filing afterwards is a confirmation rather than a chore.
 *
 * The note is created at the start so proposals have something to attach to,
 * and **deleted on cancel** — abandoning a recording must leave nothing
 * behind.
 */

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blueS: "var(--mv1-blue-strong)",
  green: "var(--mv1-green)",
} as const;

/** How often the growing transcript is sent for extraction, in ms. */
const EXTRACT_EVERY_MS = 20_000;
/** Below this many new characters, a re-read has nothing to find. */
const EXTRACT_MIN_NEW_CHARS = 80;

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The mark IS the state (project rule): a waveform means speaking. Never a
 * spinner — one appearing anywhere in this feature is wrong by the design's
 * own motion rules.
 */
function Waveform({ color }: { color: string }): React.ReactElement {
  return (
    <span className="flex items-end gap-[2px]" aria-hidden>
      {[0.35, 0.7, 1, 0.55, 0.8].map((h, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full motion-safe:animate-pulse"
          style={{
            height: `${Math.round(h * 14)}px`,
            background: color,
            animationDelay: `${i * 110}ms`,
            animationDuration: "900ms",
          }}
        />
      ))}
    </span>
  );
}

export function NoteRecordingSession({
  assistantId,
  onDone,
  onCancel,
}: {
  assistantId: string;
  onDone: (noteId: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const live = useLiveTranscript();
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const readNote = useReadNote();
  const deleteNote = useDeleteNote();

  const [elapsedMs, setElapsedMs] = useState(0);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [found, setFound] = useState<NoteExtraction[]>([]);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const noteIdRef = useRef<string | null>(null);
  const lastExtractLenRef = useRef(0);

  const teardownMic = useCallback(() => {
    live.stop();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return null;
    recorder.stream.getTracks().forEach((t) => t.stop());
    return recorder;
  }, [live]);

  // --- start, once ---------------------------------------------------------
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start();
        recorderRef.current = recorder;
        startedAtRef.current = Date.now();
        live.start();

        // The note exists from the first second so proposals have somewhere
        // to attach — and is deleted again if this is abandoned.
        const created = await createNote.mutateAsync({
          path: { assistant_id: assistantId },
          body: { title: "", body: "", source: "voice" },
        });
        const id = created?.note?.id ?? null;
        if (!alive) return;
        noteIdRef.current = id;
        setNoteId(id);
      } catch {
        if (alive) {
          setError(
            "I couldn't reach your microphone. Nothing was recorded — check the mic permission and try again.",
          );
        }
      }
    })();
    return () => {
      alive = false;
      teardownMic();
    };
    // Deliberately once: this component IS one recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- the timer -----------------------------------------------------------
  useEffect(() => {
    if (error) return;
    const t = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 500);
    return () => clearInterval(t);
  }, [error]);

  // --- forming as you talk -------------------------------------------------
  useEffect(() => {
    if (!noteId || error) return;
    const t = setInterval(() => {
      const text = live.text;
      const id = noteIdRef.current;
      if (!id) return;
      if (text.length - lastExtractLenRef.current < EXTRACT_MIN_NEW_CHARS) return;
      lastExtractLenRef.current = text.length;
      void (async () => {
        try {
          await updateNote.mutateAsync({
            path: { assistant_id: assistantId, id },
            body: { body: text },
          });
          const out = await readNote.mutateAsync({
            path: { assistant_id: assistantId, id },
            body: { force: true },
          });
          setFound(out?.extractions ?? []);
        } catch {
          // A read that fails mid-recording must never interrupt the
          // recording. The panel simply keeps saying "listening for more".
        }
      })();
    }, EXTRACT_EVERY_MS);
    return () => clearInterval(t);
  }, [noteId, error, assistantId, live.text, updateNote, readNote]);

  // --- stop ----------------------------------------------------------------
  const stopAndWrite = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    const recorder = recorderRef.current;
    const id = noteIdRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    const transcript = live.text;

    if (!recorder || !id) {
      teardownMic();
      onCancel();
      return;
    }
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    teardownMic();

    try {
      await updateNote.mutateAsync({
        path: { assistant_id: assistantId, id },
        body: {
          body: transcript,
          ...(durationMs > 0 ? { audioDurationMs: durationMs } : {}),
        },
      });
      await readNote
        .mutateAsync({
          path: { assistant_id: assistantId, id },
          body: { force: true },
        })
        .catch(() => undefined);
    } catch {
      // The note already exists with whatever was transcribed; a failed
      // final write must not lose it.
    }
    onDone(id);
  }, [
    stopping,
    live.text,
    assistantId,
    updateNote,
    readNote,
    teardownMic,
    onDone,
    onCancel,
  ]);

  // --- cancel --------------------------------------------------------------
  const cancel = useCallback(async () => {
    teardownMic();
    const id = noteIdRef.current;
    noteIdRef.current = null;
    if (id) {
      await deleteNote
        .mutateAsync({ path: { assistant_id: assistantId, id } })
        .catch(() => undefined);
    }
    onCancel();
  }, [assistantId, deleteNote, teardownMic, onCancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  if (error) {
    return (
      <div
        className="rounded-lg border px-4 py-3.5"
        style={{ borderColor: C.line2, background: C.card }}
      >
        <p className="text-[13px]" style={{ color: C.t1 }}>
          {error}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-2 text-[12px] font-medium"
          style={{ color: C.blueS }}
        >
          Back to notes
        </button>
      </div>
    );
  }

  const committed = live.text;

  return (
    <div className="flex flex-col gap-3">
      {/* The bar: how long, what it is hearing, and the way out. */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="flex items-center gap-2 rounded-full border px-3 py-1.5"
          style={{ borderColor: C.line2, background: C.sunken }}
        >
          <Waveform color={C.blueS} />
          <span
            className="font-mono text-[13px] tabular-nums"
            style={{ color: C.blueS }}
          >
            {clock(elapsedMs)}
          </span>
        </span>
        <span className="text-[13px]" style={{ color: C.t2 }}>
          Capturing the room · mic only
        </span>
        <button
          type="button"
          onClick={() => void stopAndWrite()}
          disabled={stopping}
          className="ml-auto flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold"
          style={{ background: C.t1, color: C.card, opacity: stopping ? 0.6 : 1 }}
        >
          <span
            className="inline-block size-2.5 rounded-[2px]"
            style={{ background: C.card }}
            aria-hidden
          />
          {stopping ? "Writing it up…" : "Stop & write it up"}
        </button>
      </div>

      {/* LIVE — the words as they arrive. */}
      <div
        className="rounded-lg border px-4 py-3.5"
        style={{ borderColor: C.line, background: C.card }}
      >
        <p
          className="font-mono text-[10.5px] tracking-wide uppercase"
          style={{ color: C.t3 }}
        >
          Live
        </p>
        {live.isLive ? (
          <p
            className="mt-2 text-[15px] leading-relaxed"
            style={{ color: committed ? C.t1 : C.t3 }}
            aria-live="polite"
          >
            {committed || "Listening…"}
          </p>
        ) : (
          <p className="mt-2 text-[13px] leading-relaxed" style={{ color: C.t2 }}>
            I can&rsquo;t show the words as you say them on this connection —
            keep talking, and you&rsquo;ll get them written down when you stop.
          </p>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* FORMING AS YOU TALK — extractions during, not after. */}
        <div
          className="rounded-lg border px-4 py-3.5"
          style={{ borderColor: C.line, background: C.card }}
        >
          <p
            className="font-mono text-[10.5px] tracking-wide uppercase"
            style={{ color: C.blueS }}
          >
            Forming as you talk
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {found.map((e) => (
              <li key={e.id} className="flex gap-2 text-[13px]">
                <span style={{ color: C.green }} aria-hidden>
                  ✓
                </span>
                <span style={{ color: C.t1 }}>
                  {String(
                    (e.payload as { title?: unknown } | null)?.title ??
                      "Something to do",
                  )}
                </span>
              </li>
            ))}
            <li className="flex items-center gap-2 text-[13px]">
              <span
                className="inline-block size-1.5 rounded-full motion-safe:animate-pulse"
                style={{ background: C.t3 }}
                aria-hidden
              />
              <span style={{ color: C.t3 }}>listening for more…</span>
            </li>
          </ul>
        </div>

        {/* WHERE IT'LL GO — the project guess, with its evidence. */}
        <div
          className="rounded-lg border px-4 py-3.5"
          style={{ borderColor: C.line, background: C.card }}
        >
          <p
            className="font-mono text-[10.5px] tracking-wide uppercase"
            style={{ color: C.t3 }}
          >
            Where it&rsquo;ll go
          </p>
          <p className="mt-2 text-[13px]" style={{ color: C.t2 }}>
            Unfiled for now — filing is offered when you stop, never demanded
            up front.
          </p>
        </div>
      </div>

      {/* The promise that makes recording thinkable at all. */}
      <div
        className="flex items-start gap-2.5 rounded-lg border px-4 py-3"
        style={{ borderColor: C.line, background: C.card }}
      >
        <Lock size={14} style={{ color: C.t3 }} className="mt-0.5" />
        <p className="text-[12.5px] leading-relaxed" style={{ color: C.t2 }}>
          Audio stays on this Mac. The transcript is yours to keep or delete —
          deleting it keeps the note.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void cancel()}
        className="self-start text-[12px] font-medium"
        style={{ color: C.t3 }}
      >
        Cancel · esc — throws the recording away
      </button>
    </div>
  );
}
