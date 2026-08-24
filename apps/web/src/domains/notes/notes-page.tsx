/**
 * Notes — the destination (N1) and the note itself (1a).
 *
 * Notes is the capture surface for a filing system that already exists. Cue
 * has HQ, projects, People and Memory, so a note's job is to BECOME work
 * rather than to become a second knowledge base. Everything absent here is
 * absent on purpose: no collections, no tags, no folders, no graph view. A
 * notes app that needs organising is a notes app that failed.
 *
 * ## The header line is the argument for the feature
 *
 * "62 notes · they've produced 78 tasks and 31 memories" is what proves notes
 * are not a graveyard, and every number in it is counted server-side rather
 * than estimated here.
 *
 * ## Reading happens on close, never on a timer
 *
 * Leaving a note asks the daemon to read it; unchanged text is never re-read,
 * so closing a note you did not edit costs nothing. The old design read after
 * ~2s of idle, which at a long meeting write-up is a model call every couple
 * of seconds on text that is not finished being written — expensive to run
 * and unnerving to watch. You want extractions when you have finished the
 * thought, not mid-sentence.
 *
 * ## Filing is optional, forever
 *
 * "Unfiled" is a resting state, not a backlog to shame. The walking-to-work
 * thought is the highest-value note in the system and it will never have a
 * project.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { projectsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import {
  ArrowLeft,
  Check,
  Download,
  Inbox,
  Mic,
  PenLine,
  Plane,
  Sparkles,
  Trash2,
} from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { Mv3NotesPage } from "@/mobile-v3/notes/mv3-notes-page";

import {
  useCreateNote,
  useDeleteNote,
  useUpdateNote,
} from "@/hooks/use-note-capture";
import type { Note, NoteFilter, NoteProduced } from "@/types/notes";

import { NoteAcceptRate } from "./note-accept-rate";
import { NoteAskPanel } from "./note-ask-panel";
import { NoteCreateOptions } from "./note-create-options";
import { NoteImportPanel } from "./note-import-panel";
import { NoteRail } from "./note-rail";
import { NoteRecorder } from "./note-recorder";
import { NoteRecordingPanel } from "./note-recording-panel";
import { NoteTidySheet } from "./note-tidy-sheet";
import { useNote, useNotes, useNoteSync, useReadNote } from "./use-notes";

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
  // Small text takes the -text variant, never the bright fill (§6).
  amberText: "var(--mv1-amber-text)",
} as const;

const serif = "'Instrument Serif', Georgia, serif";

const FILTERS: readonly { key: NoteFilter; label: string }[] = [
  { key: "all", label: "All" },
  // The pile acceptance creates. Named for what it asks of you, not for how
  // far behind you are. Hidden offline — whether a note has undecided
  // proposals is a fact only the daemon holds, and an empty list here would
  // read as "you are all caught up" when it means "I cannot tell".
  { key: "waiting", label: "Waiting on you" },
  { key: "unfiled", label: "Unfiled" },
  { key: "recorded", label: "Recorded" },
];

/**
 * Notes, on whichever surface you are on.
 *
 * `useMobileLayout`, not `useIsMobile`: the branch below is STRUCTURAL — the
 * phone drops the rail entirely and puts what Cue found below the note, in
 * flow, so it never competes with the keyboard. A narrow desktop window is
 * not a phone, and taking the phone branch there would lose the rail beside
 * the note on a surface where a pointer can drive both perfectly well. Same
 * reasoning as `PeoplePage`.
 */
export function NotesPage() {
  const isPhone = useMobileLayout();
  if (isPhone) return <Mv3NotesPage />;
  return <NotesPageDesktop />;
}

function NotesPageDesktop() {
  const assistantId = useActiveAssistantId();
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  /**
   * N1 offers two orders, and they answer different questions. Newest-first
   * is "what have I been thinking about"; by-work is "which of these actually
   * turned into something", which is the one that makes a long pile useful.
   */
  const [sort, setSort] = useState<NoteSort>("recent");
  const list = useNotes(assistantId, filter);
  // Above every early return — hook order cannot depend on the view state.
  const notes = useMemo(() => sortNotes(list.notes, sort), [list.notes, sort]);
  /**
   * Names for the project chips. A card that says "▤ Renew Acme" tells you
   * where a thought lives; one that says "filed" tells you nothing. Failure
   * is silent on purpose — the chip falls back to filed/unfiled and the list
   * still renders, because a project name is not worth an error state.
   */
  const projects = useQuery({
    ...projectsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
  });
  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    const rows = (projects.data as { projects?: Array<{ id: string; name: string }> } | undefined)?.projects;
    for (const p of rows ?? []) map.set(p.id, p.name);
    return map;
  }, [projects.data]);
  const createNote = useCreateNote();
  const sync = useNoteSync(assistantId);

  const startNote = useCallback(async () => {
    const created = await createNote.mutateAsync({
      path: { assistant_id: assistantId },
      body: { body: "" },
    });
    setOpenNoteId(created.note.id);
  }, [assistantId, createNote]);

  if (openNoteId) {
    return (
      <PageShell>
        <NoteView
          assistantId={assistantId}
          noteId={openNoteId}
          onClose={() => setOpenNoteId(null)}
        />
      </PageShell>
    );
  }

  const { counts } = list;

  return (
    <PageShell>
      <header className="mb-4">
        <h1
          className="text-[28px] leading-tight"
          style={{ fontFamily: serif, color: C.t1 }}
        >
          Notes
        </h1>
        {/* Counted, not estimated — this sentence is the whole argument that
            notes are not a graveyard. */}
        {/* Omitted offline rather than estimated: only the daemon can see
            accepted proposals, and this line is the feature's central claim. */}
        {counts ? (
          <p className="mt-1 text-[13px]" style={{ color: C.t2 }}>
            {counts.notes} {counts.notes === 1 ? "note" : "notes"}
            {counts.tasks + counts.memories > 0 ? (
              <>
                {" · they've produced "}
                <strong style={{ color: C.t1, fontWeight: 600 }}>
                  {counts.tasks} {counts.tasks === 1 ? "task" : "tasks"}
                </strong>
                {" and "}
                <strong style={{ color: C.t1, fontWeight: 600 }}>
                  {counts.memories}{" "}
                  {counts.memories === 1 ? "memory" : "memories"}
                </strong>
                {" so far"}
              </>
            ) : null}
          </p>
        ) : null}
      </header>

      {/* Ask sits above the list because it is the reason to keep the pile:
          without it, Notes is a folder you have to remember the contents of. */}
      <NoteAskPanel assistantId={assistantId} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void startNote()}
          disabled={createNote.isPending}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-white"
          style={{ background: C.blueS }}
        >
          <PenLine size={13} />
          New note
        </button>
        <button
          type="button"
          onClick={() => setImporting((v) => !v)}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px]"
          style={{ borderColor: C.line2, color: C.t1 }}
        >
          <Download size={13} />
          Import
        </button>
        <NoteRecorder assistantId={assistantId} onCreated={setOpenNoteId} />
        <div className="ml-auto flex flex-wrap gap-1">
          {FILTERS.filter(({ key }) => sync.online || key !== "waiting").map(
            ({ key, label }) => {
              const active = key === filter;
              const badge =
                key === "waiting"
                  ? counts?.waiting
                  : key === "unfiled"
                    ? counts?.unfiled
                    : key === "recorded"
                      ? counts?.recorded
                      : counts?.notes;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className="rounded-full border px-2.5 py-1 text-[12px]"
                  style={{
                    borderColor: active ? C.line2 : "transparent",
                    background: active ? C.sunken : "transparent",
                    color: active ? C.t1 : C.t3,
                  }}
                >
                  {label}
                  {badge !== undefined ? ` · ${badge}` : ""}
                </button>
              );
            },
          )}
          {/* N1's two orders. A toggle rather than a menu: there are exactly
              two, and a dropdown to choose between two is a click spent on
              nothing. Hidden while offline, where `produced` is unknown and
              "by work" would sort every note as if it had produced nothing. */}
          {sync.online ? (
            <button
              type="button"
              onClick={() => setSort((v) => (v === "recent" ? "work" : "recent"))}
              className="rounded-full border px-2.5 py-1 text-[12px]"
              style={{ borderColor: "transparent", color: C.t3 }}
              aria-label={
                sort === "recent"
                  ? "Sorted newest first. Switch to sorting by what they produced."
                  : "Sorted by what they produced. Switch to newest first."
              }
            >
              {sort === "recent" ? "Newest first ▾" : "By work ▾"}
            </button>
          ) : null}
        </div>
      </div>

      {importing ? (
        <div className="mb-3">
          <NoteImportPanel
            assistantId={assistantId}
            onDone={() => setImporting(false)}
          />
        </div>
      ) : null}

      {!sync.online ? <OfflineBanner pending={sync.pending} /> : null}

      {counts && counts.waiting > 0 && filter !== "waiting" ? (
        <WaitingBanner
          waiting={counts.waiting}
          onReview={() => setFilter("waiting")}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.status === "loading" ? (
          <p className="text-[13px]" style={{ color: C.t3 }}>
            Loading…
          </p>
        ) : list.status === "unreachable" ? (
          // NOT the empty state. Drawing "you have no notes" when the truth is
          // "I couldn't ask" is the same lie as reporting "nothing to file"
          // for a read that errored — and the note pile is exactly the thing
          // someone would panic about seeing empty.
          <Unreachable />
        ) : notes.length === 0 ? (
          <EmptyState filter={filter} onStart={() => void startNote()} />
        ) : (
          <>
            <NoteList
              notes={notes}
              projectNames={projectNames}
              onOpen={setOpenNoteId}
            />
            {/* The number that says whether this feature works. It renders
                only once something has actually been decided — inventing a
                rate from three decisions would be worse than showing none. */}
            <div className="mt-6">
              <NoteAcceptRate assistantId={assistantId} />
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}

/**
 * The list, with arrivals called out at the top.
 *
 * Things that arrived on their own — Halo, forwarded mail, meeting capture —
 * get their own lane because they need reading before they need filing, and
 * because someone should be able to see at a glance what came in without
 * them. **Nothing here has been filed as work**: an arrival is a note, and it
 * obeys acceptance exactly like something typed by hand.
 *
 * Everything is still one list underneath, sorted by when the thought
 * happened. The lane is a heading, not a second store — a separate inbox is
 * how a capture surface becomes a thing to process.
 */
/**
 * Group a page of notes by the day the thought happened.
 *
 * Deliberately on `occurredAt` rather than `createdAt`: a Halo capture and an
 * import both carry their own time, and filing a walk-to-work thought under
 * the moment the row was written would put it on the wrong day.
 *
 * Order is preserved from the caller (newest first), so the groups come out
 * newest first without a second sort. Arrivals are filtered out before this
 * runs — they have their own lane above.
 */
/** The two orders N1 offers. */
type NoteSort = "recent" | "work";

/**
 * Order the list.
 *
 * `recent` is the resting state and the one the day-grouping assumes.
 * `work` puts the notes that actually produced something first — the answer
 * to "which of these was worth writing down" — and falls back to recency
 * within a tie, so it never looks shuffled. Notes with undecided proposals
 * outrank ones already dealt with: they are the ones still asking.
 */
function sortNotes(notes: Note[], sort: NoteSort): Note[] {
  if (sort === "recent") return notes;
  const weight = (n: Note): number => {
    const p = n.produced;
    if (!p) return 0;
    return p.waiting * 100 + (p.tasks + p.memories + p.traits);
  };
  return [...notes].sort(
    (a, b) => weight(b) - weight(a) || b.occurredAt - a.occurredAt,
  );
}

function groupByDay(notes: Note[]): Array<[string, Note[]]> {
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(Date.now());
  const day = 24 * 60 * 60 * 1000;

  const label = (ms: number): string => {
    const at = startOfDay(ms);
    if (at === today) return "Today";
    if (at === today - day) return "Yesterday";
    return new Date(ms).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  };

  const groups: Array<[string, Note[]]> = [];
  for (const note of notes) {
    const key = label(note.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === key) last[1].push(note);
    else groups.push([key, [note]]);
  }
  return groups;
}

/**
 * Where arrivals come from, on demand.
 *
 * Collapsed by default: the answer matters the first time and never again,
 * so it is a disclosure rather than a permanent paragraph taking up the top
 * of the list. Each line names its source and what it does with your data,
 * because "a note appeared on its own" is a sentence that deserves one.
 */
function ArrivalProvenance(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px]"
        style={{ color: C.blueS }}
        aria-expanded={open}
      >
        {open ? "Hide" : "Where these come from ›"}
      </button>
      {open ? (
        <ul
          className="mt-1 flex w-full basis-full flex-col gap-1 text-[11.5px]"
          style={{ color: C.t2 }}
        >
          <li>
            <strong style={{ color: C.t1 }}>Halo</strong> — what it caught,
            with the audio kept on your device.
          </li>
          <li>
            <strong style={{ color: C.t1 }}>Forwarded email</strong> — anything
            you send to your notes address.
          </li>
          <li>
            <strong style={{ color: C.t1 }}>Meeting capture</strong> — the
            recap from a meeting Cue sat in.
          </li>
          <li style={{ color: C.t3 }}>
            All three land as notes and obey acceptance exactly like something
            you typed. None of them files work on its own.
          </li>
        </ul>
      ) : null}
    </>
  );
}

function NoteList({
  notes,
  projectNames,
  onOpen,
}: {
  notes: Note[];
  /** id → name, so a card can name its room rather than say "filed". */
  projectNames: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const arrivals = notes.filter((note) => note.source === "arrival");
  const rest = notes.filter((note) => note.source !== "arrival");

  return (
    <>
      {arrivals.length > 0 ? (
        <section className="mb-4">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Inbox size={12} style={{ color: C.t3 }} />
            <p
              className="text-[10.5px] font-semibold tracking-wide uppercase"
              style={{ color: C.t3 }}
            >
              Came in · {arrivals.length}
            </p>
            {/* R3's "Where these come from ›". Notes that appear without you
                writing them need to say how they got there, in the product
                rather than in a help page — otherwise the honest question
                ("what is this and who put it here?") has nowhere to go. */}
            <ArrivalProvenance />
          </div>
          <ul className="flex flex-col gap-2">
            {arrivals.map((note) => (
              <li key={note.id}>
                <NoteCard
                  note={note}
                  projectName={
                    note.projectId
                      ? (projectNames.get(note.projectId) ?? null)
                      : null
                  }
                  onOpen={() => onOpen(note.id)}
                  onFile={() => onOpen(note.id)}
                />
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px]" style={{ color: C.t3 }}>
            Nothing here has been filed as work — same as anything you write
            yourself.
          </p>
        </section>
      ) : null}

      {/* N1 groups by the day the thought happened — TODAY, yesterday, then
          the date. Scanning "what was I thinking on Tuesday" is most of what
          this list is for, and a flat run of timestamps does not answer it. */}
      {groupByDay(rest).map(([label, group]) => (
        <section key={label} className="flex flex-col gap-2">
          <p
            className="mt-1 text-[10.5px] font-semibold tracking-wide uppercase"
            style={{ color: C.t3 }}
          >
            {label}
          </p>
          <ul className="flex flex-col gap-2">
            {group.map((note) => (
              <li key={note.id}>
                <NoteCard
                  note={note}
                  projectName={
                    note.projectId
                      ? (projectNames.get(note.projectId) ?? null)
                      : null
                  }
                  onOpen={() => onOpen(note.id)}
                  onFile={() => onOpen(note.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * We could not reach Cue, and this device holds no snapshot to fall back on.
 *
 * The one thing this must not do is render an empty list. "No notes yet" and
 * "I could not ask" look identical on screen and mean opposite things, and
 * the second one, shown as the first, tells someone their notes are gone.
 */
function Unreachable() {
  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      style={{ borderColor: C.line2, background: C.sunken }}
    >
      <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
        I couldn&rsquo;t reach your notes just now.
      </p>
      <p className="mt-0.5 text-[12px] leading-relaxed" style={{ color: C.t2 }}>
        This is about the connection, not about your notes — nothing has been
        lost. Anything you write now is saved on this device and syncs when Cue
        is back.
      </p>
    </div>
  );
}

/**
 * Offline.
 *
 * The sentence that matters comes first — **your note is saved** — because by
 * the time this renders it is, on this device, before anything touched the
 * network. Then what works and what waits, so nobody has to guess.
 *
 * Deliberately not a spinner, not a retry countdown, not an error. Nothing is
 * being attempted and nothing is at risk; the queue drains when the
 * connection returns.
 */
function OfflineBanner({ pending }: { pending: number }) {
  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border px-3 py-2"
      style={{ borderColor: C.line2, background: C.sunken }}
    >
      <Plane size={14} style={{ color: C.t3, marginTop: 2 }} />
      <div>
        <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
          Your notes are saved on this device.
        </p>
        <p
          className="mt-0.5 text-[12px] leading-relaxed"
          style={{ color: C.t2 }}
        >
          Writing, editing and reading everything already here all work.
          I&rsquo;ll look for things to do, and file anything to a project, when
          you&rsquo;re back online.
        </p>
        {pending > 0 ? (
          <p className="mt-1 text-[11.5px]" style={{ color: C.t3 }}>
            {pending} {pending === 1 ? "note" : "notes"} waiting to be read
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The honest consequence of "nothing files without you": unreviewed
 * proposals have to be visible somewhere, or requiring acceptance just means
 * findings rot quietly.
 */
function WaitingBanner({
  waiting,
  onReview,
}: {
  waiting: number;
  onReview: () => void;
}) {
  return (
    <div
      className="mb-3 flex items-center justify-between rounded-lg border px-3 py-2"
      style={{ borderColor: C.line2, background: C.sunken }}
    >
      <p className="text-[13px]" style={{ color: C.t1 }}>
        {waiting} {waiting === 1 ? "note has" : "notes have"} things I found
        that you haven&rsquo;t looked at
      </p>
      <button
        type="button"
        onClick={onReview}
        className="text-[13px] font-medium"
        style={{ color: C.blueS }}
      >
        Review them ›
      </button>
    </div>
  );
}

function EmptyState({
  filter,
  onStart,
}: {
  filter: NoteFilter;
  onStart: () => void;
}) {
  if (filter !== "all") {
    return (
      <p className="text-[13px]" style={{ color: C.t3 }}>
        Nothing here.
      </p>
    );
  }
  // One sentence, two buttons, no tour. The empty state's job is to be used,
  // not admired.
  return (
    <div className="max-w-md py-8">
      <p
        className="text-[20px] leading-snug"
        style={{ fontFamily: serif, color: C.t1 }}
      >
        Say the thing you&rsquo;d otherwise forget.
      </p>
      <p className="mt-2 text-[13px] leading-relaxed" style={{ color: C.t2 }}>
        Write it however it comes out. I&rsquo;ll pull out anything that needs
        doing and ask you before I file it.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="mt-4 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-white"
        style={{ background: C.blueS }}
      >
        <PenLine size={13} />
        Write one
      </button>
    </div>
  );
}

/** `1:04` from a duration in ms — the shape N1 prints beside a recording. */
function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * What the note produced — N1's `✓ 3 tasks · 2 memories · 1 waiting`.
 *
 * Nothing is drawn when a note has produced nothing, which is the common and
 * legitimate case: "a note is allowed to just be a note" (N2·2), and a row of
 * zeroes would read as failure. `waiting` is the one item that gets emphasis,
 * because it is the only one asking for something.
 */
function Produced({ produced }: { produced: NoteProduced }): React.ReactElement | null {
  const parts: string[] = [];
  if (produced.tasks > 0)
    parts.push(`${produced.tasks} ${produced.tasks === 1 ? "task" : "tasks"}`);
  if (produced.memories > 0)
    parts.push(
      `${produced.memories} ${produced.memories === 1 ? "memory" : "memories"}`,
    );
  if (produced.traits > 0)
    parts.push(`${produced.traits} about people`);

  if (parts.length === 0 && produced.waiting === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px]">
      {parts.length > 0 ? (
        <span style={{ color: C.t2 }}>
          <Check size={11} className="mr-0.5 inline align-[-1px]" aria-hidden />
          {parts.join(" · ")}
        </span>
      ) : null}
      {produced.waiting > 0 ? (
        <span style={{ color: C.amberText }}>
          {parts.length > 0 ? "· " : ""}
          {produced.waiting} waiting
        </span>
      ) : null}
    </div>
  );
}

/** How a note got here, in the words N1 puts on the card. */
const SOURCE_BADGE: Partial<Record<Note["source"], string>> = {
  selection: "from ⌥C",
  voice: "spoken",
  arrival: "arrived",
  import: "imported",
};

/**
 * One note in the list.
 *
 * N1 asks the card to answer three things at a glance: when the thought
 * happened, where it is filed, and **what it produced** — that last one is the
 * card-level version of the header's whole argument, and a card without it is
 * a filename. Unfiled notes carry `File it ›` rather than being nagged: filing
 * is optional forever, so it is an offer, not a chore badge.
 */
function NoteCard({
  note,
  projectName,
  onOpen,
  onFile,
}: {
  note: Note;
  projectName: string | null;
  onOpen: () => void;
  onFile?: () => void;
}) {
  const preview = note.body.split("\n").slice(1).join(" ").trim();
  const badge = SOURCE_BADGE[note.source];
  return (
    <div
      className="w-full rounded-lg border px-3 py-2.5 text-left"
      style={{ borderColor: C.line, background: C.card }}
    >
      <button type="button" onClick={onOpen} className="w-full text-left">
        <div className="flex items-baseline gap-2">
          {note.audioPath ? (
            <Mic size={12} style={{ color: C.t3 }} />
          ) : (
            <PenLine size={12} style={{ color: C.t3 }} />
          )}
          <span className="text-[11px]" style={{ color: C.t3 }}>
            {projectName ?? (note.projectId ? "filed" : "unfiled")}
            {" · "}
            {new Date(note.occurredAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
            {note.audioPath && note.audioDurationMs
              ? ` · ${clock(note.audioDurationMs)} kept`
              : ""}
            {badge ? ` · ${badge}` : ""}
          </span>
        </div>
        <p className="mt-1 text-[14px] font-medium" style={{ color: C.t1 }}>
          {note.title}
        </p>
        {preview ? (
          <p className="mt-0.5 line-clamp-2 text-[13px]" style={{ color: C.t2 }}>
            {preview}
          </p>
        ) : null}
        {note.produced ? <Produced produced={note.produced} /> : null}
      </button>
      {!note.projectId && onFile ? (
        <button
          type="button"
          onClick={onFile}
          className="mt-1.5 text-[11.5px] font-medium"
          style={{ color: C.blueS }}
        >
          File it ›
        </button>
      ) : null}
    </div>
  );
}

/**
 * One note, open.
 *
 * Cue never edits this text. There is deliberately no ✧ button in the editor
 * inviting a rewrite — an assistant that quietly rewrites what you typed makes
 * the note untrustworthy as a record of what you actually thought, which is
 * the only reason to keep notes at all. (The tidy-with-a-diff lives in `⋯`,
 * and is not built yet.)
 */
function NoteView({
  assistantId,
  noteId,
  onClose,
}: {
  assistantId: string;
  noteId: string;
  onClose: () => void;
}) {
  const detail = useNote(assistantId, noteId);
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const readNote = useReadNote();

  const [body, setBody] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);
  const bodyRef = useRef<string | null>(null);
  const loaded = detail.data?.note;

  useEffect(() => {
    if (loaded && body === null) {
      setBody(loaded.body);
      bodyRef.current = loaded.body;
    }
  }, [loaded, body]);

  const close = useCallback(async () => {
    const current = bodyRef.current;
    // Save first, then read. The note existing is not conditional on anything
    // — reading is a separate, later, cancellable concern.
    if (current !== null && current !== loaded?.body) {
      await updateNote.mutateAsync({
        path: { assistant_id: assistantId, id: noteId },
        body: { body: current },
      });
    }
    // Read on close. Unchanged text returns `skipped` and costs nothing, so
    // this is safe to call every time rather than guarded by a dirty flag.
    void readNote.mutateAsync({
      path: { assistant_id: assistantId, id: noteId },
      body: {},
    });
    onClose();
  }, [assistantId, noteId, loaded?.body, onClose, readNote, updateNote]);

  if (!loaded) {
    // The same rule the list obeys, which this view was quietly breaking: a
    // request that FAILED must never render as one still in flight. `loaded`
    // is only ever `data?.note`, so before this every error — and every
    // never-asked query, which reports `isPending` for ever — drew "Loading…"
    // with no bound and no way out. Manav hit exactly that opening a note.
    const stillWorking = detail.isPending && detail.fetchStatus !== "idle";
    if (stillWorking) {
      return (
        <p className="text-[13px]" style={{ color: C.t3 }}>
          Loading…
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <div
          className="rounded-lg border px-3 py-2.5"
          style={{ borderColor: C.line2, background: C.sunken }}
        >
          <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
            I couldn&rsquo;t open this note just now.
          </p>
          <p
            className="mt-0.5 text-[12px] leading-relaxed"
            style={{ color: C.t2 }}
          >
            This is about the connection, not about the note — nothing has been
            lost, and it is still here.
          </p>
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              onClick={() => detail.refetch()}
              className="text-[11.5px] font-medium"
              style={{ color: C.blueS }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-[11.5px] font-medium"
              style={{ color: C.t3 }}
            >
              Back to notes
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => void close()}
          className="flex items-center gap-1.5 text-[13px]"
          style={{ color: C.t2 }}
        >
          <ArrowLeft size={14} />
          Notes
        </button>
        <div className="flex items-center gap-3">
          {/* The tidy lives HERE, not as a ✧ in the editor. A button that
              offers to rewrite your words every time you glance at them is an
              assistant with an opinion about your writing. */}
          <button
            type="button"
            onClick={() => setTidying((v) => !v)}
            className="flex items-center gap-1.5 text-[12px]"
            style={{ color: C.t3 }}
            title="Show me a tidied version. Nothing changes until you choose."
          >
            <Sparkles size={13} />
            Tidy this up
          </button>
          <button
            type="button"
            onClick={async () => {
              await deleteNote.mutateAsync({
                path: { assistant_id: assistantId, id: noteId },
              });
              onClose();
            }}
            className="flex items-center gap-1.5 text-[12px]"
            style={{ color: C.t3 }}
            // Deleting a note never deletes the work it produced. The task
            // keeps pointing back at it and says so.
            title="Deletes the note. Anything you accepted from it stays in HQ."
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>
      </div>

      {tidying ? (
        <div className="mb-3">
          <NoteTidySheet
            assistantId={assistantId}
            noteId={noteId}
            onClose={() => setTidying(false)}
          />
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[1fr_280px]">
        <textarea
          value={body ?? ""}
          onChange={(e) => {
            setBody(e.target.value);
            bodyRef.current = e.target.value;
          }}
          placeholder="Write it however it comes out."
          className="min-h-0 w-full resize-none rounded-lg border p-3 text-[14px] leading-relaxed outline-none"
          style={{
            borderColor: C.line,
            background: C.card,
            color: C.t1,
          }}
          autoFocus
        />

        <div className="min-h-0 overflow-y-auto">
          <NoteRail
            assistantId={assistantId}
            noteId={noteId}
            extractionState={loaded.extractionState}
            extractions={detail.data?.extractions ?? []}
          />
          {loaded.bodyIsSummary && !loaded.audioPath && !loaded.transcript ? (
            // Any AI-written prose in a note says so. Prose that is not
            // labelled a summary reads as a quote. A recorded note says it in
            // the recording panel instead, beside the source it can be
            // checked against.
            <p className="mt-2 text-[11.5px]" style={{ color: C.t3 }}>
              I wrote that summary — the original is the source.
            </p>
          ) : null}
          {loaded.source === "arrival" ? (
            <p className="mt-2 text-[11.5px]" style={{ color: C.t3 }}>
              Came in from {loaded.sourceDetail ?? "elsewhere"}
              {loaded.audioPath ? " · audio on this device" : ""}
            </p>
          ) : null}

          {loaded.audioPath || loaded.transcript ? (
            <div className="mt-2">
              <NoteRecordingPanel assistantId={assistantId} note={loaded} />
            </div>
          ) : null}

          <NoteCreateOptions assistantId={assistantId} noteId={noteId} />
        </div>
      </div>
    </div>
  );
}
