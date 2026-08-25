/**
 * The rail beside a note — what Cue found, and the four states it can be in.
 *
 * Nothing here files anything. Every card is a proposal, and the only way one
 * becomes a task or a memory is the owner pressing Accept. That is the rule
 * the whole feature rests on, and the rail is where a person can see it being
 * kept: a card that has not been accepted has produced nothing.
 *
 * ## The four states, and why they are four separate branches
 *
 *   1. **reading** — "Reading what you wrote…". Never blocks the editor.
 *   2. **done, nothing found** — "Nothing to file here — this reads like
 *      thinking, not commitments." The COMMON case, and it must not read as
 *      failure. No empty headings, no "0 tasks found".
 *   3. **failed** — "I couldn't read this one just now — your note is saved."
 *   4. **all decided** — collapses to one line. The rail has done its job and
 *      should stop occupying a third of the note.
 *
 * 2 and 3 are separate by rule: one is about the note, the other about the
 * request. They are written as distinct branches rather than one branch with
 * a flag precisely because the shared-component version is what ships the day
 * someone's writing looks like it might be gone.
 *
 * ## Confidence is drawn, not printed
 *
 * A confident proposal is a solid card with a pre-ticked box. An unsure one
 * is dashed, hollow, carries its reason in plain words, and needs an explicit
 * Add. There is no percentage anywhere, and no number on the wire to render
 * one from — "82% sure" is a fact about the model, not about your work.
 */

import { useState, type CSSProperties } from "react";

import { AlertTriangle, Check, Loader2 } from "lucide-react";

import type {
  NoteConflictResolution,
  NoteExtraction,
  NoteExtractionState,
} from "@/types/notes";

import {
  useAcceptExtraction,
  useDismissExtraction,
  useReadNote,
  useUndoExtraction,
} from "./use-notes";

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  greenW: "var(--mv1-green-wash)",
  amber: "var(--mv1-amber)",
  amberText: "var(--mv1-amber-text)",
  blueS: "var(--mv1-blue-strong)",
} as const;

const KIND_LABEL: Record<NoteExtraction["kind"], string> = {
  task: "task",
  memory: "memory",
  person_trait: "about a person",
};

export interface NoteRailProps {
  assistantId: string;
  noteId: string;
  extractionState: NoteExtractionState;
  extractions: NoteExtraction[];
}

export function NoteRail({
  assistantId,
  noteId,
  extractionState,
  extractions,
}: NoteRailProps) {
  const readNote = useReadNote();
  const proposals = extractions.filter((e) => e.state === "proposed");
  const accepted = extractions.filter((e) => e.state === "accepted");

  // State 1 — still reading. Appears for a beat on close, or when asked.
  if (extractionState === "reading" || readNote.isPending) {
    return (
      <RailFrame>
        <div
          className="flex items-center gap-2 text-[13px]"
          style={{ color: C.t2 }}
        >
          <Loader2 size={13} className="animate-spin" />
          Reading what you wrote…
        </div>
      </RailFrame>
    );
  }

  // State 3 — the REQUEST failed. Says so, and says the note survived.
  // Deliberately not merged with state 2 below: "couldn't read" and "nothing
  // to file" are different sentences about different things.
  if (extractionState === "failed") {
    return (
      <RailFrame>
        <p className="text-[13px] leading-relaxed" style={{ color: C.t1 }}>
          I couldn&rsquo;t read this one just now —{" "}
          <strong style={{ fontWeight: 600 }}>your note is saved.</strong>
        </p>
        <button
          type="button"
          className="mt-2 text-[13px] font-medium"
          style={{ color: C.blueS }}
          onClick={() => {
            void readNote.mutateAsync({
              path: { assistant_id: assistantId, id: noteId },
              body: { force: true },
            });
          }}
        >
          Try again ›
        </button>
      </RailFrame>
    );
  }

  // State 4 — everything decided. One line: the rail has done its job.
  if (proposals.length === 0 && accepted.length > 0) {
    return (
      <RailFrame>
        <AcceptedSummary
          assistantId={assistantId}
          noteId={noteId}
          accepted={accepted}
        />
      </RailFrame>
    );
  }

  // State 2 — a real, successful read that found nothing. The common case.
  // A note is allowed to just be a note, so this says so plainly instead of
  // rendering an empty heading or a "0 tasks found" tally.
  if (proposals.length === 0) {
    if (extractionState === "idle") {
      return (
        <RailFrame>
          <p className="text-[13px] leading-relaxed" style={{ color: C.t3 }}>
            I&rsquo;ll look for things to do when you close this.
          </p>
          <button
            type="button"
            className="mt-2 text-[13px] font-medium"
            style={{ color: C.blueS }}
            onClick={() => {
              void readNote.mutateAsync({
                path: { assistant_id: assistantId, id: noteId },
                body: { force: true },
              });
            }}
          >
            Find things to do now ›
          </button>
        </RailFrame>
      );
    }
    return (
      <RailFrame>
        <p className="text-[13px] leading-relaxed" style={{ color: C.t2 }}>
          Nothing to file here — this reads like thinking, not commitments.
        </p>
      </RailFrame>
    );
  }

  return (
    <RailFrame>
      <div className="flex flex-col gap-5">
        {groupProposals(proposals).map(({ label, items }) => (
          <div key={label}>
            <p
              className="mb-2 text-[11px] font-semibold tracking-wider uppercase"
              style={{ color: C.t3 }}
            >
              {items.length} {label}
            </p>
            <div className="flex flex-col gap-2">
              {items.map((extraction) => (
                <ProposalCard
                  key={extraction.id}
                  assistantId={assistantId}
                  noteId={noteId}
                  extraction={extraction}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px]" style={{ color: C.t3 }}>
        Nothing is filed until you say so.
      </p>
    </RailFrame>
  );
}

/**
 * The three kinds, grouped and in a fixed order — design `1a`.
 *
 * **Grouped because they are answered differently.** A task is something you
 * will do, a fact is something Cue will remember, and a person note changes
 * how it talks about somebody. Read as one undifferentiated list they all
 * look like the same small decision, and the person notes — the ones with the
 * longest reach — are the easiest to wave through.
 *
 * The order is fixed rather than by count, so the rail does not rearrange
 * itself between two readings of the same note.
 */
const PROPOSAL_GROUPS = [
  { kind: "task", one: "thing", many: "things" },
  { kind: "memory", one: "fact", many: "facts" },
  { kind: "person_trait", one: "person", many: "people" },
] as const;

export function groupProposals(
  proposals: NoteExtraction[],
): Array<{ label: string; items: NoteExtraction[] }> {
  const groups: Array<{ label: string; items: NoteExtraction[] }> = [];
  const placed = new Set<string>();
  for (const { kind, one, many } of PROPOSAL_GROUPS) {
    const items = proposals.filter((p) => p.kind === kind);
    for (const item of items) placed.add(item.id);
    if (items.length === 0) continue;
    groups.push({ label: items.length === 1 ? one : many, items });
  }
  // A kind nobody has taught this list about still has to reach the owner: an
  // extraction that renders nowhere is a proposal that files itself by never
  // being refused.
  const rest = proposals.filter((p) => !placed.has(p.id));
  if (rest.length > 0) {
    groups.push({ label: rest.length === 1 ? "thing" : "things", items: rest });
  }
  return groups;
}

/**
 * What the rail says once everything is decided — and the Undo beside it.
 *
 * **Undo sits next to the claim, not in a toast that expires.** The whole
 * reason it exists is to make pressing Accept a decision you do not have to
 * be sure about, and a control that vanishes after four seconds does not do
 * that.
 *
 * It is a reversal rather than a delete, so it can refuse: once Cue has
 * started the task, taking it back would destroy work instead of undoing a
 * click. When it refuses it says why, in the same place — a refusal someone
 * can understand beats an undo that quietly does the wrong thing.
 */
function AcceptedSummary({
  assistantId,
  noteId,
  accepted,
}: {
  assistantId: string;
  noteId: string;
  accepted: NoteExtraction[];
}) {
  const undo = useUndoExtraction();
  const [refusal, setRefusal] = useState<string | null>(null);

  const undoAll = async () => {
    setRefusal(null);
    for (const extraction of accepted) {
      const result = await undo.mutateAsync({
        path: {
          assistant_id: assistantId,
          id: noteId,
          extractionId: extraction.id,
        },
      });
      if (result.status === "too_late" && result.reason) {
        setRefusal(result.reason);
        return;
      }
    }
  };

  return (
    <>
      <div className="flex items-start gap-2">
        <Check size={14} style={{ color: C.green, marginTop: 2 }} />
        <div>
          <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
            Filed {summarise(accepted)}
          </p>
          <p className="mt-0.5 text-[12px]" style={{ color: C.t3 }}>
            In HQ now. This note stays the source.
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={undo.isPending}
        onClick={() => void undoAll()}
        className="mt-2 text-[12px] font-medium"
        style={{ color: C.blueS }}
      >
        Undo
      </button>
      {refusal ? (
        <p className="mt-1.5 text-[11.5px]" style={{ color: C.amberText }}>
          {refusal}
        </p>
      ) : null}
    </>
  );
}

function RailFrame({ children }: { children: React.ReactNode }) {
  return (
    <aside
      className="rounded-lg border p-3"
      style={{ borderColor: C.line, background: C.card }}
      aria-label="What Cue found in this note"
    >
      {children}
    </aside>
  );
}

/** "3 tasks · 2 memories" — counted, never estimated. */
function summarise(accepted: NoteExtraction[]): string {
  const counts = new Map<string, number>();
  for (const item of accepted) {
    const label =
      item.kind === "task"
        ? "task"
        : item.kind === "memory"
          ? "memory"
          : "note about a person";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, n]) => `${n} ${n === 1 ? label : plural(label)}`)
    .join(" · ");
}

function plural(label: string): string {
  if (label === "memory") return "memories";
  if (label === "note about a person") return "notes about people";
  return `${label}s`;
}

/**
 * One proposal.
 *
 * The confident and unsure tiers differ in border, in the box glyph, in
 * whether a reason is shown, and in the verb on the button — four signals
 * carrying one distinction, none of them a number.
 */
function ProposalCard({
  assistantId,
  noteId,
  extraction,
}: {
  assistantId: string;
  noteId: string;
  extraction: NoteExtraction;
}) {
  const accept = useAcceptExtraction();
  const dismiss = useDismissExtraction();
  const [error, setError] = useState<string | null>(null);
  const confident = extraction.confidenceTier === "confident";

  const style: CSSProperties = {
    borderColor: confident ? C.line2 : C.line,
    borderStyle: confident ? "solid" : "dashed",
    background: confident ? C.card : "transparent",
  };

  const onAccept = async (resolution?: NoteConflictResolution) => {
    setError(null);
    const result = await accept.mutateAsync({
      path: {
        assistant_id: assistantId,
        id: noteId,
        extractionId: extraction.id,
      },
      body: resolution ? { resolution } : {},
    });
    // A failed write leaves the proposal proposed. Saying so is the whole
    // point — a rail that claims "Filed" for something that did not land is
    // worse than one that admits it could not.
    if (result.status === "failed") {
      setError("That didn't file. Nothing was changed — try again?");
    }
  };

  return (
    <div className="rounded-lg border p-2.5" style={style}>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-0.5 flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border"
          style={{
            borderColor: confident ? C.green : C.line2,
            background: confident ? C.greenW : "transparent",
            borderRadius: confident ? 4 : 999,
          }}
        >
          {confident ? <Check size={11} style={{ color: C.green }} /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug" style={{ color: C.t1 }}>
            {extraction.payload.title ?? extraction.payload.detail}
          </p>
          <p className="mt-0.5 text-[11px]" style={{ color: C.t3 }}>
            {KIND_LABEL[extraction.kind]}
            {extraction.payload.dueAt
              ? ` · by ${new Date(extraction.payload.dueAt).toLocaleDateString(undefined, { weekday: "long" })}`
              : ""}
          </p>
          {/* The unsure tier explains itself in the owner's own words. That
              explanation is what earns it a place on screen at all. */}
          {!confident && extraction.reason ? (
            <p className="mt-1 text-[11.5px] italic" style={{ color: C.t2 }}>
              {extraction.reason}
            </p>
          ) : null}
        </div>
      </div>

      {extraction.conflict ? (
        <ConflictCard
          conflict={extraction.conflict}
          onResolve={(resolution) => void onAccept(resolution)}
          pending={accept.isPending}
        />
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={accept.isPending}
            onClick={() => void onAccept()}
            className="rounded-full px-2.5 py-1 text-[12px] font-medium"
            style={{
              background: confident ? C.green : "transparent",
              color: confident ? "#ffffff" : C.blueS,
              border: confident ? "none" : `1px solid ${C.line2}`,
            }}
          >
            {confident ? "Accept" : "Add"}
          </button>
          <button
            type="button"
            disabled={dismiss.isPending}
            onClick={() => {
              void dismiss.mutateAsync({
                path: {
                  assistant_id: assistantId,
                  id: noteId,
                  extractionId: extraction.id,
                },
              });
            }}
            className="text-[12px]"
            style={{ color: C.t3 }}
          >
            Not this
          </button>
        </div>
      )}

      {error ? (
        <p className="mt-2 text-[11.5px]" style={{ color: C.amberText }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * N4 — this proposal disagrees with something Cue already believes.
 *
 * Both values render WITH where each came from, because a value without a
 * source is an assertion rather than evidence. And there are **three**
 * answers, never two: a two-button version forces a false choice between the
 * old truth and the new one, when the honest answer for a price or a date
 * that legitimately changed is usually "keep both".
 */
function ConflictCard({
  conflict,
  onResolve,
  pending,
}: {
  conflict: NonNullable<NoteExtraction["conflict"]>;
  onResolve: (resolution: NoteConflictResolution) => void;
  pending: boolean;
}) {
  return (
    <div
      className="mt-2 rounded-lg border p-2.5"
      style={{ borderColor: C.amber, background: C.sunken }}
    >
      <div className="flex items-center gap-1.5">
        <AlertTriangle size={12} style={{ color: C.amberText }} />
        <p
          className="text-[11px] font-semibold tracking-wide uppercase"
          style={{ color: C.amberText }}
        >
          This disagrees with what I knew
        </p>
      </div>

      <div className="mt-2 grid gap-2 text-[12px]" style={{ color: C.t1 }}>
        <div>
          <p className="text-[10.5px] uppercase" style={{ color: C.t3 }}>
            I had
          </p>
          <p className="leading-snug">{conflict.existing}</p>
          <p className="text-[11px]" style={{ color: C.t3 }}>
            {conflict.existingSource}
            {conflict.existingAt
              ? ` · ${new Date(conflict.existingAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <div>
          <p className="text-[10.5px] uppercase" style={{ color: C.t3 }}>
            This note says
          </p>
          <p className="leading-snug">{conflict.incoming}</p>
          <p className="text-[11px]" style={{ color: C.t3 }}>
            {conflict.incomingSource}
            {conflict.incomingAt
              ? ` · ${new Date(conflict.incomingAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : ""}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {/* Keep both leads, and is the default answer: it is the only one of
            the three that loses nothing. */}
        <button
          type="button"
          disabled={pending}
          onClick={() => onResolve("keep_both")}
          className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
          style={{ background: C.green }}
        >
          Keep both
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onResolve("replace")}
          className="rounded-full border px-2.5 py-1 text-[12px]"
          style={{ borderColor: C.line2, color: C.t1 }}
        >
          Replace it
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onResolve("ignore")}
          className="text-[12px]"
          style={{ color: C.t3 }}
        >
          Ignore
        </button>
      </div>
    </div>
  );
}
