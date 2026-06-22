/**
 * Agents at Work — a live fleet view of Cue's in-chat sub-agents.
 *
 * The Activity surface tracks background work-items, runs, schedules and
 * watchers. It does NOT show the in-chat sub-agents (`SubagentManager`) that a
 * conversation's LLM spawns mid-turn — e.g. "audit Downloads" / "audit Caches"
 * agents fanned out inside a single chat. This page binds to the read-only
 * `GET /v1/subagents` daemon endpoint (generated SDK: `subagentsGetOptions`),
 * polling every ~3s, and renders each sub-agent's label, status, parent thread
 * (linked to the conversation), elapsed time, error, and an "awaiting approval"
 * flag so the user can watch parallel sub-agents run and spot stuck ones.
 *
 * Read-only: it never aborts, confirms, or otherwise mutates sub-agent state.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

import { subagentsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { SubagentsGetResponse } from "@/generated/daemon/types.gen";
import { C, mono, serif } from "@/domains/activity/theme";
import { routes } from "@/utils/routes";

type Subagent = SubagentsGetResponse["subagents"][number];
type FleetStatus = Subagent["status"];

const POLL_MS = 3_000;

/** Visual treatment per coarse status. */
const STATUS_STYLE: Record<FleetStatus, { bg: string; fg: string; label: string }> = {
  running: { bg: C.blueW, fg: C.blueS, label: "running" },
  completed: { bg: "#DCEFE2", fg: C.green, label: "completed" },
  failed: { bg: "#FBE2D8", fg: C.danger, label: "failed" },
  aborted: { bg: C.sunken, fg: C.t2, label: "aborted" },
};

/** Format an elapsed span between startedAt and finishedAt (or now). */
function elapsed(startedAt: number, finishedAt?: number): string {
  const start = startedAt < 1e12 ? startedAt * 1000 : startedAt;
  const end =
    finishedAt == null
      ? Date.now()
      : finishedAt < 1e12
        ? finishedAt * 1000
        : finishedAt;
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function StatusBadge({ status }: { status: FleetStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 11,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        background: s.bg,
        color: s.fg,
        borderRadius: 999,
        padding: "2px 9px",
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

function AgentRow({ agent }: { agent: Subagent }) {
  const isTerminal = agent.status !== "running";
  return (
    <div
      data-slot="agent-row"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${
          agent.hasPendingConfirmation
            ? C.amber
            : STATUS_STYLE[agent.status].fg
        }`,
        borderRadius: "0 10px 10px 0",
        padding: "12px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontFamily: serif,
            fontSize: 17,
            color: C.ink,
            lineHeight: 1.2,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={agent.label}
        >
          {agent.label || "Untitled sub-agent"}
        </span>
        {agent.hasPendingConfirmation && (
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: C.amber,
              whiteSpace: "nowrap",
            }}
            title="This sub-agent is blocked on a confirmation/approval."
          >
            ⏳ awaiting approval
          </span>
        )}
        <StatusBadge status={agent.status} />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          fontFamily: mono,
          fontSize: 12,
          color: C.t2,
        }}
      >
        <span title={isTerminal ? "Total runtime" : "Elapsed so far"}>
          ⏱ {elapsed(agent.startedAt, agent.finishedAt)}
          {isTerminal ? "" : " elapsed"}
        </span>
        <Link
          to={routes.conversation(agent.parentConversationId)}
          style={{ color: C.blueS, textDecoration: "none" }}
          title={`Parent conversation ${agent.parentConversationId}`}
        >
          ▸ parent thread →
        </Link>
        <span style={{ color: C.t3 }}>
          {agent.id.slice(0, 8)}
        </span>
      </div>

      {agent.error && (
        <div
          style={{
            fontFamily: mono,
            fontSize: 12,
            color: C.danger,
            background: "#FBE2D8",
            border: `1px solid #F3C9BA`,
            borderRadius: 6,
            padding: "6px 9px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {agent.error}
        </div>
      )}
    </div>
  );
}

export function AgentsAtWorkPage() {
  const assistantId = useActiveAssistantId();

  const { data, isLoading, isError, error } = useQuery({
    ...subagentsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });

  const agents = data?.subagents ?? [];
  // Active first (running / awaiting approval), then most-recent terminal.
  const sorted = [...agents].sort((a, b) => {
    const aActive = a.status === "running" ? 1 : 0;
    const bActive = b.status === "running" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aT = a.finishedAt ?? a.startedAt;
    const bT = b.finishedAt ?? b.startedAt;
    return bT - aT;
  });

  const runningCount = agents.filter((a) => a.status === "running").length;
  const awaitingCount = agents.filter((a) => a.hasPendingConfirmation).length;

  const summary = (() => {
    if (isLoading) return "Looking for sub-agents at work…";
    const parts = [`${runningCount} running`];
    if (awaitingCount) parts.push(`${awaitingCount} awaiting you`);
    parts.push(`${agents.length} total`);
    return parts.join("  ·  ");
  })();

  return (
    <div
      data-slot="agents-at-work-page"
      style={{ height: "100%", overflowY: "auto", background: C.bg }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `@media (max-width:640px){[data-slot="agents-at-work-page"] [data-slot="agents-inner"]{padding:18px 16px !important;}[data-slot="agents-at-work-page"] [data-slot="agents-hero"]{font-size:28px !important;}}`,
        }}
      />
      <div
        data-slot="agents-inner"
        style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.blueS,
            marginBottom: 8,
          }}
        >
          Agents at Work
        </div>
        <div
          data-slot="agents-hero"
          style={{
            fontFamily: serif,
            fontSize: 38,
            letterSpacing: "-0.5px",
            lineHeight: 1.08,
            color: C.ink,
          }}
        >
          Cue’s sub-agent fleet.
        </div>
        <div
          style={{
            fontSize: 13.5,
            color: C.t2,
            marginTop: 8,
            fontFamily: mono,
          }}
        >
          {summary}
        </div>

        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderLeft: `3px solid ${C.violet}`,
            borderRadius: "0 12px 12px 0",
            padding: "11px 14px",
            fontSize: 13,
            color: C.t2,
            margin: "16px 0 22px",
          }}
        >
          These are the sub-agents Cue spins up <em>inside</em> a chat to work in
          parallel. Each row links back to the conversation that spawned it; a
          ⏳ flag means a sub-agent is paused waiting for your approval.
        </div>

        {isError && (
          <div
            style={{
              fontFamily: mono,
              fontSize: 12.5,
              color: C.danger,
              background: "#FBE2D8",
              border: `1px solid #F3C9BA`,
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 18,
            }}
          >
            Couldn’t load sub-agents
            {error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}

        {!isLoading && !isError && agents.length === 0 && (
          <div
            style={{
              fontFamily: mono,
              fontSize: 13,
              color: C.t3,
              textAlign: "center",
              padding: "48px 16px",
              border: `1px dashed ${C.line2}`,
              borderRadius: 12,
            }}
          >
            No sub-agents are running right now. They appear here the moment Cue
            fans out work inside a conversation.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sorted.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      </div>
    </div>
  );
}
