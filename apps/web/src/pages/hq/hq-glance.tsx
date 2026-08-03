/**
 * Glance — the 30-second check, and what HQ opens on.
 *
 * Centred: greeting → one subline of receipts → capture → **one** "Your next
 * move" card → "N more need you ›". Then the footer strip of five tappable
 * numbers, which is the whole rest of your world in one row.
 *
 * Everything that used to scroll past here is gone: the rings hero, the
 * came-in rows, the drift cards, the delivered list, the tier rail. Design's
 * rule is that HQ answers *"what needs me right now"* and nothing else, and
 * anything handled, held, filed or watched is a **number you can tap** rather
 * than a row you scroll past.
 *
 * The strip is not decoration and not a dead end — every cell opens Deck
 * focused on that lane, which is why {@link GlanceStrip} takes an `onOpen`
 * rather than a list of links. Design: "you rarely need to toggle manually".
 *
 * The one thing Glance keeps that is not a number: the screen-owning broken
 * states. A filer that has stopped and a watcher that cannot be reached are
 * not routine emptiness — they are the product being less than the owner
 * believes it is, and they belong in the 30-second check more than anything
 * else on the page.
 */

import { Link } from "react-router";

import { routes } from "@/utils/routes";

import { CaptureBar } from "./capture-bar";
import {
  sublineLanes,
  type HqCensus,
  type HqLaneId,
  stripCells,
} from "./hq-census";
import { GlanceStrip } from "./hq-lane-ui";
import { C, mono, serif } from "./hq-kit";
import { NextMoveCard, type NextMove } from "./hq-modules";

/**
 * The receipts line under the greeting.
 *
 * `delivered` arrives as a sentence the caller minted from its own queried
 * lane (see `deliverySentence` in ./hq-tiers — a `Queried` cannot be built
 * from a literal), and the in-motion lanes append their own detail. In-motion
 * has no strip cell of its own, so this line is where it stays visible:
 * "collapsed" must never become "dropped".
 *
 * Each part is a complete sentence in its own right, so the joiner has to take
 * the full stops off everything but the last one — otherwise the line reads
 * "Today so far: 1 done. · Nothing is running", which is a paragraph pretending
 * to be a subtitle.
 */
export function glanceSubline(delivered: string, census: HqCensus): string {
  const parts = [delivered, ...sublineLanes(census).map((l) => l.detail)]
    .map((part) => part.trim())
    .filter(Boolean);
  return parts
    .map((part, i) =>
      i === parts.length - 1 ? part : part.replace(/\.$/, ""),
    )
    .join(" · ");
}

export function HqGlance({
  assistantId,
  greeting,
  deliveredSentence,
  census,
  move,
  needsYouCount,
  onOpenLane,
  brokenStates,
}: {
  assistantId: string;
  greeting: string;
  /** Already-minted receipts sentence — never assembled from a literal here. */
  deliveredSentence: string;
  census: HqCensus;
  move: NextMove;
  /**
   * The needs-you number, or null when the queue could not be read. Null prints
   * no "N more" door rather than a zero — a door to a number we do not have.
   */
  needsYouCount: number | null;
  onOpenLane: (id: HqLaneId) => void;
  /** Filer stopped / watchers unreachable / nothing watched. Rare, and loud. */
  brokenStates?: React.ReactNode;
}) {
  const more = needsYouCount == null ? 0 : Math.max(0, needsYouCount - 1);
  return (
    <div
      data-slot="hq-glance"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        data-slot="hq-glance-focus"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          padding: "28px 24px 34px",
          gap: 0,
        }}
      >
        <div
          data-slot="hq-title"
          style={{ fontFamily: serif, fontSize: 30, lineHeight: 1.12 }}
        >
          {greeting}
        </div>
        <div
          data-slot="hq-glance-subline"
          style={{
            fontSize: 13,
            color: C.t2,
            marginTop: 5,
            maxWidth: 520,
            lineHeight: 1.5,
          }}
        >
          {glanceSubline(deliveredSentence, census)}
        </div>

        <div style={{ width: "min(460px, 100%)", marginTop: 18 }}>
          <CaptureBar
            placeholder="Tell Cue what you need…"
            autoFilesChip={false}
          />
        </div>

        {brokenStates ? (
          <div style={{ width: "min(460px, 100%)", textAlign: "left" }}>
            {brokenStates}
          </div>
        ) : null}

        {/* THE one move. Not a lane, not a list — the single thing Cue thinks
            you should do next, with the rest behind one door. */}
        <div style={{ width: "min(460px, 100%)", marginTop: 16 }}>
          {move.hasMove ? (
            <NextMoveCard assistantId={assistantId} move={move} />
          ) : (
            <div
              data-slot="hq-glance-clear"
              style={{
                border: `1px solid ${C.line}`,
                borderRadius: 13,
                padding: "16px 20px",
                background: C.surface,
                fontSize: 14,
                color: C.t2,
              }}
            >
              {needsYouCount == null ? (
                "I couldn't read your queue just now."
              ) : needsYouCount === 0 ? (
                <>
                  <span aria-hidden style={{ color: C.greenText }}>
                    ✓{" "}
                  </span>
                  Nothing needs you. Go do something else.
                </>
              ) : (
                <>
                  <span aria-hidden style={{ color: C.amberText }}>
                    ‖{" "}
                  </span>
                  {needsYouCount} {needsYouCount === 1 ? "thing" : "things"} need
                  {needsYouCount === 1 ? "s" : ""} you — I haven&rsquo;t picked
                  one out yet.
                </>
              )}
            </div>
          )}
        </div>

        {/* "5 more need you ›" — only when there ARE more, and only when we
            know how many. A door to a count we could not read is a fake door. */}
        {more > 0 ? (
          <Link
            to={routes.reviewQueue}
            data-slot="hq-glance-more"
            style={{
              marginTop: 13,
              fontFamily: mono,
              fontSize: 12,
              color: C.blueText,
              textDecoration: "none",
            }}
          >
            {more} more need you ›
          </Link>
        ) : null}

        {/*
          The valve's caveat about THIS lane.

          On Glance, needs-you is a bare number in the footer strip, so without
          this line "57 need you" reads as a valve-filtered 57 — when in fact
          the valve may not have judged a single one of them. An unfiltered lane
          passing for a filtered one is the most flattering lie a filter can
          tell, and it is the one this line exists to stop.
        */}
        {census.needs_you.caveat ? (
          <div
            data-slot="hq-glance-caveat"
            style={{
              marginTop: 9,
              fontSize: 11.5,
              color: C.amberText,
              maxWidth: 460,
              lineHeight: 1.45,
            }}
          >
            {census.needs_you.caveat}
          </div>
        ) : null}
      </div>

      <GlanceStrip cells={stripCells(census)} onOpen={onOpenLane} />
    </div>
  );
}
