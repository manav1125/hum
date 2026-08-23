/**
 * What a recorded note leaves behind (N3).
 *
 * The one thing this screen must never do is **launder a summary as a
 * transcript**. So Cue's prose and the words that were actually said are two
 * visibly different things here, the summary says in plain language that Cue
 * wrote it, and every sentence of it can be tapped to hear the moment it came
 * from. A summary you cannot check against its source is an assertion asking
 * to be believed; this one is evidence you can audit.
 *
 * **"Delete audio, keep note" is always available.** It is the escape people
 * need before they will record anything at all — and it has to be visible
 * rather than buried, because a promise nobody can find is not one.
 */

import { useCallback, useRef, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import {
  notesByIdAlignmentGetOptions,
  notesByIdPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useInvalidateNotes } from "@/hooks/use-invalidate-notes";
import type { Note } from "@/types/notes";

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blueS: "var(--mv1-blue-strong)",
} as const;

interface Sentence {
  text: string;
  atMs: number | null;
}

function formatMs(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function NoteRecordingPanel({
  assistantId,
  note,
}: {
  assistantId: string;
  note: Note;
}) {
  const invalidate = useInvalidateNotes();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [showTranscript, setShowTranscript] = useState(false);

  const alignment = useQuery({
    ...notesByIdAlignmentGetOptions({
      path: { assistant_id: assistantId, id: note.id },
    }),
    enabled: Boolean(note.bodyIsSummary && note.transcript),
    staleTime: 5 * 60_000,
  }) as unknown as { data?: { sentences: Sentence[] } };

  const update = useMutation(notesByIdPatchMutation()) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string; id: string };
      body: { audioPath: null };
    }) => Promise<unknown>;
    isPending: boolean;
  };

  const play = useCallback((atMs: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = atMs / 1000;
    void audio.play();
  }, []);

  const deleteAudio = useCallback(async () => {
    await update.mutateAsync({
      path: { assistant_id: assistantId, id: note.id },
      body: { audioPath: null },
    });
    invalidate();
  }, [assistantId, invalidate, note.id, update]);

  if (!note.audioPath && !note.transcript) return null;

  const sentences = alignment.data?.sentences ?? [];

  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: C.line, background: C.card }}
    >
      <div className="flex items-center justify-between">
        <p
          className="text-[10.5px] font-semibold tracking-wide uppercase"
          style={{ color: C.t3 }}
        >
          Recorded note
          {note.audioDurationMs ? ` · ${formatMs(note.audioDurationMs)}` : ""}
        </p>
        {note.audioPath ? (
          <button
            type="button"
            onClick={() => void deleteAudio()}
            disabled={update.isPending}
            className="flex items-center gap-1 text-[11.5px]"
            style={{ color: C.t3 }}
            // The escape people need before they will record anything at all,
            // so it is on the surface rather than behind a menu.
            title="Removes the recording from this device. The note stays."
          >
            <Trash2 size={12} />
            Delete audio, keep note
          </button>
        ) : null}
      </div>

      {note.audioPath ? (
        <audio ref={audioRef} src={note.audioPath} className="hidden" />
      ) : null}

      {/* Cue's prose, said to be Cue's, and checkable sentence by sentence. */}
      {note.bodyIsSummary && sentences.length > 0 ? (
        <div className="mt-2">
          <p className="text-[13px] leading-relaxed" style={{ color: C.t1 }}>
            {sentences.map((sentence, index) =>
              sentence.atMs !== null && note.audioPath ? (
                <button
                  key={index}
                  type="button"
                  onClick={() => play(sentence.atMs!)}
                  className="mr-1 text-left underline decoration-dotted underline-offset-2"
                  style={{ color: C.t1 }}
                  title={`Hear this at ${formatMs(sentence.atMs)}`}
                >
                  {sentence.text}
                </button>
              ) : (
                // No confident moment, so it is not tappable. Better than a
                // link that plays the wrong part of the recording.
                <span key={index} className="mr-1">
                  {sentence.text}
                </span>
              ),
            )}
          </p>
          <p className="mt-1.5 text-[11px]" style={{ color: C.t3 }}>
            I wrote that summary
            {note.audioPath ? " — tap any sentence to hear that moment" : ""}.
          </p>
        </div>
      ) : null}

      {note.transcript ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            className="text-[12px] font-medium"
            style={{ color: C.blueS }}
          >
            {showTranscript ? "Hide what was said" : "What was said ›"}
          </button>
          {showTranscript ? (
            <blockquote
              className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border-l-2 py-1 pl-2 text-[12.5px] leading-relaxed whitespace-pre-wrap"
              style={{ borderColor: C.line2, color: C.t2 }}
            >
              {note.transcript}
            </blockquote>
          ) : null}
        </div>
      ) : null}

      <p className="mt-2 text-[11px]" style={{ color: C.t3 }}>
        {note.audioPath
          ? "Audio stays on this device · never uploaded"
          : "Audio deleted · the note and the transcript stay"}
      </p>
    </div>
  );
}
