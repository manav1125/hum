import { useEffect, useRef, type CSSProperties } from "react";

/**
 * The note itself — design `1a`.
 *
 * **A writing surface, not a form.** The editor is the page: no box, no
 * border, no visible field. What is around it is the argument for the
 * feature — a meta line that says where this note already belongs, a rail
 * that says what it could become — and the writing sits in the middle of that
 * without being framed like data entry.
 *
 * Three things here are rules rather than decoration:
 *
 *   · **The title is serif and the body is not.** The title is the one line
 *     you scan a list by, and the serif is what makes a note read as
 *     something written rather than something logged. It is the same face HQ
 *     uses for the same reason.
 *   · **"Private · autosaved" is stated, not implied.** People do not write
 *     honestly in a box they are not sure about. It says both facts, every
 *     time, in the place your eye lands after the title.
 *   · **`Record instead` is an offer, not a mode switch.** It is in the
 *     footer beside the formatting hints — one of the ways to put something
 *     in, not a different application.
 */

/** The same face HQ uses. A note should read as written, not logged. */
const SERIF = "'Instrument Serif', Georgia, serif";
const MONO = "'DM Mono', ui-monospace, SFMono-Regular, monospace";

const C = {
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  line: "var(--mv1-line)",
  green: "var(--mv1-green)",
  greenWash: "var(--mv1-green-wash)",
  card: "var(--mv1-card)",
  lineStrong: "var(--mv1-line-strong)",
};

/**
 * `NOTE · TODAY 14:22` — when the thought happened, not when the row was
 * written. Today and yesterday are named rather than dated, because that is
 * how people refer to their own week.
 */
export function noteStamp(occurredAt: number, now: number = Date.now()): string {
  const at = new Date(occurredAt);
  const time = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round(
    (startOfDay(new Date(now)) - startOfDay(at)) / 86_400_000,
  );
  if (days === 0) return `TODAY ${time}`;
  if (days === 1) return `YESTERDAY ${time}`;
  return `${at
    .toLocaleDateString(undefined, { day: "numeric", month: "short" })
    .toUpperCase()} ${time}`;
}

export interface NoteEditorProps {
  title: string;
  body: string;
  occurredAt: number;
  /** The project this note already belongs to, if any. */
  projectName?: string | null;
  /** Saved-ness, said plainly. */
  saved: boolean;
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onRecordInstead: () => void;
}

export function NoteEditor({
  title,
  body,
  occurredAt,
  projectName,
  saved,
  onTitleChange,
  onBodyChange,
  onRecordInstead,
}: NoteEditorProps): React.ReactElement {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // The body grows with what is in it. A writing surface that scrolls inside
  // its own little window is a form again.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [body]);

  const bare: CSSProperties = {
    width: "100%",
    border: 0,
    outline: "none",
    background: "transparent",
    padding: 0,
    color: C.t1,
    resize: "none",
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            letterSpacing: ".09em",
            color: C.t3,
          }}
        >
          NOTE · {noteStamp(occurredAt)}
        </span>
        {projectName ? (
          <span
            data-note-project
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
            style={{
              background: C.greenWash,
              color: C.green,
              fontSize: 12.5,
              fontWeight: 500,
            }}
          >
            <span aria-hidden>▤</span>
            {projectName}
          </span>
        ) : null}
        <span className="flex-1" />
        {/* Both facts, every time. People do not write honestly in a box they
            are not sure about. */}
        <span style={{ fontSize: 13, color: C.t3 }}>
          Private · {saved ? "autosaved" : "saving…"}
        </span>
      </div>

      <input
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder="Untitled"
        aria-label="Note title"
        style={{
          ...bare,
          fontFamily: SERIF,
          fontSize: 40,
          lineHeight: 1.15,
          marginBottom: 18,
        }}
      />

      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Write it however it comes out."
        aria-label="Note"
        style={{
          ...bare,
          fontSize: 17,
          lineHeight: 1.75,
          minHeight: 220,
          overflow: "hidden",
        }}
        autoFocus
      />

      <div
        className="mt-6 flex flex-wrap items-center gap-3 pt-5"
        style={{ borderTop: `1px solid ${C.line}` }}
      >
        <span style={{ fontSize: 13.5, color: C.t3 }}>
          Type <b style={{ color: C.t2 }}>/</b> to format ·{" "}
          <b style={{ color: C.t2 }}>@</b> for a person ·{" "}
          <b style={{ color: C.t2 }}>▤</b> to attach
        </span>
        <span className="flex-1" />
        {/* An offer, not a mode switch — one of the ways to put something in. */}
        <button
          type="button"
          onClick={onRecordInstead}
          className="inline-flex items-center gap-2 rounded-full px-4 py-2.5"
          style={{
            background: C.card,
            border: `1px solid ${C.lineStrong}`,
            color: C.t1,
            fontSize: 13.5,
            fontWeight: 500,
          }}
        >
          <span aria-hidden>◎</span>
          Record instead
        </button>
      </div>
    </div>
  );
}
