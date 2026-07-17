/**
 * HQ work-loop board — the five-lane body of the hybrid HQ layout. The rings
 * hero + capture bar sit above this; the board reads the loop left-to-right:
 *
 *   Inbound → Running → Needs you → Review → Done
 *
 * Every lane speaks the same state vocabulary (StateBadge) and attributes work
 * to a named agent (AgentChip). Running cards show live movement — the agent's
 * latest progress note + the animated equalizer — so you can watch tasks move.
 * Each lane owns a calm empty state; an empty "Needs you" is the goal, and
 * says so. Data comes straight from the HQ hooks; nothing is fabricated.
 */
import { AgentChip, StateBadge } from "@vellumai/design-library";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { useNavigate } from "react-router";

import {
  confirmPostMutation,
  pendinginteractionsGetOptions,
  pendinginteractionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { relativeTime } from "@/domains/activity/theme";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

import { C, LiveBars, mono, sourceBadge } from "./hq-kit";
import { useAgentFor } from "./hq-agent-identity";
import type { HqWorkItem, Mission } from "./use-missions";

type ByProject = Map<string, Mission>;

/* -------------------------------------------------------------------------- */
/* Lane shell                                                                 */
/* -------------------------------------------------------------------------- */

const LANE_ACCENT: Record<string, string> = {
  capture: C.blue,
  running: C.blue,
  needsyou: C.amber ?? "#B4770F",
  review: C.violet ?? "#7F77DD",
  done: C.green,
};

function Lane({
  state,
  label,
  count,
  children,
  empty,
  coach,
  order,
}: {
  state: "capture" | "running" | "needsyou" | "review" | "done";
  label: string;
  count: number;
  children: ReactNode;
  empty: ReactNode;
  /** `data-coach` anchor for the guided first-step tour, when this lane is one. */
  coach?: string;
  /** Visual order — used on mobile to sort the stream by what needs you. */
  order?: number;
}) {
  return (
    <div
      data-coach={coach}
      style={{ display: "flex", flexDirection: "column", minWidth: 0, order }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "0 2px 8px",
          borderBottom: `2px solid ${LANE_ACCENT[state] ?? C.line}`,
          marginBottom: 10,
        }}
      >
        <StateBadge state={state} size="sm" label={label} />
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            color: C.t3,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {count === 0 ? empty : children}
      </div>
    </div>
  );
}

function LaneEmpty({ glyph, text }: { glyph: string; text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "12px 12px",
        border: `1px dashed ${C.line}`,
        borderRadius: 10,
        background: "transparent",
        fontSize: 12,
        color: C.t3,
        lineHeight: 1.4,
      }}
    >
      <span aria-hidden style={{ color: C.t3, flexShrink: 0 }}>
        {glyph}
      </span>
      <span>{text}</span>
    </div>
  );
}

function cardShell(accent: string): React.CSSProperties {
  return {
    background: C.surface,
    border: `1px solid ${C.line}`,
    borderLeft: `3px solid ${accent}`,
    borderRadius: 10,
    padding: "10px 11px",
    textAlign: "left",
    width: "100%",
    cursor: "default",
  };
}

const titleStyle: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: C.ink,
  lineHeight: 1.3,
  marginTop: 6,
};

function AgentLine({
  assignee,
  detail,
}: {
  assignee: string | null | undefined;
  detail?: string | null;
}) {
  const agent = useAgentFor(assignee);
  if (!agent) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <AgentChip
        name={agent.name}
        emoji={agent.emoji}
        detail={detail ?? undefined}
        size="sm"
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Lane cards                                                                  */
/* -------------------------------------------------------------------------- */

function InboundCard({ item }: { item: HqWorkItem }) {
  const badge = sourceBadge(item.sourceType);
  return (
    <div style={cardShell(C.blue)}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <StateBadge state="capture" size="sm" showLabel={false} />
        <span
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            color: C.t3,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {badge.glyph} {item.sourceType ?? "captured"}
        </span>
      </div>
      <div style={titleStyle}>{item.title}</div>
      <AgentLine assignee={item.assignee} />
    </div>
  );
}

function RunningCard({ item }: { item: HqWorkItem }) {
  return (
    <div style={cardShell(C.blue)}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <StateBadge state="running" size="sm" />
        <LiveBars color={C.blue} />
      </div>
      <div style={titleStyle}>{item.title}</div>
      {/* Live movement — the agent's latest progress line, updated over SSE. */}
      <div
        style={{
          fontSize: 11.5,
          color: C.t2,
          marginTop: 6,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.lastProgressNote ?? "Working…"}
      </div>
      <AgentLine assignee={item.assignee} />
    </div>
  );
}

interface PendingInteraction {
  requestId: string;
  kind?: string | null;
  toolName?: string | null;
  riskLevel?: string | null;
}

function NeedsYouCardRow({
  interaction,
  assistantId,
}: {
  interaction: PendingInteraction;
  assistantId: string;
}) {
  const queryClient = useQueryClient();
  const key = pendinginteractionsGetQueryKey({
    path: { assistant_id: assistantId },
  });
  const decide = useMutation({
    ...confirmPostMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const accent = C.amber ?? "#B4770F";
  return (
    <div style={cardShell(accent)}>
      <StateBadge state="needsyou" size="sm" />
      <div style={titleStyle}>
        {interaction.toolName ?? interaction.kind ?? "Approval required"}
      </div>
      <div style={{ fontSize: 11.5, color: C.t2, marginTop: 4 }}>
        Cue paused for your decision before it continues.
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate({
              path: { assistant_id: assistantId },
              body: { requestId: interaction.requestId, decision: "allow" },
            })
          }
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            background: accent,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          Approve &amp; finish
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate({
              path: { assistant_id: assistantId },
              body: { requestId: interaction.requestId, decision: "deny" },
            })
          }
          style={{
            fontSize: 11.5,
            background: "transparent",
            color: C.t2,
            border: `1px solid ${C.line}`,
            borderRadius: 8,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

function ReviewCard({
  item,
  onOpen,
}: {
  item: HqWorkItem;
  onOpen: () => void;
}) {
  const accent = C.violet ?? "#7F77DD";
  return (
    <div style={cardShell(accent)}>
      <StateBadge state="review" size="sm" />
      <div style={titleStyle}>{item.title}</div>
      <div style={{ fontSize: 11.5, color: C.t2, marginTop: 4 }}>
        Cue finished this — it waits for your yes.
      </div>
      <AgentLine assignee={item.assignee} />
      <button
        type="button"
        onClick={onOpen}
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          background: accent,
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "6px 12px",
          cursor: "pointer",
          marginTop: 9,
        }}
      >
        Review &rarr; done
      </button>
    </div>
  );
}

function DoneCard({ item, onOpen }: { item: HqWorkItem; onOpen: () => void }) {
  // Autonomy provenance ("auto" | "you_approved" | "manual"), derived
  // server-side from the guardian ledger — never labels a human-approved run
  // "auto". Falls back to the relative time when provenance is unknown.
  const detail =
    item.ranProvenance === "auto"
      ? "auto"
      : item.ranProvenance === "you_approved"
        ? "you approved"
        : item.ranProvenance === "manual"
          ? "done by you"
          : item.updatedAt
            ? relativeTime(item.updatedAt)
            : undefined;
  return (
    <button type="button" onClick={onOpen} style={cardShell(C.green)}>
      <StateBadge state="done" size="sm" />
      <div style={titleStyle}>{item.title}</div>
      <AgentLine assignee={item.assignee} detail={detail} />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Board                                                                      */
/* -------------------------------------------------------------------------- */

export function HqWorkLoopBoard({
  assistantId,
  inbound,
  running,
  review,
  done,
}: {
  assistantId: string;
  /** Optional — when omitted, the Inbound lane is hidden (a 4-lane board);
   *  used when the surface shows a richer came-in strip above the board. */
  inbound?: HqWorkItem[];
  running: HqWorkItem[];
  review: HqWorkItem[];
  done: HqWorkItem[];
  byProject: ByProject;
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const interactionsQuery = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });
  const needsYou = (interactionsQuery.data?.interactions ??
    []) as PendingInteraction[];

  const openItem = (item: HqWorkItem) => {
    if (item.lastRunConversationId) {
      navigate(routes.conversation(item.lastRunConversationId));
    } else {
      navigate(routes.allWork);
    }
  };

  return (
    <div style={{ marginTop: 16 }} data-coach="hq-lanes">
      {/* Desktop reads the loop left-to-right. Mobile collapses the lanes into
          one scannable stream ordered by what needs you (design: v2 §C) —
          same badges, same verbs — rather than a side-scrolling board. */}
      <div
        style={{ overflowX: isMobile ? "visible" : "auto", paddingBottom: 4 }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile
              ? "minmax(0, 1fr)"
              : `repeat(${inbound ? 5 : 4}, minmax(190px, 1fr))`,
            gap: 12,
            alignItems: "start",
          }}
        >
          {inbound ? (
            <Lane
              state="capture"
              label="Inbound"
              order={isMobile ? 4 : undefined}
              count={inbound.length}
              empty={
                <LaneEmpty
                  glyph="↴"
                  text="All caught up. New commitments from your channels land here automatically."
                />
              }
            >
              {inbound.slice(0, 6).map((item) => (
                <InboundCard key={item.id} item={item} />
              ))}
            </Lane>
          ) : null}

          <Lane
            state="running"
            label="Running"
            order={isMobile ? 3 : undefined}
            coach="hq-agents"
            count={running.length}
            empty={
              <LaneEmpty
                glyph="◔"
                text="Idle — nothing running. Confirm something in Inbound and Cue picks it up."
              />
            }
          >
            {running.slice(0, 6).map((item) => (
              <RunningCard key={item.id} item={item} />
            ))}
          </Lane>

          <Lane
            state="needsyou"
            label="Needs you"
            order={isMobile ? 1 : undefined}
            count={needsYou.length}
            empty={
              <LaneEmpty
                glyph="✓"
                text="Nothing needs you. Cue surfaces anything that needs a decision here."
              />
            }
          >
            {needsYou.slice(0, 6).map((it) => (
              <NeedsYouCardRow
                key={it.requestId}
                interaction={it}
                assistantId={assistantId}
              />
            ))}
          </Lane>

          <Lane
            state="review"
            label="Review"
            order={isMobile ? 2 : undefined}
            count={review.length}
            empty={
              <LaneEmpty
                glyph="◱"
                text="Nothing to sign off. Finished work lands here for your OK."
              />
            }
          >
            {review.slice(0, 6).map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onOpen={() => openItem(item)}
              />
            ))}
          </Lane>

          <Lane
            state="done"
            label="Done"
            order={isMobile ? 5 : undefined}
            count={done.length}
            empty={
              <LaneEmpty
                glyph="✓"
                text="Your wins land here. Everything Cue completes stacks up."
              />
            }
          >
            {done.slice(0, 8).map((item) => (
              <DoneCard
                key={item.id}
                item={item}
                onOpen={() => openItem(item)}
              />
            ))}
          </Lane>
        </div>
      </div>
    </div>
  );
}
