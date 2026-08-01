/**
 * New Mission modal — title, outcome, optional metric/horizon, the "leash"
 * dial (workspace default badge + per-mission override), a budget ceiling,
 * and linking existing projects as initiatives.
 *
 * Follows the NewProjectModal chrome (mono kicker + serif headline + field
 * stack) and the design doc's mode-dial framing: the workspace default is a
 * badge, overriding is an explicit act.
 */

import { useState } from "react";

import { C, MODE_META, mono, serif } from "./hq-kit";
import { useProjects } from "@/pages/projects/use-projects";
import {
  useCreateMission,
  useLinkProject,
  type WorkspaceMode,
} from "./use-missions";

export function NewMissionModal({
  assistantId,
  workspaceMode,
  presetTitle,
  onClose,
  onCreated,
}: {
  assistantId: string;
  /** The workspace-level autonomy default (shown as the "default" badge). */
  workspaceMode: WorkspaceMode;
  presetTitle?: string;
  onClose: () => void;
  onCreated: (missionId: string) => void;
}) {
  const create = useCreateMission(assistantId);
  const linker = useLinkProject(assistantId);
  const { projects } = useProjects(assistantId);

  const [title, setTitle] = useState(presetTitle ?? "");
  const [outcome, setOutcome] = useState("");
  const [metric, setMetric] = useState("");
  const [horizon, setHorizon] = useState(""); // yyyy-mm-dd from <input type=date>
  const [mode, setMode] = useState<WorkspaceMode | null>(null); // null = default
  const [budget, setBudget] = useState(""); // USD
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const linkable = projects.filter((p) => p.status === "active");
  const canSubmit =
    title.trim().length > 0 && outcome.trim().length > 0 && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const horizonMs = horizon
      ? new Date(`${horizon}T12:00:00`).getTime()
      : null;
    const budgetUsd = budget.trim() ? Number(budget) : null;
    create.mutate(
      {
        path: { assistant_id: assistantId },
        body: {
          title: title.trim(),
          outcome: outcome.trim(),
          ...(metric.trim() ? { metric: metric.trim() } : {}),
          ...(horizonMs && Number.isFinite(horizonMs)
            ? { horizon: horizonMs }
            : {}),
          ...(mode ? { mode } : {}),
          ...(budgetUsd != null && Number.isFinite(budgetUsd) && budgetUsd > 0
            ? { budgetCents: Math.round(budgetUsd * 100) }
            : {}),
        },
      },
      {
        onSuccess: (res) => {
          const id = res?.mission?.id;
          if (!id) {
            setSubmitting(false);
            onClose();
            return;
          }
          // Link the chosen initiatives, then land on the mission page. The
          // links are fire-and-settle: the detail page refetches on mount.
          const ids = [...linkedIds];
          if (ids.length === 0) {
            onCreated(id);
            return;
          }
          let remaining = ids.length;
          for (const projectId of ids) {
            linker.link(projectId, id, {
              onSettled: () => {
                remaining -= 1;
                if (remaining === 0) onCreated(id);
              },
            });
          }
        },
        onError: () => setSubmitting(false),
      },
    );
  };

  const toggleLink = (projectId: string) => {
    setLinkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New mission"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in srgb, #000 42%, transparent)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: C.surface,
          border: `1px solid ${C.line2}`,
          borderRadius: 16,
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.5)",
          padding: "22px 22px 20px",
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          New mission
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 25,
            letterSpacing: "-0.4px",
            color: C.ink,
            marginTop: 2,
            marginBottom: 18,
          }}
        >
          Point Cue at an outcome.
        </div>

        <FieldLabel>Title</FieldLabel>
        <input
          autoFocus={!presetTitle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="e.g. $500K seed, Ship v2…"
          style={inputStyle}
        />

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Outcome — what done looks like</FieldLabel>
          <textarea
            autoFocus={Boolean(presetTitle)}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="The measurable destination this mission drives toward, e.g. “$500K committed, wired by Sept 30.”"
            rows={2}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
          />
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <div style={{ flex: 1.4 }}>
            <FieldLabel>Metric · optional</FieldLabel>
            <input
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
              placeholder="e.g. $ raised of $500K"
              style={inputStyle}
            />
            <Hint>
              Connect a metric and the ring shows a real % — never before.
            </Hint>
          </div>
          <div style={{ flex: 1 }}>
            <FieldLabel>Horizon · optional</FieldLabel>
            <input
              type="date"
              value={horizon}
              onChange={(e) => setHorizon(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        {/* The leash dial: default badge + explicit override. */}
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
            }}
          >
            <FieldLabel>How much leash</FieldLabel>
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: C.blueS,
                background: C.blueW,
                borderRadius: 6,
                padding: "3px 8px",
              }}
            >
              workspace default · {MODE_META[workspaceMode].glyph}{" "}
              {MODE_META[workspaceMode].label.toLowerCase()}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 4,
              background: C.sunken,
              borderRadius: 13,
              padding: 5,
              marginTop: 8,
            }}
          >
            <ModeSeg
              active={mode === null}
              label="Default"
              glyph={MODE_META[workspaceMode].glyph}
              onClick={() => setMode(null)}
            />
            {(["observe", "assist", "autonomous"] as const).map((m) => (
              <ModeSeg
                key={m}
                active={mode === m}
                label={MODE_META[m].label}
                glyph={MODE_META[m].glyph}
                onClick={() => setMode(m)}
              />
            ))}
          </div>
          <Hint>
            {mode
              ? `Overridden → ${MODE_META[mode].label}. ${MODE_META[mode].blurb}`
              : `Uses the workspace default (${MODE_META[workspaceMode].label}). ${MODE_META[workspaceMode].blurb}`}
          </Hint>
        </div>

        <div style={{ marginTop: 16, maxWidth: 220 }}>
          <FieldLabel>Budget ceiling · optional</FieldLabel>
          <div style={{ position: "relative" }}>
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 11,
                top: "50%",
                transform: "translateY(-50%)",
                color: C.t3,
                fontSize: 14,
              }}
            >
              $
            </span>
            <input
              type="number"
              min={0}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="e.g. 3000"
              style={{ ...inputStyle, paddingLeft: 24 }}
            />
          </div>
          <Hint>Cue stops at the ceiling instead of overrunning — always.</Hint>
        </div>

        {linkable.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <FieldLabel>
              Initiatives — link existing projects · optional
            </FieldLabel>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                maxHeight: 170,
                overflowY: "auto",
                border: `1px solid ${C.line}`,
                borderRadius: 10,
                padding: 8,
              }}
            >
              {linkable.map((p) => {
                const checked = linkedIds.has(p.id);
                return (
                  <label
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      fontSize: 13,
                      color: C.ink,
                      cursor: "pointer",
                      padding: "5px 6px",
                      borderRadius: 7,
                      background: checked ? C.sunken : "transparent",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleLink(p.id)}
                    />
                    <span aria-hidden>{p.emoji ?? "📁"}</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.title}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {create.isError ? (
          <div style={{ marginTop: 12, fontSize: 12.5, color: C.dangerText }}>
            Couldn&rsquo;t create the mission — try again in a moment.
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
          }}
        >
          <button type="button" onClick={onClose} style={ghostBtn}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={{
              ...primaryBtn,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "default",
            }}
          >
            {submitting ? "Creating…" : "Create mission"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeSeg({
  active,
  label,
  glyph,
  onClick,
}: {
  active: boolean;
  label: string;
  glyph: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        flex: 1,
        textAlign: "center",
        padding: "9px 6px",
        borderRadius: 10,
        border: "none",
        fontSize: 12.5,
        fontWeight: active ? 600 : 400,
        background: active ? C.surface : "transparent",
        color: active ? C.blueS : C.t2,
        boxShadow: active ? "0 6px 16px -8px rgba(20,28,44,.3)" : "none",
        cursor: "pointer",
      }}
    >
      <div aria-hidden style={{ fontSize: 15, marginBottom: 2 }}>
        {glyph}
      </div>
      {label}
    </button>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: C.t3,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 6,
        fontSize: 11.5,
        color: C.t3,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 14,
  color: C.ink,
  background: C.bg,
  border: `1px solid ${C.line2}`,
  borderRadius: 9,
  padding: "9px 11px",
  outline: "none",
};

const ghostBtn: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  padding: "8px 14px",
  borderRadius: 9,
  border: `1px solid ${C.line2}`,
  background: "transparent",
  color: C.t2,
  cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  padding: "8px 16px",
  borderRadius: 9,
  border: "none",
  background: C.blue,
  color: "#fff",
};
