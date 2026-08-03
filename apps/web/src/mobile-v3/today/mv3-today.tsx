/**
 * Mv3Today — the mobile v3 Today screen (spec frame 1 dark / 12 light + the
 * round-4 frame 60 collapse). Replaces the MOBILE rendering of HqPage only;
 * desktop keeps the serif HQ deck untouched.
 *
 * Layout (spec-verbatim): date eyebrow + avatar → "Good morning, Manav."
 * large title → CueRing hero with orbit chips + "Working on N things for
 * you" → the card stack: NEXT MOVE → NEEDS YOUR OK (amber, Approve/Deny) →
 * REVIEW READY (violet) → WORKING NOW rows → "Came in today" strip.
 *
 * ROUND-4 FRAME 60 — the whole page scrolls as ONE surface and the hero
 * condenses into a pinned 56px bar with exact physics (see
 * ./today-collapse.ts for the verbatim spec + the pure value maps). The
 * scroll driver is rAF-batched and writes transform/opacity ONLY, with all
 * geometry (ring start/target centers) measured once per mount/resize —
 * never per frame (WKWebView guardrails). Reduced motion degrades to two
 * static states with a 200ms cross-fade at threshold 100.
 *
 * DATA MAPPING — nothing invented, every slot rides the wiring HqPage
 * already has (a slot with no data collapses; the designed empty state is a
 * later frame):
 *   · next-move endpoint (`useNextMove` in HqPage)      → NEXT MOVE card
 *   · pending interactions (`pendinginteractionsGet`)   → NEEDS YOUR OK
 *   · awaiting_review work items                        → REVIEW READY
 *   · running work items (+ lastProgressNote)           → WORKING NOW rows
 *   · pending (came-in) work items                      → came-in strip
 *
 * Capture stays reachable through the tab bar's + (Create) — the v3 design
 * moves capture there, so Today carries no capture bar.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";

import { client } from "@/generated/daemon/client.gen";
import { relativeTime } from "@/domains/activity/theme";
import {
  buildActionBody,
  nextMoveQueryKey,
  type NextMove,
  type NextMoveAction,
} from "@/pages/command-center/use-next-move";
import type { ArrivalsSummary } from "@/pages/hq/hq-deck";
import { RING_META, sourceBadge } from "@/pages/hq/hq-kit";
import type {
  DayPicture,
  Horizon,
  Unavailable,
  WaitingItem,
} from "@/pages/hq/hq-k1-modules";
import {
  counted,
  deliverySentence,
  known,
  laneSlotsFor,
  unavailable,
} from "@/pages/hq/hq-tiers";
import {
  ringStatusFor,
  type HqSchedule,
  type HqWorkItem,
  type Mission,
} from "@/pages/hq/use-missions";

import { buildMv3Lanes, Mv3TierRail } from "./mv3-lanes";
import { Mv3DayStrip, useDayClock } from "./mv3-day-strip";
import { Mv3GoingQuietRows, Mv3UnreadableRows } from "./mv3-hq-rows";
import {
  Mv3PausedRunLine,
  Mv3PausedRunRow,
  usePausedRuns,
} from "./mv3-paused-run";
import { capDeck, isCapped, needsYouLabel } from "./needs-you-deck";
import type { PausedRun } from "../approval-sheet";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { CueRing, CueRingHero, type OrbitChip } from "../cue-ring";
import { EmptyOrbit } from "../empty-orbit";
import { GlassCard } from "../glass-card";
import { DismissX, dismissLeave, useDismissTask } from "../undo-toast";
import { cornerChromeProps } from "../corner-chrome";
import {
  cardBody,
  cardTitle,
  microLabel,
  mv3Mono,
  primaryBtn,
  rise,
  secondaryBtn,
} from "../mv3-kit";
import {
  barChromeOpacity,
  captionOpacity,
  chipFade,
  condensedRightOpacity,
  condensedTitleOpacity,
  greetingOpacity,
  guideRingOpacity,
  reducedMode,
  ringHandoff,
  ringTransform,
  REDUCED_MOTION_FADE_MS,
  type RingGeometry,
} from "./today-collapse";

const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

function dayPart(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** "SATURDAY · JUL 19" (uppercased by the header's eyebrow styling). */
function dateEyebrow(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  const monthDay = now.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${weekday} · ${monthDay}`;
}

/** Spec orbit-chip hues, applied per slot. */
const CHIP_COLORS = [
  "var(--mv3-ring-active)",
  "var(--mv3-violet)",
  "var(--mv3-teal)",
];

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

/** NEXT MOVE — the daemon's chief-of-staff pick (same wiring as NextMoveCard). */
function NextMoveV3({
  assistantId,
  move,
}: {
  assistantId: string;
  move: NextMove;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: async (action: NextMoveAction) => {
      if (action.kind === "open_thread" || !action.endpoint) return;
      const method = action.method ?? "POST";
      const opts = {
        url: action.endpoint,
        throwOnError: true,
        // Approvals need `{ requestId, decision }` or /v1/confirm 400s. Shared
        // with the desktop hero card so the twins can't drift.
        ...(buildActionBody(action, move) ?? {}),
      } as const;
      if (method === "GET") await client.get(opts);
      else if (method === "PATCH") await client.patch(opts);
      else if (method === "DELETE") await client.delete(opts);
      else await client.post(opts);
    },
    // Without this a failed approval was indistinguishable from a successful
    // one on mobile — same silent card, no signal at all.
    onError: () => haptic.error(),
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({
        queryKey: nextMoveQueryKey(assistantId),
      });
    },
  });

  if (!move.hasMove) return null;

  const primary = move.actions.find(
    (a) => a.kind === "approve" || a.kind === "run",
  );
  const canOpen = Boolean(move.sourceConversationId);
  const open = () => {
    haptic.light();
    if (move.sourceConversationId)
      navigate(routes.conversation(move.sourceConversationId));
  };

  return (
    <GlassCard style={rise(0.1)}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ ...microLabel, color: "var(--mv3-micro)" }}>
          Next move
        </span>
        {move.generatedAt ? (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11.5,
              color: "var(--mv3-faint)",
            }}
          >
            {relativeTime(new Date(move.generatedAt).getTime())}
          </span>
        ) : null}
      </div>
      <div style={cardTitle}>{move.headline}</div>
      {move.reasoning ? <div style={cardBody}>{move.reasoning}</div> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
        {primary ? (
          <button
            type="button"
            className="cue-pressable"
            disabled={act.isPending}
            onClick={() => {
              haptic.medium();
              act.mutate(primary);
            }}
            style={{ ...primaryBtn, opacity: act.isPending ? 0.6 : 1 }}
          >
            {primary.label}
          </button>
        ) : null}
        {canOpen ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={open}
            style={primary ? secondaryBtn : { ...primaryBtn }}
          >
            Open
          </button>
        ) : null}
      </div>
    </GlassCard>
  );
}

/*
 * There used to be a `NeedsOkV3` card here: an inline **Approve** beside a
 * **Deny**, 8px apart, on a card whose body might read "£4,200 to Mafai Ma".
 *
 * Design was asked inline-or-sheet and answered *neither* (v22 R4). The row now
 * leads with a single **Review** that opens `../approval-sheet` — see
 * `./mv3-paused-run`, which owns both. Nothing on this screen can approve a
 * stopped run any more; the sheet is the only door, and it is the only place
 * with room for the amount, the recipient and the fact that it can't be
 * recalled.
 */

/** REVIEW READY — an awaiting_review work item, violet. */
function ReviewV3({
  item,
  delay,
  leaving,
  onDismiss,
}: {
  item: HqWorkItem;
  delay: number;
  /** Mid-collapse (the 150ms dismiss leave). */
  leaving: boolean;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const open = () => {
    haptic.medium();
    // Full-bleed review pager (frame 16), seeded at THIS item (P1-4).
    navigate(`${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`);
  };
  return (
    <GlassCard
      tint="violet"
      style={{ ...rise(delay), ...dismissLeave(leaving) }}
    >
      <div
        style={{
          ...microLabel,
          color: "var(--mv3-violet)",
          display: "flex",
          alignItems: "center",
        }}
      >
        ◱ Review ready
        <DismissX
          title={item.title}
          onDismiss={onDismiss}
          style={{ marginLeft: "auto", marginRight: -14, marginTop: -12 }}
        />
      </div>
      <div style={{ ...cardTitle, fontSize: 15.5 }}>{item.title}</div>
      <div style={{ ...cardBody, fontSize: 12.5 }}>
        Cue finished this — it waits for your yes
        {item.updatedAt ? ` · ${relativeTime(item.updatedAt)}` : ""}.
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
        <button
          type="button"
          className="cue-pressable"
          onClick={open}
          style={{
            ...primaryBtn,
            background: "var(--mv3-violet-on-fill)",
            boxShadow:
              "0 12px 26px -10px color-mix(in srgb, var(--mv3-violet-on-fill) 50%, transparent)",
          }}
        >
          Review
        </button>
      </div>
    </GlassCard>
  );
}

/**
 * "Review ready · N / See all N ›" strip (UAT P1-3): when more deliverables
 * await review than Today shows, surface the real count and link into the
 * review INDEX (round-4 frame 55 — the list seeds the pager) instead of
 * silently hiding the rest.
 */
function ReviewSeeAllStrip({ total }: { total: number }) {
  const navigate = useNavigate();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "2px 6px 0",
      }}
    >
      <span style={{ ...microLabel, color: "var(--mv3-violet)" }}>
        ◱ Review ready · {total}
      </span>
      <button
        type="button"
        className="cue-pressable"
        aria-label={`See all ${total} items ready for review`}
        onClick={() => {
          haptic.light();
          navigate(routes.reviewIndex);
        }}
        style={{
          marginLeft: "auto",
          fontSize: 12,
          color: "var(--mv3-micro)",
          background: "none",
          border: "none",
          padding: "4px 0",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        See all {total} ›
      </button>
    </div>
  );
}

/**
 * Tier 1 · Needs you — the lane, not a single card.
 *
 * At 390px the lane is a stack under one header carrying the number. **The
 * headline IS the number** (v8 M2), and at zero it says so out loud — "0 need
 * you" is a real number, not a hidden absence, and hiding the lane on a quiet
 * morning is exactly how a calm deck and a broken query come to look identical.
 *
 * **The order inside the stack is load-bearing.** Paused runs sort above
 * everything: unlike a draft awaiting review, NOTHING continues until they are
 * answered. Then the next move, then the review cards. The cap is applied to
 * that ordered list, so the three cards you get are always the three that
 * matter most — a cap over a badly ordered list quietly hides a stopped run.
 *
 * **The deck never grows.** Three cards, and above three the header reads
 * `3 of N` with a door to the rest. `N` is `glanceCount`, computed once by
 * HqPage and handed to both surfaces — never a count of the cards this screen
 * happened to build.
 */
function NeedsYouV3({
  assistantId,
  move,
  moveLoading,
  pausedRuns,
  review,
  count,
  leavingId,
  onDismiss,
}: {
  assistantId: string;
  move: NextMove;
  moveLoading: boolean;
  /** Runs stopped at a checkpoint. Sorted first — nothing continues. */
  pausedRuns: PausedRun[];
  review: HqWorkItem[];
  count: number;
  leavingId: string | null;
  onDismiss: (item: HqWorkItem) => void;
}) {
  const navigate = useNavigate();
  let slot = 0;
  const nextDelay = () => 0.1 + 0.15 * slot++;
  if (move.hasMove) slot = 1; // NextMove takes .1 itself

  // The ordered stack, built before it is capped.
  const stack: { key: string; node: React.ReactNode }[] = [];
  pausedRuns.forEach((run, i) => {
    stack.push({
      key: `paused:${run.requestId}`,
      node:
        i === 0 ? (
          // The lead one gets the amber card and the full-width Review; the
          // rest are compact rows through the same single door.
          <Mv3PausedRunRow
            assistantId={assistantId}
            run={run}
            style={rise(0.1)}
          />
        ) : (
          <Mv3PausedRunLine assistantId={assistantId} run={run} />
        ),
    });
  });
  if (moveLoading && !move.hasMove) {
    stack.push({
      key: "move-skeleton",
      // Reserve the Next-move slot while the pick computes so the card
      // streaming in later never shoves the Review cards down mid-read.
      node: (
        <div
          aria-hidden
          style={{
            height: 96,
            borderRadius: 18,
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-line)",
            opacity: 0.55,
          }}
        />
      ),
    });
  } else if (move.hasMove) {
    stack.push({
      key: "move",
      node: <NextMoveV3 assistantId={assistantId} move={move} />,
    });
  }
  for (const item of review) {
    stack.push({
      key: `review:${item.id}`,
      node: (
        <ReviewV3
          item={item}
          delay={nextDelay()}
          leaving={leavingId === item.id}
          onDismiss={() => onDismiss(item)}
        />
      ),
    });
  }

  const shown = capDeck(stack);
  const capped = isCapped(count);
  const hiddenReview = review.length - shown.filter((s) =>
    s.key.startsWith("review:"),
  ).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 6px 0",
        }}
      >
        <span
          style={{
            ...microLabel,
            color: count > 0 ? "var(--mv3-amber-text)" : "var(--mv3-muted)",
          }}
        >
          ‖ Needs you · {needsYouLabel(count)}
        </span>
        {capped ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              navigate(routes.reviewQueue);
            }}
            style={{
              marginLeft: "auto",
              fontFamily: mv3Mono,
              fontSize: 11,
              color: "var(--mv3-micro)",
              background: "none",
              border: "none",
              padding: "4px 0",
              cursor: "pointer",
            }}
          >
            Triage the rest ›
          </button>
        ) : null}
      </div>
      {count === 0 && pausedRuns.length === 0 ? (
        <GlassCard blur={false} style={rise(0.1)}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 9,
              fontSize: 14,
              color: "var(--mv3-text)",
            }}
          >
            <span aria-hidden style={{ color: "var(--mv3-green, #4CAF82)" }}>
              ✓
            </span>
            <span>Nothing needs you. Go do something else.</span>
          </div>
        </GlassCard>
      ) : null}
      {/* The review index door, when the cap swallowed review cards. */}
      {hiddenReview > 0 ? <ReviewSeeAllStrip total={review.length} /> : null}
      {shown.map((entry) => (
        <Fragment key={entry.key}>{entry.node}</Fragment>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The tiers at 390px (v8 M2, brief §13.1)                                    */
/* -------------------------------------------------------------------------- */

/*
 * **At 390px a lane is a card or a line, never between**, and the rail is four
 * lines — see `./mv3-lanes`, which owns the roster and the rail so both are
 * testable without mounting a scroll driver, an aurora and four live queries.
 *
 * Cards for needs-you, delivered and missions; Arrivals, Waiting, Rhythms and
 * Pulse as lines carrying the same honest statements desktop shows, including
 * "0 need you", which is a real number rather than a hidden absence. In-motion,
 * the day and Life are absorbed by surfaces that already answer them; the batch
 * offer and the filing correction are events, absent when they didn't happen.
 */

/** Tier 1 · Delivered — Cue's receipts, and a card even when there are none. */
function DeliveredV3({ items, delay }: { items: HqWorkItem[]; delay: number }) {
  const navigate = useNavigate();
  return (
    <GlassCard blur={false} style={rise(delay)}>
      <div style={{ ...microLabel, color: "var(--mv3-green, #4CAF82)" }}>
        ✓ Delivered · {items.length}
      </div>
      {items.length === 0 ? (
        <div style={{ ...cardBody, marginTop: 7 }}>
          I haven&rsquo;t finished anything for you yet today.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 10,
          }}
        >
          {items.slice(0, 3).map((item) => (
            <button
              key={item.id}
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                navigate(
                  item.lastRunConversationId
                    ? routes.conversation(item.lastRunConversationId)
                    : routes.allWork,
                );
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "none",
                border: "none",
                padding: 0,
                textAlign: "left",
                font: "inherit",
                cursor: "pointer",
              }}
            >
              <span
                aria-hidden
                style={{ color: "var(--mv3-green, #4CAF82)", fontSize: 13 }}
              >
                ✓
              </span>
              <span
                style={{
                  fontSize: 13.5,
                  color: "var(--mv3-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </GlassCard>
  );
}

/** Tier 1 · Missions — the rings as rows, or the offer when there are none. */
function MissionsV3({
  missions,
  delay,
}: {
  missions: Mission[];
  delay: number;
}) {
  const navigate = useNavigate();
  return (
    <GlassCard blur={false} style={rise(delay)}>
      <div style={{ ...microLabel, color: "var(--mv3-micro)" }}>
        ◎ Missions · {missions.length}
      </div>
      {missions.length === 0 ? (
        <div style={{ ...cardBody, marginTop: 7 }}>
          No missions yet — and that&rsquo;s fine. Cue still catches what comes
          in.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
            marginTop: 10,
          }}
        >
          {missions.slice(0, 4).map((m) => {
            const status = ringStatusFor(m);
            const meta = RING_META[status];
            return (
              <button
                key={m.id}
                type="button"
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  navigate(routes.hqMission(m.id));
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "none",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                  font: "inherit",
                  cursor: "pointer",
                }}
              >
                {/* Glyph, never colour alone. */}
                <span aria-hidden style={{ color: meta.color, fontSize: 13 }}>
                  {meta.glyph}
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    color: "var(--mv3-text)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.title}
                </span>
                <span
                  style={{
                    fontFamily: mv3Mono,
                    fontSize: 10.5,
                    color: "var(--mv3-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {meta.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}

/**
 * The census — the last line of the page, in the flow.
 *
 * It used to be `position: absolute; bottom: 0` with a blur, pinned across the
 * canvas so the one number saying how much Cue is holding never needed
 * scrolling to. The cost of that was not visible from a simulator: on a real
 * phone it sits permanently on top of the card stack, and the owner's Today
 * screenshot has it cutting the REVIEW READY card in half mid-title. **A bar
 * that hides the thing it is summarising has made the screen worse**, and the
 * card stack is the whole surface — the census is a footer for it, not chrome
 * over it. The 104px of bottom padding that existed only to hold it off the
 * last row goes with it; the tab bar is a flex sibling of this screen, not an
 * overlay, so nothing else needs clearing.
 *
 * The design's own rule for what may sit on the home canvas settles the rest:
 * *"is this already visible somewhere else on this screen?"* Every segment
 * here is — need-you is the headline AND the lane header, doing is the hero
 * caption, done today is the Delivered card. So it earns a line at the bottom
 * of the page and nothing more.
 *
 * Segments with nothing in them are omitted rather than shown as zero: a zero
 * here reads as "none", which is a claim.
 *
 * **Except a segment that is answering for an absorbed lane.** In-motion no
 * longer takes a line in the rail because this bar states "N doing"
 * (`ANSWERED_BY` in `@/pages/hq/hq-tiers`) — so that segment cannot also
 * disappear at zero, or the standing question "is anything running?" would go
 * unanswered on the whole screen, which is the silent absence the lane rules
 * exist to prevent. `keep` is how a segment declares it is carrying that
 * weight.
 */
export function Mv3Census({
  segments,
}: {
  segments: { label: string; value: number; keep?: boolean }[];
}) {
  const navigate = useNavigate();
  const shown = segments.filter((s) => s.keep || s.value > 0);
  if (shown.length === 0) return null;
  return (
    <div
      data-slot="mv3-census"
      style={{
        marginTop: 4,
        padding: "10px 2px 0",
        borderTop: "1px solid var(--mv3-line)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: mv3Mono,
        fontSize: 11,
        color: "var(--mv3-muted)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        {shown.map((s, i) => (
          <span key={s.label}>
            {i > 0 ? " · " : ""}
            <span style={{ color: "var(--mv3-text)" }}>{s.value}</span>{" "}
            {s.label}
          </span>
        ))}
      </span>
      <button
        type="button"
        onClick={() => {
          haptic.light();
          navigate(routes.allWork);
        }}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          fontFamily: "inherit",
          fontSize: 11,
          color: "var(--mv3-micro)",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        All work ›
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Frame 60 — the collapse driver                                             */
/* -------------------------------------------------------------------------- */

/** The element handles the rAF scroll driver writes to. */
interface CollapseRefs {
  scroller: React.RefObject<HTMLDivElement | null>;
  eyebrowRow: React.RefObject<HTMLDivElement | null>;
  greeting: React.RefObject<HTMLDivElement | null>;
  morph: React.RefObject<HTMLDivElement | null>;
  orbitals: React.RefObject<HTMLDivElement | null>;
  guides: React.RefObject<HTMLDivElement | null>;
  caption: React.RefObject<HTMLDivElement | null>;
  barChrome: React.RefObject<HTMLDivElement | null>;
  barRing: React.RefObject<HTMLSpanElement | null>;
  barSlot: React.RefObject<HTMLSpanElement | null>;
  barLiveDot: React.RefObject<HTMLSpanElement | null>;
  barTitle: React.RefObject<HTMLDivElement | null>;
  barRight: React.RefObject<HTMLButtonElement | null>;
}

/**
 * rAF scroll driver — reads scrollTop, writes transform/opacity through the
 * physics maps in ./today-collapse.ts. No React re-render per tick, no
 * per-frame layout reads (geometry is measured on mount/resize only).
 */
function useTodayCollapse(refs: CollapseRefs, hasLive: boolean) {
  useEffect(() => {
    const scroller = refs.scroller.current;
    if (!scroller) return;

    const reducedQuery = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    let geom: RingGeometry | null = null;
    let raf = 0;

    const fade = `opacity ${REDUCED_MOTION_FADE_MS}ms ease`;
    const setFade = (el: HTMLElement | null, on: boolean) => {
      if (el) el.style.transition = on ? fade : "";
    };
    const setOpacity = (el: HTMLElement | null, v: number) => {
      if (el) el.style.opacity = String(v);
    };

    /** Measure the morph start/target centers with the transform cleared. */
    const measure = () => {
      const morph = refs.morph.current;
      const slot = refs.barSlot.current;
      if (!morph || !slot) {
        geom = null;
        return;
      }
      const prev = morph.style.transform;
      morph.style.transform = "";
      const m = morph.getBoundingClientRect();
      const s = slot.getBoundingClientRect();
      morph.style.transform = prev;
      geom = {
        heroCx: m.left + m.width / 2,
        heroCyDoc: m.top + scroller.scrollTop + m.height / 2,
        barCx: s.left + s.width / 2,
        barCy: s.top + s.height / 2,
      };
    };

    const apply = () => {
      raf = 0;
      const y = scroller.scrollTop;
      const reduced = Boolean(reducedQuery?.matches);
      const morph = refs.morph.current;
      const right = refs.barRight.current;

      if (reduced) {
        // Two static states, 200ms cross-fade at threshold 100 (spec).
        const condensed = reducedMode(y) === "condensed";
        for (const el of [
          refs.eyebrowRow.current,
          refs.greeting.current,
          refs.orbitals.current,
          refs.guides.current,
          refs.caption.current,
          refs.barChrome.current,
          refs.barRing.current,
          refs.barLiveDot.current,
          refs.barTitle.current,
          right,
          morph,
        ])
          setFade(el, true);
        if (morph) morph.style.transform = "";
        setOpacity(refs.eyebrowRow.current, condensed ? 0 : 1);
        setOpacity(refs.greeting.current, condensed ? 0 : 1);
        setOpacity(refs.orbitals.current, condensed ? 0 : 1);
        setOpacity(refs.guides.current, condensed ? 0 : 1);
        setOpacity(refs.caption.current, condensed ? 0 : 1);
        setOpacity(morph, condensed ? 0 : 1);
        setOpacity(refs.barChrome.current, condensed ? 1 : 0);
        // Reduced mode swaps in the STATIC 30px bar ring (no morph flight).
        setOpacity(refs.barRing.current, condensed ? 1 : 0);
        setOpacity(refs.barLiveDot.current, condensed && hasLive ? 1 : 0);
        setOpacity(refs.barTitle.current, condensed ? 1 : 0);
        if (right) {
          right.style.opacity = condensed ? "1" : "0";
          right.style.pointerEvents = condensed ? "auto" : "none";
        }
        return;
      }

      // Full physics. Transforms/opacity only; every value is a pure map.
      const chips = chipFade(y);
      const orbitals = refs.orbitals.current;
      if (orbitals) {
        setFade(orbitals, false);
        orbitals.style.opacity = String(chips.opacity);
        orbitals.style.transform = `scale(${chips.scale})`;
      }
      const guides = refs.guides.current;
      if (guides) {
        setFade(guides, false);
        guides.style.opacity = String(guideRingOpacity(y));
      }
      const handoff = ringHandoff(y);
      if (morph && geom) {
        setFade(morph, false);
        // 150–190: hand the visual off to the bar's own ring (above the
        // chrome) — see ringHandoff in today-collapse.ts.
        morph.style.opacity = String(1 - handoff);
        const t = ringTransform(y, geom);
        morph.style.transform = `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})`;
      }
      const gOp = greetingOpacity(y);
      setFade(refs.greeting.current, false);
      setOpacity(refs.greeting.current, gOp);
      setFade(refs.eyebrowRow.current, false);
      setOpacity(refs.eyebrowRow.current, gOp);
      setFade(refs.caption.current, false);
      setOpacity(refs.caption.current, captionOpacity(y));
      setFade(refs.barChrome.current, false);
      setOpacity(refs.barChrome.current, barChromeOpacity(y));
      setFade(refs.barTitle.current, false);
      setOpacity(refs.barTitle.current, condensedTitleOpacity(y));
      // The morphed hero ring carries the flight; the bar's static ring
      // takes over during the 150–190 handoff (it sits ABOVE the chrome).
      setFade(refs.barRing.current, false);
      setOpacity(refs.barRing.current, handoff);
      setFade(refs.barLiveDot.current, false);
      setOpacity(
        refs.barLiveDot.current,
        hasLive ? condensedTitleOpacity(y) : 0,
      );
      if (right) {
        setFade(right, false);
        const t = condensedRightOpacity(y);
        right.style.opacity = String(t);
        right.style.pointerEvents = t > 0.5 ? "auto" : "none";
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const remeasure = () => {
      measure();
      schedule();
    };

    // Initial measure rides one frame after mount so fonts/layout settle.
    const initial = requestAnimationFrame(remeasure);
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", remeasure);
    reducedQuery?.addEventListener?.("change", remeasure);
    return () => {
      cancelAnimationFrame(initial);
      if (raf) cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", remeasure);
      reducedQuery?.removeEventListener?.("change", remeasure);
    };
  }, [refs, hasLive]);
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export function Mv3Today({
  assistantId,
  userName,
  move,
  moveLoading = false,
  review,
  reviewError,
  glanceCount,
  running,
  cameIn,
  done,
  doneError,
  missions,
  missionsError,
  day,
  dayUnavailable,
  lifeGroups,
  lifeUnavailable,
  arrivals,
  arrivalsError,
  waiting,
  waitingUnavailable,
  schedules,
  schedulesError,
  watchingCount,
  heartbeatRuns,
  degraded,
}: {
  assistantId: string;
  userName: string | null;
  move: NextMove;
  /** True while the next-move pick is still computing (skeleton slot). */
  moveLoading?: boolean;
  /** awaiting_review items (next-move item already excluded by HqPage). */
  review: HqWorkItem[];
  reviewError: boolean;
  /**
   * The needs-you number, computed once by HqPage so the badge, the headline
   * and the rows are provably the same set (invariant 2). Mobile must not
   * re-derive it — that is exactly how the two disagreed before.
   */
  glanceCount: number;
  running: HqWorkItem[];
  /** pending (came-in) items. */
  cameIn: HqWorkItem[];
  /** done-today items — the Delivered lane. */
  done: HqWorkItem[];
  doneError: boolean;
  missions: Mission[];
  missionsError: boolean;
  day: DayPicture | null;
  dayUnavailable?: Unavailable;
  lifeGroups: { horizon: Horizon; titles: string[] }[];
  lifeUnavailable?: Unavailable;
  arrivals: ArrivalsSummary;
  arrivalsError: boolean;
  waiting: WaitingItem[];
  waitingUnavailable?: Unavailable;
  schedules: HqSchedule[];
  schedulesError: boolean;
  /** Sources currently observed AND healthy. Existing != working. */
  watchingCount: number;
  heartbeatRuns: number | null;
  degraded: boolean;
}) {
  const navigate = useNavigate();
  // The fixed ☰ / avatar buttons land on the eyebrow row; this is the row's
  // half of that arrangement. See `corner-chrome.ts`.
  const cornerChrome = cornerChromeProps(useLocation().pathname, "row");
  const scrollRef = useRef<HTMLDivElement>(null);
  const eyebrowRowRef = useRef<HTMLDivElement>(null);
  const greetingRef = useRef<HTMLDivElement>(null);
  const morphRef = useRef<HTMLDivElement>(null);
  const orbitalsRef = useRef<HTMLDivElement>(null);
  const guidesRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const barChromeRef = useRef<HTMLDivElement>(null);
  const barRingRef = useRef<HTMLSpanElement>(null);
  const barSlotRef = useRef<HTMLSpanElement>(null);
  const barLiveDotRef = useRef<HTMLSpanElement>(null);
  const barTitleRef = useRef<HTMLDivElement>(null);
  const barRightRef = useRef<HTMLButtonElement>(null);

  const collapseRefs = useMemo<CollapseRefs>(
    () => ({
      scroller: scrollRef,
      eyebrowRow: eyebrowRowRef,
      greeting: greetingRef,
      morph: morphRef,
      orbitals: orbitalsRef,
      guides: guidesRef,
      caption: captionRef,
      barChrome: barChromeRef,
      barRing: barRingRef,
      barSlot: barSlotRef,
      barLiveDot: barLiveDotRef,
      barTitle: barTitleRef,
      barRight: barRightRef,
    }),
    [],
  );
  useTodayCollapse(collapseRefs, running.length > 0);

  // One-tap ✕ dismiss on review cards, with the shared 5s undo pill.
  const { dismiss, gone, leavingId, toastNode } = useDismissTask(assistantId);

  /**
   * Runs stopped at a checkpoint — the same source as the HQ board's needs-you
   * lane, with the tool input fetched for the ones on screen so the sheet can
   * state the amount and the recipient rather than guess at them.
   */
  const paused = usePausedRuns(assistantId);

  // Stamped once per mount — reading the clock during render is impure. The
  // day strip's segments would otherwise slide on every unrelated re-render.
  const [hour] = useState(() => new Date().getHours());
  // Ticks per minute, and feeds ONLY the day strip. The rail's bounds don't
  // move, but "is that free block still ahead of me?" does, and a session left
  // open across the gap would otherwise keep offering time that had gone.
  const [mountedMs] = useState(() => Date.now());
  const nowMs = useDayClock(mountedMs);
  /**
   * The delivered count, minted from the lane's own answer. `Queried` cannot be
   * built from a literal, so the sentence physically cannot claim a number the
   * deck did not ask for — a lane we could not read contributes nothing rather
   * than a zero.
   */
  const deliveredCount = counted(
    doneError ? unavailable<HqWorkItem[]>("unreadable") : known(done),
    (items) => items.length,
  );
  const needsYouHeadline = reviewError
    ? "I couldn't read your queue."
    : glanceCount === 0
      ? "Nothing needs you."
      : `${glanceCount} ${glanceCount === 1 ? "needs" : "need"} you.`;
  // (The owner's initial used to be derived here, defaulting to a hardcoded
  // "M". It moved to `Mv3OverflowMenu` along with the chip that rendered it,
  // and the fallback there is `☺` — a letter nobody is named beats a letter
  // that looks like a name Cue does not actually know.)
  const greeting = userName
    ? `Good ${dayPart()}, ${userName}.`
    : `Good ${dayPart()}.`;

  // Defense-in-depth dedupe (QA night P1-12): HqPage already drops the review
  // item whose id the next move names, but the daemon's LLM-phrased move can
  // reference a review item WITHOUT a matching itemId (stale/paraphrased) —
  // then the same task shows as NEXT MOVE and a REVIEW READY card. The move
  // usually phrases itself AROUND the title ("Run: <title>"), so a reasonably
  // long title contained in the headline counts as the same item.
  const reviewShown = useMemo(() => {
    const visible = review.filter((item) => !gone.has(item.id));
    if (!move.hasMove) return visible;
    const headline = move.headline.trim().toLowerCase();
    const isTheMove = (title: string): boolean => {
      const t = title.trim().toLowerCase();
      if (!headline || !t) return false;
      return t === headline || (t.length >= 12 && headline.includes(t));
    };
    return visible.filter(
      (item) => item.id !== move.itemId && !isTheMove(item.title),
    );
  }, [review, gone, move.hasMove, move.headline, move.itemId]);

  /**
   * First-morning empty state (frame 22): the orbit waits — dashed, still,
   * inviting — instead of a blank card stack.
   *
   * v7 narrows when this is allowed to take the screen. A screen-owning empty
   * is for the NOT-SET-UP case, and nothing else: an account with watchers
   * running and a genuinely quiet morning must get the deck, because "0 need
   * you" is a real number and the Tier-1 cards are what state it. Taking the
   * whole screen there would hide the delivered lane, the missions lane and the
   * four honest lines behind a picture.
   */
  const everyLaneEmpty =
    !move.hasMove &&
    paused.runs.length === 0 &&
    reviewShown.length === 0 &&
    running.length === 0 &&
    cameIn.length === 0 &&
    done.length === 0 &&
    missions.length === 0;
  const orbitEmpty = everyLaneEmpty && watchingCount === 0;

  // Orbit chips = the active work streams (running items), spec hues per slot.
  const chips: OrbitChip[] = useMemo(
    () =>
      running.slice(0, 3).map((item, i) => ({
        color: CHIP_COLORS[i],
        icon: (
          <span style={{ fontSize: 12, lineHeight: 1 }} aria-hidden>
            {sourceBadge(item.sourceType).glyph}
          </span>
        ),
      })),
    [running],
  );

  const lanes = buildMv3Lanes({
    glanceCount,
    reviewError,
    done,
    doneError,
    missions,
    missionsError,
    running,
    cameIn,
    day,
    dayUnavailable,
    lifeGroups,
    lifeUnavailable,
    arrivals,
    arrivalsError,
    waiting,
    waitingUnavailable,
    schedules,
    schedulesError,
    watchingCount,
    heartbeatRuns,
    cards: {
      needsYou: (count) => (
        <NeedsYouV3
          assistantId={assistantId}
          move={move}
          moveLoading={moveLoading}
          pausedRuns={paused.runs}
          review={reviewShown}
          count={count}
          leavingId={leavingId}
          onDismiss={dismiss}
        />
      ),
      delivered: (items) => <DeliveredV3 items={items} delay={0.25} />,
      missions: (ms) => <MissionsV3 missions={ms} delay={0.4} />,
    },
  });
  // Cards and lines come out of the SAME roster, so nothing can fall between
  // them: `laneSlotsFor` throws if a slot is neither a card, a line nor a
  // warranted absence — and if a standing lane is the absence. `Mv3TierRail`
  // reads the same roster for the line half.
  const { cards: tierCards } = laneSlotsFor(lanes);

  /**
   * Everything the deck already holds, handed to the `⌗` scan purely so it can
   * skip a round-trip per item it can already see. An optimisation and nothing
   * more: an un-comprehended item is excluded from every one of these list
   * reads, so it can never appear here and a partial set can never drop a `⌗`.
   */
  const knownWorkItemIds = new Set(
    [...review, ...cameIn, ...running, ...done].map((item) => item.id),
  );

  if (orbitEmpty && !paused.isLoading) {
    // Keep the undo pill alive if dismissing the last card emptied the orbit.
    return (
      <>
        <EmptyOrbit />
        {toastNode}
      </>
    );
  }

  const watchLive = () => {
    haptic.light();
    const first = running[0];
    if (first) navigate(routes.workLive(first.id));
    else navigate(routes.allWork);
  };

  return (
    <div
      data-mv3
      data-slot="mv3-today"
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />

      {/* ── Frame 60: the pinned condensed bar (invisible at rest). ─────────
          The overlay never takes pointer events except the right slot once
          it's visible; the page scrolls underneath. */}
      <div
        data-slot="mv3-today-condensed-bar"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 4,
          pointerEvents: "none",
        }}
      >
        {/* Hairline + blur backdrop — fades in 120–200. Opacity carries the
            blur with it (one composited layer, no per-frame filter writes). */}
        <div
          ref={barChromeRef}
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: "color-mix(in srgb, var(--mv3-bg) 62%, transparent)",
            borderBottom: "1px solid var(--mv3-line)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            opacity: 0,
          }}
        />
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: `calc(${SAFE_TOP} + 8px) 20px 10px`,
          }}
        >
          {/* Bar-left ring slot: the morph target. The static 30px ring
              inside only shows under reduced motion (the animated path flies
              the hero ring in instead). Live-dot rides on top either way. */}
          <span
            ref={barSlotRef}
            style={{
              position: "relative",
              width: 30,
              height: 30,
              flexShrink: 0,
            }}
          >
            <span ref={barRingRef} style={{ opacity: 0, display: "block" }}>
              <CueRing size={30} stroke="var(--mv3-text)" />
            </span>
            <span
              ref={barLiveDotRef}
              aria-hidden
              style={{
                position: "absolute",
                right: -2,
                top: -2,
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "var(--mv3-accent)",
                border: "2px solid var(--mv3-bg)",
                opacity: 0,
              }}
            />
          </span>
          {/* Condensed title — 16/700 (intentional per frame 60, vs the
              shared header's 17/600; keep as drawn). */}
          <div
            ref={barTitleRef}
            style={{
              flex: 1,
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: "-0.3px",
              opacity: 0,
            }}
          >
            Today
          </div>
          <button
            ref={barRightRef}
            type="button"
            className="cue-pressable"
            aria-label={
              running.length > 0
                ? `Working on ${running.length} — watch live`
                : "Nothing running"
            }
            onClick={watchLive}
            style={{
              fontSize: 11,
              color: "var(--mv3-micro)",
              background: "none",
              border: "none",
              // ≥44pt target for the 15px-tall link.
              padding: "14px 0 14px 14px",
              margin: "-14px 0",
              minHeight: 44,
              cursor: "pointer",
              fontFamily: "inherit",
              opacity: 0,
              pointerEvents: "none",
            }}
          >
            {running.length > 0 ? `working on ${running.length} ›` : ""}
          </button>
        </div>
      </div>

      {/* ── ONE page scroll (frame 60: no inner region). ──────────────────── */}
      <div
        ref={scrollRef}
        style={{
          position: "relative",
          zIndex: 2,
          height: "100%",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {/* Hero zone — 285px at rest, condensing to the 56px bar over
            scrollY 0–200 by scroll consumption + transform/opacity (heights
            never animate). */}
        <div style={{ padding: `calc(${SAFE_TOP} + 6px) 22px 0` }}>
          <div
            ref={eyebrowRowRef}
            {...cornerChrome}
            style={{
              display: "flex",
              alignItems: "center",
              // The corner chrome (`Mv3OverflowMenu`) is FIXED-position: two
              // 34px buttons on an 18px gutter, at this same safe-area offset.
              // This row is the only content that shares their band, and it was
              // sliding underneath the left one — "SUNDAY · 2 AUG" rendered as
              // a ☰ button with "DAY · 2 AUG" beside it. The insets are the
              // buttons' outer edges (18 + 34) less this container's own 22px
              // padding, plus a gap.
              // Holds the band open to the buttons' height too. The avatar
              // `<span>` that used to sit in this row was doing this
              // incidentally; when it moved into the corner chrome the hero
              // jumped 21px up. Spread from `cornerChromeProps` rather than
              // written out, so `corner-chrome.test.tsx` can see this header.
              ...cornerChrome.style,
            }}
          >
            <div
              style={{
                fontFamily: mv3Mono,
                fontSize: 11,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--mv3-micro)",
              }}
            >
              {dateEyebrow()}
            </div>
            {/*
              The avatar that used to sit here was a `<span>`. It carried the
              owner's initial in the exact corner design assigns to the
              settings door — and it did nothing. The live affordance was an
              anonymous `◍` circle inset 62px beside it, so the element that
              looked like the door was dead and the one that worked looked
              like decoration.

              `Mv3OverflowMenu` now renders the initial, in this position, as
              a real button. It is fixed-position chrome from the root layout,
              which is why nothing replaces the node here: leaving a spacer
              would only re-create the collision at a smaller size. The eyebrow
              row keeps `space-between` so the date still sits left of it.
            */}
          </div>
          {/* Greeting + headline — fade out 40–100 as "Today" takes over
              100–160. **The headline IS the number** (v8 M2): the big line is
              what needs you, and the delivery sentence underneath carries the
              receipts. Both read counts the deck actually queried — a lane we
              could not ask contributes nothing rather than a zero. */}
          <div ref={greetingRef} style={{ marginTop: 4 }}>
            <div
              style={{
                fontSize: 13.5,
                color: "var(--mv3-muted)",
                lineHeight: 1.3,
              }}
            >
              {greeting}
            </div>
            <div
              style={{
                fontSize: 29,
                fontWeight: 700,
                letterSpacing: "-0.8px",
                lineHeight: 1.08,
                marginTop: 2,
              }}
            >
              {needsYouHeadline}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--mv3-muted)",
                marginTop: 4,
                lineHeight: 1.4,
              }}
            >
              {deliverySentence(deliveredCount, null, hour)}
            </div>
          </div>
        </div>

        {degraded ? (
          <div
            role="status"
            style={{
              textAlign: "center",
              fontFamily: mv3Mono,
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--mv3-faint)",
              padding: "4px 0 0",
            }}
          >
            Reconnecting to Cue…
          </div>
        ) : null}

        <CueRingHero
          chips={chips}
          caption={
            running.length > 0
              ? `Working on ${running.length} ${running.length === 1 ? "thing" : "things"} for you`
              : undefined
          }
          morphRef={morphRef}
          orbitalsRef={orbitalsRef}
          guidesRef={guidesRef}
          captionRef={captionRef}
        />

        {/*
          Card stack — rides the same page scroll (frame 60).

          Three Tier-1 cards, then the rail, then the census as the footer.
          Nothing docks over this stack any more, so the bottom padding is a
          margin rather than the clearance the census used to need.
        */}
        <div style={{ padding: "4px 16px 24px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/*
              C1's order, top to bottom: day strip · paused run · needs-you ·
              going-quiet person · ⌗ couldn't-read · delivered · Tier-3 lines.
              The paused run leads the needs-you stack (nothing continues until
              it is answered), which is why it is not a separate slot here.
            */}
            <Mv3DayStrip
              day={day}
              unavailable={dayUnavailable}
              nowMs={nowMs}
              style={rise(0.06)}
            />
            {tierCards.map((slot) => (
              <Fragment key={slot.id}>
                <div data-lane={slot.id}>{slot.node}</div>
                {slot.id === "needs_you" ? (
                  <>
                    {/* The People prompt, relocated. Named people beat a badge
                        that can only ever say a number. */}
                    <Mv3GoingQuietRows
                      waiting={waiting}
                      unavailable={waitingUnavailable}
                    />
                    {/* What Cue read and could not name. Neutral, no tint. */}
                    <Mv3UnreadableRows
                      assistantId={assistantId}
                      knownWorkItemIds={knownWorkItemIds}
                    />
                  </>
                ) : null}
              </Fragment>
            ))}
            {/* The rail — four lines, always present, carrying the same
                honest statements desktop shows, including "0 need you". */}
            <Mv3TierRail lanes={lanes} style={rise(0.55)} />
            {/* The census closes the page rather than floating over it.
                "Cue is doing" is `keep`: it carries the in-motion lane's
                answer, which is why that lane takes no line in the rail — so
                it still has to be on the screen, just not on top of it. */}
            <Mv3Census
              segments={[
                { label: "need you", value: glanceCount },
                { label: "Cue is doing", value: running.length, keep: true },
                { label: "waiting", value: cameIn.length },
                { label: "done today", value: done.length },
              ]}
            />
          </div>
        </div>
      </div>
      {toastNode}
    </div>
  );
}
