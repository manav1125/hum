/**
 * Mv3ProjectDetail — the mobile v3 project detail (spec frame 3): "sheet
 * grammar + live run". Replaces the MOBILE rendering of ProjectDetailPage
 * only; desktop keeps the serif B2 board untouched.
 *
 * Layout (spec-verbatim): the header stays ON the aurora (‹ back, PROJECT ·
 * status microlabel, name, progress ring %, goal line + "N running · M needs
 * you"), then the work rides an iOS sheet (grabber, blur, 28px top radius):
 * LIVE run card (pulse badge · elapsed · step checklist) → amber needs-you
 * card (Approve & finish) → ◱ review artifact rows → queued/done rows → the
 * "Ask about this project…" composer.
 *
 * DATA MAPPING — nothing invented:
 *   · `useProject` + per-project stats            → header, ring %, tallies
 *   · `useProjectWorkItems`                       → sheet cards by status
 *   · `workitemsByIdEventsGet` (per live item)    → the step checklist
 *   · Approve & finish → `workitemsByIdCompletePost` (the review approve path)
 *   · Step in → the run conversation · Watch live → routes.workLive(id)
 * CONTROLS OMITTED (no backend): the frame's "Pause" button — the daemon only
 * exposes a hard cancel for running items, so the live card carries Watch
 * live + Step in instead of a dead Pause.
 */
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { relativeTime } from "@/domains/activity/theme";
import {
  workitemsByIdCompletePostMutation,
  workitemsByIdEventsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import {
  AuroraBackdrop,
  CueRing,
  SheetShell,
  StateChip,
  cardBody,
  microLabel,
  rise,
} from "@/mobile-v3";
import { SwipeArchiveRow } from "@/mobile-v3/swipe-archive-row";
import { dismissLeave, useDismissTask } from "@/mobile-v3/undo-toast";
import {
  BackRow,
  Grabber,
  LivePulseBadge,
  ParkedCoachline,
  ParkedMark,
  RunNowButton,
  dueLabel,
  elapsedLabel,
  inlineSheet,
  isParked,
  useRunNow,
} from "@/mobile-v3/work-kit";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { Mv3ProjectBrief } from "./mv3-project-brief";
import { Mv3ProjectKnowledge } from "./mv3-project-knowledge";
import { Mv3TaskSheet } from "./mv3-task-sheet";
import {
  useDeleteProject,
  usePatchProject,
  useProject,
  useProjects,
  type ProjectView,
} from "./use-projects";
import { useQuickAddTask } from "./use-quick-add";

/** Human line for a work-item trail event (status transitions, honest). */
function stepLabel(e: {
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
}): string {
  if (e.kind === "created") return "Captured";
  switch (e.toStatus) {
    case "queued":
    case "pending":
      return "Queued";
    case "running":
      return "Started the run";
    case "awaiting_review":
      return "Finished — ready for your review";
    case "done":
      return "Approved";
    case "failed":
      return "Hit an error";
    case "cancelled":
      return "Stopped";
    default:
      return e.kind.replaceAll("_", " ");
  }
}

/** LIVE run card (frame 3): pulse badge · elapsed · step checklist · controls. */
function LiveRunCard({
  assistantId,
  item,
  now,
  delay,
}: {
  assistantId: string;
  item: HqWorkItem;
  now: number;
  delay: number;
}) {
  const navigate = useNavigate();
  const events = useQuery({
    ...workitemsByIdEventsGetOptions({
      path: { assistant_id: assistantId, id: item.id },
    }),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  const trail = useMemo(
    () => [...(events.data?.events ?? [])].sort((a, b) => a.at - b.at),
    [events.data?.events],
  );
  const runStart =
    [...trail].reverse().find((e) => e.toStatus === "running")?.at ??
    item.lastActivityAt ??
    item.updatedAt;

  return (
    <div
      data-mv3
      style={{
        background: "var(--mv3-card)",
        border: "1px solid rgba(61,110,232,.35)",
        borderRadius: 18,
        padding: "14px 15px",
        ...rise(delay),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <LivePulseBadge />
        <span
          style={{
            ...microLabel,
            fontSize: 9.5,
            letterSpacing: "0.08em",
            color: "var(--mv3-micro)",
          }}
        >
          Live · Cue
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11.5,
            color: "var(--mv3-muted)",
          }}
        >
          {elapsedLabel(runStart, now)}
        </span>
      </div>
      <div
        style={{
          fontSize: 14.5,
          fontWeight: 600,
          marginTop: 8,
          color: "var(--mv3-text)",
        }}
      >
        {item.title}
      </div>

      {/* Step checklist — the item's real event trail, then the runner's live
          progress note as the current (fetching) step. */}
      <div
        style={{
          marginTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        {trail.slice(-3).map((e) => (
          <div
            key={e.id}
            style={{
              display: "flex",
              gap: 8,
              fontSize: 12,
              color: "var(--mv3-muted)",
            }}
          >
            <span style={{ color: "var(--mv3-green)" }} aria-hidden>
              ✓
            </span>
            {stepLabel(e)}
          </div>
        ))}
        <div
          style={{
            display: "flex",
            gap: 8,
            fontSize: 12,
            color: "var(--mv3-text)",
            alignItems: "flex-start",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              border: "2px solid var(--mv3-accent)",
              borderRadius: "50%",
              marginTop: 2,
              flexShrink: 0,
            }}
          />
          {item.lastProgressNote ?? "Cue is working on this…"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            navigate(routes.workLive(item.id));
          }}
          style={sheetBtn}
        >
          Watch live
        </button>
        {item.lastRunConversationId ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.medium();
              navigate(routes.conversation(item.lastRunConversationId!));
            }}
            style={sheetBtn}
          >
            Step in
          </button>
        ) : null}
      </div>
    </div>
  );
}

const sheetBtn: React.CSSProperties = {
  flex: 1,
  background: "var(--mv3-btn2-bg)",
  color: "var(--mv3-text)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 11,
  padding: 9,
  minHeight: 40,
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};

/** Amber needs-you card: the first awaiting_review item, Approve & finish. */
function NeedsYouCard({
  assistantId,
  item,
  delay,
  onOpen,
}: {
  assistantId: string;
  item: HqWorkItem;
  delay: number;
  /** Opens the OUTPUT — the review pager seeded at this item. */
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries();
    },
  });
  return (
    <div
      data-mv3
      style={{
        background: "var(--mv3-amber-card-bg)",
        border: "1px solid var(--mv3-amber-card-border)",
        borderRadius: 18,
        padding: "14px 15px",
        ...rise(delay),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: 7,
            background: "color-mix(in srgb, var(--mv3-amber) 20%, transparent)",
            color: "var(--mv3-amber)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          ‖
        </span>
        <span
          style={{
            ...microLabel,
            fontSize: 9.5,
            letterSpacing: "0.08em",
            color: "var(--mv3-amber)",
          }}
        >
          Ready · needs you
        </span>
      </div>
      <div
        style={{
          fontSize: 14.5,
          fontWeight: 600,
          marginTop: 8,
          color: "var(--mv3-text)",
        }}
      >
        {item.title}
      </div>
      <button
        type="button"
        className="cue-pressable"
        disabled={approve.isPending}
        onClick={() => {
          haptic.medium();
          approve.mutate({
            path: { assistant_id: assistantId, id: item.id },
            body: {},
          });
        }}
        style={{
          width: "100%",
          background: "var(--mv3-amber)",
          color: "var(--mv3-amber-btn-text)",
          border: "none",
          borderRadius: 11,
          padding: 10,
          minHeight: 44,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          marginTop: 11,
          cursor: "pointer",
          opacity: approve.isPending ? 0.6 : 1,
        }}
      >
        {approve.isPending ? "Approving…" : "Approve & finish"}
      </button>
      {/* The output link — see what Cue actually made before approving. */}
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          onOpen();
        }}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          color: "var(--mv3-muted)",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "inherit",
          padding: 8,
          minHeight: 36,
          marginTop: 2,
          cursor: "pointer",
        }}
      >
        Review the work ›
      </button>
    </div>
  );
}

/** ◱ artifact row — a review deliverable, chevron into the review pager. */
function ArtifactRow({
  item,
  delay,
  onOpen,
}: {
  item: HqWorkItem;
  delay: number;
  onOpen: () => void;
}) {
  return (
    <div
      data-mv3
      role="button"
      tabIndex={0}
      className="cue-pressable"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderRadius: 18,
        padding: "14px 15px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        cursor: "pointer",
        minHeight: 48,
        ...rise(delay),
      }}
    >
      <span
        aria-hidden
        style={{
          width: 40,
          height: 48,
          borderRadius: 8,
          background: "linear-gradient(160deg,#232C3D,#1A2130)",
          border: "1px solid rgba(255,255,255,.1)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 7px",
          gap: 3,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            height: 4,
            width: "80%",
            background: "#F4F4F6",
            borderRadius: 1,
            opacity: 0.9,
          }}
        />
        <span
          style={{
            height: 2.5,
            width: "100%",
            background: "rgba(255,255,255,.3)",
            borderRadius: 1,
          }}
        />
        <span
          style={{
            height: 2.5,
            width: "70%",
            background: "rgba(255,255,255,.3)",
            borderRadius: 1,
          }}
        />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--mv3-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </div>
        <div
          style={{ fontSize: 11.5, color: "var(--mv3-violet)", marginTop: 2 }}
        >
          ◱ Ready for review
          {item.updatedAt ? ` · ${relativeTime(item.updatedAt)}` : ""}
        </div>
      </div>
      <span aria-hidden style={{ fontSize: 16, color: "var(--mv3-faint)" }}>
        ›
      </span>
    </div>
  );
}

/**
 * The project ⋯ menu (QA night P1-7): Rename (inline, PATCH title) + Archive
 * (confirm-tap, PATCH status) + Delete (confirm-tap, DELETE) — the same real
 * endpoints desktop's project management uses (`usePatchProject` /
 * `useDeleteProject`, the writes Mv3NewProjectSheet's create sits beside).
 */
function Mv3ProjectMenuSheet({
  assistantId,
  project,
  open,
  onClose,
}: {
  assistantId: string;
  project: ProjectView | null;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const patch = usePatchProject(assistantId);
  const del = useDeleteProject(assistantId);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Re-arm everything each time the sheet opens.
  useEffect(() => {
    if (open) {
      setRenaming(false);
      setNameDraft(project?.title ?? "");
      setConfirmArchive(false);
      setConfirmDelete(false);
    }
  }, [open, project?.title]);

  if (!project) return null;
  const busy = patch.isPending || del.isPending;
  const pathOpts = { path: { assistant_id: assistantId, id: project.id } };

  const rowStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 48,
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 14,
    fontFamily: "inherit",
    textAlign: "left",
    background: "var(--mv3-btn2-bg)",
    border: "1px solid var(--mv3-btn2-border)",
    color: "var(--mv3-text)",
    cursor: "pointer",
  };

  const saveRename = () => {
    const title = nameDraft.trim();
    if (!title || title === project.title || busy) return;
    haptic.medium();
    patch.mutate(
      { ...pathOpts, body: { title } },
      {
        onSuccess: () => {
          haptic.success();
          onClose();
        },
      },
    );
  };

  return (
    <SheetShell open={open} onClose={onClose} label={`Project: ${project.title}`}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: "var(--mv3-text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {project.emoji ? `${project.emoji} ` : ""}
        {project.title}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
        {/* Rename — inline, in-sheet. */}
        {renaming ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              autoFocus
              aria-label="Project name"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 44,
                fontSize: 16,
                color: "var(--mv3-text)",
                background: "var(--mv3-btn2-bg)",
                border: "1.5px solid var(--mv3-accent)",
                borderRadius: 12,
                padding: "10px 13px",
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              className="cue-pressable"
              disabled={!nameDraft.trim() || busy}
              onClick={saveRename}
              style={{
                minHeight: 44,
                padding: "8px 16px",
                borderRadius: 12,
                border: "none",
                background: "var(--mv3-text)",
                color: "var(--mv3-bg)",
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                opacity: nameDraft.trim() && !busy ? 1 : 0.55,
              }}
            >
              {patch.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setRenaming(true);
            }}
            style={rowStyle}
          >
            Rename
          </button>
        )}

        {/* Archive — confirm-tap, PATCH status → archived. */}
        {project.status !== "archived" ? (
          <button
            type="button"
            className="cue-pressable"
            disabled={busy}
            onClick={() => {
              if (!confirmArchive) {
                haptic.light();
                setConfirmArchive(true);
                setConfirmDelete(false);
                return;
              }
              haptic.medium();
              patch.mutate(
                { ...pathOpts, body: { status: "archived" } },
                {
                  onSuccess: () => {
                    haptic.success();
                    onClose();
                    navigate(routes.projects);
                  },
                },
              );
            }}
            style={{
              ...rowStyle,
              color: confirmArchive ? "var(--mv3-amber)" : "var(--mv3-text)",
              fontWeight: confirmArchive ? 600 : 400,
            }}
          >
            {patch.isPending && confirmArchive
              ? "Archiving…"
              : confirmArchive
                ? "Tap again to archive"
                : "Archive"}
          </button>
        ) : null}

        {/* Delete — confirm-tap, quiet red, the real DELETE. */}
        <button
          type="button"
          className="cue-pressable"
          disabled={busy}
          onClick={() => {
            if (!confirmDelete) {
              haptic.light();
              setConfirmDelete(true);
              setConfirmArchive(false);
              return;
            }
            haptic.medium();
            del.mutate(pathOpts, {
              onSuccess: () => {
                haptic.success();
                onClose();
                navigate(routes.projects);
              },
            });
          }}
          style={{
            ...rowStyle,
            color: "#E5675B",
            background: confirmDelete ? "rgba(229,103,91,.12)" : "transparent",
            border: confirmDelete
              ? "1px solid rgba(229,103,91,.3)"
              : "1px solid var(--mv3-btn2-border)",
            fontWeight: confirmDelete ? 600 : 400,
          }}
        >
          {del.isPending
            ? "Deleting…"
            : confirmDelete
              ? "Tap again to delete — tasks stay unfiled"
              : "Delete"}
        </button>
      </div>

      {patch.isError || del.isError ? (
        <div style={{ fontSize: 11.5, color: "var(--mv3-amber)", marginTop: 10 }}>
          Couldn’t save that — try again in a moment.
        </div>
      ) : null}
    </SheetShell>
  );
}

export function Mv3ProjectDetail() {
  const assistantId = useActiveAssistantId();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);
  const [now] = useState(() => Date.now());

  const { project } = useProject(assistantId, projectId);
  // Full projects list — the task sheet's Filed-to reassign targets.
  const { projects } = useProjects(assistantId);
  // Task edit sheet (due date / labels / re-file / Run-Redo) + quick-add.
  const [sheetItemId, setSheetItemId] = useState<string | null>(null);
  // The project ⋯ menu (rename / archive / delete).
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  const quickAdd = useQuickAddTask(assistantId, projectId);
  // Sheet rows ride the same typed bucket the HQ surfaces consume, scoped to
  // this project client-side (keeps the exact HqWorkItem shape the cards need).
  // One-tap ✕ dismiss with the shared 5s undo pill.
  const { dismiss, gone, leavingId, toastNode } = useDismissTask(assistantId);
  // One-tap ▶ run (the task sheet's "Have Cue handle it", inline on rows).
  const { runNow, started } = useRunNow(assistantId);
  const all = useHqWorkItems(assistantId);
  const items = useMemo(
    () =>
      all.items.filter((i) => i.projectId === projectId && !gone.has(i.id)),
    [all.items, projectId, gone],
  );

  const running = useMemo(
    () => items.filter((i) => i.status === "running"),
    [items],
  );
  const review = useMemo(
    () => items.filter((i) => i.status === "awaiting_review"),
    [items],
  );
  const queued = useMemo(
    () =>
      items.filter((i) => i.status === "queued" || i.status === "pending"),
    [items],
  );
  const done = useMemo(
    () =>
      [...items.filter((i) => i.status === "done")].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    [items],
  );

  const parkedCount = useMemo(() => queued.filter(isParked).length, [queued]);

  // The single-project GET omits `stats`, so the ring + goal line derive
  // from the board items themselves (the same rows the sheet renders).
  const total = items.length;
  const pct = total > 0 ? Math.round((done.length / total) * 100) : null;
  const next = useMemo(() => {
    const open = [...queued].sort((a, b) => {
      if (a.dueAt != null && b.dueAt != null) return a.dueAt - b.dueAt;
      if (a.dueAt != null) return -1;
      if (b.dueAt != null) return 1;
      return a.priorityTier - b.priorityTier;
    });
    return open[0] ?? null;
  }, [queued]);

  const posture =
    review.length > 0 ? "needs_you" : running.length > 0 ? "on_track" : "quiet";
  const micro =
    posture === "needs_you"
      ? "Project · needs you"
      : posture === "on_track"
        ? "Project · on track"
        : "Project · quiet";
  const microColor =
    posture === "needs_you" ? "var(--mv3-amber)" : "var(--mv3-micro)";

  // Progress ring geometry (frame 3): r21, circumference ≈132.
  const RING_C = 2 * Math.PI * 21;

  let slot = 0;
  const nextDelay = () => 0.1 + 0.12 * slot++;

  return (
    <div
      data-mv3
      data-slot="mv3-project-detail"
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

      <BackRow
        label="Projects"
        onBack={() => {
          haptic.light();
          navigate(routes.projects);
        }}
        trailing={
          <button
            type="button"
            aria-label="Project menu"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setMenuOpen(true);
            }}
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "1px solid var(--mv3-glass-border)",
              background: "var(--mv3-glass)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              color: "var(--mv3-muted)",
              fontSize: 16,
              lineHeight: 1,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              WebkitTapHighlightColor: "transparent",
              padding: 0,
            }}
          >
            ⋯
          </button>
        }
      />

      {/* Header ON the aurora (frame 3). */}
      <div
        style={{
          padding: "2px 22px 14px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ ...microLabel, color: microColor }}>{micro}</div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-0.7px",
            marginTop: 6,
          }}
        >
          {project ? (
            <>
              {project.emoji ? `${project.emoji} ` : ""}
              {project.title}
            </>
          ) : (
            "…"
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 12,
          }}
        >
          {pct != null ? (
            <div
              style={{ position: "relative", width: 52, height: 52 }}
              aria-label={`${pct}% done`}
            >
              <svg width={52} height={52} viewBox="0 0 52 52" aria-hidden>
                <circle
                  cx={26}
                  cy={26}
                  r={21}
                  fill="none"
                  stroke="var(--mv3-track)"
                  strokeWidth={5}
                />
                <circle
                  cx={26}
                  cy={26}
                  r={21}
                  fill="none"
                  stroke="var(--mv3-accent)"
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - pct / 100)}
                  transform="rotate(-90 26 26)"
                />
              </svg>
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {pct}%
              </span>
            </div>
          ) : null}
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              lineHeight: 1.5,
            }}
          >
            {next ? (
              <>
                {next.title}
                {next.dueAt != null ? ` · ${dueLabel(next.dueAt, now).toLowerCase()}` : ""}
                <br />
              </>
            ) : null}
            <b style={{ color: "var(--mv3-text)", fontWeight: 600 }}>
              {running.length} running · {review.length} needs you
              {parkedCount > 0 ? ` · ${parkedCount} parked` : ""}
            </b>
          </div>
        </div>
      </div>

      {/* The sheet — the work rides an iOS sheet (grabber, blur, 28px). */}
      <div style={inlineSheet}>
        <Grabber />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            paddingBottom: 16,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {running.slice(0, 2).map((item) => (
              <LiveRunCard
                key={item.id}
                assistantId={assistantId}
                item={item}
                now={now}
                delay={nextDelay()}
              />
            ))}
            {review.slice(0, 1).map((item) => (
              <NeedsYouCard
                key={item.id}
                assistantId={assistantId}
                item={item}
                delay={nextDelay()}
                onOpen={() =>
                  navigate(
                    `${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`,
                  )
                }
              />
            ))}
            {review.slice(1, 4).map((item) => (
              <ArtifactRow
                key={item.id}
                item={item}
                delay={nextDelay()}
                onOpen={() => {
                  haptic.light();
                  // Seed the pager AT this artifact (QA night P1-4).
                  navigate(
                    `${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`,
                  );
                }}
              />
            ))}

            {/* Queued + recent done — gap frame 48's density RULE: no inline
                ✕ (dismiss = swipe-left 88pt Archive, full-swipe commits), the
                DUE chip merges into the metadata line, long-press (and tap,
                here) opens the task sheet's actions. Rows keep the chevron. */}
            {queued.slice(0, 4).map((item) => {
              const due =
                item.dueAt != null
                  ? dueLabel(item.dueAt, now).toLowerCase()
                  : null;
              // Optimistic ▶: render running until the daemon's flip lands
              // (then the item graduates to the LiveRunCard above).
              const optimisticRun = started.has(item.id);
              const parked = isParked(item) && !optimisticRun;
              return (
                <SwipeArchiveRow
                  key={item.id}
                  title={item.title}
                  onArchive={() => dismiss(item, { immediate: true })}
                  onLongPress={() => setSheetItemId(item.id)}
                  onOpen={() => {
                    haptic.light();
                    setSheetItemId(item.id);
                  }}
                  radius={12}
                  containerStyle={{
                    ...rise(nextDelay()),
                    ...dismissLeave(leavingId === item.id),
                  }}
                  rowStyle={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 4px",
                    minHeight: 44,
                    boxSizing: "border-box",
                  }}
                >
                  {optimisticRun ? (
                    <LivePulseBadge size={18} />
                  ) : (
                    <StateChip state="picked_up" label="" size="sm" />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 13,
                        color: "var(--mv3-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.title}
                    </span>
                    {optimisticRun ? (
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--mv3-micro)",
                          marginTop: 1,
                        }}
                      >
                        Cue picked this up
                      </span>
                    ) : due || parked ? (
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--mv3-amber)",
                          marginTop: 1,
                        }}
                      >
                        {due}
                        {due && parked ? " · " : ""}
                        {/* Quiet honest "waits for your ▶" (not a chip state). */}
                        {parked ? <ParkedMark /> : null}
                      </span>
                    ) : null}
                  </span>
                  {!optimisticRun ? (
                    <RunNowButton
                      title={item.title}
                      onRun={() => runNow(item)}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    style={{ fontSize: 15, color: "var(--mv3-faint)" }}
                  >
                    ›
                  </span>
                </SwipeArchiveRow>
              );
            })}
            {done.slice(0, 3).map((item) => (
              <SwipeArchiveRow
                key={item.id}
                title={item.title}
                onArchive={() => dismiss(item, { immediate: true })}
                onLongPress={() => setSheetItemId(item.id)}
                onOpen={() => {
                  haptic.light();
                  // ✓ lands on the OUTPUT (the run's thread) when one exists;
                  // long-press keeps the edit sheet (Run again / labels).
                  if (item.lastRunConversationId)
                    navigate(routes.conversation(item.lastRunConversationId));
                  else setSheetItemId(item.id);
                }}
                radius={12}
                containerStyle={{
                  opacity: 0.75,
                  ...rise(nextDelay()),
                  ...dismissLeave(leavingId === item.id),
                }}
                rowStyle={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 4px",
                  minHeight: 44,
                  boxSizing: "border-box",
                }}
              >
                <span
                  aria-hidden
                  style={{ color: "var(--mv3-green)", fontSize: 12 }}
                >
                  ✓
                </span>
                <span
                  style={{
                    fontSize: 13,
                    color: "var(--mv3-muted)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.title}
                </span>
                {item.updatedAt ? (
                  <span style={{ fontSize: 11, color: "var(--mv3-faint)" }}>
                    {relativeTime(item.updatedAt)}
                  </span>
                ) : null}
                <span
                  aria-hidden
                  style={{ fontSize: 15, color: "var(--mv3-faint)" }}
                >
                  ›
                </span>
              </SwipeArchiveRow>
            ))}

            {!all.isLoading && items.length === 0 ? (
              <div style={{ ...cardBody, padding: "8px 4px" }}>
                Nothing filed here yet — Cue files matching work in
                automatically.
              </div>
            ) : null}

            {/* First-run coaching — one quiet line, once per session. */}
            <ParkedCoachline hasParked={parkedCount > 0} />

            {/* Quick-add — the board's `useQuickAddTask` (POST work-items
                { title, projectId }), as an inline v3 row. */}
            {addOpen ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const title = addDraft.trim();
                  if (!title || quickAdd.isPending) return;
                  quickAdd.add(title, {
                    onSuccess: () => {
                      haptic.success();
                      setAddDraft("");
                      setAddOpen(false);
                    },
                  });
                }}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    autoFocus
                    aria-label="New task title"
                    placeholder="What should Cue take on?"
                    value={addDraft}
                    onChange={(e) => setAddDraft(e.target.value)}
                    style={{
                      flex: 1,
                      minHeight: 44,
                      fontSize: 16,
                      padding: "8px 13px",
                      borderRadius: 12,
                      background: "var(--mv3-btn2-bg)",
                      border: "1px solid var(--mv3-btn2-border)",
                      color: "var(--mv3-text)",
                      fontFamily: "inherit",
                      outline: "none",
                    }}
                  />
                  <button
                    type="submit"
                    className="cue-pressable"
                    disabled={!addDraft.trim() || quickAdd.isPending}
                    style={{
                      minHeight: 44,
                      padding: "8px 16px",
                      borderRadius: 12,
                      border: "none",
                      background: "var(--mv3-text)",
                      color: "var(--mv3-bg)",
                      fontSize: 12.5,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor:
                        addDraft.trim() && !quickAdd.isPending
                          ? "pointer"
                          : "default",
                      opacity:
                        addDraft.trim() && !quickAdd.isPending ? 1 : 0.55,
                    }}
                  >
                    {quickAdd.isPending ? "Adding…" : "Add"}
                  </button>
                  <button
                    type="button"
                    className="cue-pressable"
                    aria-label="Cancel adding a task"
                    onClick={() => {
                      haptic.light();
                      quickAdd.reset();
                      setAddDraft("");
                      setAddOpen(false);
                    }}
                    style={{
                      minHeight: 44,
                      padding: "8px 12px",
                      borderRadius: 12,
                      background: "var(--mv3-btn2-bg)",
                      border: "1px solid var(--mv3-btn2-border)",
                      color: "var(--mv3-muted)",
                      fontSize: 12.5,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                </div>
                {quickAdd.isError ? (
                  <div style={{ fontSize: 11.5, color: "var(--mv3-amber)" }}>
                    Couldn’t add that task — try again.
                  </div>
                ) : null}
              </form>
            ) : (
              <button
                type="button"
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  setAddOpen(true);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  border:
                    "1.5px dashed color-mix(in srgb, var(--mv3-text) 16%, transparent)",
                  borderRadius: 14,
                  padding: "10px 13px",
                  minHeight: 44,
                  color: "var(--mv3-muted)",
                  background: "transparent",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                <span aria-hidden style={{ color: "var(--mv3-micro)" }}>
                  ＋
                </span>
                Add a task
              </button>
            )}

            {/* Brief + knowledge pane (spec frame 41) — the project's real
                `context` field and its knowledge store, both of which the
                runner reads into every run's preamble. Delays capped so the
                pane never waits out a long row stagger. */}
            <Mv3ProjectBrief
              assistantId={assistantId}
              projectId={projectId}
              brief={project?.context ?? null}
              delay={Math.min(nextDelay(), 0.7)}
            />
            <Mv3ProjectKnowledge
              assistantId={assistantId}
              projectId={projectId}
              delay={Math.min(nextDelay(), 0.8)}
            />

            {/* Ask about this project… — opens a fresh conversation (no
                project-scoped chat exists yet; noted for the coordinator). */}
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                navigate(routes.conversations);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 16,
                padding: "12px 15px",
                marginTop: 2,
                minHeight: 48,
                cursor: "pointer",
                fontFamily: "inherit",
                textAlign: "left",
              }}
            >
              <CueRing size={18} stroke="var(--mv3-micro)" strokeWidth={46} dotRadius={34} />
              <span style={{ fontSize: 13.5, color: "var(--mv3-faint)" }}>
                Ask about this project…
              </span>
              <span
                aria-hidden
                style={{
                  marginLeft: "auto",
                  fontSize: 14,
                  color: "var(--mv3-faint)",
                }}
              >
                ◎
              </span>
            </button>
          </div>
        </div>
      </div>

      <Mv3TaskSheet
        assistantId={assistantId}
        item={items.find((i) => i.id === sheetItemId) ?? null}
        projects={projects}
        onClose={() => setSheetItemId(null)}
      />
      <Mv3ProjectMenuSheet
        assistantId={assistantId}
        project={project}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
      {toastNode}
    </div>
  );
}
