/**
 * Capturing a note — local first, and it never awaits the network.
 *
 * Lives in `hooks/` rather than inside `domains/notes` because more than one
 * surface captures: the Notes page, the floating corner's `⌘↵`, and the iOS
 * doors to come. Per CONVENTIONS.md a hook two domains need is a top-level
 * hook — the alternative is a cross-domain import, which is how one domain
 * quietly becomes another's library.
 *
 * The ordering here IS the capture contract. A note is durable on this device,
 * with an id it keeps forever, before any of these functions resolve; only
 * then is a push queued. That is why the UI can print "your note is saved" —
 * because by then it is, not because a request was optimistic.
 *
 * The push is idempotent on the minted id, so the queue may retry it freely.
 */

import { useCallback } from "react";

import {
  deleteNoteLocally,
  enqueue,
  getLocalNote,
  mintNoteId,
  saveNoteLocally,
  type LocalNote,
} from "@/stores/note-local-store";
import { drainQueue } from "@/stores/note-sync";
import type { Note, NoteSource } from "@/types/notes";

import { useInvalidateNotes } from "@/hooks/use-invalidate-notes";

export function useCreateNote() {
  const invalidate = useInvalidateNotes();

  const mutateAsync = useCallback(
    async (vars: {
      path: { assistant_id: string };
      body: { body: string; title?: string; source?: NoteSource };
    }): Promise<{ note: Note }> => {
      const now = Date.now();
      const note: LocalNote = {
        id: mintNoteId(),
        title: vars.body.title?.trim() || deriveTitle(vars.body.body),
        body: vars.body.body,
        source: vars.body.source ?? "typed",
        sourceDetail: null,
        projectId: null,
        audioPath: null,
        audioDurationMs: null,
        transcript: null,
        bodyIsSummary: false,
        extractionState: "idle",
        lastReadHash: null,
        lastReadAt: null,
        occurredAt: now,
        createdAt: now,
        updatedAt: now,
        pending: true,
      };

      await saveNoteLocally(note);
      await enqueue({ op: "create", noteId: note.id, at: now });
      // Fire-and-forget: a drain that fails leaves the queue intact and the
      // note is already safe, so nothing here waits on it.
      void drainQueue(vars.path.assistant_id).then(invalidate);
      return { note };
    },
    [invalidate],
  );

  return { mutateAsync, isPending: false };
}

/** Edit a note. Same contract as create: local first, push queued. */
export function useUpdateNote() {
  const invalidate = useInvalidateNotes();

  const mutateAsync = useCallback(
    async (vars: {
      path: { assistant_id: string; id: string };
      body: { title?: string; body?: string; projectId?: string | null };
    }): Promise<{ note: Note }> => {
      const existing = await getLocalNote(vars.path.id);
      const now = Date.now();
      const next: LocalNote = {
        ...(existing ?? emptyLocalNote(vars.path.id, now)),
        ...(vars.body.title !== undefined ? { title: vars.body.title } : {}),
        ...(vars.body.body !== undefined ? { body: vars.body.body } : {}),
        ...(vars.body.projectId !== undefined
          ? { projectId: vars.body.projectId }
          : {}),
        updatedAt: now,
        pending: true,
      };
      await saveNoteLocally(next);
      await enqueue({ op: "update", noteId: vars.path.id, at: now });
      void drainQueue(vars.path.assistant_id).then(invalidate);
      return { note: next };
    },
    [invalidate],
  );

  return { mutateAsync, isPending: false };
}

/**
 * Delete a note — locally at once, on the daemon when it can be reached.
 *
 * Work accepted out of the note is untouched either way: provenance is
 * one-way, and the daemon enforces that. Nothing here needs to know.
 */
export function useDeleteNote() {
  const invalidate = useInvalidateNotes();

  const mutateAsync = useCallback(
    async (vars: {
      path: { assistant_id: string; id: string };
    }): Promise<{ deleted: boolean }> => {
      await deleteNoteLocally(vars.path.id);
      await enqueue({ op: "delete", noteId: vars.path.id, at: Date.now() });
      void drainQueue(vars.path.assistant_id).then(invalidate);
      return { deleted: true };
    },
    [invalidate],
  );

  return { mutateAsync };
}

/** Mirrors the daemon's own title derivation so an offline card is not blank. */
function deriveTitle(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "Untitled note";
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

function emptyLocalNote(id: string, now: number): LocalNote {
  return {
    id,
    title: "Untitled note",
    body: "",
    source: "typed",
    sourceDetail: null,
    projectId: null,
    audioPath: null,
    audioDurationMs: null,
    transcript: null,
    bodyIsSummary: false,
    extractionState: "idle",
    lastReadHash: null,
    lastReadAt: null,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
    pending: true,
  };
}
