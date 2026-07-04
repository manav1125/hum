/**
 * Task detail drawer — the per-task cowork panel.
 *
 * Slides in from the right (bottom sheet on mobile) over a project's board. It
 * carries: title + status, due + assignee, the owning project with a MOVE
 * control (PATCH projectId → another project), an editable per-task Context
 * field ("notes Cue reads before running this"), a Source section derived from
 * the task's sourceContext snapshot, a link to the run thread, the valid
 * Run / Approve / Redo actions, and the status/cycle-time event trail.
 *
 * Because the daemon's work-item PATCH requires the FULL record even for a
 * one-field change, every mutation assembles a complete body from the item
 * currently rendered.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { StatusPill } from "@/domains/activity/activity-row";
import { DueChip } from "@/domains/activity/due-chip";
import { C, mono, relativeTime, serif } from "@/domains/activity/theme";
import {
  workitemsByIdCompletePostMutation,
  workitemsByIdEventsGetOptions,
  workitemsByIdRunPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { statusTone } from "./project-kit";
import { usePatchWorkItem, type ProjectView } from "./use-projects";
import type { BoardItem } from "./board-item";

/** Parse the JSON sourceContext snapshot into a readable origin + snippet. */
function parseSource(raw: string | null): {
  origin: string | null;
  snippet: string | null;
} {
  if (!raw) return { origin: null, snippet: null };
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    const originRaw =
      rec.origin ?? rec.source ?? rec.type ?? rec.channel ?? rec.kind;
    const snippetRaw =
      rec.snippet ?? rec.text ?? rec.excerpt ?? rec.summary ?? rec.body;
    return {
      origin: typeof originRaw === "string" ? originRaw : null,
      snippet: typeof snippetRaw === "string" ? snippetRaw : null,
    };
  } catch {
    // Non-JSON snapshots are rare but harmless — show them raw.
    return { origin: null, snippet: raw.slice(0, 400) };
  }
}

function fullBody(
  item: BoardItem,
  patch: Partial<{
    projectId: string | null;
    context: string | null;
    status: string;
  }>,
) {
  let labels: string[] = [];
  if (item.labels) {
    try {
      const parsed = JSON.parse(item.labels) as unknown;
      if (Array.isArray(parsed))
        labels = parsed.filter((l): l is string => typeof l === "string");
    } catch {
      // ignore malformed labels
    }
  }
  return {
    title: item.title,
    notes: item.notes ?? "",
    status: patch.status ?? item.status,
    priorityTier: item.priorityTier,
    sortIndex: item.sortIndex ?? 0,
    projectId: patch.projectId !== undefined ? patch.projectId : item.projectId,
    dueAt: item.dueAt,
    labels,
    assignee: item.assignee ?? "cue",
    context: patch.context !== undefined ? patch.context : item.context,
  };
}

export function TaskDrawer({
  assistantId,
  item,
  projects,
  currentProjectId,
  onClose,
}: {
  assistantId: string;
  item: BoardItem;
  projects: ProjectView[];
  currentProjectId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const patch = usePatchWorkItem(assistantId);

  const [context, setContext] = useState(item.context ?? "");
  const [contextDirty, setContextDirty] = useState(false);
  const [showMove, setShowMove] = useState(false);

  useEffect(() => {
    setContext(item.context ?? "");
    setContextDirty(false);
  }, [item.id, item.context]);

  const events = useQuery({
    ...workitemsByIdEventsGetOptions({
      path: { assistant_id: assistantId, id: item.id },
    }),
    staleTime: 20_000,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        q.queryKey.some(
          (k) =>
            typeof k === "object" &&
            k !== null &&
            "_id" in k &&
            String((k as { _id?: string })._id).startsWith("projects"),
        ),
    });

  const run = useMutation({
    ...workitemsByIdRunPostMutation(),
    onSettled: invalidate,
  });
  const approve = useMutation({
    ...workitemsByIdCompletePostMutation(),
    onSettled: invalidate,
  });
  const pathOpts = { path: { assistant_id: assistantId, id: item.id } };

  const source = parseSource(item.sourceContext);
  const cycleTime = events.data?.cycleTimeMs ?? null;
  const trail = events.data?.events ?? [];

  const saveContext = () => {
    if (!contextDirty) return;
    patch.mutate({
      ...pathOpts,
      body: fullBody(item, { context: context.trim() || null }),
    });
    setContextDirty(false);
  };

  const moveTo = (projectId: string | null) => {
    patch.mutate(
      { ...pathOpts, body: fullBody(item, { projectId }) },
      { onSuccess: () => setShowMove(false) },
    );
  };

  const otherProjects = projects.filter(
    (p) => p.id !== currentProjectId && p.status === "active",
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Task: ${item.title}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 55,
        background: "color-mix(in srgb, #000 34%, transparent)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        className="cue-task-drawer"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(460px, 100%)",
          maxWidth: "100%",
          height: "100%",
          overflowY: "auto",
          background: C.surface,
          borderLeft: `1px solid ${C.line2}`,
          boxShadow: "-24px 0 60px -30px rgba(0,0,0,0.5)",
          padding: "20px 20px 40px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <StatusPill
            label={item.status.replace(/_/g, " ")}
            tone={statusTone(item.status)}
          />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              color: C.t3,
              cursor: "pointer",
              padding: 4,
              borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            fontFamily: serif,
            fontSize: 24,
            lineHeight: 1.15,
            letterSpacing: "-0.3px",
            color: C.ink,
          }}
        >
          {item.title}
        </div>

        {/* Meta row: due + assignee */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          <DueChip dueAt={item.dueAt} status={item.status} />
          <span style={{ fontFamily: mono, fontSize: 11.5, color: C.t3 }}>
            {item.assignee && item.assignee !== "cue"
              ? `assignee · ${item.assignee}`
              : "assignee · Cue"}
          </span>
          {item.lastActivityAt ? (
            <span style={{ fontFamily: mono, fontSize: 11.5, color: C.t3 }}>
              active {relativeTime(item.lastActivityAt)}
            </span>
          ) : null}
        </div>

        {/* Actions */}
        <div
          style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}
        >
          {(item.status === "queued" || item.status === "pending") && (
            <ActionBtn
              label={run.isPending ? "Starting…" : "Run now"}
              primary
              disabled={run.isPending}
              onClick={() => run.mutate(pathOpts)}
            />
          )}
          {item.status === "awaiting_review" && (
            <>
              <ActionBtn
                label={approve.isPending ? "Approving…" : "Approve"}
                primary
                disabled={approve.isPending}
                onClick={() => approve.mutate(pathOpts)}
              />
              <ActionBtn
                label={run.isPending ? "Redoing…" : "Redo"}
                disabled={run.isPending}
                onClick={() => run.mutate(pathOpts)}
              />
            </>
          )}
          {item.status === "done" && (
            <ActionBtn
              label={run.isPending ? "Running…" : "Run again"}
              disabled={run.isPending}
              onClick={() => run.mutate(pathOpts)}
            />
          )}
          {item.lastRunConversationId ? (
            <ActionBtn
              label="Open thread"
              icon={<ExternalLink size={12} />}
              onClick={() =>
                navigate(
                  `/assistant/conversations/${item.lastRunConversationId}`,
                )
              }
            />
          ) : null}
        </div>

        {/* Project + move */}
        <Section label="Project">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: C.t1 }}>
              {projects.find((p) => p.id === currentProjectId)
                ? `${projects.find((p) => p.id === currentProjectId)!.emoji ?? "📁"} ${projects.find((p) => p.id === currentProjectId)!.title}`
                : "This project"}
            </span>
            <button
              type="button"
              onClick={() => setShowMove((v) => !v)}
              disabled={patch.isPending}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                marginLeft: "auto",
                fontFamily: mono,
                fontSize: 11,
                padding: "4px 9px",
                borderRadius: 7,
                border: `1px solid ${C.line2}`,
                background: "transparent",
                color: C.t2,
                cursor: "pointer",
              }}
            >
              <ArrowRightLeft size={11} /> Move
            </button>
          </div>
          {showMove ? (
            <div
              style={{
                marginTop: 8,
                display: "grid",
                gap: 4,
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {otherProjects.length === 0 ? (
                <div style={{ fontSize: 12, color: C.t3 }}>
                  No other projects to move to.
                </div>
              ) : (
                otherProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => moveTo(p.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      borderRadius: 8,
                      border: `1px solid ${C.line}`,
                      background: C.bg,
                      color: C.t1,
                      fontSize: 13,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span>{p.emoji ?? "📁"}</span>
                    {p.title}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </Section>

        {/* Per-task context */}
        <Section label="Context">
          <textarea
            value={context}
            onChange={(e) => {
              setContext(e.target.value);
              setContextDirty(true);
            }}
            onBlur={saveContext}
            placeholder="Notes Cue reads before running this task…"
            rows={3}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontSize: 13,
              lineHeight: 1.5,
              color: C.ink,
              background: C.bg,
              border: `1px solid ${C.line2}`,
              borderRadius: 9,
              padding: "9px 11px",
              outline: "none",
              resize: "vertical",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 6,
              fontSize: 11,
              color: C.t3,
            }}
          >
            <span style={{ color: C.violet }}>▸</span>
            {contextDirty
              ? "Unsaved — click away or press save."
              : patch.isPending
                ? "Saving…"
                : "Cue reads this before running this task."}
            {contextDirty ? (
              <button
                type="button"
                onClick={saveContext}
                style={{
                  marginLeft: "auto",
                  fontFamily: mono,
                  fontSize: 10.5,
                  padding: "3px 9px",
                  borderRadius: 6,
                  border: "none",
                  background: C.ink,
                  color: C.bg,
                  cursor: "pointer",
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </Section>

        {/* Source */}
        {source.origin || source.snippet ? (
          <Section label="Source">
            {source.origin ? (
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 11.5,
                  color: C.t2,
                  marginBottom: 6,
                }}
              >
                from {source.origin}
              </div>
            ) : null}
            {source.snippet ? (
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: C.t2,
                  padding: "9px 11px",
                  borderRadius: 9,
                  background: C.sunken,
                  border: `1px solid ${C.line}`,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {source.snippet}
              </div>
            ) : null}
          </Section>
        ) : item.sourceType ? (
          <Section label="Source">
            <div style={{ fontFamily: mono, fontSize: 11.5, color: C.t2 }}>
              from {item.sourceType}
            </div>
          </Section>
        ) : null}

        {/* Event / cycle-time trail */}
        {trail.length > 0 ? (
          <Section label="Trail">
            {cycleTime != null ? (
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 11.5,
                  color: C.t2,
                  marginBottom: 8,
                }}
              >
                cycle time · {formatDuration(cycleTime)}
              </div>
            ) : null}
            <div style={{ display: "grid", gap: 8 }}>
              {trail.slice(0, 12).map((e) => (
                <div
                  key={e.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: C.t2,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: C.violet,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: C.t1 }}>
                    {e.toStatus
                      ? `${e.fromStatus ?? "—"} → ${e.toStatus}`
                      : e.kind}
                  </span>
                  {e.actor ? (
                    <span
                      style={{ fontFamily: mono, fontSize: 10.5, color: C.t3 }}
                    >
                      {e.actor}
                    </span>
                  ) : null}
                  <span
                    style={{
                      marginLeft: "auto",
                      fontFamily: mono,
                      fontSize: 10.5,
                      color: C.t3,
                    }}
                  >
                    {relativeTime(e.at)}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 22 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 10.5,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.t3,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ActionBtn({
  label,
  primary = false,
  disabled = false,
  icon,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontWeight: 500,
        padding: "7px 13px",
        borderRadius: 9,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        border: primary ? `1px solid ${C.blue}` : `1px solid ${C.line2}`,
        background: primary ? C.blue : C.surface,
        color: primary ? "#fff" : C.t1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
