/**
 * Deck — the command surface, for when you sit down to work.
 *
 * Centre column: greeting, receipts subline, capture, **Your next move**, then
 * **Needs you capped at 3 of N** with one door to triage. Right rail: 300px,
 * always visible, never scrolls, carrying the same five lanes Glance collapses
 * into its footer strip.
 *
 * The centre is deliberately short. Everything that made the old deck a mile of
 * scroll — the rings hero, the mission list, the drift cards, the came-in rows,
 * the delivered list, the twelve-lane tier rail — is either a rail tile now or
 * gone to the surface that owns it (drift belongs on the mission's own detail
 * page, where it already lives). **The deck never grows**: at 6 open items or
 * 600, only the numbers move.
 *
 * The needs-you order inside the cap is load-bearing and is the same order the
 * phone uses: paused runs first (nothing continues until they are answered),
 * then review rows. A cap applied over a badly ordered list quietly hides a
 * stopped run.
 */

import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { StateBadge } from "@vellumai/design-library";

import { relativeTime } from "@/domains/activity/theme";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { CaptureBar } from "./capture-bar";
import { NEEDS_YOU_CAP } from "./hq-deck";
import { railTiles, type HqCensus, type HqLaneId } from "./hq-census";
import { HqRail } from "./hq-lane-ui";
import { C, MicroLabel, serif } from "./hq-kit";
import { NextMoveCard, type NextMove } from "./hq-modules";
import { PausedNeedsYouRow, type PausedApproval } from "./paused-approvals";
import { feedbackSubject, useValveFeedback } from "./use-valve";
import { ValveDoor } from "./valve-doors";
import type { HqWorkItem, Mission } from "./use-missions";

/**
 * One needs-you row — the compact form the centre column can hold three of.
 *
 * The ✕ is not a hide button. It posts `dismissed` to the valve against the
 * item's SENDER or CHANNEL, which is the only feedback that can compound:
 * teaching Cue that one particular email did not matter teaches it nothing,
 * because that email will never arrive again. Design's promise that "the
 * holding count shrinks on its own" is a property of this call existing, not of
 * the rules — which is why the control and the call are the same gesture rather
 * than a control with a call bolted beside it.
 *
 * It is offered only when there is a subject to teach about. A ✕ that quietly
 * taught nothing would be worse than no ✕ at all: the owner would spend
 * dismissals believing they were training a filter that never heard them.
 */
function NeedsYouRow({
  item,
  mission,
  assistantId,
}: {
  item: HqWorkItem;
  mission: Mission | null;
  assistantId: string;
}) {
  const navigate = useNavigate();
  const feedback = useValveFeedback(assistantId);
  const subject = feedbackSubject(item);
  const open = () => {
    haptic.light();
    navigate(
      item.lastRunConversationId
        ? routes.conversation(item.lastRunConversationId)
        : routes.reviewQueue,
    );
  };
  const notRelevant = () => {
    if (!subject) return;
    haptic.light();
    feedback.mutate({
      path: { assistant_id: assistantId },
      body: { ...subject, signal: "dismissed" },
    });
  };
  return (
    <div
      data-slot="hq-needs-you-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "11px 15px",
        borderTop: `1px solid ${C.line}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: C.ink,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {item.title}
          </span>
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            <StateBadge state="review" size="sm" />
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--hq-muted)", marginTop: 2 }}>
          {mission ? `${mission.title} · ` : ""}Cue finished · waits for your yes
          {item.updatedAt ? ` · ${relativeTime(item.updatedAt)}` : ""}
        </div>
      </div>
      <button
        type="button"
        onClick={open}
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          background: C.ink,
          color: C.bg,
          border: "none",
          borderRadius: 8,
          padding: "6px 12px",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        Review
      </button>
      {subject ? (
        <button
          type="button"
          data-slot="hq-not-relevant"
          aria-label={`Not relevant — teach Cue about this ${subject.subjectKind}`}
          title={
            feedback.isSuccess
              ? "Noted — Cue will let this sender through more quietly."
              : `Not relevant. Cue lowers this ${subject.subjectKind}'s score.`
          }
          disabled={feedback.isPending || feedback.isSuccess}
          onClick={notRelevant}
          style={{
            fontSize: 12,
            lineHeight: 1,
            // Never colour alone: the mark itself changes on success.
            color: feedback.isSuccess ? C.greenText : C.t3,
            background: "none",
            border: "none",
            padding: "6px 2px",
            cursor: feedback.isPending || feedback.isSuccess ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {feedback.isSuccess ? "✓" : "✕"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The needs-you block: `3 OF N` and a door, or the honest zero.
 *
 * `count` is the ONE needs-you number the page computed and shares with the
 * sidebar badge — never a count of the rows this block happened to build. That
 * distinction is what stopped the headline reading 6 while the badge read 5.
 */
function NeedsYouBlock({
  assistantId,
  count,
  caveat,
  approvals,
  items,
  missionsByProjectId,
  focused,
}: {
  assistantId: string;
  count: number | null;
  /** The valve's honesty note about this lane — see `HqLaneReading.caveat`. */
  caveat: string | null;
  approvals: PausedApproval[];
  items: HqWorkItem[];
  missionsByProjectId: Map<string, Mission>;
  focused: boolean;
}) {
  const rows: React.ReactNode[] = [];
  for (const approval of approvals) {
    if (rows.length >= NEEDS_YOU_CAP) break;
    rows.push(
      <PausedNeedsYouRow
        key={`paused:${approval.requestId}`}
        assistantId={assistantId}
        approval={approval}
      />,
    );
  }
  for (const item of items) {
    if (rows.length >= NEEDS_YOU_CAP) break;
    rows.push(
      <NeedsYouRow
        key={item.id}
        assistantId={assistantId}
        item={item}
        mission={
          item.projectId
            ? (missionsByProjectId.get(item.projectId) ?? null)
            : null
        }
      />,
    );
  }

  const label =
    count == null
      ? "NEEDS YOU"
      : count > rows.length && rows.length > 0
        ? `NEEDS YOU · ${rows.length} OF ${count}`
        : `NEEDS YOU · ${count}`;

  return (
    <section
      data-hq-lane="needs_you"
      data-slot="hq-needs-you"
      style={{ marginTop: 16 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <MicroLabel color={count && count > 0 ? C.amberText : C.t3}>
          {label}
        </MicroLabel>
        <span style={{ flex: 1, height: 1, background: C.line }} />
        {count != null && count > rows.length ? (
          <Link
            to={routes.reviewQueue}
            style={{ fontSize: 11, color: C.blueText, textDecoration: "none" }}
          >
            Triage all ›
          </Link>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 9,
          background: C.surface,
          border: focused
            ? `1px solid color-mix(in srgb, ${C.blue} 55%, ${C.line})`
            : `1px solid ${C.line}`,
          boxShadow: focused
            ? `0 0 0 3px color-mix(in srgb, ${C.blue} 16%, transparent)`
            : "none",
          borderRadius: 13,
          overflow: "hidden",
          transition: "box-shadow .3s ease, border-color .3s ease",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: "13px 15px", fontSize: 13, color: C.t2 }}>
            {count == null ? (
              "Cue couldn't read your review queue just now."
            ) : (
              <>
                <span aria-hidden style={{ color: C.greenText }}>
                  ✓{" "}
                </span>
                Nothing needs you. Go do something else.
              </>
            )}
          </div>
        ) : (
          // The first row's own border-top would double the card's edge.
          <div style={{ marginTop: -1 }}>{rows}</div>
        )}
      </div>
      {caveat ? (
        <div
          data-slot="hq-lane-caveat"
          style={{
            fontSize: 11,
            color: C.amberText,
            marginTop: 7,
            lineHeight: 1.45,
          }}
        >
          {caveat}
        </div>
      ) : null}
    </section>
  );
}

export function HqDeckSurface({
  assistantId,
  greeting,
  deliveredSentence,
  census,
  missions,
  move,
  needsYouCount,
  approvals,
  reviewItems,
  missionsByProjectId,
  focus,
  onFocusConsumed,
  brokenStates,
}: {
  assistantId: string;
  greeting: string;
  deliveredSentence: string;
  census: HqCensus;
  /** Open missions — the rail's rings. */
  missions: Mission[];
  move: NextMove;
  needsYouCount: number | null;
  approvals: PausedApproval[];
  reviewItems: HqWorkItem[];
  missionsByProjectId: Map<string, Mission>;
  /** The lane a Glance tap asked for. Scrolled to once, then released. */
  focus: HqLaneId | null;
  onFocusConsumed: () => void;
  brokenStates?: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Glance is never a dead end: a tap arrives here as `focus`, and this is the
  // half that makes it land. The lane is marked for a beat (see the `focused`
  // outlines above) and the focus is released so an unrelated re-render cannot
  // scroll the reader away later.
  useEffect(() => {
    if (!focus) return;
    const node = rootRef.current?.querySelector(`[data-hq-lane="${focus}"]`);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = window.setTimeout(onFocusConsumed, 2400);
    return () => window.clearTimeout(timer);
  }, [focus, onFocusConsumed]);

  return (
    <div
      ref={rootRef}
      data-slot="hq-deck-surface"
      style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch" }}
    >
      <div
        data-slot="hq-deck-centre"
        style={{
          flex: 1,
          minWidth: 0,
          padding: "20px 30px 30px",
          overflowY: "auto",
        }}
      >
        <div
          data-slot="hq-title"
          style={{ fontFamily: serif, fontSize: 27, lineHeight: 1.1 }}
        >
          {greeting}
        </div>
        <div style={{ fontSize: 13, color: C.t2, marginTop: 4 }}>
          {deliveredSentence}
        </div>

        <div style={{ marginTop: 14, maxWidth: 640 }}>
          <CaptureBar
            placeholder={
              'Tell Cue what you need — or "take the Halo pricing" to hand it over'
            }
            autoFilesChip={false}
          />
        </div>

        {brokenStates}

        {/* No section header above this card: `NextMoveCard` draws its own
            "◆ YOUR NEXT MOVE" eyebrow, and adding a matching rule above it put
            the same four words on the screen twice, four pixels apart. */}
        {move.hasMove ? (
          <section style={{ marginTop: 18 }}>
            <NextMoveCard assistantId={assistantId} move={move} />
          </section>
        ) : null}

        <NeedsYouBlock
          assistantId={assistantId}
          count={needsYouCount}
          caveat={census.needs_you.caveat}
          approvals={approvals}
          items={reviewItems}
          missionsByProjectId={missionsByProjectId}
          focused={focus === "needs_you"}
        />
      </div>

      <HqRail
        assistantId={assistantId}
        tiles={railTiles(census)}
        missions={missions}
        focus={focus}
        valveDoor={<ValveDoor assistantId={assistantId} />}
      />
    </div>
  );
}
