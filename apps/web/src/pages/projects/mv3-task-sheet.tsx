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
import { client } from "@/generated/daemon/client.gen";
import {
  SheetShell,
  StateChip,
  microLabel,
  primaryBtn,
  type Mv3State,
} from "@/mobile-v3";
import { Mv3AssessmentPanel } from "@/mobile-v3/assessment-mv3";
import { isAutoFiled, isParked } from "@/mobile-v3/work-kit";
import { mv3Mono } from "@/mobile-v3/mv3-kit";
import {
  blockedFixKind,
  readAssessment,
  type AssessmentFix,
} from "@/pages/hq/assessment-kit";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { rateLimitRetry } from "@/utils/rate-limit-retry";
import { routes } from "@/utils/routes";

import { Mv3RefileSheet } from "./mv3-refile-sheet";
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
    context: string | null;
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
    context: patch.context !== undefined ? patch.context : (item.context ?? null),
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

/**
 * Feature-detected "completed outside Cue" read-side marker: the daemon's
 * `ranProvenance: "manual"` trust signal (already shipped) or the incoming
 * `completedElsewhere` completion marker, whichever the daemon carries.
 */
function wasDoneElsewhere(item: HqWorkItem): boolean {
  if (item.status !== "done") return false;
  const rec = item as unknown as Record<string, unknown>;
  return rec.ranProvenance === "manual" || rec.completedElsewhere === true;
}

function chipFor(item: HqWorkItem): { state: Mv3State; label: string } {
  switch (item.status) {
    case "running":
      return { state: "running", label: "Running" };
    case "awaiting_review":
      return { state: "review", label: "Ready · review" };
    case "done":
      return {
        state: "done",
        label: wasDoneElsewhere(item) ? "Done · elsewhere" : "Done",
      };
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
  color: "var(--mv3-muted)",
  marginBottom: 8,
};

const fieldShell: React.CSSProperties = {
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 12,
  color: "var(--mv3-text)",
  fontFamily: "inherit",
};

/**
 * One row of frame 45's stacked action list — full-width, text-left.
 * `primary` = the blue-gradient CTA; `quiet` = the borderless faint row
 * ("✕ Not relevant — archive").
 */
function StackBtn({
  label,
  caption,
  primary = false,
  quiet = false,
  disabled = false,
  color,
  onClick,
}: {
  label: React.ReactNode;
  /** Right-aligned faint note ("complete, not Cue's work"). */
  caption?: string;
  primary?: boolean;
  quiet?: boolean;
  disabled?: boolean;
  /** Label color override (the archive amber confirm state). */
  color?: string;
  onClick: () => void;
}) {
  const chrome: React.CSSProperties = primary
    ? { ...primaryBtn, flex: "initial", borderRadius: 11 }
    : quiet
      ? {
          background: "none",
          border: "none",
          color: color ?? "var(--mv3-muted)",
        }
      : {
          background: "var(--mv3-btn2-bg)",
          border: "1px solid var(--mv3-btn2-border)",
          color: color ?? "var(--mv3-text)",
          borderRadius: 11,
        };
  return (
    <button
      type="button"
      className="cue-pressable"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: "100%",
        minHeight: 44,
        padding: quiet ? "9px 13px" : "11px 13px",
        fontSize: quiet ? 12 : 12.5,
        fontWeight: primary ? 600 : 400,
        fontFamily: "inherit",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 7,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        ...chrome,
      }}
    >
      <span style={{ flex: caption ? "initial" : 1 }}>{label}</span>
      {caption ? (
        <span
          style={{
            marginLeft: "auto",
            fontSize: 9,
            color: "var(--mv3-muted)",
            fontWeight: 400,
          }}
        >
          {caption}
        </span>
      ) : null}
    </button>
  );
}

/* --------------------------------- sheet ---------------------------------- */

export function Mv3TaskSheet({
  assistantId,
  item,
  projects,
  onClose,
  onAttachKnowledge,
}: {
  assistantId: string;
  /** The task to edit; null keeps the sheet closed. */
  item: HqWorkItem | null;
  /** Filed-to targets (the sheet filters to active projects itself). */
  projects: ProjectView[];
  onClose: () => void;
  /**
   * Take the user to this project's knowledge pane. Supplied by the surface
   * behind the sheet (project detail has one; All-work does not); when it's
   * absent a `blocked` verdict that wants a file says what's needed instead of
   * offering a button with nowhere to go.
   */
  onAttachKnowledge?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const patch = usePatchWorkItem(assistantId);

  const [labelDraft, setLabelDraft] = useState("");
  // Archive is confirm-tap (the schedule editor's delete pattern): first tap
  // arms, second tap writes. Re-arms per item.
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Frame 44's "Where does this belong?" — the 📁 action's sheet.
  const [refileOpen, setRefileOpen] = useState(false);
  useEffect(() => {
    setLabelDraft("");
    setConfirmArchive(false);
    setRefileOpen(false);
  }, [item?.id]);

  // Refresh EVERY work surface (all-work list, hq buckets, project boards,
  // review queue) after a write — the sheet is shared across them.
  const refreshAll = () => {
    haptic.success();
    void queryClient.invalidateQueries();
  };

  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    ...rateLimitRetry,
    onSuccess: refreshAll,
  });
  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    ...rateLimitRetry,
    onSuccess: refreshAll,
  });

  /**
   * "Done elsewhere" — you handled it yourself; Cue never runs it. Uses the
   * REAL complete endpoint, carrying the `completedElsewhere: true` marker
   * (daemons that don't know the field ignore body fields on this route).
   * Older daemons gate /complete to awaiting_review, so non-review statuses
   * fall back to the sheet's full-record PATCH (status → done) on rejection.
   */
  const doneElsewhere = useMutation({
    ...rateLimitRetry,
    mutationFn: async () => {
      if (!item) return;
      const path = { assistant_id: assistantId, id: item.id };
      try {
        await client.post({
          url: "/v1/assistants/{assistant_id}/work-items/{id}/complete",
          path,
          body: { completedElsewhere: true },
          throwOnError: true,
        });
      } catch (err) {
        if (item.status === "awaiting_review") throw err;
        await client.patch({
          url: "/v1/assistants/{assistant_id}/work-items/{id}",
          path,
          body: sheetBody(item, { status: "done" }),
          throwOnError: true,
        });
      }
    },
    onSuccess: () => {
      refreshAll();
      onClose();
    },
  });

  if (!item) return null;

  const pathOpts = { path: { assistant_id: assistantId, id: item.id } };
  const chip = chipFor(item);
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

  /* ----------------------------- the pre-run read ---------------------------- */

  // The verdict the daemon stored before this item's run. A non-`execute`
  // verdict means the run was HELD, so the sheet's loud ▶ stands down and the
  // panel owns the honest framing (plus the override). No verdict → nothing
  // renders and the sheet is exactly what it was.
  const assessment = readAssessment(item);
  const canRun = item.status === "queued" || item.status === "pending";
  const held = assessment != null && assessment.verdict !== "execute";
  const canDoneElsewhere =
    item.status === "queued" ||
    item.status === "pending" ||
    item.status === "awaiting_review";

  /**
   * Answer the assessor's one question (or name what was missing). The text
   * lands in the task's OWN context — the same field the run reads — which
   * changes the assessment's input hash, so Cue looks at the task again
   * instead of asking twice.
   */
  const answerQuestion = (answer: string) => {
    const prompt =
      assessment?.verdict === "clarify"
        ? assessment.question
        : (assessment?.missing ?? null);
    const entry = prompt ? `${prompt}\n${answer}` : answer;
    const merged = [(item.context ?? "").trim(), entry]
      .filter(Boolean)
      .join("\n\n");
    patch.mutate(
      { ...pathOpts, body: sheetBody(item, { context: merged }) },
      { onSuccess: refreshAll },
    );
  };

  /** The one real destination that clears a `blocked` verdict, when we have one. */
  const blockedFix = ((): AssessmentFix | null => {
    if (assessment?.verdict !== "blocked") return null;
    const kind = blockedFixKind(assessment.missing);
    if (kind === "connect") {
      return {
        label: "Connect an account",
        onClick: () => {
          onClose();
          navigate(routes.connectors);
        },
      };
    }
    if (kind === "attach" && onAttachKnowledge) {
      return {
        label: "Attach it to this project",
        onClick: () => {
          onClose();
          onAttachKnowledge();
        },
      };
    }
    return null;
  })();

  return (
    <SheetShell open label={`Task: ${item.title}`} onClose={onClose}>
      <div style={{ paddingBottom: 6 }}>
        {/* Header — state chip · last activity, then the title. Parked items
            say "○ Parked" here too (one vocabulary everywhere): a parked task
            was never "queued and active" — it waits for the user's ▶. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {isParked(item) ? (
            <span
              style={{
                fontFamily: mv3Mono,
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--mv3-muted)",
              }}
            >
              ○ Parked
            </span>
          ) : (
            <StateChip state={chip.state} label={chip.label} />
          )}
          {item.lastActivityAt != null ? (
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11.5,
                color: "var(--mv3-muted)",
              }}
            >
              {isParked(item)
                ? "waits for your ▶"
                : `active ${relativeTime(item.lastActivityAt)}`}
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

        {/* What Cue understood before it ran this, in plain words — and, when
            it is holding the task, the one thing it needs from you. Absent on
            an item that was never assessed: that renders exactly as before. */}
        {assessment ? (
          <Mv3AssessmentPanel
            assessment={assessment}
            running={item.status === "running"}
            checked={
              assessment.assessedAt != null
                ? relativeTime(assessment.assessedAt)
                : null
            }
            onAnswer={
              // clarify always takes an answer; blocked takes one only when we
              // have no real destination to send you to (the phone has no
              // Context editor to point at).
              assessment.verdict === "clarify" ||
              (assessment.verdict === "blocked" && !blockedFix)
                ? answerQuestion
                : undefined
            }
            answerPending={patch.isPending}
            answerFailed={patch.isError}
            onMarkDone={
              assessment.verdict === "not_ai_task" && canDoneElsewhere
                ? () => doneElsewhere.mutate()
                : undefined
            }
            markDonePending={doneElsewhere.isPending}
            onRunAnyway={canRun ? () => run.mutate(pathOpts) : undefined}
            runPending={run.isPending}
            fix={blockedFix}
          />
        ) : null}

        {/* Actions — frame 45's stacked order: ▶ Have Cue handle it ·
            📁 File to a project · ✓ Done elsewhere · ✕ Not relevant — archive.
            Same wiring as ever (run / refile PATCH / complete + 409→PATCH
            fallback / archive PATCH); review keeps its Approve/Redo pair in
            the primary slot. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 5,
            marginTop: 14,
          }}
        >
          {/* Held by the assessment → no loud ▶ here. The panel above says why
              and carries the override, so we never offer "have Cue handle it"
              for something Cue has just said it cannot handle yet. */}
          {canRun && !held && (
            <StackBtn
              primary
              label={run.isPending ? "Starting…" : "▶ Have Cue handle it"}
              disabled={run.isPending}
              onClick={() => {
                haptic.medium();
                run.mutate(pathOpts);
              }}
            />
          )}
          {item.status === "awaiting_review" && (
            <>
              <StackBtn
                primary
                label={approve.isPending ? "Approving…" : "✓ Approve & finish"}
                disabled={approve.isPending}
                onClick={() => {
                  haptic.medium();
                  approve.mutate({ ...pathOpts, body: {} });
                }}
              />
              <StackBtn
                label={run.isPending ? "Redoing…" : "▶ Redo"}
                disabled={run.isPending}
                onClick={() => {
                  haptic.medium();
                  run.mutate(pathOpts);
                }}
              />
            </>
          )}
          {item.status === "done" && (
            <StackBtn
              label={run.isPending ? "Running…" : "▶ Run again"}
              disabled={run.isPending}
              onClick={() => {
                haptic.medium();
                run.mutate(pathOpts);
              }}
            />
          )}

          <StackBtn
            label="📁 File to a project"
            onClick={() => {
              haptic.light();
              setRefileOpen(true);
            }}
          />

          {item.status === "queued" ||
          item.status === "pending" ||
          item.status === "awaiting_review" ? (
            <StackBtn
              label={
                <>
                  <span aria-hidden style={{ color: "var(--mv3-green)" }}>
                    ✓
                  </span>{" "}
                  {doneElsewhere.isPending ? "Marking done…" : "Done elsewhere"}
                </>
              }
              caption="complete, not Cue's work"
              disabled={doneElsewhere.isPending}
              onClick={() => {
                haptic.medium();
                doneElsewhere.mutate();
              }}
            />
          ) : null}

          {item.status !== "archived" ? (
            <StackBtn
              quiet
              label={
                patch.isPending && confirmArchive
                  ? "Archiving…"
                  : confirmArchive
                    ? "✕ Tap again to archive"
                    : "✕ Not relevant — archive"
              }
              color={confirmArchive ? "var(--mv3-amber)" : undefined}
              disabled={patch.isPending}
              onClick={() => {
                if (!confirmArchive) {
                  haptic.light();
                  setConfirmArchive(true);
                  return;
                }
                haptic.medium();
                patch.mutate(
                  {
                    ...pathOpts,
                    body: sheetBody(item, { status: "archived" }),
                  },
                  {
                    onSuccess: () => {
                      refreshAll();
                      onClose();
                    },
                  },
                );
              }}
            />
          ) : null}

          {item.lastRunConversationId ? (
            <StackBtn
              label="Open thread"
              onClick={() => {
                haptic.light();
                onClose();
                navigate(routes.conversation(item.lastRunConversationId!));
              }}
            />
          ) : null}
        </div>

        {/* The ledger-honest line under Done elsewhere (frame 45 / D3). */}
        {item.status === "queued" ||
        item.status === "pending" ||
        item.status === "awaiting_review" ? (
          <div
            style={{
              fontSize: 11,
              color: doneElsewhere.isError
                ? "var(--mv3-amber)"
                : "var(--mv3-muted)",
              marginTop: 6,
              lineHeight: 1.5,
            }}
          >
            {doneElsewhere.isError
              ? "Couldn’t mark it done — try again."
              : "Done elsewhere completes it for progress — the ledger says completed by you."}
          </div>
        ) : null}

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
                    aria-label={
                      current
                        ? `Filed to ${p.title} (current)`
                        : `File to ${p.title}`
                    }
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
                        {/* ✨ = Cue auto-filed it here (feature-detected);
                            moving it is the same refile as ever. */}
                        {isAutoFiled(item) ? "✨ Auto-filed" : "Current"}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--mv3-muted)",
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
            color: patch.isError ? "var(--mv3-amber)" : "var(--mv3-muted)",
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

      {/* 📁 File to a project → frame 44's "Where does this belong?". */}
      <Mv3RefileSheet
        assistantId={assistantId}
        item={refileOpen ? item : null}
        projects={projects}
        onClose={() => setRefileOpen(false)}
        onMoved={() => refreshAll()}
      />
    </SheetShell>
  );
}
