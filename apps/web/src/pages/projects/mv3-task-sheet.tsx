/**
 * Mv3TaskSheet — the mobile v3 task edit sheet (parity audit §3: due-date /
 * labels / re-file / Run-Redo, the capabilities desktop's `task-drawer.tsx`
 * carries). Opens from task rows on the mv3 project detail and All-work list.
 *
 * ENDPOINTS — the exact writes the desktop drawer uses, nothing new:
 *   · edit due date / labels / re-file → `workitemsByIdPatch` via
 *     `usePatchWorkItem` (the daemon's PATCH requires the FULL record, so
 *     every mutation assembles a complete body from the rendered item —
 *     same rule as task-drawer's `fullBody`).
 *   · Run now / Redo / Run again      → `workitemsByIdRunPost`
 *   · Approve & finish                → `workitemsByIdCompletePost`
 *
 * Assignee is DISPLAY-ONLY here because it is display-only on desktop too
 * (task-drawer renders "assignee · Cue" with no picker); the editable
 * "reassign" in the audit is the Filed-to project move, which this sheet has.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { relativeTime } from "@/domains/activity/theme";
import {
  workitemsByIdCompletePostMutation,
  workitemsByIdRunPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { SheetShell, StateChip, microLabel, type Mv3State } from "@/mobile-v3";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { usePatchWorkItem, type ProjectView } from "./use-projects";

/* ------------------------------ data helpers ------------------------------ */

function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((l): l is string => typeof l === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Rebuild the FULL PATCH body (daemon requirement) with the sheet's editable
 * leaves layered in — mirrors task-drawer's `fullBody`, extended with the
 * `dueAt` / `labels` patches this sheet edits.
 */
function sheetBody(
  item: HqWorkItem,
  patch: Partial<{
    dueAt: number | null;
    labels: string[];
    projectId: string | null;
    status: string;
  }>,
) {
  return {
    title: item.title,
    notes: item.notes ?? "",
    status: patch.status ?? item.status,
    priorityTier: item.priorityTier,
    sortIndex: item.sortIndex ?? 0,
    projectId: patch.projectId !== undefined ? patch.projectId : item.projectId,
    dueAt: patch.dueAt !== undefined ? patch.dueAt : item.dueAt,
    labels: patch.labels !== undefined ? patch.labels : parseLabels(item.labels),
    assignee: item.assignee ?? "cue",
    context: item.context ?? null,
  };
}

/** epoch ms → the native date input's yyyy-mm-dd (local). */
function toDateInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * yyyy-mm-dd → epoch ms, keeping the item's existing time-of-day when it had
 * one (so "move to Friday" doesn't silently shift a 4pm deadline to midnight);
 * fresh dates land at 9:00 local.
 */
function fromDateInput(value: string, prev: number | null): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  const next = new Date(y, m - 1, d);
  if (prev != null) {
    const p = new Date(prev);
    next.setHours(p.getHours(), p.getMinutes(), 0, 0);
  } else {
    next.setHours(9, 0, 0, 0);
  }
  return next.getTime();
}

function chipFor(status: string): { state: Mv3State; label: string } {
  switch (status) {
    case "running":
      return { state: "running", label: "Running" };
    case "awaiting_review":
      return { state: "review", label: "Ready · review" };
    case "done":
      return { state: "done", label: "Done" };
    case "failed":
      return { state: "needs_you", label: "Failed" };
    default:
      return { state: "picked_up", label: "Queued" };
  }
}

/* ------------------------------ visual atoms ------------------------------ */

const sectionLabel: React.CSSProperties = {
  ...microLabel,
  fontSize: 9.5,
  letterSpacing: "0.1em",
  color: "var(--mv3-faint)",
  marginBottom: 8,
};

const fieldShell: React.CSSProperties = {
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 12,
  color: "var(--mv3-text)",
  fontFamily: "inherit",
};

function ActionBtn({
  label,
  primary = false,
  disabled = false,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="cue-pressable"
      disabled={disabled}
      onClick={onClick}
      style={{
        flex: 1,
        minHeight: 44,
        borderRadius: 12,
        padding: "10px 12px",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        border: primary ? "none" : "1px solid var(--mv3-btn2-border)",
        background: primary ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
        color: primary ? "var(--mv3-bg)" : "var(--mv3-text)",
      }}
    >
      {label}
    </button>
  );
}

/* --------------------------------- sheet ---------------------------------- */

export function Mv3TaskSheet({
  assistantId,
  item,
  projects,
  onClose,
}: {
  assistantId: string;
  /** The task to edit; null keeps the sheet closed. */
  item: HqWorkItem | null;
  /** Filed-to targets (the sheet filters to active projects itself). */
  projects: ProjectView[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const patch = usePatchWorkItem(assistantId);

  const [labelDraft, setLabelDraft] = useState("");
  useEffect(() => setLabelDraft(""), [item?.id]);

  // Refresh EVERY work surface (all-work list, hq buckets, project boards,
  // review queue) after a write — the sheet is shared across them.
  const refreshAll = () => {
    haptic.success();
    void queryClient.invalidateQueries();
  };

  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSuccess: refreshAll,
  });
  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    onSuccess: refreshAll,
  });

  if (!item) return null;

  const pathOpts = { path: { assistant_id: assistantId, id: item.id } };
  const chip = chipFor(item.status);
  const labels = parseLabels(item.labels);

  const patchItem = (p: Parameters<typeof sheetBody>[1]) => {
    patch.mutate(
      { ...pathOpts, body: sheetBody(item, p) },
      { onSuccess: refreshAll },
    );
  };

  const addLabel = () => {
    const next = labelDraft.trim();
    if (!next || labels.includes(next)) return;
    patchItem({ labels: [...labels, next] });
    setLabelDraft("");
  };

  const reassignTargets = projects.filter(
    (p) => p.status === "active" || p.id === item.projectId,
  );

  return (
    <SheetShell open label={`Task: ${item.title}`} onClose={onClose}>
      <div style={{ paddingBottom: 6 }}>
        {/* Header — state chip · last activity, then the title. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StateChip state={chip.state} label={chip.label} />
          {item.lastActivityAt != null ? (
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11.5,
                color: "var(--mv3-faint)",
              }}
            >
              active {relativeTime(item.lastActivityAt)}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: "-0.3px",
            marginTop: 8,
            color: "var(--mv3-text)",
            lineHeight: 1.35,
          }}
        >
          {item.title}
        </div>
        <div
          style={{ fontSize: 12, color: "var(--mv3-muted)", marginTop: 5 }}
        >
          {item.assignee && item.assignee !== "cue"
            ? `Assignee · ${item.assignee}`
            : "Assignee · Cue"}
          {item.sourceType ? ` · from ${item.sourceType}` : ""}
        </div>

        {/* Actions — the drawer's exact status-gated set. */}
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          {(item.status === "queued" || item.status === "pending") && (
            <ActionBtn
              label={run.isPending ? "Starting…" : "Run now"}
              primary
              disabled={run.isPending}
              onClick={() => {
                haptic.medium();
                run.mutate(pathOpts);
              }}
            />
          )}
          {item.status === "awaiting_review" && (
            <>
              <ActionBtn
                label={approve.isPending ? "Approving…" : "Approve"}
                primary
                disabled={approve.isPending}
                onClick={() => {
                  haptic.medium();
                  approve.mutate(pathOpts);
                }}
              />
              <ActionBtn
                label={run.isPending ? "Redoing…" : "Redo"}
                disabled={run.isPending}
                onClick={() => {
                  haptic.medium();
                  run.mutate(pathOpts);
                }}
              />
            </>
          )}
          {item.status === "done" && (
            <ActionBtn
              label={run.isPending ? "Running…" : "Run again"}
              disabled={run.isPending}
              onClick={() => {
                haptic.medium();
                run.mutate(pathOpts);
              }}
            />
          )}
          {item.lastRunConversationId ? (
            <ActionBtn
              label="Open thread"
              onClick={() => {
                haptic.light();
                onClose();
                navigate(routes.conversation(item.lastRunConversationId!));
              }}
            />
          ) : null}
        </div>

        {/* Due date — native picker, 16px so iOS doesn't zoom. */}
        <div style={{ marginTop: 20 }}>
          <div style={sectionLabel}>Due</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="date"
              aria-label="Due date"
              value={toDateInput(item.dueAt)}
              onChange={(e) => {
                haptic.light();
                patchItem({ dueAt: fromDateInput(e.target.value, item.dueAt) });
              }}
              style={{
                ...fieldShell,
                flex: 1,
                minHeight: 44,
                fontSize: 16,
                padding: "8px 12px",
                colorScheme: "dark",
              }}
            />
            {item.dueAt != null ? (
              <button
                type="button"
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  patchItem({ dueAt: null });
                }}
                style={{
                  ...fieldShell,
                  minHeight: 44,
                  padding: "8px 14px",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--mv3-muted)",
                  cursor: "pointer",
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {/* Labels — chips with remove, plus an add row. */}
        <div style={{ marginTop: 20 }}>
          <div style={sectionLabel}>Labels</div>
          {labels.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 7,
                marginBottom: 9,
              }}
            >
              {labels.map((l) => (
                <span
                  key={l}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: "var(--mv3-text)",
                    background:
                      "color-mix(in srgb, var(--mv3-accent) 16%, transparent)",
                    border:
                      "1px solid color-mix(in srgb, var(--mv3-accent) 30%, transparent)",
                    borderRadius: 9,
                    padding: "5px 6px 5px 10px",
                  }}
                >
                  {l}
                  <button
                    type="button"
                    aria-label={`Remove label ${l}`}
                    onClick={() => {
                      haptic.light();
                      patchItem({ labels: labels.filter((x) => x !== l) });
                    }}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "var(--mv3-muted)",
                      fontSize: 13,
                      lineHeight: 1,
                      padding: "6px 7px",
                      margin: -4,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              aria-label="Add a label"
              placeholder="Add a label…"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLabel();
                }
              }}
              style={{
                ...fieldShell,
                flex: 1,
                minHeight: 44,
                fontSize: 16,
                padding: "8px 12px",
                outline: "none",
              }}
            />
            <button
              type="button"
              className="cue-pressable"
              disabled={!labelDraft.trim()}
              onClick={addLabel}
              style={{
                ...fieldShell,
                minHeight: 44,
                padding: "8px 16px",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: labelDraft.trim() ? "pointer" : "default",
                opacity: labelDraft.trim() ? 1 : 0.5,
              }}
            >
              Add
            </button>
          </div>
        </div>

        {/* Filed to — the §4 reassign move (moving teaches Cue). */}
        <div style={{ marginTop: 20 }}>
          <div style={sectionLabel}>Filed to</div>
          {reassignTargets.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
              No projects yet — this task stays unfiled.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {reassignTargets.map((p) => {
                const current = p.id === item.projectId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="cue-pressable"
                    disabled={current || patch.isPending}
                    onClick={() => {
                      haptic.medium();
                      patchItem({ projectId: p.id });
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      minHeight: 44,
                      padding: "10px 13px",
                      borderRadius: 12,
                      textAlign: "left",
                      fontFamily: "inherit",
                      fontSize: 13.5,
                      cursor: current ? "default" : "pointer",
                      color: "var(--mv3-text)",
                      background: current
                        ? "color-mix(in srgb, var(--mv3-accent) 14%, transparent)"
                        : "var(--mv3-btn2-bg)",
                      border: current
                        ? "1px solid color-mix(in srgb, var(--mv3-accent) 40%, transparent)"
                        : "1px solid var(--mv3-btn2-border)",
                    }}
                  >
                    <span aria-hidden>{p.emoji ?? "📁"}</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.title}
                    </span>
                    {current ? (
                      <span
                        style={{
                          ...microLabel,
                          fontSize: 9,
                          color: "var(--mv3-micro)",
                        }}
                      >
                        Current
                      </span>
                    ) : null}
                  </button>
                );
              })}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--mv3-faint)",
                  lineHeight: 1.5,
                  marginTop: 2,
                }}
              >
                Moving teaches Cue where work like this belongs.
              </div>
            </div>
          )}
        </div>

        {/* Write status — honest, one line. */}
        <div
          style={{
            marginTop: 16,
            fontSize: 11.5,
            color: patch.isError ? "var(--mv3-amber)" : "var(--mv3-faint)",
            minHeight: 16,
          }}
        >
          {patch.isPending
            ? "Saving…"
            : patch.isError
              ? "Couldn’t save that — try again."
              : ""}
        </div>
      </div>
    </SheetShell>
  );
}
