/**
 * The `⌗` row and its header count — the visible half of the un-comprehended
 * rule (v9 §Q3, frame N1). See `uncomprehended.ts` for why the state exists and
 * why `low_confidence` is the only verdict that earns it.
 *
 * Four decisions are load-bearing here and each one is a rule, not a taste:
 *
 * **The glyph carries the state, and nothing else does.** `⌗` is neutral — no
 * amber, no tint, no wash. Amber is already spoken for by `?` ("I don't know
 * where this goes") and `‖` ("waiting on you"), and lending this state a colour
 * it shares with either would re-create the exact confusion this frame exists
 * to end. The row therefore has no colour-only state to get wrong.
 *
 * **The subject is quoted and italic.** Everywhere else on this deck the title
 * is Cue's verb phrase — its reading of the message. Here there is no reading,
 * so the row shows the sender's own words and marks them as borrowed. Italic
 * inside typographic quotes is the signal: *their words, not my summary.*
 *
 * **`Open it` is the only action, and it opens the message — not a task page.**
 * The item deliberately does not exist in the task list, so routing "Open" at
 * the task list would send the user to a surface the item is absent from. It
 * expands in place instead and shows what actually arrived: who sent it, when,
 * through which watcher, and the snippet verbatim. That is the entire honest
 * content of "open it" for something Cue cannot describe.
 *
 * **The `⋯` offers only verbs that do something.** `work-verbs.tsx` renders
 * exactly the verbs it is handed, for the reason stated there: an inert button
 * teaches the wrong shortcut. `approve` has nothing to approve on an item with
 * no proposal, and `later` and `hand_off` have no mutation behind them anywhere
 * in this app yet — so they are omitted rather than stubbed. `open` is omitted
 * for the opposite reason: it is already the button on the row, and a second
 * rendering of the same action is what the six-element cap exists to stop.
 * File, Archive and Done-elsewhere are what the caller supplies.
 */

import { useState, type ReactNode } from "react";

import { C, mono } from "./hq-kit";
import type { UnreadableArrival } from "./uncomprehended";
import { unreadableLabel } from "./uncomprehended";
import { WorkVerbBar, type WorkVerbHandlers } from "./work-verbs";
import type { WorkVerbId } from "./work-vocabulary";

/** The glyph, in one place. `?` is filing confidence and `‖` is needs-you. */
export const UNREADABLE_GLYPH = "⌗";

/** Cue's one honest line. Not configurable — a variant would be a hedge. */
export const UNREADABLE_LINE = "I couldn't tell what this needs.";

/**
 * The header count — "2 I couldn't read", beside the filed/dropped numbers and
 * never merged into them. One is a claim about the mail; this is a claim about
 * Cue, and the comprehension failure rate is only watchable while it has its
 * own slot.
 *
 * Renders nothing at zero. The glyph rides along so the count is legible in a
 * screenshot and to a reader who cannot see the row it refers to.
 */
export function UnreadableCount({ count }: { count: number }): ReactNode {
  const label = unreadableLabel(count);
  if (!label) return null;
  return (
    <span
      data-slot="unreadable-count"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: mono,
        fontSize: 11,
        letterSpacing: "0.04em",
        color: C.t2,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ fontWeight: 600 }}>
        {UNREADABLE_GLYPH}
      </span>
      {label}
    </span>
  );
}

/**
 * One un-comprehended arrival.
 *
 * `verbs` is passed straight to the shared bar, so a caller that cannot
 * honestly perform a verb simply does not supply it and it does not render.
 */
export function UnreadableRow({
  item,
  verbs,
  busyVerb,
}: {
  item: UnreadableArrival;
  verbs: WorkVerbHandlers;
  /** The verb currently in flight, so the bar can mark it and lock the rest. */
  busyVerb?: WorkVerbId | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);

  return (
    <div data-slot="unreadable-row" style={{ position: "relative" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 12.5,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            border: `1px solid ${C.line2}`,
            background: C.sunken,
            color: C.t1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {UNREADABLE_GLYPH}
        </span>
        {/* Their words, marked as borrowed. The screen-reader name says so too
            — the quote marks are decoration to a screen reader, and without
            this the row would read as if Cue had written the title. */}
        <span
          data-slot="unreadable-subject"
          aria-label={`Couldn't read this arrival. It says: ${item.subject}`}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontStyle: "italic",
            color: C.ink,
          }}
        >
          {`“${item.subject}”`}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            flexShrink: 0,
            fontSize: 11.5,
            fontWeight: 500,
            color: C.blueS,
            background: "transparent",
            border: "none",
            padding: "2px 4px",
            cursor: "pointer",
          }}
        >
          Open it
        </button>
        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`More actions for “${item.subject}”`}
          style={{
            flexShrink: 0,
            width: 18,
            height: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: mono,
            fontSize: 12,
            color: C.t2,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          ⋯
        </button>
      </div>
      {/* The admission. `t2`, not a tint: there is no colour on this row at all
          and the glyph above already carries the state. */}
      <div
        data-slot="unreadable-line"
        style={{
          fontSize: 11.5,
          color: C.t2,
          lineHeight: 1.45,
          marginTop: 4,
          marginLeft: 28,
        }}
      >
        {UNREADABLE_LINE}
      </div>
      {open ? (
        <div
          data-slot="unreadable-open"
          style={{
            marginTop: 8,
            marginLeft: 28,
            padding: "9px 11px",
            border: `1px solid ${C.line}`,
            borderRadius: 9,
            background: C.surface,
            fontSize: 12,
            color: C.t1,
            lineHeight: 1.5,
          }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: C.t2,
              marginBottom: 5,
            }}
          >
            {[item.senderName ?? item.senderAddress, item.channel]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {/* Verbatim, or an explicit absence. A blank space where the body
              should be reads as a rendering bug, not as "nothing was stored". */}
          <div style={{ whiteSpace: "pre-wrap" }}>
            {item.snippet ?? "Nothing but the subject line was stored."}
          </div>
        </div>
      ) : null}
      {menu ? (
        <div style={{ marginTop: 8, marginLeft: 28 }}>
          <WorkVerbBar handlers={verbs} busy={busyVerb ?? null} compact />
        </div>
      ) : null}
    </div>
  );
}
