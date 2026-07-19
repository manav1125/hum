/**
 * Mv3AgentsPage — the mobile Agents manage screen (spec frame 32: your staff —
 * charter, pause, re-charter). Rendered by AgentsOrgPage's mobile branch;
 * the desktop org grid is untouched.
 *
 * DATA (all real — the same hooks the desktop org page trusts):
 *  · roster       — the server-side agent registry (`useCharters`)
 *  · status line  — live work items by assignee (`useAgentWork`)
 *  · acts + spend — the acts ledger + the spend-attribution endpoint, with
 *                   the honest "measuring…" fallback (never a fabricated
 *                   split)
 *  · verbs        — pause/resume + retire persist through `useCharterActions`;
 *                   Re-charter opens the existing charter editor; Adjust
 *                   scope deep-links the Guardrails agent-scopes band.
 *
 * Retire uses a real confirm dialog (the desktop page's `window.confirm` is
 * replaced in the same pass).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { agentsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { CharterEditor, HireModal } from "@/pages/hq-agents/agent-modals";
import {
  useCharterActions,
  useCharters,
  type AgentCharter,
} from "@/pages/hq-agents/charters";
import {
  actsForCharter,
  spendForCharter,
  useAgentActs,
  useAgentSpend,
  useAgentWork,
  workForCharter,
  type AgentActs,
  type AgentSpend,
  type AgentWork,
} from "@/pages/hq-agents/use-agent-data";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { rise, secondaryBtn } from "../mv3-kit";
import { QuietLink, YouScreen } from "./you-kit";

/** Per-agent tile hue (the house palette: Ops teal / Growth violet / Inbox blue). */
function agentTileBg(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("ops")) return "#0E8C8C";
  if (n.includes("growth")) return "#7F77DD";
  if (n.includes("inbox") || n.includes("build")) return "#3D6EE8";
  const cycle = ["#0E8C8C", "#7F77DD", "#3D6EE8", "#3560CC"];
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 997;
  return cycle[h % cycle.length];
}

/** Honest status line + color per frame 32's grammar. */
function statusLine(
  charter: AgentCharter,
  work: AgentWork | null,
): { text: string; color: string } {
  if (charter.paused)
    return { text: "paused", color: "var(--mv3-amber)" };
  if (work?.running) {
    return {
      text: work.currentLine
        ? `running — ${work.currentLine}`
        : "running",
      color: "var(--mv3-micro)",
    };
  }
  if (work && work.liveCount > 0) {
    return {
      text: `active — ${work.liveCount} run${work.liveCount === 1 ? "" : "s"} queued`,
      color: "var(--mv3-green)",
    };
  }
  return { text: "quiet", color: "var(--mv3-muted)" };
}

function fmtUsd(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

function AgentCardV3({
  charter,
  work,
  acts,
  spend,
  measuringActs,
  expanded,
  delay,
  onToggle,
  onEdit,
  onTogglePause,
  onAdjustScope,
  onRetire,
}: {
  charter: AgentCharter;
  work: AgentWork | null;
  acts: AgentActs | null;
  spend: AgentSpend | null;
  measuringActs: boolean;
  expanded: boolean;
  delay: number;
  onToggle: () => void;
  onEdit: () => void;
  onTogglePause: () => void;
  onAdjustScope: () => void;
  onRetire: () => void;
}) {
  const status = statusLine(charter, work);

  return (
    <GlassCard
      radius={22}
      padding={expanded ? "15px 16px" : "14px 16px"}
      blur={delay < 0.4}
      style={{
        ...(expanded
          ? {
              border: `1px solid color-mix(in srgb, ${agentTileBg(charter.name)} 35%, transparent)`,
            }
          : {}),
        opacity: charter.paused ? 0.85 : 1,
        ...rise(delay),
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => {
          haptic.light();
          onToggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onToggle();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          cursor: "pointer",
          minHeight: 44,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: agentTileBg(charter.name),
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          {charter.emoji}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: expanded ? 16 : 15, fontWeight: 700 }}>
            {charter.name}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--mv3-muted)",
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Tier {charter.tier} ·{" "}
            <span style={{ color: status.color }}>{status.text}</span>
          </div>
        </div>
        <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
          {expanded ? "⌄" : "›"}
        </span>
      </div>

      {expanded ? (
        <>
          <div
            style={{
              background: "var(--mv3-btn2-bg)",
              borderRadius: 12,
              padding: "10px 12px",
              marginTop: 11,
              fontSize: 12,
              color: "var(--mv3-muted)",
              lineHeight: 1.5,
              fontStyle: "italic",
            }}
          >
            {charter.charter
              ? `“${charter.charter}”`
              : "No charter written yet — Re-charter to give this agent its mandate."}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginTop: 11,
            }}
          >
            <span style={{ fontSize: 11.5, color: "var(--mv3-muted)" }}>
              {measuringActs || !acts ? (
                "acts · measuring…"
              ) : (
                <>
                  <b style={{ color: "var(--mv3-text)" }}>{acts.actions}</b>{" "}
                  acts · {acts.reversed} reversed
                </>
              )}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--mv3-muted)" }}>
              {spend && spend.usd > 0 ? (
                <>
                  <b style={{ color: "var(--mv3-text)" }}>
                    {fmtUsd(spend.usd)}
                  </b>{" "}
                  · 7d
                </>
              ) : (
                "spend · measuring…"
              )}
            </span>
            <span style={{ marginLeft: "auto" }}>
              <QuietLink label="Re-charter ›" onPress={onEdit} />
            </span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 11,
              paddingTop: 11,
              borderTop: "1px solid var(--mv3-line)",
            }}
          >
            <button
              type="button"
              onClick={() => {
                haptic.medium();
                onTogglePause();
              }}
              style={{
                ...secondaryBtn,
                flex: 1,
                fontSize: 12,
                fontWeight: 600,
                padding: 9,
                minHeight: 40,
                borderRadius: 10,
              }}
            >
              {charter.paused ? "▶ Resume agent" : "⏸ Pause agent"}
            </button>
            <button
              type="button"
              onClick={() => {
                haptic.light();
                onAdjustScope();
              }}
              style={{
                ...secondaryBtn,
                flex: 1,
                fontSize: 12,
                color: "var(--mv3-muted)",
                padding: 9,
                minHeight: 40,
                borderRadius: 10,
              }}
            >
              Adjust scope
            </button>
          </div>
          <div style={{ textAlign: "center", marginTop: 6 }}>
            <button
              type="button"
              onClick={() => {
                haptic.medium();
                onRetire();
              }}
              style={{
                fontSize: 12,
                color: "#E5675B",
                background: "none",
                border: "none",
                padding: "8px 12px",
                minHeight: 40,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Retire agent
            </button>
          </div>
        </>
      ) : null}
    </GlassCard>
  );
}

export function Mv3AgentsPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const charters = useCharters(assistantId);
  // Same query key as useCharters — read only the load state so the empty
  // "hire your first agent" line never fires while the roster is in flight.
  const rosterQuery = useQuery({
    ...agentsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 15_000,
  });
  const rosterLoading = rosterQuery.isLoading;
  const charterActions = useCharterActions(assistantId);
  const { byName: workByName } = useAgentWork(assistantId);
  const { byName: actsByName, measuring: measuringActs } = useAgentActs(
    assistantId,
    charters,
  );
  const { byName: spendByName } = useAgentSpend(assistantId);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentCharter | null>(null);
  const [hiring, setHiring] = useState(false);
  const [pendingRetire, setPendingRetire] = useState<AgentCharter | null>(
    null,
  );

  // First card expanded by default (frame 32 shows Ops open).
  const effectiveExpanded = expandedId ?? charters[0]?.id ?? null;

  const count = charters.length;
  const sub = useMemo(
    () =>
      count > 0
        ? `${count} on staff · each with a charter you wrote`
        : rosterLoading
          ? "Calling the roster…"
          : "Hire your first agent — describe the job",
    [count, rosterLoading],
  );

  return (
    <YouScreen
      tint="teal"
      testId="mv3-agents"
      back={routes.channels}
      title="Agents"
      sub={sub}
    >
      {charters.map((charter, i) => (
        <AgentCardV3
          key={charter.id}
          charter={charter}
          work={workForCharter(charter, workByName)}
          acts={actsForCharter(charter, actsByName)}
          spend={spendForCharter(charter, spendByName)}
          measuringActs={measuringActs}
          expanded={effectiveExpanded === charter.id}
          delay={0.1 + Math.min(i, 3) * 0.13}
          onToggle={() =>
            setExpandedId(
              effectiveExpanded === charter.id ? "" : charter.id,
            )
          }
          onEdit={() => setEditing(charter)}
          onTogglePause={() =>
            charterActions.update(charter.id, { paused: !charter.paused })
          }
          onAdjustScope={() => navigate(routes.guardrails)}
          onRetire={() => setPendingRetire(charter)}
        />
      ))}

      {/* + Hire an agent — describe the job (conversational create flow). */}
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          setHiring(true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 9,
          border: "1.5px dashed var(--mv3-btn2-border)",
          borderRadius: 18,
          padding: 13,
          minHeight: 50,
          background: "transparent",
          color: "var(--mv3-muted)",
          cursor: "pointer",
          fontFamily: "inherit",
          ...rise(0.5),
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "rgba(61,110,232,.2)",
            color: "var(--mv3-micro)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
          }}
        >
          +
        </span>
        <span style={{ fontSize: 13 }}>Hire an agent — describe the job</span>
      </button>

      {editing ? (
        <CharterEditor
          assistantId={assistantId}
          charter={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {hiring ? (
        <HireModal
          assistantId={assistantId}
          onClose={() => setHiring(false)}
          onHired={() => setHiring(false)}
        />
      ) : null}

      <ConfirmDialog
        open={pendingRetire !== null}
        title="Retire this agent?"
        message={
          pendingRetire
            ? `Retire ${pendingRetire.name}? Its charter and settings are removed permanently; past work in the ledger is kept.`
            : ""
        }
        confirmLabel="Retire"
        destructive
        onConfirm={() => {
          if (pendingRetire) {
            charterActions.retire(pendingRetire.id);
            setPendingRetire(null);
          }
        }}
        onCancel={() => setPendingRetire(null)}
      />
    </YouScreen>
  );
}
