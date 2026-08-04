/**
 * Mobile-v3 Guardrails additions (task #101) — restores the two desktop
 * Guardrails bands the shipped v3 Rules/Ledger screens dropped:
 *
 *   · Mv3GuardrailsBar — a pinned glass bar under the Rules screen at the
 *     plain `/assistant/guardrails` URL (the URL the v3 Agents screen's
 *     "Adjust scope" deep-links). Two affordances: "+ Checkpoint" opens the
 *     composer sheet; "Agent scopes ›" pushes `?view=scopes`.
 *   · Mv3CheckpointSheet — the desktop 3-step composer (template → scope →
 *     name, same fields + mutations) in v3 SheetShell grammar, plus the
 *     user-made checkpoint list with remove (defaults stay toggle-only, on
 *     the Rules screen).
 *   · Mv3AgentScopesScreen — per-agent tool-scope editing (the desktop
 *     AGENT SCOPES band's chips + `toolScopes` PATCH) as a v3 You-cluster
 *     screen at `?view=scopes` — the previously-dead "Adjust scope" target.
 *
 * Rendered only from `guardrails-page.tsx`'s mobile branch; desktop stays
 * byte-identical. mv3 foundation (`GlassCard`, `SheetShell`, YouScreen kit)
 * is consumed read-only, never edited.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  agentsByIdPatchMutation,
  agentsGetOptions,
  guardrailsCheckpointsByIdDeleteMutation,
  guardrailsCheckpointsPostMutation,
  guardrailsGetOptions,
  missionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  AgentsGetResponse,
  GuardrailsGetResponse,
} from "@/generated/daemon/types.gen";
import {
  CHECKPOINT_TEMPLATES,
  agentGlyph,
  normalizeToolScopeSelection,
  parseThresholdCents,
  templateGlyph,
  tierDescriptor,
  TOOL_SCOPE_IDS,
  type CheckpointTemplate,
} from "@/lib/guardrails-kit";
import { GlassCard } from "@/mobile-v3/glass-card";
import { SheetShell } from "@/mobile-v3/sheet-shell";
import { microLabel, rise } from "@/mobile-v3/mv3-kit";
import { YouScreen } from "@/mobile-v3/you/you-kit";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

type GuardrailsPayload = GuardrailsGetResponse;
type Checkpoint = GuardrailsPayload["checkpoints"][number];
type RegistryAgent = AgentsGetResponse["agents"][number];

/** Partial-match predicate for every cached `guardrailsGet` window. */
function invalidateGuardrails(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  void queryClient.invalidateQueries({
    predicate: (q) =>
      Array.isArray(q.queryKey) &&
      (q.queryKey[0] as { _id?: string })?._id === "guardrailsGet",
  });
}

function invalidateAgents(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  void queryClient.invalidateQueries({
    predicate: (q) =>
      Array.isArray(q.queryKey) &&
      (q.queryKey[0] as { _id?: string })?._id === "agentsGet",
  });
}

// ---------------------------------------------------------------------------
// The pinned bar under the Rules screen (plain /assistant/guardrails).
// ---------------------------------------------------------------------------

export function Mv3GuardrailsBar() {
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);

  const barBtn: React.CSSProperties = {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    background: "var(--mv3-glass)",
    color: "var(--mv3-text)",
    border: "1px solid var(--mv3-glass-border)",
    borderRadius: 14,
    padding: "11px 12px",
    minHeight: 44,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  };

  return (
    <div
      data-mv3
      data-slot="mv3-guardrails-bar"
      style={{
        flexShrink: 0,
        display: "flex",
        gap: 8,
        padding: "8px 16px 10px",
        background: "var(--mv3-bg)",
        fontFamily: "var(--mv3-font)",
        position: "relative",
        zIndex: 3,
      }}
    >
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          setSheetOpen(true);
        }}
        style={barBtn}
      >
        + Checkpoint
      </button>
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          navigate(`${routes.guardrails}?view=scopes`);
        }}
        style={{ ...barBtn, color: "var(--mv3-muted)", fontWeight: 500 }}
      >
        Agent scopes ›
      </button>
      <Mv3CheckpointSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The checkpoint composer sheet — desktop's 3 steps in sheet grammar.
// ---------------------------------------------------------------------------

type ScopeKind = "everywhere" | "agent" | "mission";

function StepLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        ...microLabel,
        color: "var(--mv3-micro)",
        margin: "16px 0 8px",
      }}
    >
      {children}
    </div>
  );
}

const sheetInput: React.CSSProperties = {
  width: "100%",
  fontSize: 16, // ≥16px so iOS Safari doesn't zoom the sheet
  fontFamily: "inherit",
  color: "var(--mv3-text)",
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 12,
  padding: "12px 14px",
  minHeight: 44,
  outline: "none",
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: active ? 600 : 400,
    fontFamily: "inherit",
    color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
    background: active ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
    border: active
      ? "1px solid transparent"
      : "1px solid var(--mv3-btn2-border)",
    borderRadius: 99,
    padding: "8px 14px",
    minHeight: 36,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  };
}

export function Mv3CheckpointSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  // Same 7-day read the Rules screen holds — agents for the scope picker,
  // checkpoints for the removable list. Cache-shared with Mv3RulesPage.
  const guardrailsQuery = useQuery({
    ...guardrailsGetOptions({
      path: { assistant_id: assistantId },
      query: { days: 7 },
    }),
    staleTime: 30_000,
    enabled: open,
  });
  const agents = guardrailsQuery.data?.agents ?? [];
  const checkpoints: Checkpoint[] = guardrailsQuery.data?.checkpoints ?? [];
  const userCheckpoints = checkpoints.filter((c) => c.isDefault !== 1);

  const [template, setTemplate] = useState<CheckpointTemplate>("send_message");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("everywhere");
  const [scopeAgentId, setScopeAgentId] = useState<string | null>(null);
  const [scopeMissionId, setScopeMissionId] = useState<string | null>(null);
  const [label, setLabel] = useState(CHECKPOINT_TEMPLATES[0].defaultLabel);
  const [pattern, setPattern] = useState("");
  const [touchedName, setTouchedName] = useState(false);

  // Missions load lazily, only when "One mission" is picked (desktop parity).
  const missionsQuery = useQuery({
    ...missionsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "active" },
    }),
    enabled: open && scopeKind === "mission",
  });

  const createMutation = useMutation({
    ...guardrailsCheckpointsPostMutation(),
    onSuccess: () => {
      haptic.success();
      invalidateGuardrails(queryClient);
      onClose();
    },
    onError: () => haptic.error(),
  });

  const deleteMutation = useMutation({
    ...guardrailsCheckpointsByIdDeleteMutation(),
    onSettled: () => invalidateGuardrails(queryClient),
  });

  const pickTemplate = (t: CheckpointTemplate) => {
    haptic.light();
    setTemplate(t);
    if (!touchedName) {
      setLabel(
        CHECKPOINT_TEMPLATES.find((m) => m.template === t)?.defaultLabel ?? "",
      );
    }
  };

  const scope =
    scopeKind === "agent" && scopeAgentId
      ? `agent:${scopeAgentId}`
      : scopeKind === "mission" && scopeMissionId
        ? `mission:${scopeMissionId}`
        : "everywhere";

  const canSave =
    label.trim().length > 0 &&
    (template !== "custom" || pattern.trim().length > 0) &&
    (scopeKind !== "agent" || scopeAgentId !== null) &&
    (scopeKind !== "mission" || scopeMissionId !== null) &&
    !createMutation.isPending;

  const save = () => {
    if (!canSave) return;
    haptic.medium();
    const thresholdCents =
      template === "spend_over" ? parseThresholdCents(label) : undefined;
    createMutation.mutate({
      path: { assistant_id: assistantId },
      body: {
        template,
        label: label.trim(),
        scope,
        ...(template === "custom" ? { pattern: pattern.trim() } : {}),
        ...(thresholdCents !== undefined ? { thresholdCents } : {}),
      },
    });
  };

  const remove = (cp: Checkpoint) => {
    haptic.medium();
    // Optimistic removal; the invalidate reconciles (desktop parity).
    queryClient.setQueriesData<GuardrailsPayload>(
      {
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          (q.queryKey[0] as { _id?: string })?._id === "guardrailsGet",
      },
      (prev) =>
        prev
          ? {
              ...prev,
              checkpoints: prev.checkpoints.filter((c) => c.id !== cp.id),
            }
          : prev,
    );
    deleteMutation.mutate({ path: { assistant_id: assistantId, id: cp.id } });
  };

  return (
    <SheetShell open={open} onClose={onClose} label="Add a checkpoint">
      <div style={{ padding: "2px 2px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            aria-hidden
            style={{
              width: 24,
              height: 24,
              borderRadius: 8,
              background: "var(--mv3-accent)",
              color: "#fff",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ‖
          </span>
          <span style={{ fontSize: 16, fontWeight: 700 }}>
            Add a checkpoint
          </span>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--mv3-muted)",
            marginTop: 8,
            lineHeight: 1.5,
          }}
        >
          Cue always asks before matching actions — everywhere, or scoped to
          one agent or mission.
        </div>

        <StepLabel>1 · Cue should ask before</StepLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {CHECKPOINT_TEMPLATES.map((t) => (
            <button
              key={t.template}
              type="button"
              aria-pressed={t.template === template}
              onClick={() => pickTemplate(t.template)}
              style={chipStyle(t.template === template)}
            >
              {t.glyph} {t.chip}
            </button>
          ))}
        </div>

        {template === "custom" ? (
          <>
            <StepLabel>Custom pattern</StepLabel>
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="e.g. email_send or shell:rm *"
              aria-label="Custom pattern"
              style={{ ...sheetInput, fontFamily: "var(--mv3-mono)" }}
            />
          </>
        ) : null}

        <StepLabel>2 · Where does it apply?</StepLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {(
            [
              ["everywhere", "Everywhere"],
              ["agent", "One agent"],
              ["mission", "One mission"],
            ] as const
          ).map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              aria-pressed={scopeKind === kind}
              onClick={() => {
                haptic.light();
                setScopeKind(kind);
              }}
              style={chipStyle(scopeKind === kind)}
            >
              {text}
            </button>
          ))}
        </div>
        {scopeKind === "agent" ? (
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}
          >
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={scopeAgentId === a.id}
                onClick={() => {
                  haptic.light();
                  setScopeAgentId(a.id);
                }}
                style={chipStyle(scopeAgentId === a.id)}
              >
                {agentGlyph(a.name, a.emoji)} {a.name}
              </button>
            ))}
            {agents.length === 0 ? (
              <span style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
                No agents in the registry yet.
              </span>
            ) : null}
          </div>
        ) : null}
        {scopeKind === "mission" ? (
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}
          >
            {missionsQuery.isLoading ? (
              <span style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
                Loading missions…
              </span>
            ) : (missionsQuery.data?.missions.length ?? 0) === 0 ? (
              <span style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
                No active missions yet.
              </span>
            ) : (
              missionsQuery.data?.missions.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={scopeMissionId === m.id}
                  onClick={() => {
                    haptic.light();
                    setScopeMissionId(m.id);
                  }}
                  style={{
                    ...chipStyle(scopeMissionId === m.id),
                    maxWidth: 240,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.title}
                </button>
              ))
            )}
          </div>
        ) : null}

        <StepLabel>3 · Name it</StepLabel>
        <input
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setTouchedName(true);
          }}
          placeholder="e.g. Spending over $25 on ads"
          aria-label="Checkpoint name"
          style={sheetInput}
        />

        {createMutation.isError ? (
          <div style={{ fontSize: 12, color: "#E5675B", marginTop: 8 }}>
            Couldn&rsquo;t save the checkpoint — try again.
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
          <button
            type="button"
            disabled={!canSave}
            onClick={save}
            style={{
              flex: 1,
              fontSize: 13.5,
              fontWeight: 600,
              fontFamily: "inherit",
              background: "var(--mv3-text)",
              color: "var(--mv3-bg)",
              border: "none",
              borderRadius: 12,
              padding: 12,
              minHeight: 44,
              cursor: canSave ? "pointer" : "default",
              opacity: canSave ? 1 : 0.55,
            }}
          >
            {createMutation.isPending ? "Saving…" : "Save checkpoint"}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 13.5,
              fontFamily: "inherit",
              background: "var(--mv3-btn2-bg)",
              color: "var(--mv3-muted)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 12,
              padding: "12px 16px",
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>

        {userCheckpoints.length > 0 ? (
          <>
            <StepLabel>Your checkpoints</StepLabel>
            <div
              style={{
                border: "1px solid var(--mv3-btn2-border)",
                borderRadius: 14,
                overflow: "hidden",
              }}
            >
              {userCheckpoints.map((cp, i) => (
                <div
                  key={cp.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 13px",
                    minHeight: 48,
                    borderBottom:
                      i === userCheckpoints.length - 1
                        ? "none"
                        : "1px solid var(--mv3-line)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{ fontSize: 12, color: "var(--mv3-amber)" }}
                  >
                    {templateGlyph(cp.template)}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cp.label}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove checkpoint: ${cp.label}`}
                    onClick={() => remove(cp)}
                    style={{
                      fontSize: 12,
                      color: "var(--mv3-muted)",
                      background: "none",
                      border: "none",
                      padding: "8px 6px",
                      minHeight: 40,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    ✕ Remove
                  </button>
                </div>
              ))}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--mv3-muted)",
                marginTop: 8,
                lineHeight: 1.5,
              }}
            >
              Seeded defaults aren&rsquo;t removable — switch them off from
              the Rules list instead.
            </div>
          </>
        ) : null}
      </div>
    </SheetShell>
  );
}

// ---------------------------------------------------------------------------
// Agent scopes — the v3 screen at ?view=scopes (the "Adjust scope" target).
// ---------------------------------------------------------------------------

export function Mv3AgentScopesScreen() {
  const assistantId = useActiveAssistantId();

  // The registry read alone carries everything this screen edits — name,
  // tier, paused, and the real `toolScopes` (null = unrestricted).
  const registryQuery = useQuery({
    ...agentsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 15_000,
  });
  const agents = registryQuery.data?.agents ?? [];

  const sub = registryQuery.isLoading
    ? "Calling the roster…"
    : agents.length === 0
      ? "No agents yet — hire one and its scopes show up here"
      : `${agents.length} agent${agents.length === 1 ? "" : "s"} · what each may touch on background runs`;

  return (
    <YouScreen
      tint="teal"
      testId="mv3-agent-scopes"
      back={routes.guardrails}
      backLabel="Rules"
      title="Agent scopes"
      sub={sub}
    >
      {agents.map((agent, i) => (
        <Mv3AgentScopeCard
          key={agent.id}
          assistantId={assistantId}
          agent={agent}
          delay={0.1 + Math.min(i, 3) * 0.13}
        />
      ))}
      {registryQuery.isError ? (
        <GlassCard>
          <div style={{ fontSize: 13, color: "var(--mv3-muted)" }}>
            Couldn&rsquo;t load the agent roster — pull back and try again.
          </div>
        </GlassCard>
      ) : null}
      <div
        style={{
          fontSize: 11.5,
          color: "var(--mv3-muted)",
          textAlign: "center",
          padding: "4px 12px",
          lineHeight: 1.5,
        }}
      >
        Scopes are enforced on background runs · all on = unrestricted
      </div>
    </YouScreen>
  );
}

function Mv3AgentScopeCard({
  assistantId,
  agent,
  delay,
}: {
  assistantId: string;
  agent: RegistryAgent;
  delay: number;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const patchAgent = useMutation({
    ...agentsByIdPatchMutation(),
    onSuccess: () => {
      haptic.success();
      setEditing(false);
    },
    onError: () => haptic.error(),
    onSettled: () => {
      invalidateAgents(queryClient);
      invalidateGuardrails(queryClient);
    },
  });

  const paused = agent.paused === 1;
  const toolScopes = agent.toolScopes;
  const scopes = toolScopes ?? [];

  const startEditing = () => {
    haptic.light();
    setSelected(new Set(toolScopes ?? TOOL_SCOPE_IDS));
    setEditing(true);
  };

  const toggleScope = (id: string) => {
    haptic.light();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveScopes = () => {
    haptic.medium();
    patchAgent.mutate({
      path: { assistant_id: assistantId, id: agent.id },
      body: { toolScopes: normalizeToolScopeSelection(selected) },
    });
  };

  const chip = (text: string, on: boolean, onPress?: () => void) => (
    <button
      key={text}
      type="button"
      aria-pressed={onPress ? on : undefined}
      disabled={!onPress}
      onClick={onPress}
      style={{
        fontSize: 12,
        fontFamily: "inherit",
        color: on ? "var(--mv3-text)" : "var(--mv3-muted)",
        background: on ? "var(--mv3-btn2-bg)" : "transparent",
        border: on
          ? "1px solid var(--mv3-btn2-border)"
          : "1px dashed var(--mv3-btn2-border)",
        borderRadius: 9,
        padding: "7px 12px",
        minHeight: 34,
        cursor: onPress ? "pointer" : "default",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {onPress && on ? "✓ " : ""}
      {text}
    </button>
  );

  return (
    <GlassCard style={{ ...rise(delay), opacity: paused ? 0.75 : 1 }}>
      {/* identity row */}
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <span
          aria-hidden
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            background: "color-mix(in srgb, var(--mv3-teal, #4FC7C7) 15%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 15,
            flexShrink: 0,
          }}
        >
          {agentGlyph(agent.name, agent.emoji)}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>
            {agent.name}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 11,
              color: "var(--mv3-muted)",
              marginTop: 1,
            }}
          >
            Tier {agent.tier} · {tierDescriptor(agent.tier)}
          </span>
        </span>
        <span
          style={{
            ...microLabel,
            fontSize: 9.5,
            color: paused ? "var(--mv3-muted)" : "var(--mv3-green)",
            background: `color-mix(in srgb, ${
              paused ? "var(--mv3-muted)" : "var(--mv3-green)"
            } 12%, transparent)`,
            padding: "4px 9px",
            borderRadius: 6,
          }}
        >
          {paused ? "PAUSED" : "ACTIVE"}
        </span>
      </div>

      {/* scopes */}
      {editing ? (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 7,
              marginTop: 13,
            }}
          >
            {TOOL_SCOPE_IDS.map((id) =>
              chip(id, selected.has(id), () => toggleScope(id)),
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 12,
            }}
          >
            <button
              type="button"
              disabled={patchAgent.isPending}
              onClick={saveScopes}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: "inherit",
                background: "var(--mv3-text)",
                color: "var(--mv3-bg)",
                border: "none",
                borderRadius: 11,
                padding: "9px 16px",
                minHeight: 40,
                cursor: patchAgent.isPending ? "default" : "pointer",
                opacity: patchAgent.isPending ? 0.7 : 1,
              }}
            >
              {patchAgent.isPending ? "Saving…" : "Save scopes"}
            </button>
            <button
              type="button"
              onClick={() => {
                haptic.light();
                setEditing(false);
              }}
              style={{
                fontSize: 12.5,
                fontFamily: "inherit",
                color: "var(--mv3-muted)",
                background: "none",
                border: "none",
                padding: "9px 6px",
                minHeight: 40,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <span
              style={{
                fontSize: 10.5,
                color: "var(--mv3-muted)",
                marginLeft: "auto",
              }}
            >
              all on = unrestricted
            </span>
          </div>
          {patchAgent.isError ? (
            <div style={{ fontSize: 12, color: "#E5675B", marginTop: 8 }}>
              Couldn&rsquo;t save the scopes — try again.
            </div>
          ) : null}
        </>
      ) : (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 7,
            marginTop: 13,
          }}
        >
          {toolScopes === null ? (
            <span
              style={{
                fontSize: 12,
                color: "var(--mv3-muted)",
                fontStyle: "italic",
              }}
            >
              unrestricted — every tool
            </span>
          ) : (
            scopes.map((s) => chip(s, true))
          )}
          <button
            type="button"
            className="cue-pressable"
            onClick={startEditing}
            style={{
              fontSize: 12,
              fontFamily: "inherit",
              color: "var(--mv3-micro)",
              background: "transparent",
              border: "1px dashed var(--mv3-btn2-border)",
              borderRadius: 9,
              padding: "7px 12px",
              minHeight: 34,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            edit ✎
          </button>
        </div>
      )}
    </GlassCard>
  );
}
