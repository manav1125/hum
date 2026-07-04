/**
 * Projects home — the cowork surface's front door.
 *
 * Projects are shown as cards grouped by category (Personal / Professional /
 * Other / Uncategorized), with pinned projects floating into a "Pinned" band at
 * the very top. Each card carries the project's per-status task tally (straight
 * off the daemon's stats endpoint), the single most-urgent next task, a subtle
 * progress bar, and a pin toggle. Clicking a card opens the project board.
 */

import { FolderKanban, Pin, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { GroupHeader } from "@/domains/activity/group-header";
import { C, mono, relativeTime, serif } from "@/domains/activity/theme";
import { routes } from "@/utils/routes";

import { NewProjectModal } from "./new-project-modal";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  categoryBucket,
  type CategoryKey,
} from "./project-kit";
import { useProjects, usePatchProject, type ProjectView } from "./use-projects";

function ProgressBar({
  done,
  total,
  accent,
}: {
  done: number;
  total: number;
  accent: string;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div
      aria-label={`${pct}% done`}
      style={{
        height: 4,
        borderRadius: 999,
        background: C.sunken,
        overflow: "hidden",
        marginTop: 12,
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: accent,
          borderRadius: 999,
          transition: "width 240ms",
        }}
      />
    </div>
  );
}

function TallyBits({ p }: { p: ProjectView }) {
  const c = p.stats?.counts;
  const bits: Array<{ label: string; tone: string }> = [];
  if (c) {
    if (c.queued > 0) bits.push({ label: `${c.queued} queued`, tone: C.amber });
    if (c.running > 0)
      bits.push({ label: `${c.running} running`, tone: C.blue });
    if (c.awaiting_review > 0)
      bits.push({ label: `${c.awaiting_review} review`, tone: C.violet });
    if (c.done > 0) bits.push({ label: `${c.done} done`, tone: C.green });
  }
  if (bits.length === 0) {
    return (
      <span style={{ fontFamily: mono, fontSize: 11.5, color: C.t3 }}>
        nothing filed yet
      </span>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {bits.map((b) => (
        <span
          key={b.label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontFamily: mono,
            fontSize: 11.5,
            color: C.t2,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: b.tone,
            }}
          />
          {b.label}
        </span>
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onTogglePin,
  pinBusy,
}: {
  project: ProjectView;
  onOpen: () => void;
  onTogglePin: () => void;
  pinBusy: boolean;
}) {
  const next = project.stats?.nextTask ?? null;
  const counts = project.stats?.counts;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        position: "relative",
        padding: "16px 18px",
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.surface,
        cursor: "pointer",
        color: C.ink,
        textAlign: "left",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            fontSize: 19,
            background: project.color
              ? `color-mix(in srgb, ${project.color} 16%, ${C.sunken})`
              : C.sunken,
            border: `1px solid ${project.color ? `color-mix(in srgb, ${project.color} 40%, ${C.line})` : C.line}`,
            flexShrink: 0,
          }}
        >
          {project.emoji ?? "📁"}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontFamily: serif,
              fontSize: 19,
              letterSpacing: "-0.2px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {project.title}
          </div>
          <div style={{ marginTop: 6 }}>
            <TallyBits p={project} />
          </div>
        </div>
        <button
          type="button"
          aria-label={project.pinned ? "Unpin project" : "Pin project"}
          aria-pressed={project.pinned}
          disabled={pinBusy}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          style={{
            flexShrink: 0,
            width: 28,
            height: 28,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            border: `1px solid ${project.pinned ? C.violet : C.line}`,
            background: project.pinned
              ? `color-mix(in srgb, ${C.violet} 14%, transparent)`
              : "transparent",
            color: project.pinned ? C.violet : C.t3,
            cursor: pinBusy ? "default" : "pointer",
            opacity: pinBusy ? 0.5 : 1,
          }}
        >
          <Pin size={14} fill={project.pinned ? "currentColor" : "none"} />
        </button>
      </div>

      {next ? (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            color: C.t2,
          }}
        >
          <span style={{ color: C.violet, flexShrink: 0 }}>▸</span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Next: {next.title}
          </span>
          {next.dueAt ? (
            <span
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                color: C.t3,
                flexShrink: 0,
              }}
            >
              {relativeTime(next.dueAt)}
            </span>
          ) : null}
        </div>
      ) : null}

      {counts && counts.total > 0 ? (
        <ProgressBar
          done={counts.done}
          total={counts.total}
          accent={project.color ?? C.green}
        />
      ) : null}
    </div>
  );
}

export function ProjectsPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const { projects, isLoading, isError } = useProjects(assistantId);
  const patch = usePatchProject(assistantId);
  const [showNew, setShowNew] = useState(false);
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);

  const active = useMemo(
    () => projects.filter((p) => p.status === "active"),
    [projects],
  );

  const pinned = useMemo(() => active.filter((p) => p.pinned), [active]);

  // Group non-pinned actives by category bucket. Pinned projects still appear
  // in their category group too? No — they float to the top band only, to keep
  // the "pinned" affordance meaningful.
  const grouped = useMemo(() => {
    const map = new Map<CategoryKey, ProjectView[]>();
    for (const p of active) {
      if (p.pinned) continue;
      const key = categoryBucket(p.category);
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    const order: CategoryKey[] = [...CATEGORY_ORDER, "uncategorized"];
    return order
      .filter((k) => (map.get(k)?.length ?? 0) > 0)
      .map((k) => ({ key: k, label: CATEGORY_LABEL[k], items: map.get(k)! }));
  }, [active]);

  const togglePin = (p: ProjectView) => {
    setPinBusyId(p.id);
    patch.mutate(
      {
        path: { assistant_id: assistantId, id: p.id },
        body: { pinned: !p.pinned },
      },
      { onSettled: () => setPinBusyId(null) },
    );
  };

  const cardGrid = (items: ProjectView[]) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        gap: 12,
      }}
    >
      {items.map((p) => (
        <ProjectCard
          key={p.id}
          project={p}
          pinBusy={pinBusyId === p.id}
          onOpen={() => navigate(routes.project(p.id))}
          onTogglePin={() => togglePin(p)}
        />
      ))}
    </div>
  );

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div
        style={{ maxWidth: 1000, margin: "0 auto", padding: "34px 22px 60px" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 4,
          }}
        >
          <GroupHeader
            kicker="Projects"
            title="Where Cue keeps your work."
            accent={C.violet}
            hint="Each project carries a brief Cue reads before working any task inside it."
          />
          <button
            type="button"
            onClick={() => setShowNew(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              flexShrink: 0,
              fontFamily: mono,
              fontSize: 12,
              padding: "9px 15px",
              borderRadius: 10,
              border: "none",
              background: C.ink,
              color: C.bg,
              cursor: "pointer",
            }}
          >
            <Plus size={14} /> New project
          </button>
        </div>

        {isLoading ? (
          <div style={{ fontSize: 13, color: C.t2, marginTop: 20 }}>
            Loading projects…
          </div>
        ) : isError ? (
          <div style={{ fontSize: 13, color: C.t2, marginTop: 20 }}>
            Couldn’t load projects just now — try again in a moment.
          </div>
        ) : active.length === 0 ? (
          <EmptyState onCreate={() => setShowNew(true)} />
        ) : (
          <div style={{ marginTop: 22, display: "grid", gap: 30 }}>
            {pinned.length > 0 ? (
              <section>
                <BandHeader label="Pinned" icon />
                {cardGrid(pinned)}
              </section>
            ) : null}
            {grouped.map((g) => (
              <section key={g.key}>
                <BandHeader label={g.label} />
                {cardGrid(g.items)}
              </section>
            ))}
          </div>
        )}
      </div>

      {showNew ? (
        <NewProjectModal
          assistantId={assistantId}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            navigate(routes.project(id));
          }}
        />
      ) : null}
    </div>
  );
}

function BandHeader({
  label,
  icon = false,
}: {
  label: string;
  icon?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        fontFamily: mono,
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: icon ? C.violet : C.t3,
        marginBottom: 12,
      }}
    >
      {icon ? <Pin size={12} fill="currentColor" /> : null}
      {label}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        marginTop: 30,
        padding: "44px 26px",
        border: `1px dashed ${C.line2}`,
        borderRadius: 16,
        textAlign: "center",
        display: "grid",
        placeItems: "center",
        gap: 12,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          display: "grid",
          placeItems: "center",
          background: C.sunken,
          border: `1px solid ${C.line}`,
          color: C.violet,
        }}
      >
        <FolderKanban size={24} />
      </span>
      <div
        style={{
          fontFamily: serif,
          fontSize: 24,
          letterSpacing: "-0.3px",
          color: C.ink,
        }}
      >
        Create your first project
      </div>
      <div
        style={{ fontSize: 13.5, color: C.t2, maxWidth: 380, lineHeight: 1.5 }}
      >
        A project groups related tasks under a shared brief — so Cue works every
        task inside it with the same context, without you re-explaining.
      </div>
      <button
        type="button"
        onClick={onCreate}
        style={{
          marginTop: 4,
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontFamily: mono,
          fontSize: 12,
          padding: "10px 18px",
          borderRadius: 10,
          border: "none",
          background: C.ink,
          color: C.bg,
          cursor: "pointer",
        }}
      >
        <Plus size={14} /> New project
      </button>
    </div>
  );
}
