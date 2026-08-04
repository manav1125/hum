/**
 * Mv3LedgerPage — the mobile act ledger (spec frame 31: "Everything Cue did"
 * — the receipts behind the You screen's acts tile). Rendered by the
 * Guardrails route's mobile branch at `?view=ledger`.
 *
 * DATA (all real — the Wave-2 acts store):
 *  · list    — `actsGet` (optionally filtered to one agent)
 *  · rollup  — `actsSummaryGet`: total acts · reversed + the per-agent
 *              breakdown that feeds the filter chips
 *  · reverse — `POST acts/:id/reverse`; a 409 renders the honest "nothing to
 *              unwind" note, never a fake success
 *
 * HONEST OMISSIONS (the act records don't capture these yet — nothing is
 * fabricated): who approved an act + at what second, the exact channel and
 * recipient it went out on. The expanded detail renders what IS recorded:
 * agent, kind, time, real model + cost when measured, reversibility state
 * with a live Reverse, and the work-item link.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useHideVendorUi } from "@/assistant/use-managed-mode";
import {
  actsByIdReversePostMutation,
  actsGetOptions,
  actsSummaryGetOptions,
  agentsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ActsGetResponses } from "@/generated/daemon/types.gen";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel, mv3Mono, rise } from "../mv3-kit";
import { YouScreen, clockLabel, shortDate } from "./you-kit";
import { usd } from "./use-you-data";

type Act = ActsGetResponses[200]["acts"][number];

/** Kind-derived fallback titles + honest subtitle lines. */
const KIND_META: Record<
  Act["kind"],
  { title: string; line: string; glyph: string }
> = {
  run_completed: {
    title: "Completed a background run",
    line: "auto · background run",
    glyph: "◆",
  },
  output_produced: {
    title: "Produced an output",
    line: "auto · produced an output",
    glyph: "◱",
  },
  message_drafted: {
    title: "Drafted a message",
    line: "draft · waited for you",
    glyph: "✉",
  },
  schedule_fired: {
    title: "Ran a scheduled task",
    line: "auto · on schedule",
    glyph: "↻",
  },
  other: { title: "Did background work", line: "auto", glyph: "•" },
};

/** Per-agent hue cycle (the guardrails house palette). */
const AGENT_HUES = ["#4FC7C7", "#7F77DD", "#3D6EE8", "#6FD69A", "#E0A64B"];
function agentHue(agent: string): string {
  const n = agent.toLowerCase();
  if (n.includes("ops")) return "#4FC7C7";
  if (n.includes("growth")) return "#7F77DD";
  if (n.includes("inbox") || n === "cue") return "#3D6EE8";
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 997;
  return AGENT_HUES[h % AGENT_HUES.length];
}

/** "TODAY" / "YESTERDAY" / "JUL 16" day-group label. */
function dayLabel(epoch: number): string {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const d = new Date(ms);
  const now = new Date();
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toUpperCase();
}

function modelShortName(model: string): string {
  const tail = model.split("/").pop() ?? model;
  const m = /(haiku|sonnet|opus|gemini|deepseek)[-. ]?([\d.]*)/i.exec(tail);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return m[2] ? `${fam} ${m[2].replace(/\.$/, "")}` : fam;
  }
  return tail;
}

function ActDetail({ act, assistantId }: { act: Act; assistantId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The cost stays — it is the user's money. The model name is the vendor's
  // identity, which a managed instance does not disclose.
  const hideVendor = useHideVendorUi();
  const [conflict, setConflict] = useState<string | null>(null);

  const reverse = useMutation({
    ...actsByIdReversePostMutation(),
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          ["actsGet", "actsSummaryGet", "guardrailsGet"].includes(
            (q.queryKey[0] as { _id?: string })?._id ?? "",
          ),
      });
    },
    onError: () => setConflict("Nothing to unwind for this act."),
  });

  const cost = usd(act.costCents);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px solid var(--mv3-line)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          fontSize: 11.5,
          color: "var(--mv3-muted)",
        }}
      >
        <span style={{ color: "var(--mv3-green)", flexShrink: 0 }}>✓</span>
        {KIND_META[act.kind].title} · {shortDate(act.createdAt)} at{" "}
        {clockLabel(act.createdAt)} · by {act.agent}
      </div>
      {cost || (act.model && !hideVendor) ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            fontSize: 11.5,
            color: "var(--mv3-muted)",
          }}
        >
          <span style={{ color: "var(--mv3-green)", flexShrink: 0 }}>✓</span>
          {[cost, act.model && !hideVendor ? modelShortName(act.model) : null]
            .filter(Boolean)
            .join(" · ")}{" "}
          — measured, not estimated
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11.5,
          color: "var(--mv3-muted)",
        }}
      >
        <span style={{ color: "var(--mv3-micro)", flexShrink: 0 }}>↩</span>
        {act.reversed === 1 ? (
          <span>
            Reversed
            {act.reversedAt ? ` · ${shortDate(act.reversedAt)}` : ""}
          </span>
        ) : conflict ? (
          <span>{conflict}</span>
        ) : (
          <>
            <span>Reversible</span>
            <button
              type="button"
              disabled={reverse.isPending}
              onClick={() => {
                haptic.medium();
                reverse.mutate({
                  path: { assistant_id: assistantId, id: act.id },
                });
              }}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--mv3-micro)",
                background: "none",
                border: "none",
                padding: "2px 4px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {reverse.isPending ? "Reversing…" : "↩ Reverse"}
            </button>
          </>
        )}
        {act.workItemId ? (
          <button
            type="button"
            onClick={() => {
              haptic.light();
              navigate(routes.workLive(act.workItemId!));
            }}
            style={{
              marginLeft: "auto",
              fontSize: 11.5,
              color: "var(--mv3-micro)",
              background: "none",
              border: "none",
              padding: "2px 0",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            work item ›
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Mv3LedgerPage() {
  const assistantId = useActiveAssistantId();
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const summaryQuery = useQuery({
    ...actsSummaryGetOptions({
      path: { assistant_id: assistantId },
      query: {},
    }),
    staleTime: 30_000,
  });
  const actsQuery = useQuery({
    ...actsGetOptions({
      path: { assistant_id: assistantId },
      query: { limit: 200, ...(agentFilter ? { agent: agentFilter } : {}) },
    }),
    staleTime: 15_000,
  });
  const agentsQuery = useQuery({
    ...agentsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 60_000,
  });

  const summary = summaryQuery.data ?? null;
  const acts = useMemo(() => actsQuery.data?.acts ?? [], [actsQuery.data]);

  // Filter chips ride the real per-agent breakdown (agents with ≥1 act).
  const agentChips = useMemo(() => {
    const byAgent = summary?.byAgent ?? [];
    const emojiByName = new Map(
      (agentsQuery.data?.agents ?? []).map((a) => [
        a.name.toLowerCase(),
        a.emoji ?? null,
      ]),
    );
    return byAgent.map((row) => ({
      agent: row.agent,
      emoji: emojiByName.get(row.agent.toLowerCase()) ?? null,
      acts: row.acts,
    }));
  }, [summary, agentsQuery.data]);

  // Day-grouped rows.
  const groups = useMemo(() => {
    const out: { label: string; acts: Act[] }[] = [];
    for (const act of acts) {
      const label = dayLabel(act.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.acts.push(act);
      else out.push({ label, acts: [act] });
    }
    return out;
  }, [acts]);

  return (
    <YouScreen
      tint="blue"
      testId="mv3-ledger"
      back={routes.channels}
      header={
        <div
          style={{
            padding: "6px 22px 12px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <div
            style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.8px" }}
          >
            Everything Cue did
          </div>
          <div
            style={{ fontSize: 13, color: "var(--mv3-muted)", marginTop: 5 }}
          >
            {summary
              ? `${summary.acts} acts · ${summary.reversed} reversed · every one has a receipt`
              : summaryQuery.isLoading
                ? "Adding up the receipts…"
                : "The receipts behind every act"}
          </div>
          {agentChips.length > 0 ? (
            <div
              role="group"
              aria-label="Filter by agent"
              style={{
                display: "flex",
                gap: 7,
                marginTop: 11,
                overflowX: "auto",
                WebkitOverflowScrolling: "touch",
                scrollbarWidth: "none",
              }}
            >
              <button
                type="button"
                aria-pressed={agentFilter === null}
                onClick={() => {
                  haptic.light();
                  setAgentFilter(null);
                }}
                style={{
                  flexShrink: 0,
                  fontSize: 12,
                  fontWeight: agentFilter === null ? 600 : 400,
                  fontFamily: "inherit",
                  color:
                    agentFilter === null ? "var(--mv3-bg)" : "var(--mv3-muted)",
                  background:
                    agentFilter === null
                      ? "var(--mv3-text)"
                      : "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 99,
                  padding: "6px 13px",
                  minHeight: 32,
                  cursor: "pointer",
                }}
              >
                All
              </button>
              {agentChips.map((chip) => {
                const hue = agentHue(chip.agent);
                const active = agentFilter === chip.agent;
                return (
                  <button
                    key={chip.agent}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      haptic.light();
                      setAgentFilter(active ? null : chip.agent);
                    }}
                    style={{
                      flexShrink: 0,
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      fontFamily: "inherit",
                      color: active ? "var(--mv3-bg)" : hue,
                      background: active ? hue : "transparent",
                      border: `1px solid color-mix(in srgb, ${hue} 40%, transparent)`,
                      borderRadius: 99,
                      padding: "6px 13px",
                      minHeight: 32,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {chip.emoji ? `${chip.emoji} ` : ""}
                    {chip.agent}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      }
    >
      {actsQuery.isLoading ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--mv3-muted)",
            padding: "16px 4px",
          }}
        >
          Pulling the receipts…
        </div>
      ) : actsQuery.isError ? (
        <GlassCard padding="16px">
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            Couldn't load the ledger
          </div>
          <div
            style={{ fontSize: 12.5, color: "var(--mv3-muted)", marginTop: 4 }}
          >
            The assistant may be unreachable — try again in a moment.
          </div>
        </GlassCard>
      ) : acts.length === 0 ? (
        <GlassCard padding="18px 16px">
          <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
            {agentFilter
              ? `No acts by ${agentFilter} yet.`
              : "No acts yet — when Cue does something on its own, the receipt lands here."}
          </div>
        </GlassCard>
      ) : (
        groups.map((group, gi) => (
          <div key={group.label} style={rise(0.1 + Math.min(gi, 2) * 0.15)}>
            <div
              style={{
                ...microLabel,
                fontSize: 9.5,
                color: "var(--mv3-muted)",
                padding: "4px 4px 8px",
              }}
            >
              {group.label}
            </div>
            <GlassCard padding={0} radius={18} style={{ overflow: "hidden" }}>
              {group.acts.map((act, i) => {
                const meta = KIND_META[act.kind];
                const hue = agentHue(act.agent);
                const expanded = expandedId === act.id;
                const cost = usd(act.costCents);
                return (
                  <div
                    key={act.id}
                    style={{
                      padding: "11px 14px",
                      borderBottom:
                        i === group.acts.length - 1
                          ? "none"
                          : "1px solid var(--mv3-line)",
                      background: expanded
                        ? "color-mix(in srgb, var(--mv3-accent) 5%, transparent)"
                        : "transparent",
                    }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={expanded}
                      onClick={() => {
                        haptic.light();
                        setExpandedId(expanded ? null : act.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          setExpandedId(expanded ? null : act.id);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        cursor: "pointer",
                        minHeight: 36,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 6,
                          background: hue,
                          color: "#08211F",
                          fontSize: 9,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {meta.glyph}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: expanded ? 600 : 400,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {act.title ?? meta.title}
                        </div>
                        <div
                          style={{
                            fontSize: 10.5,
                            color: "var(--mv3-muted)",
                            marginTop: 1,
                          }}
                        >
                          {act.reversed === 1
                            ? "reversed"
                            : [meta.line, cost].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <span
                        style={{
                          fontFamily: mv3Mono,
                          fontSize: 10,
                          color: "var(--mv3-muted)",
                          flexShrink: 0,
                        }}
                      >
                        {clockLabel(act.createdAt)}
                      </span>
                    </div>
                    {expanded ? (
                      <ActDetail act={act} assistantId={assistantId} />
                    ) : null}
                  </div>
                );
              })}
            </GlassCard>
          </div>
        ))
      )}
    </YouScreen>
  );
}
