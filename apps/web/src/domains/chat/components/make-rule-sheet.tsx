/**
 * "Make this a rule →" mini-sheet (Cue-Guardrails design, SET 2 — rules born
 * in the moment).
 *
 * Mounted from the approval dialog: the checkpoint template is inferred from
 * the pending action (tool name + title — the confirmation carries no
 * autonomy class), the name is editable, the scope is Everywhere / one agent,
 * and Save POSTs a guardrails checkpoint. Purely additive next to the
 * existing Allow/Deny decision buttons — saving a rule does NOT resolve the
 * live confirmation.
 */

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  agentsGetOptions,
  guardrailsCheckpointsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  agentGlyph,
  inferTemplateFromAction,
  inferredCheckpointLabel,
  parseThresholdCents,
  templateGlyph,
} from "@/lib/guardrails-kit";

const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";
const C = {
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  blueW: "var(--mv1-blue-wash)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  danger: "var(--mv1-danger)",
  /** Text leg for small copy where colour is the only carrier (A1). */
  dangerText: "var(--mv1-danger-text)",
} as const;

export function MakeRuleSheet({
  toolName,
  title,
  onBack,
}: {
  toolName?: string;
  title?: string;
  /** Return to the plain approval buttons. */
  onBack: () => void;
}) {
  // Raw store read (not useActiveAssistantId): chat renders across
  // pre-active states, so we guard the null case ourselves.
  const assistantId =
    useResolvedAssistantsStore.use.activeAssistantId() ?? "";
  const template = inferTemplateFromAction(toolName, title);
  const [label, setLabel] = useState(() =>
    inferredCheckpointLabel(template, title),
  );
  const [editingLabel, setEditingLabel] = useState(false);
  const [scopeAgentId, setScopeAgentId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Agents load lazily, only while the sheet is open (for the scope row).
  const agentsQuery = useQuery({
    ...agentsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: assistantId.length > 0,
  });
  const agents = agentsQuery.data?.agents ?? [];

  const createMutation = useMutation({
    ...guardrailsCheckpointsPostMutation(),
    onSuccess: () => setSaved(true),
  });

  const canSave =
    label.trim().length > 0 &&
    assistantId.length > 0 &&
    !createMutation.isPending;

  const save = () => {
    if (!canSave) return;
    const thresholdCents =
      template === "spend_over" ? parseThresholdCents(label) : undefined;
    createMutation.mutate({
      path: { assistant_id: assistantId },
      body: {
        template,
        label: label.trim(),
        scope: scopeAgentId ? `agent:${scopeAgentId}` : "everywhere",
        // `custom` requires an explicit pattern; the tool name is the most
        // honest match for "actions like this one".
        ...(template === "custom"
          ? { pattern: toolName?.trim() || "custom" }
          : {}),
        ...(thresholdCents !== undefined ? { thresholdCents } : {}),
      },
    });
  };

  if (saved) {
    return (
      <div style={{ padding: "12px 2px 4px", textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: C.green }}>
          ✓ Checkpoint saved
        </div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 5, lineHeight: 1.5 }}>
          &ldquo;{label.trim()}&rdquo; now lives in Guardrails → Checkpoints —
          on {scopeAgentId ? "for that agent" : "for all agents"}, editable
          anytime. Decide on this action above.
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 12 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.blueS,
        }}
      >
        New checkpoint · inferred from this action
      </div>
      <div
        style={{
          fontFamily: serif,
          fontSize: 21,
          color: C.t1,
          marginTop: 9,
        }}
      >
        Cue will always ask before…
      </div>

      {/* the inferred, editable rule name */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          background: C.surface,
          border: `1px solid ${C.line2}`,
          borderRadius: 11,
          padding: editingLabel ? "6px 14px" : "12px 14px",
          marginTop: 14,
        }}
      >
        <span style={{ fontSize: 13, color: C.t2, flexShrink: 0 }}>
          {templateGlyph(template)}
        </span>
        {editingLabel ? (
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => setEditingLabel(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setEditingLabel(false);
            }}
            style={{
              flex: 1,
              fontSize: 13.5,
              fontWeight: 500,
              color: C.t1,
              background: "transparent",
              border: "none",
              outline: "none",
              padding: "6px 0",
            }}
          />
        ) : (
          <>
            <span
              style={{
                flex: 1,
                fontSize: 13.5,
                fontWeight: 500,
                color: C.t1,
                minWidth: 0,
              }}
            >
              {label}
            </span>
            <button
              type="button"
              onClick={() => setEditingLabel(true)}
              style={{
                fontSize: 11,
                color: C.blueS,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              edit ✎
            </button>
          </>
        )}
      </div>

      {/* scope */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, color: C.t3, marginBottom: 7 }}>Scope</div>
        <div
          style={{
            display: "inline-flex",
            background: C.sunken,
            borderRadius: 9,
            padding: 3,
            flexWrap: "wrap",
          }}
        >
          <ScopePill
            active={scopeAgentId === null}
            onClick={() => setScopeAgentId(null)}
          >
            Everywhere
          </ScopePill>
          {agents.map((a) => (
            <ScopePill
              key={a.id}
              active={scopeAgentId === a.id}
              onClick={() => setScopeAgentId(a.id)}
            >
              {agentGlyph(a.name, a.emoji)} {a.name} only
            </ScopePill>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18 }}>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          style={{
            flex: 1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 600,
            background: C.blue,
            color: "#fff",
            border: "none",
            borderRadius: 9,
            padding: "11px 0",
            cursor: canSave ? "pointer" : "default",
            opacity: canSave ? 1 : 0.55,
          }}
        >
          {createMutation.isPending && (
            <Loader2 className="size-3.5 animate-spin" />
          )}
          Save checkpoint
        </button>
        <button
          type="button"
          onClick={onBack}
          style={{
            fontSize: 12.5,
            color: C.t3,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "0 8px",
          }}
        >
          Back
        </button>
      </div>
      {createMutation.isError && (
        <div style={{ fontSize: 12, color: C.dangerText, marginTop: 8 }}>
          Couldn&rsquo;t save the checkpoint — try again.
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          color: C.t3,
          marginTop: 13,
          lineHeight: 1.5,
          textAlign: "center",
        }}
      >
        It appears in Guardrails → Checkpoints, on{" "}
        {scopeAgentId ? "for that agent" : "for all agents"}, editable anytime.
      </div>
    </div>
  );
}

function ScopePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        color: active ? C.t1 : C.t2,
        background: active ? C.surface : "transparent",
        border: active ? `1px solid ${C.line2}` : "1px solid transparent",
        borderRadius: 7,
        padding: "7px 14px",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
