/**
 * Typed client bindings for Notes.
 *
 * This file is the single place the web app names the wire shape, the same
 * role `hooks/use-activity-list.ts` plays for Mission Control. The generated
 * SDK names its operations off the URL (`notesByIdReadPost`), which is fine
 * for transport and unreadable at a call site, so the hooks below give each
 * one the name the feature actually uses.
 *
 * Two things the rest of the domain depends on and must not re-derive:
 *
 *   · **`extractionState: "done"` with no proposals is "nothing to file".**
 *     `"failed"` is "I couldn't read this one just now — your note is
 *     saved." One is about the note, the other about the request, and the
 *     UI has a separate branch for each.
 *   · **`confidenceTier` is drawn, never printed.** There is no number on
 *     the wire to render, and there must never be one: "82% sure" is a fact
 *     about the model, not about the owner's work.
 */

import { useCallback, useEffect, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import {
  notesByIdExtractionsByExtractionIdAcceptPostMutation,
  notesByIdExtractionsByExtractionIdDismissPostMutation,
  notesByIdExtractionsByExtractionIdUndoPostMutation,
  notesByIdGetOptions,
  notesByIdReadPostMutation,
  notesExtractionsWaitingGetOptions,
  notesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { useInvalidateNotes } from "@/hooks/use-invalidate-notes";
import {
  enqueue,
  getLocalNote,
  listLocalNotes,
  mirrorServerNotes,
  type LocalNote,
} from "@/stores/note-local-store";
import { drainQueue, isOnline, startNoteSync } from "@/stores/note-sync";
import type {
  Note,
  NoteConflictResolution,
  NoteCounts,
  NoteExtraction,
  NoteFilter,
  ReadNoteResult,
} from "@/types/notes";

/**
 * The list, the header's counts, and — the part that took two tries to get
 * right — an honest answer about which of those it actually has.
 *
 * Online it is the daemon's answer, mirrored into the local store on the way
 * through so this device always holds a current snapshot. Offline it is that
 * snapshot: "reading everything already on the phone" is one of the things
 * the offline split promises, so the list renders with no signal.
 *
 * **`status` exists because an empty list and a failed request are not the
 * same thing.** Rendering the empty state — "Say the thing you'd otherwise
 * forget" — when the request merely failed tells someone they have no notes
 * when the truth is that we could not ask. That is the same lie as reporting
 * "nothing to file" for a read that errored, one level up, and it is exactly
 * the mistake this feature is built to avoid.
 *
 * The counts are only trustworthy from the daemon, which is the only place
 * that can see accepted proposals. From the local snapshot they are omitted
 * rather than estimated: the header line is the feature's central claim, and
 * a guessed one is worse than none.
 */
export interface NotesView {
  /**
   *  · `loading`     — genuinely still waiting, and only ever on the local
   *                    read, which the store bounds. A query that is merely
   *                    disabled never settles and so may never render here.
   *  · `ready`       — a list, from `source`.
   *  · `unreachable` — the daemon could not be reached AND this device holds
   *                    no snapshot. Say so; never draw an empty list.
   */
  status: "loading" | "ready" | "unreachable";
  source: "server" | "local" | null;
  notes: Note[];
  counts: NoteCounts | null;
}

/**
 * The resolution rules, as one pure function.
 *
 * Exported and used by the hook itself rather than re-derived in a test —
 * a test that restates these branches can pass while the hook does the
 * opposite, which is worse than no test at all.
 */
export function resolveNotesView(
  query: {
    data?: { notes: Note[]; counts: NoteCounts };
    isPending: boolean;
    isError: boolean;
    /**
     * react-query's second axis. A **disabled** query — ours is
     * `enabled: Boolean(assistantId)` — reports `isPending` for as long as it
     * stays disabled, because "pending" means *no data yet*, not *a request is
     * in flight*. `fetchStatus: "idle"` is the only thing that separates
     * "nobody asked" from "asking". Optional so a caller that cannot supply it
     * keeps the old behaviour rather than silently reading as never-asked.
     */
    fetchStatus?: "fetching" | "paused" | "idle";
  },
  /** `undefined` = the local read has not answered yet. */
  local: LocalNote[] | undefined,
  filter: NoteFilter,
): NotesView {
  if (query.data) {
    return {
      status: "ready",
      source: "server",
      notes: query.data.notes,
      counts: query.data.counts,
    };
  }

  // A query that was never asked is not a query that is waiting. Everything
  // below reads this rather than `isPending` alone — see the field's note.
  const neverAsked = query.isPending && query.fetchStatus === "idle";

  // Waiting on the local read, which is bounded by the store's open timeout —
  // an unreadable store answers with an empty array, never never. Worth doing
  // even when the daemon was never asked: this device may still hold the pile.
  if (local === undefined && (query.isPending || query.isError)) {
    return { status: "loading", source: null, notes: [], counts: null };
  }

  // Being unable to reach the daemon must not hide what this device holds.
  if (local && local.length > 0) {
    return {
      status: "ready",
      source: "local",
      notes: applyFilter(local, filter),
      counts: null,
    };
  }

  // Nothing local, and either the daemon errored or it was never asked at all.
  // Both mean the same thing to the reader — *we do not know what is there* —
  // and "no notes" would be a guess dressed as a fact about the pile someone
  // would most panic to see empty. `neverAsked` belongs here and NOT in the
  // loading branch below: a disabled query never settles, so treating it as
  // loading is an unbounded spinner, which is the one thing this resolver
  // exists to prevent.
  if (query.isError || neverAsked) {
    return { status: "unreachable", source: null, notes: [], counts: null };
  }

  if (query.isPending) {
    return { status: "loading", source: null, notes: [], counts: null };
  }

  return { status: "ready", source: "local", notes: [], counts: null };
}

export function useNotes(
  assistantId: string,
  filter: NoteFilter = "all",
): NotesView {
  const query = useQuery({
    ...notesGetOptions({
      path: { assistant_id: assistantId },
      query: { filter },
    }),
    enabled: Boolean(assistantId),
  }) as unknown as {
    data?: { notes: Note[]; counts: NoteCounts };
    isPending: boolean;
    isError: boolean;
    fetchStatus: "fetching" | "paused" | "idle";
  };

  const [local, setLocal] = useState<LocalNote[] | undefined>(undefined);

  // Mirror every successful fetch, so the offline list is the last thing the
  // daemon said rather than only what this device happened to write.
  useEffect(() => {
    if (query.data?.notes) void mirrorServerNotes(query.data.notes);
  }, [query.data]);

  // Read the local snapshot once, always. It is the fallback for both the
  // offline case and the daemon-unreachable case, so it must not be
  // conditional on the query's state. A failed read answers `[]` — a device
  // whose store cannot be opened has no notes on it, which is an answer.
  useEffect(() => {
    let cancelled = false;
    void listLocalNotes()
      .catch(() => [] as LocalNote[])
      .then((notes) => {
        if (!cancelled) setLocal(notes);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return resolveNotesView(query, local, filter);
}

/**
 * The filters, applied locally.
 *
 * `waiting` is deliberately absent: whether a note has undecided proposals is
 * a fact only the daemon holds, and a filter that silently returned nothing
 * would read as "you are all caught up" when it means "I cannot tell".
 */
function applyFilter(notes: LocalNote[], filter: NoteFilter): LocalNote[] {
  if (filter === "unfiled") return notes.filter((n) => !n.projectId);
  if (filter === "recorded") return notes.filter((n) => n.audioPath);
  return notes;
}

/**
 * What is still waiting to reach the daemon — the "3 notes waiting to be
 * read" line, and the honest version of an offline state.
 *
 * Deliberately not a spinner and not a retry countdown: the note is already
 * saved, so there is nothing for the owner to wait for. It drains when the
 * connection returns.
 */
export function useNoteSync(assistantId: string) {
  const [online, setOnline] = useState(isOnline);
  const [pending, setPending] = useState(0);

  const refreshPending = useCallback(async () => {
    const notes = await listLocalNotes();
    setPending(notes.filter((n) => n.pending).length);
  }, []);

  useEffect(() => {
    const teardown = startNoteSync(assistantId);
    const onOnline = () => {
      setOnline(true);
      void drainQueue(assistantId).then(refreshPending);
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void refreshPending();
    return () => {
      teardown();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [assistantId, refreshPending]);

  return { online, pending, refreshPending };
}

/**
 * One note — the daemon's copy, or this device's, whichever exists.
 *
 * **The local fallback is not an offline nicety; it is the only way a
 * just-written note can be opened at all.** Capture is local-first by
 * contract: `useCreateNote` mints an id, saves to this device, queues a push
 * and returns — the note is durable here before the function resolves, and
 * the daemon has not heard of it yet. This view then asked the daemon for it
 * by id, got a 404, and said "I couldn't open this note just now. This is
 * about the connection, not about the note — nothing has been lost, and it is
 * still here." Every word of that was true and the view was looking in the
 * one place the note was not.
 *
 * The list has had this fallback since it was written, which is why the list
 * worked and opening what it listed did not. The asymmetry was the bug.
 *
 * Extractions stay server-only, and a local-only note reports none. That is
 * honest rather than lossy: proposals are something the daemon makes about a
 * note it has read, and it has not read this one yet.
 */
export function useNote(assistantId: string, noteId: string | null) {
  const query = useQuery({
    ...notesByIdGetOptions({
      path: { assistant_id: assistantId, id: noteId ?? "" },
    }),
    enabled: Boolean(assistantId && noteId),
  }) as unknown as {
    data?: { note: Note; extractions: NoteExtraction[] };
    isPending: boolean;
    isError: boolean;
    /** See the note on `resolveNotesView`: a disabled query sits here. */
    fetchStatus: "fetching" | "paused" | "idle";
    refetch: () => void;
  };

  // `undefined` is "not looked yet", `null` is "looked, and it is not here".
  // The difference decides whether this view may show a failure, so the two
  // cannot be collapsed.
  const [local, setLocal] = useState<LocalNote | null | undefined>(undefined);
  useEffect(() => {
    if (!noteId) {
      setLocal(null);
      return;
    }
    let cancelled = false;
    setLocal(undefined);
    void getLocalNote(noteId)
      .catch(() => null)
      .then((found) => {
        if (!cancelled) setLocal(found);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // Mirror what the daemon says, so the next open works with no network at
  // all — the same thing the list does with its page of notes.
  useEffect(() => {
    if (query.data?.note) void mirrorServerNotes([query.data.note]);
  }, [query.data]);

  return { ...query, ...resolveNoteDetail(query, local, noteId) } as typeof query;
}

/**
 * Which copy of the note the detail view gets, and whether it may fail yet.
 *
 * Pure, and exported, for the same reason `resolveNotesView` is: these are the
 * branches that were wrong in a build someone actually used, and a test that
 * re-derived them could pass while the hook did the opposite.
 */
export function resolveNoteDetail(
  query: {
    data?: { note: Note; extractions: NoteExtraction[] };
    isPending: boolean;
    fetchStatus: "fetching" | "paused" | "idle";
  },
  local: LocalNote | null | undefined,
  noteId: string | null,
): {
  data?: { note: Note; extractions: NoteExtraction[] };
  isPending: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
} {
  // A local read still outstanding is work in flight, on BOTH of the fields
  // the view tests. It draws its failure only when `isPending` is false *and*
  // `fetchStatus` is idle, so reporting one without the other still lets the
  // failure flash in the gap between the daemon answering "no" and this
  // device answering "yes" — a failure that un-fails itself, which is worse
  // than either answer.
  const stillReadingLocally = local === undefined && Boolean(noteId);
  const data = query.data?.note
    ? query.data
    : local
      ? { note: local as Note, extractions: [] as NoteExtraction[] }
      : undefined;

  return {
    ...(data ? { data } : {}),
    isPending: query.isPending || stillReadingLocally,
    fetchStatus: stillReadingLocally ? "fetching" : query.fetchStatus,
  };
}

/**
 * Every undecided proposal, across every note.
 *
 * Requiring acceptance means unreviewed findings pile up somewhere; this is
 * what makes the pile visible. The morning brief reads the same endpoint, so
 * the count in Notes and the count in the brief can never disagree.
 */
export function useWaitingExtractions(assistantId: string) {
  return useQuery({
    ...notesExtractionsWaitingGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: Boolean(assistantId),
  }) as unknown as { data?: { extractions: NoteExtraction[] } };
}

/**
 * Read a note for things to do — on close, or when the owner asks.
 *
 * Never called on a timer. Unchanged text returns `skipped`, so closing a
 * note you did not edit costs nothing at all.
 *
 * **Offline this queues rather than fails.** Intelligence is on the "waits"
 * side of the offline split: the note is already saved, and it will be read
 * when there is a connection. Returning a `skipped` outcome rather than a
 * failure keeps the rail honest — nothing went wrong, the reading simply has
 * not happened yet.
 */
export function useReadNote() {
  const invalidate = useInvalidateNotes();
  const online = useMutation({
    ...notesByIdReadPostMutation(),
    onSuccess: invalidate,
  }) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string; id: string };
      body: { force?: boolean };
    }) => Promise<ReadNoteResult>;
    isPending: boolean;
  };

  const mutateAsync = useCallback(
    async (vars: {
      path: { assistant_id: string; id: string };
      body: { force?: boolean };
    }): Promise<ReadNoteResult> => {
      if (!isOnline()) {
        await enqueue({ op: "read", noteId: vars.path.id, at: Date.now() });
        return { status: "skipped", skippedReason: "offline", extractions: [] };
      }
      return online.mutateAsync(vars);
    },
    [online],
  );

  return { mutateAsync, isPending: online.isPending };
}

/**
 * Accept one proposal — the only call in this file that puts anything into
 * HQ, memory or People.
 */
export function useAcceptExtraction() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    ...notesByIdExtractionsByExtractionIdAcceptPostMutation(),
    onSuccess: invalidate,
  }) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string; id: string; extractionId: string };
      body: { resolution?: NoteConflictResolution };
    }) => Promise<{
      status: "accepted" | "dismissed" | "already_decided" | "failed";
      refType: string | null;
      refId: string | null;
      error: string | null;
    }>;
    isPending: boolean;
  };
}

/** Dismiss one proposal. Writes nothing anywhere. */
export function useDismissExtraction() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    ...notesByIdExtractionsByExtractionIdDismissPostMutation(),
    onSuccess: invalidate,
  }) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string; id: string; extractionId: string };
    }) => Promise<{ status: string }>;
    isPending: boolean;
  };
}

/**
 * Take back an acceptance.
 *
 * A reversal rather than a delete, so it can refuse: once Cue has started the
 * task, or the memory page has been edited around the line, taking it back
 * would destroy work instead of undoing a click. `too_late` carries the
 * sentence explaining that, and the rail shows it beside the claim.
 */
export function useUndoExtraction() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    ...notesByIdExtractionsByExtractionIdUndoPostMutation(),
    onSuccess: invalidate,
  }) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string; id: string; extractionId: string };
    }) => Promise<{
      status: "undone" | "not_accepted" | "too_late" | "failed";
      reason: string | null;
    }>;
    isPending: boolean;
  };
}
