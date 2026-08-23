/**
 * Notes on the phone (N5).
 *
 * ## No rail
 *
 * The desktop puts what Cue found in a side rail. A phone has no side, and
 * more importantly it has a keyboard that eats the bottom half of the screen —
 * so the found-things card sits **below the note, in flow**, where it never
 * competes with what the owner is typing. It scrolls into view when they stop.
 *
 * ## One Accept for the set
 *
 * Deciding four proposals with four taps on a phone is four chances to get it
 * wrong with a thumb. So there is one Accept for everything found, and
 * tapping a row drops it from the set first. The rule underneath is unchanged
 * and unchangeable: **nothing is filed until that button is pressed.**
 *
 * ## Reached from the ⓶ menu
 *
 * Notes has no tab. The phone's three slots are full and the mark has to stay
 * centred, so Notes is a drawer row — see `MOBILE_DRAWER_DESTINATION_KEYS`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ArrowLeft, Check, PenLine } from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useCreateNote, useUpdateNote } from "@/hooks/use-note-capture";
import { GlassCard } from "@/mobile-v3/glass-card";
import { LargeTitleHeader } from "@/mobile-v3/large-title-header";
import type { Note, NoteExtraction } from "@/types/notes";
import { haptic } from "@/utils/haptics";

import {
  useAcceptExtraction,
  useDismissExtraction,
  useNote,
  useNotes,
  useReadNote,
} from "@/domains/notes/use-notes";

export function Mv3NotesPage() {
  const assistantId = useActiveAssistantId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useNotes(assistantId);
  const createNote = useCreateNote();

  const start = useCallback(async () => {
    haptic.light();
    const created = await createNote.mutateAsync({
      path: { assistant_id: assistantId },
      body: { body: "" },
    });
    setOpenId(created.note.id);
  }, [assistantId, createNote]);

  if (openId) {
    return (
      <Mv3NoteView
        assistantId={assistantId}
        noteId={openId}
        onClose={() => setOpenId(null)}
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      style={{ height: "100%", overflowY: "auto", padding: "0 16px 24px" }}
    >
      <LargeTitleHeader title="Notes" scrollRef={scrollRef} />

      <button
        type="button"
        onClick={() => void start()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minHeight: 44,
          marginBottom: 12,
          padding: "12px 14px",
          borderRadius: 18,
          border: "1px solid var(--mv3-line)",
          background: "transparent",
          color: "var(--mv3-muted)",
          fontSize: 14,
          textAlign: "left",
        }}
      >
        <PenLine size={15} aria-hidden />
        Say the thing you&rsquo;d otherwise forget
      </button>

      {list.status === "loading" ? (
        <p style={{ fontSize: 13, color: "var(--mv3-muted)" }}>Loading…</p>
      ) : list.status === "unreachable" ? (
        // Never the empty state. "No notes yet" and "I couldn't ask" look
        // identical and mean opposite things.
        <GlassCard radius={18} padding="13px 15px">
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            I couldn&rsquo;t reach your notes just now.
          </div>
          <div
            style={{ marginTop: 4, fontSize: 12, color: "var(--mv3-muted)" }}
          >
            This is about the connection, not your notes — nothing is lost.
          </div>
        </GlassCard>
      ) : list.notes.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--mv3-muted)" }}>
          Nothing yet. Write it however it comes out — I&rsquo;ll pull out
          anything that needs doing and ask you before I file it.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.notes.map((note: Note) => (
            <button
              key={note.id}
              type="button"
              onClick={() => {
                haptic.light();
                setOpenId(note.id);
              }}
              style={{
                textAlign: "left",
                border: "none",
                background: "transparent",
                padding: 0,
              }}
            >
              <GlassCard radius={18} padding="13px 15px">
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--mv3-muted)",
                    textTransform: "uppercase",
                  }}
                >
                  {note.projectId ? "filed" : "unfiled"} ·{" "}
                  {new Date(note.occurredAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </div>
                <div style={{ marginTop: 3, fontSize: 14, fontWeight: 600 }}>
                  {note.title}
                </div>
              </GlassCard>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Mv3NoteView({
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
  const readNote = useReadNote();
  const [body, setBody] = useState<string | null>(null);
  const bodyRef = useRef<string | null>(null);

  const loaded = detail.data?.note;

  // Seed the editor once the note arrives. In an effect rather than during
  // render: writing a ref while rendering is a tearing hazard under
  // concurrent React, and the lint rule that caught it is right.
  useEffect(() => {
    if (loaded && body === null) {
      setBody(loaded.body);
      bodyRef.current = loaded.body;
    }
  }, [loaded, body]);

  const close = useCallback(async () => {
    const current = bodyRef.current;
    if (current !== null && current !== loaded?.body) {
      await updateNote.mutateAsync({
        path: { assistant_id: assistantId, id: noteId },
        body: { body: current },
      });
    }
    // Read on close, never on a timer. Unchanged text costs nothing.
    void readNote.mutateAsync({
      path: { assistant_id: assistantId, id: noteId },
      body: {},
    });
    onClose();
  }, [assistantId, loaded?.body, noteId, onClose, readNote, updateNote]);

  const proposals = (detail.data?.extractions ?? []).filter(
    (e: NoteExtraction) => e.state === "proposed",
  );

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "0 16px 24px" }}>
      <button
        type="button"
        onClick={() => void close()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minHeight: 44,
          border: "none",
          background: "transparent",
          color: "var(--mv3-muted)",
          fontSize: 14,
          padding: 0,
        }}
      >
        <ArrowLeft size={16} aria-hidden />
        Notes
      </button>

      <textarea
        value={body ?? ""}
        onChange={(e) => {
          setBody(e.target.value);
          bodyRef.current = e.target.value;
        }}
        placeholder="Write it however it comes out."
        rows={10}
        autoFocus
        style={{
          width: "100%",
          marginTop: 8,
          padding: "12px 14px",
          borderRadius: 18,
          border: "1px solid var(--mv3-line)",
          background: "var(--mv3-card, transparent)",
          fontSize: 15,
          lineHeight: 1.5,
          resize: "none",
          outline: "none",
        }}
      />

      {/* Below the note, in flow — never a rail, never over the keyboard. */}
      {proposals.length > 0 ? (
        <FoundThings
          assistantId={assistantId}
          noteId={noteId}
          proposals={proposals}
        />
      ) : null}
    </div>
  );
}

/**
 * One Accept for the set; tap a row to drop it first.
 *
 * Four proposals decided with four taps is four chances for a thumb to get it
 * wrong. The rule underneath does not move: nothing is filed until Accept is
 * pressed, and a dropped row is dismissed rather than quietly ignored.
 */
function FoundThings({
  assistantId,
  noteId,
  proposals,
}: {
  assistantId: string;
  noteId: string;
  proposals: NoteExtraction[];
}) {
  const accept = useAcceptExtraction();
  const dismiss = useDismissExtraction();
  const [dropped, setDropped] = useState<Set<string>>(new Set());

  const keep = proposals.filter((p) => !dropped.has(p.id));

  const acceptSet = useCallback(async () => {
    haptic.light();
    for (const proposal of keep) {
      await accept.mutateAsync({
        path: {
          assistant_id: assistantId,
          id: noteId,
          extractionId: proposal.id,
        },
        body: {},
      });
    }
    // A dropped row is a decision too — recorded as dismissed, so accept rate
    // counts it and the rail does not offer it again.
    for (const proposal of proposals.filter((p) => dropped.has(p.id))) {
      await dismiss.mutateAsync({
        path: {
          assistant_id: assistantId,
          id: noteId,
          extractionId: proposal.id,
        },
      });
    }
  }, [accept, assistantId, dismiss, dropped, keep, noteId, proposals]);

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 7,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: "var(--mv3-muted)",
          }}
        >
          Found {keep.length} {keep.length === 1 ? "thing" : "things"}
        </span>
        <button
          type="button"
          disabled={keep.length === 0 || accept.isPending}
          onClick={() => void acceptSet()}
          style={{
            minHeight: 32,
            padding: "6px 14px",
            borderRadius: 999,
            border: "none",
            background: "var(--mv3-accent, #2b53c4)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Accept
        </button>
      </div>

      <GlassCard radius={18} padding="4px 0">
        {proposals.map((proposal) => {
          const isDropped = dropped.has(proposal.id);
          return (
            <button
              key={proposal.id}
              type="button"
              onClick={() => {
                haptic.light();
                setDropped((prev) => {
                  const next = new Set(prev);
                  if (next.has(proposal.id)) next.delete(proposal.id);
                  else next.add(proposal.id);
                  return next;
                });
              }}
              style={{
                display: "flex",
                gap: 10,
                width: "100%",
                minHeight: 44,
                padding: "9px 15px",
                border: "none",
                background: "transparent",
                textAlign: "left",
                opacity: isDropped ? 0.4 : 1,
              }}
            >
              <span
                aria-hidden
                style={{
                  marginTop: 2,
                  color: isDropped
                    ? "var(--mv3-muted)"
                    : "var(--mv3-green, #277e41)",
                }}
              >
                {isDropped ? "○" : <Check size={13} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, lineHeight: 1.4 }}>
                  {String(proposal.payload.title ?? proposal.payload.detail)}
                </span>
                {proposal.confidenceTier === "unsure" && proposal.reason ? (
                  <span
                    style={{
                      display: "block",
                      marginTop: 2,
                      fontSize: 11,
                      fontStyle: "italic",
                      color: "var(--mv3-muted)",
                    }}
                  >
                    {proposal.reason}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </GlassCard>

      <p style={{ marginTop: 7, fontSize: 11, color: "var(--mv3-muted)" }}>
        Tap a row to drop it. Nothing is filed until you press Accept.
      </p>
    </div>
  );
}
