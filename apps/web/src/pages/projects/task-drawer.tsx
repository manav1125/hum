/**
 * Task detail drawer — the per-task cowork panel, in HQ's language.
 *
 * Slides in from the right (bottom sheet on mobile) over a project's board.
 * Restyled to the Cue-HQ-Build Round 5 · B2 drawer frame: a mono TASK label,
 * the one-card-language header (source badge · title · status chip), a LIVE
 * progress panel while the runner is working, and a "FILED TO" move control
 * that speaks the §4 reassign-menu language (current project highlighted,
 * sibling projects one tap away, "moving teaches Cue"). Every existing flow
 * stays: Run / Approve / Redo, open thread, per-task context, source snapshot,
 * and the status/cycle-time trail.
 *
 * Because the daemon's work-item PATCH requires the FULL record even for a
 * one-field change, every mutation assembles a complete body from the item
 * currently rendered.
 */

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { DueChip } from "@/domains/activity/due-chip";
import { C, mono, relativeTime } from "@/domains/activity/theme";
import {
  workitemsByIdCompletePostMutation,
  workitemsByIdEventsGetOptions,
  workitemsByIdRunPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { client } from "@/generated/daemon/client.gen";
import { MicroLabel } from "@/pages/hq/hq-kit";
import {
  ReassignMenu,
  ReassignTeachToast,
  type ReassignTarget,
} from "@/pages/hq/reassign-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ItemCard, statusChip } from "./item-card";
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
  const [taught, setTaught] = useState<{ to: string } | null>(null);

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

  /**
   * "Done elsewhere" (frame D3) — you handled it yourself; completes for
   * progress, the ledger says "completed by you", never credits Cue. The REAL
   * complete endpoint carrying `completedElsewhere: true`; older daemons gate
   * /complete to awaiting_review, so other statuses fall back to the
   * full-record PATCH (status → done) on rejection — the same 409→PATCH
   * fallback the mobile sheet ships.
   */
  const doneElsewhere = useMutation({
    mutationFn: async () => {
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
          body: fullBody(item, { status: "done" }),
          throwOnError: true,
        });
      }
    },
    onSettled: invalidate,
  });

  /** "Not relevant — archive" (frame D3) — archive, never delete; close after. */
  const archive = () =>
    patch.mutate(
      { ...pathOpts, body: fullBody(item, { status: "archived" }) },
      { onSuccess: onClose },
    );

  const filedToRef = useRef<HTMLDivElement>(null);
  const scrollToFiledTo = () =>
    filedToRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const canRun = item.status === "queued" || item.status === "pending";
  const canDoneElsewhere =
    item.status === "queued" ||
    item.status === "pending" ||
    item.status === "awaiting_review";

  // Frame D3's popover shortcuts: ↵ run/approve · F file · D done elsewhere ·
  // ⌫ archive. Active while the drawer is up and focus isn't in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el?.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") {
        if (item.status === "awaiting_review") {
          e.preventDefault();
          approve.mutate({ ...pathOpts, body: {} });
        } else if (canRun) {
          e.preventDefault();
          run.mutate(pathOpts);
        }
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        scrollToFiledTo();
      } else if ((e.key === "d" || e.key === "D") && canDoneElsewhere) {
        e.preventDefault();
        doneElsewhere.mutate();
      } else if (e.key === "Backspace" && item.status !== "archived") {
        e.preventDefault();
        archive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm per item/status only
  }, [item.id, item.status]);

  const source = parseSource(item.sourceContext);
  const cycleTime = events.data?.cycleTimeMs ?? null;
  const trail = events.data?.events ?? [];
  const running = item.status === "running";

  const saveContext = () => {
    if (!contextDirty) return;
    patch.mutate({
      ...pathOpts,
      body: fullBody(item, { context: context.trim() || null }),
    });
    setContextDirty(false);
  };

  const moveTo = (projectId: string) => {
    const dest = projects.find((p) => p.id === projectId);
    patch.mutate(
      { ...pathOpts, body: fullBody(item, { projectId }) },
      {
        onSuccess: () => setTaught(dest ? { to: dest.title } : null),
      },
    );
  };

  // §4 reassign targets: every active project, current one highlighted inside
  // the menu. The drawer moves a *filed* task, so no "dismiss" door here — that
  // door belongs on HQ's came-in rows (ReassignMenu supports it via onDismiss).
  const reassignTargets: ReassignTarget[] = projects
    .filter((p) => p.status === "active" || p.id === currentProjectId)
    .map((p) => ({ id: p.id, title: p.title, emoji: p.emoji }));

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
            marginBottom: 12,
          }}
        >
          <MicroLabel>Task</MicroLabel>
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
            <X size={16} />
          </button>
        </div>

        {/* The one-card-language header: badge · title · status chip. */}
        <ItemCard
          flat
          sourceType={item.sourceType}
          title={item.title}
          titleSize={15.5}
          chip={statusChip(item.status)}
          live={running}
        />

        {/* Meta row: due + assignee + last activity */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 10,
            flexWrap: "wrap",
          }}
        >
          <DueChip dueAt={item.dueAt} status={item.status} />
          <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
            {item.assignee && item.assignee !== "cue"
              ? `assignee · ${item.assignee}`
              : "assignee · Cue"}
          </span>
          {item.lastActivityAt ? (
            <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
              active {relativeTime(item.lastActivityAt)}
            </span>
          ) : null}
        </div>

        {/* LIVE — the runner's progress note, agents-at-work style */}
        {running ? (
          <div
            style={{
              background: C.sunken,
              borderRadius: 10,
              padding: "11px 12px",
              marginTop: 12,
            }}
          >
            <MicroLabel style={{ fontSize: 9 }}>Live</MicroLabel>
            <div
              style={{
                fontSize: 11.5,
                color: C.blueS,
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              {item.lastProgressNote ?? "Cue is working on this…"}
            </div>
          </div>
        ) : null}

        {/* Actions — frame D3's order + shortcuts: ▶ Have Cue handle it ↵ ·
            📁 File to a project F · ✓ Done elsewhere D · ✕ archive ⌫. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            marginTop: 14,
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            padding: 6,
          }}
        >
          {canRun && (
            <DrawerAction
              glyph="▶"
              glyphColor={C.blue}
              label={run.isPending ? "Starting…" : "Have Cue handle it"}
              kbd="↵"
              primary
              disabled={run.isPending}
              onClick={() => run.mutate(pathOpts)}
            />
          )}
          {item.status === "awaiting_review" && (
            <>
              <DrawerAction
                glyph="✓"
                glyphColor={C.blue}
                label={approve.isPending ? "Approving…" : "Approve & finish"}
                kbd="↵"
                primary
                disabled={approve.isPending}
                onClick={() => approve.mutate({ ...pathOpts, body: {} })}
              />
              <DrawerAction
                glyph="▶"
                glyphColor={C.t2}
                label={run.isPending ? "Redoing…" : "Redo"}
                disabled={run.isPending}
                onClick={() => run.mutate(pathOpts)}
              />
            </>
          )}
          {item.status === "done" && (
            <DrawerAction
              glyph="▶"
              glyphColor={C.t2}
              label={run.isPending ? "Running…" : "Run again"}
              disabled={run.isPending}
              onClick={() => run.mutate(pathOpts)}
            />
          )}
          <DrawerAction
            glyph="📁"
            label="File to a project"
            kbd="F"
            onClick={scrollToFiledTo}
          />
          {canDoneElsewhere && (
            <DrawerAction
              glyph="✓"
              glyphColor={C.green}
              label={doneElsewhere.isPending ? "Marking done…" : "Done elsewhere"}
              caption="complete, not Cue's work"
              kbd="D"
              disabled={doneElsewhere.isPending}
              onClick={() => doneElsewhere.mutate()}
            />
          )}
          {item.status !== "archived" && (
            <DrawerAction
              glyph="✕"
              glyphColor={C.t2}
              label="Not relevant — archive"
              kbd="⌫"
              muted
              disabled={patch.isPending}
              onClick={archive}
            />
          )}
          {item.lastRunConversationId ? (
            <DrawerAction
              glyph={<ExternalLink size={12} />}
              label="Open thread"
              muted
              onClick={() =>
                navigate(
                  `/assistant/conversations/${item.lastRunConversationId}`,
                )
              }
            />
          ) : null}
        </div>
        {doneElsewhere.isError ? (
          <div style={{ fontSize: 11, color: C.amber, marginTop: 6 }}>
            Couldn’t mark it done — try again.
          </div>
        ) : null}

        {/* FILED TO — the §4 reassign menu: tap a row to re-file, and the
            move is confirmed as a lesson (ReassignTeachToast). The F action
            above scrolls here. */}
        <div ref={filedToRef}>
        <Section label="Filed to">
          {taught ? (
            <div style={{ marginBottom: 10 }}>
              <ReassignTeachToast
                destinationTitle={taught.to}
                onDismiss={() => setTaught(null)}
              />
            </div>
          ) : null}
          {reassignTargets.length <= 1 ? (
            <div
              style={{
                padding: "9px 12px",
                border: `1px solid ${C.line}`,
                borderRadius: 11,
                background: C.sunken,
                fontSize: 11,
                color: C.t3,
              }}
            >
              No other projects to move to.
            </div>
          ) : (
            <ReassignMenu
              targets={reassignTargets}
              currentId={currentProjectId}
              busy={patch.isPending}
              label="Filed to"
              onPick={moveTo}
            />
          )}
          <div
            style={{
              fontSize: 10.5,
              color: C.t3,
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            Moving teaches Cue — same rule as re-filing inbound on HQ.
          </div>
        </Section>
        </div>

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
            <span style={{ color: C.blue }}>▸</span>
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
                      background: C.blue,
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
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 9.5,
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

/**
 * One row of frame D3's action list — glyph · label · faint caption · mono
 * kbd hint. `primary` wears the blue wash; `muted` reads quiet.
 */
function DrawerAction({
  glyph,
  glyphColor,
  label,
  caption,
  kbd,
  primary = false,
  muted = false,
  disabled = false,
  onClick,
}: {
  glyph: React.ReactNode;
  glyphColor?: string;
  label: string;
  caption?: string;
  kbd?: string;
  primary?: boolean;
  muted?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "9px 11px",
        borderRadius: 10,
        border: "none",
        background: primary
          ? `color-mix(in srgb, ${C.blue} 8%, transparent)`
          : "transparent",
        color: muted ? C.t2 : C.t1,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: "inherit",
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 12,
          color: glyphColor,
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        {glyph}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: primary ? 600 : 400,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {caption ? (
        <span style={{ fontSize: 10, color: C.t3, flexShrink: 0 }}>
          {caption}
        </span>
      ) : null}
      {kbd ? (
        <span
          aria-hidden
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            color: C.t3,
            flexShrink: 0,
          }}
        >
          {kbd}
        </span>
      ) : null}
    </button>
  );
}
