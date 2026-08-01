/**
 * `<ProvenanceTrace/>` — the one-click answer to "why is this here, and what
 * did Cue do to it?"
 *
 * A quiet inline pill on a work row (origin in the user's words, carried by a
 * glyph as well as a tone) which opens a small panel listing everything
 * provenance can honestly say: where it came from, who sent it, whether Cue
 * filed it and how sure it was, and who actually ran it. When the item names
 * an originating conversation the panel offers a link to it — the id itself is
 * never shown.
 *
 * The words all come from `work-provenance.ts`; this file owns only the
 * pixels. Two rules survive the trip:
 *
 * · **Nothing to say → nothing rendered.** An item with no provenance returns
 *   an empty `lines` array and this component returns `null`. It never falls
 *   back to a guess, and it never renders an empty pill that opens an empty
 *   panel.
 * · **Colour is never the only carrier.** Every line leads with its glyph and
 *   states its meaning in words; the tone is an accelerant.
 *
 * Rows that own this pill are themselves clickable (the board card's `onOpen`,
 * the activity row), so every pointer and key event is stopped here — opening
 * the trace must never also open the task.
 */

import { useEffect, useId, useRef, useState } from "react";

import { C } from "@/domains/activity/theme";

import {
  describeProvenance,
  type ProvenanceFields,
  type ProvenanceLine,
  type ProvenanceTone,
} from "./work-provenance";

/** Tone → the palette's TEXT leg. These are small-copy sizes (11–12px), where
 *  the fill legs do not clear contrast (design addendum A1). */
const TONE_TEXT: Record<ProvenanceTone, string> = {
  blue: C.blueText,
  amber: C.amberText,
  green: C.greenText,
  violet: C.violetText,
  muted: C.t3,
};

function LineRow({ line }: { line: ProvenanceLine }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 7,
        fontSize: 12,
        lineHeight: 1.45,
        color: C.t2,
      }}
    >
      <span
        aria-hidden
        style={{
          color: TONE_TEXT[line.tone],
          flexShrink: 0,
          width: 12,
          textAlign: "center",
        }}
      >
        {line.glyph}
      </span>
      <span>{line.text}</span>
    </div>
  );
}

export function ProvenanceTrace({
  item,
  projectTitle,
  onOpenConversation,
  style,
}: {
  /** Any work-item record carrying the provenance columns. */
  item: ProvenanceFields | null | undefined;
  /** The filing destination in words. Never pass an id. */
  projectTitle?: string | null;
  /** Called with the originating conversation id when the user asks for it.
   *  Omitted → the link is not offered (no dead ends). */
  onOpenConversation?: (conversationId: string) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  // Dismiss on an outside click or Escape. Bound only while open so a list of
  // fifty rows carries no listeners at rest.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // THE rule: nothing known, nothing claimed. Computed before any early
  // return on state so the hook order is stable.
  const trace = item ? describeProvenance(item, projectTitle) : null;
  if (!trace || trace.lines.length === 0) return null;

  // The pill leads with the origin when there is one; otherwise the first
  // thing we can honestly say (a filing judgement, or the run).
  const lead = trace.origin ?? trace.lines[0]!;

  return (
    <span
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex", ...style }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Why is this here? ${trace.lines.map((l) => l.text).join(". ")}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontFamily: "inherit",
          fontSize: 11,
          color: TONE_TEXT[lead.tone],
          background: C.sunken,
          border: `1px solid ${C.line}`,
          borderRadius: 99,
          padding: "2px 8px",
          cursor: "pointer",
          whiteSpace: "nowrap",
          maxWidth: 220,
          overflow: "hidden",
          textOverflow: "ellipsis",
          flexShrink: 0,
        }}
      >
        <span aria-hidden>{lead.glyph}</span>
        <span
          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
          data-slot="provenance-lead"
        >
          {lead.short}
        </span>
      </button>

      {open ? (
        <span
          id={panelId}
          role="group"
          aria-label="Where this came from"
          data-slot="provenance-panel"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 40,
            minWidth: 240,
            maxWidth: 320,
            display: "flex",
            flexDirection: "column",
            gap: 7,
            padding: "11px 13px",
            borderRadius: 11,
            background: C.surface,
            border: `1px solid ${C.line2}`,
            boxShadow: "0 18px 40px -22px rgba(0,0,0,.45)",
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
          {trace.lines.map((line) => (
            <LineRow key={line.id} line={line} />
          ))}
          {trace.originConversationId && onOpenConversation ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onOpenConversation(trace.originConversationId!);
              }}
              style={{
                alignSelf: "flex-start",
                marginTop: 2,
                fontFamily: "inherit",
                fontSize: 11.5,
                color: C.blueText,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            >
              Open the conversation ›
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
