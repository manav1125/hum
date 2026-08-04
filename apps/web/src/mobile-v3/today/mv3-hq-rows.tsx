/**
 * Two rows C1 adds to the phone: the going-quiet person, and `⌗`.
 *
 * Both already exist on desktop and both are rendered here from the SAME
 * predicates and the SAME data those surfaces use. That is not tidiness — a
 * second copy of "which arrivals count as unreadable" is how the two surfaces
 * come to disagree about a number in front of the owner.
 *
 * ## `⌗` — the predicate must not be widened, ever
 *
 * `isUnComprehended` in `@/pages/hq/uncomprehended` is a whitelist of exactly
 * one comprehension verdict, `low_confidence`: *Cue read the message and could
 * not name an action.* `failed` is deliberately NOT in it, because `failed`
 * covers timeouts and unreachable models — during an outage EVERY arrival is
 * `failed`, and a `⌗` bucket that swallowed them would empty the deck at the
 * exact moment Cue is least able to explain itself. This module imports that
 * predicate rather than restating it, so widening it would have to be done
 * somewhere a test is already watching.
 *
 * The badge is **neutral — no tint**. Amber belongs to `?` ("I don't know where
 * this goes") and `‖` ("waiting on you"), and lending this state their colour
 * would rebuild the exact confusion the state was invented to end.
 *
 * ## Going quiet — what the data can actually say
 *
 * Design's row reads *"Sarah Chen is going quiet · asked twice, 11 days ·
 * a16z"*, as the mitigation for People losing its tab. Three of those four
 * fragments are real and one is not:
 *
 *   · **the person** — `contacts[].displayName`, joined through a work item's
 *     `waitingOn`. Real.
 *   · **the day count** — `now − (lastChasedAt ?? lastActivityAt ?? createdAt)`.
 *     Real, and it means *days since I chased*, which is what the copy says.
 *   · **the state** — the daemon's own `waitingState` derivation (`going_cold`
 *     after 5 days of silence past a chase). Real.
 *   · **"asked twice"** — **not stored anywhere the web can read.**
 *     `lastChasedAt` is a scalar with no counter, work-item events have no
 *     `chased` kind, and the `followups` table that does count asks has no HTTP
 *     route at all. So the row does not say it. Neither does it say "a16z":
 *     contacts carry no company field.
 *
 * A row that printed an ask count would be inventing the one number that makes
 * it feel authoritative. It says less, and everything it says is true.
 */

import { useState } from "react";
import { useNavigate } from "react-router";

import type { Unavailable, WaitingItem } from "@/pages/hq/hq-k1-modules";
import {
  useUnreadableArrivals,
  type UnreadableArrival,
} from "@/pages/hq/uncomprehended";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { mv3Mono } from "../mv3-kit";

/* -------------------------------------------------------------------------- */
/* Going quiet                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rows shown at once.
 *
 * Two, not all of them: the Tier-3 waiting line below already carries the
 * total ("3 people owe you something — 1 is going cold"), so the rows are the
 * named few rather than a second, longer list of the same fact.
 */
export const QUIET_ROW_CAP = 2;

/** The states worth a row. `on_time` wants to be forgotten, not surfaced. */
export function goingQuiet(items: WaitingItem[]): WaitingItem[] {
  return items
    .filter((w) => w.state === "going_cold" || w.state === "chased")
    .slice(0, QUIET_ROW_CAP);
}

/** What the row says, with no fragment the data cannot support. */
export function quietSentence(item: WaitingItem): {
  headline: string;
  detail: string;
} {
  const days = `${item.days} ${item.days === 1 ? "day" : "days"}`;
  return item.state === "going_cold"
    ? {
        headline: `${item.person} is going quiet`,
        detail: `${item.what} · ${days} since I chased`,
      }
    : {
        headline: `${item.person} hasn't come back`,
        detail: `${item.what} · chased ${days} ago`,
      };
}

function initial(name: string): string {
  const ch = name.trim()[0];
  return ch ? ch.toUpperCase() : "·";
}

/**
 * The going-quiet rows.
 *
 * Renders nothing when nobody is going quiet — this is not a standing lane, it
 * is a set of named people, and "no one is going quiet" is already stated by
 * the waiting line. A failed read DOES speak, because a person silently
 * dropping off the deck is the failure the relocation was supposed to prevent.
 */
export function Mv3GoingQuietRows({
  waiting,
  unavailable,
}: {
  waiting: WaitingItem[];
  unavailable?: Unavailable;
}) {
  const navigate = useNavigate();
  if (unavailable) {
    return (
      <div
        data-slot="mv3-going-quiet-error"
        role="status"
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11.5,
          color: "var(--mv3-fail-text)",
          padding: "3px 2px",
        }}
      >
        <span aria-hidden style={{ fontFamily: mv3Mono }}>
          ◼
        </span>
        <span>{unavailable.reason}</span>
      </div>
    );
  }
  const rows = goingQuiet(waiting);
  if (rows.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.map((item) => {
        const { headline, detail } = quietSentence(item);
        return (
          <button
            key={item.id}
            type="button"
            className="cue-pressable"
            data-slot="mv3-going-quiet"
            onClick={() => {
              haptic.light();
              navigate(routes.people);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              font: "inherit",
              color: "var(--mv3-text)",
              background: "var(--mv3-card)",
              border: "1px solid var(--mv3-fail-card-border)",
              borderRadius: 15,
              padding: "11px 13px",
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: "var(--mv3-teal-fill)",
                color: "var(--mv3-teal-on-fill)",
                fontSize: 10,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {initial(item.person)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12.5,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {headline}
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 5,
                  fontSize: 9.5,
                  color: "var(--mv3-fail-text)",
                  marginTop: 1,
                }}
              >
                {/* The state carries a glyph, never the tint alone. */}
                <span aria-hidden style={{ fontFamily: mv3Mono }}>
                  ◷
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {detail}
                </span>
              </span>
            </span>
            <span
              aria-hidden
              style={{
                fontSize: 10.5,
                color: "var(--mv3-micro)",
                flexShrink: 0,
              }}
            >
              Open
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ⌗ — I couldn't tell what this needs                                        */
/* -------------------------------------------------------------------------- */

/** The glyph and the line, matching desktop's `uncomprehended-row.tsx`. */
export const UNREADABLE_GLYPH = "⌗";
export const UNREADABLE_LINE = "I couldn't tell what this needs";

/** Rows at once. The deck never grows — not even the admissions. */
export const UNREADABLE_ROW_CAP = 2;

/**
 * One `⌗` arrival: their subject, quoted and italic, and Cue's admission.
 *
 * Tapping expands in place rather than routing at the task list — the item is
 * deliberately absent from that list, so "Open" there would land on a surface
 * the thing is not on.
 */
export function Mv3UnreadableRow({ item }: { item: UnreadableArrival }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-slot="mv3-unreadable"
      style={{
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderRadius: 15,
        padding: "11px 13px",
      }}
    >
      <button
        type="button"
        className="cue-pressable"
        aria-expanded={open}
        onClick={() => {
          haptic.light();
          setOpen((v) => !v);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "var(--mv3-text)",
          cursor: "pointer",
        }}
      >
        {/* Neutral. No tint — amber is spoken for by `?` and `‖`. */}
        <span
          role="img"
          aria-label="Couldn't read this"
          style={{
            width: 18,
            height: 18,
            borderRadius: 6,
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            color: "var(--mv3-text)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: mv3Mono,
            fontSize: 10,
            flexShrink: 0,
          }}
        >
          {UNREADABLE_GLYPH}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {/* Their words, marked as borrowed: everywhere else the title is
              Cue's reading of the message, and here there is no reading. */}
          <span
            data-slot="mv3-unreadable-subject"
            style={{
              display: "block",
              fontSize: 12.5,
              fontStyle: "italic",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {`“${item.subject}”`}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 9.5,
              color: "var(--mv3-muted)",
              marginTop: 1,
            }}
          >
            {UNREADABLE_LINE}
          </span>
        </span>
        <span
          aria-hidden
          style={{ fontSize: 10.5, color: "var(--mv3-micro)", flexShrink: 0 }}
        >
          {open ? "Close" : "Open"}
        </span>
      </button>
      {open ? (
        <div
          style={{
            marginTop: 9,
            marginLeft: 28,
            padding: "9px 11px",
            borderRadius: 10,
            background: "var(--mv3-token-well)",
            border: "1px solid var(--mv3-token-well-border)",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--mv3-text)",
          }}
        >
          <div
            style={{
              fontFamily: mv3Mono,
              fontSize: 9.5,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: "var(--mv3-muted)",
              marginBottom: 5,
            }}
          >
            {[item.senderName ?? item.senderAddress, item.channel]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {/* Verbatim, or an explicit absence — a blank body reads as a bug. */}
          <div style={{ whiteSpace: "pre-wrap" }}>
            {item.snippet ?? "Nothing but the subject line was stored."}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `⌗` strip.
 *
 * Silent at zero: a comprehension failure rate of nothing is not a fact worth a
 * slot. Loud on a failed scan, for the same reason the whole state exists —
 * something arrived and went nowhere visible, which is the bug this closes.
 */
export function Mv3UnreadableRows({
  assistantId,
  knownWorkItemIds,
}: {
  assistantId: string;
  knownWorkItemIds?: ReadonlySet<string>;
}) {
  const { items, count, isError } = useUnreadableArrivals(assistantId, {
    knownWorkItemIds,
  });
  if (isError) {
    return (
      <div
        data-slot="mv3-unreadable-error"
        role="status"
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11.5,
          color: "var(--mv3-fail-text)",
          padding: "3px 2px",
        }}
      >
        <span aria-hidden style={{ fontFamily: mv3Mono }}>
          ◼
        </span>
        <span>I couldn&rsquo;t check what I failed to read.</span>
      </div>
    );
  }
  if (count === 0) return null;
  const shown = items.slice(0, UNREADABLE_ROW_CAP);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {shown.map((item) => (
        <Mv3UnreadableRow key={item.workItemId} item={item} />
      ))}
      {count > shown.length ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: mv3Mono,
            fontSize: 10.5,
            color: "var(--mv3-muted)",
            padding: "1px 4px",
          }}
        >
          <span aria-hidden>{UNREADABLE_GLYPH}</span>
          <span>
            {count} I couldn&rsquo;t read · {shown.length} shown
          </span>
        </div>
      ) : null}
    </div>
  );
}
