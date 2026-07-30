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
import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import {
  confirmPostMutation,
  pendinginteractionsGetOptions,
  pendinginteractionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { client } from "@/generated/daemon/client.gen";
import { relativeTime } from "@/domains/activity/theme";
import {
  buildActionBody,
  nextMoveQueryKey,
  type NextMove,
  type NextMoveAction,
} from "@/pages/command-center/use-next-move";
import { holdsForYou } from "@/pages/hq/assessment-kit";
import { sourceBadge } from "@/pages/hq/hq-kit";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { CueRing, CueRingHero, type OrbitChip } from "../cue-ring";
import { EmptyOrbit } from "../empty-orbit";
import { GlassCard } from "../glass-card";
import { StateChip } from "../state-chip";
import { DismissX, dismissLeave, useDismissTask } from "../undo-toast";
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

interface PendingInteraction {
  requestId: string;
  kind?: string | null;
  toolName?: string | null;
}

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

/** NEEDS YOUR OK — a real pending approval, amber, Approve/Deny. */
function NeedsOkV3({
  assistantId,
  interaction,
  delay,
}: {
  assistantId: string;
  interaction: PendingInteraction;
  delay: number;
}) {
  const queryClient = useQueryClient();
  const key = pendinginteractionsGetQueryKey({
    path: { assistant_id: assistantId },
  });
  const decide = useMutation({
    ...confirmPostMutation(),
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const title = interaction.toolName ?? interaction.kind ?? "Approval required";
  return (
    <GlassCard tint="amber" style={rise(delay)}>
      <div style={{ ...microLabel, color: "var(--mv3-amber)" }}>
        ‖ Needs your OK
      </div>
      <div style={{ ...cardTitle, fontSize: 15.5 }}>{title}</div>
      <div style={{ ...cardBody, fontSize: 12.5 }}>
        Cue paused for your decision before it continues.
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
        <button
          type="button"
          className="cue-pressable"
          disabled={decide.isPending}
          onClick={() => {
            haptic.medium();
            decide.mutate({
              path: { assistant_id: assistantId },
              body: { requestId: interaction.requestId, decision: "allow" },
            });
          }}
          style={{
            ...primaryBtn,
            background: "var(--mv3-amber)",
            color: "var(--mv3-amber-btn-text)",
            boxShadow: "none",
            opacity: decide.isPending ? 0.6 : 1,
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="cue-pressable"
          disabled={decide.isPending}
          onClick={() => {
            haptic.medium();
            decide.mutate({
              path: { assistant_id: assistantId },
              body: { requestId: interaction.requestId, decision: "deny" },
            });
          }}
          style={{ ...secondaryBtn, color: "var(--mv3-muted)" }}
        >
          Deny
        </button>
      </div>
    </GlassCard>
  );
}

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
            background: "var(--mv3-violet-fill)",
            boxShadow:
              "0 12px 26px -10px color-mix(in srgb, #7F77DD 50%, transparent)",
          }}
        >
          Review
        </button>
      </div>
    </GlassCard>
  );
}

/** Review cards shown inline on Today before "See all" takes over. */
const REVIEW_SHOWN_MAX = 2;

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

/** The 3-bar live equalizer (spec: 2px bars, 12px tall, staggered mv3Bar). */
function LiveBarsV3() {
  return (
    <span
      aria-hidden
      style={{ display: "flex", gap: 1.5, height: 12, alignItems: "center" }}
    >
      {[0, 0.3, 0.6].map((d) => (
        <span
          key={d}
          style={{
            width: 2,
            height: "100%",
            background: "var(--mv3-accent)",
            borderRadius: 1,
            animation: `mv3Bar .9s ease-in-out ${d}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

/** WORKING NOW — running items with live movement + Watch. */
function WorkingNowV3({
  running,
  delay,
}: {
  running: HqWorkItem[];
  delay: number;
}) {
  const navigate = useNavigate();
  if (running.length === 0) return null;
  const watch = () => {
    haptic.light();
    // Watch live (frame 17) — the running item's step stream.
    const first = running[0];
    if (first) navigate(routes.workLive(first.id));
    else navigate(routes.allWork);
  };
  return (
    <GlassCard padding="12px 17px" style={rise(delay)}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 9,
        }}
      >
        <span style={{ ...microLabel, color: "var(--mv3-muted)" }}>
          Working now · {running.length}
        </span>
        <button
          type="button"
          onClick={watch}
          style={{
            marginLeft: "auto",
            fontSize: 11.5,
            color: "var(--mv3-micro)",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Watch ›
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {running.slice(0, 3).map((item, i) => (
          <div key={item.id} style={{ opacity: i === 0 ? 1 : 0.75 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <LiveBarsV3 />
              <span
                style={{
                  fontSize: 13,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--mv3-text)",
                }}
              >
                {item.title}
              </span>
              {item.updatedAt ? (
                <span style={{ fontSize: 11.5, color: "var(--mv3-faint)" }}>
                  {relativeTime(item.updatedAt)}
                </span>
              ) : null}
            </div>
            {item.lastProgressNote ? (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  marginTop: 3,
                  paddingLeft: 17,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.lastProgressNote}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

/** "Came in today · N auto-filed / See all ›" strip (not a card). */
function CameInStripV3({
  items,
  delay,
}: {
  items: HqWorkItem[];
  delay: number;
}) {
  const navigate = useNavigate();
  if (items.length === 0) return null;
  const filed = items.filter((i) => i.projectId != null).length;
  // The pre-run verdicts that WAIT on a person (a question Cue needs answered,
  // or something it is missing). Only these are called out — a captured item
  // Cue can simply do gets no badge.
  const held = items.filter((i) => holdsForYou(i) != null).length;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "2px 6px",
        ...rise(delay),
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 8,
          background: "color-mix(in srgb, var(--mv3-accent) 15%, transparent)",
          color: "var(--mv3-micro)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          flexShrink: 0,
        }}
      >
        ↴
      </span>
      <span
        style={{
          fontSize: 13,
          color: "var(--mv3-muted)",
          flex: 1,
          minWidth: 0,
        }}
      >
        Came in today ·{" "}
        <b style={{ color: "var(--mv3-text)", fontWeight: 600 }}>
          {filed > 0 ? `${filed} auto-filed` : `${items.length} captured`}
        </b>
        {held > 0 ? (
          <span style={{ display: "block", marginTop: 3 }}>
            <StateChip
              state="needs_you"
              size="sm"
              label={held === 1 ? "1 waits on you" : `${held} wait on you`}
            />
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => {
          haptic.light();
          // Swipe-triage surface (frame 15).
          navigate(routes.cameIn);
        }}
        style={{
          fontSize: 12,
          color: "var(--mv3-micro)",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        See all ›
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
  running,
  cameIn,
  degraded,
}: {
  assistantId: string;
  userName: string | null;
  move: NextMove;
  /** True while the next-move pick is still computing (skeleton slot). */
  moveLoading?: boolean;
  /** awaiting_review items (next-move item already excluded by HqPage). */
  review: HqWorkItem[];
  running: HqWorkItem[];
  /** pending (came-in) items. */
  cameIn: HqWorkItem[];
  degraded: boolean;
}) {
  const navigate = useNavigate();
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

  // Real pending approvals (same source as the HQ board's Needs-you lane).
  const interactionsQuery = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });
  const approvals = (interactionsQuery.data?.interactions ??
    []) as PendingInteraction[];

  const initial = (userName ?? "").trim().charAt(0).toUpperCase() || "M";
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

  // First-morning empty state (frame 22): when every slot is empty, the orbit
  // waits — dashed, still, inviting — instead of a blank card stack. The
  // early return lives BELOW the last hook (chips useMemo) per hooks rules.
  const orbitEmpty =
    !move.hasMove &&
    approvals.length === 0 &&
    reviewShown.length === 0 &&
    running.length === 0 &&
    cameIn.length === 0;

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

  if (orbitEmpty && !interactionsQuery.isLoading) {
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

  // Stagger delays follow the spec's cadence (.1/.25/.4/.55) across whatever
  // slots actually rendered.
  let slot = 0;
  const nextDelay = () => 0.1 + 0.15 * slot++;
  if (move.hasMove) slot = 1; // NextMove takes .1 itself

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
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
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
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "var(--mv3-avatar-bg)",
                border: "1px solid var(--mv3-avatar-border)",
                boxShadow: "var(--mv3-avatar-shadow)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 600,
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
            >
              {initial}
            </span>
          </div>
          {/* Greeting — fades out 40–100 as "Today" takes over 100–160. */}
          <div
            ref={greetingRef}
            style={{
              fontSize: 29,
              fontWeight: 700,
              letterSpacing: "-0.8px",
              marginTop: 4,
              lineHeight: 1.08,
            }}
          >
            {greeting}
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

        {/* Card stack — rides the same page scroll (frame 60). */}
        <div style={{ padding: "4px 16px 16px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {moveLoading && !move.hasMove ? (
              // Reserve the Next-move slot while the pick computes so the card
              // streaming in later never shoves the Review cards down mid-read.
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
            ) : (
              <NextMoveV3 assistantId={assistantId} move={move} />
            )}
            {approvals.slice(0, 2).map((interaction) => (
              <NeedsOkV3
                key={interaction.requestId}
                assistantId={assistantId}
                interaction={interaction}
                delay={nextDelay()}
              />
            ))}
            {reviewShown.length > REVIEW_SHOWN_MAX ? (
              <ReviewSeeAllStrip total={reviewShown.length} />
            ) : null}
            {reviewShown.slice(0, REVIEW_SHOWN_MAX).map((item) => (
              <ReviewV3
                key={item.id}
                item={item}
                delay={nextDelay()}
                leaving={leavingId === item.id}
                onDismiss={() => dismiss(item)}
              />
            ))}
            <WorkingNowV3 running={running} delay={nextDelay()} />
            <CameInStripV3 items={cameIn} delay={nextDelay()} />
          </div>
        </div>
      </div>
      {toastNode}
    </div>
  );
}
