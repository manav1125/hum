/**
 * Mv3Today — the mobile v3 Today screen (spec frame 1 dark / 12 light): the
 * daily hook. Replaces the MOBILE rendering of HqPage only; desktop keeps the
 * serif HQ deck untouched.
 *
 * Layout (spec-verbatim): date eyebrow + avatar → "Good morning, Manav."
 * large title → CueRing hero with orbit chips + "Working on N things for
 * you" → the card stack: NEXT MOVE → NEEDS YOUR OK (amber, Approve/Deny) →
 * REVIEW READY (violet) → WORKING NOW rows → "Came in today" strip.
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
import { useMemo, useRef } from "react";
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
  nextMoveQueryKey,
  type NextMove,
  type NextMoveAction,
} from "@/pages/command-center/use-next-move";
import { sourceBadge } from "@/pages/hq/hq-kit";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { CueRingHero, type OrbitChip } from "../cue-ring";
import { EmptyOrbit } from "../empty-orbit";
import { GlassCard } from "../glass-card";
import { LargeTitleHeader } from "../large-title-header";
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
      const opts = { url: action.endpoint, throwOnError: true } as const;
      if (method === "GET") await client.get(opts);
      else if (method === "PATCH") await client.patch(opts);
      else if (method === "DELETE") await client.delete(opts);
      else await client.post(opts);
    },
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
  const title =
    interaction.toolName ?? interaction.kind ?? "Approval required";
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
    <GlassCard tint="violet" style={{ ...rise(delay), ...dismissLeave(leaving) }}>
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
            boxShadow: "0 12px 26px -10px color-mix(in srgb, #7F77DD 50%, transparent)",
          }}
        >
          Review
        </button>
      </div>
    </GlassCard>
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
      <span style={{ fontSize: 13, color: "var(--mv3-muted)", flex: 1 }}>
        Came in today ·{" "}
        <b style={{ color: "var(--mv3-text)", fontWeight: 600 }}>
          {filed > 0 ? `${filed} auto-filed` : `${items.length} captured`}
        </b>
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
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export function Mv3Today({
  assistantId,
  userName,
  move,
  review,
  running,
  cameIn,
  degraded,
}: {
  assistantId: string;
  userName: string | null;
  move: NextMove;
  /** awaiting_review items (next-move item already excluded by HqPage). */
  review: HqWorkItem[];
  running: HqWorkItem[];
  /** pending (came-in) items. */
  cameIn: HqWorkItem[];
  degraded: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

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
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />

      <LargeTitleHeader
        eyebrow={dateEyebrow()}
        title={greeting}
        scrollRef={scrollRef}
        trailing={
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
        }
      />

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
            position: "relative",
            zIndex: 2,
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
      />

      {/* Card stack — the only scrolling region (header + hero stay put). */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 16px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <NextMoveV3 assistantId={assistantId} move={move} />
          {approvals.slice(0, 2).map((interaction) => (
            <NeedsOkV3
              key={interaction.requestId}
              assistantId={assistantId}
              interaction={interaction}
              delay={nextDelay()}
            />
          ))}
          {reviewShown.slice(0, 2).map((item) => (
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
      {toastNode}
    </div>
  );
}
