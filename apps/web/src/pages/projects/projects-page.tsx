/**
 * Projects home — the cowork surface's front door, in HQ's language.
 *
 * Restyled to the locked Cue-HQ-Build Round 5 · B1 frames: a serif hero under
 * an "INITIATIVES & AREAS · N ACTIVE" microlabel, HQ card DNA on the project
 * cards (emoji tile · sans title · mono category microlabel), a ⟡ mission tag
 * on every mission-linked project ("Standalone" otherwise), mono status-tally
 * chips, a "Next:" footer with an urgency dot, a 📌 PINNED band, and the
 * editorial empty state. Same grid, same grouping, same functionality —
 * a restyle, not a redesign.
 */

import { Pin, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { C, mono, relativeTime, serif } from "@/domains/activity/theme";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { HqStyle, MicroLabel } from "@/pages/hq/hq-kit";
import { routes } from "@/utils/routes";

import { MissionTag } from "./item-card";
import { NewProjectModal } from "./new-project-modal";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  categoryBucket,
  categoryLabel,
  type CategoryKey,
} from "./project-kit";
import {
  useMissionTitles,
  usePatchProject,
  useProjects,
  type ProjectView,
} from "./use-projects";

/** Mono tally chip ("4 IN PROGRESS") in ring-tone hues. */
function TallyChip({
  label,
  color,
  wash = false,
}: {
  label: string;
  color: string;
  wash?: boolean;
}) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9,
        letterSpacing: "0.04em",
        color,
        background: wash
          ? `color-mix(in srgb, ${color} 12%, transparent)`
          : C.sunken,
        borderRadius: 6,
        padding: "3px 7px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function tallyChips(p: ProjectView): Array<{
  label: string;
  color: string;
  wash: boolean;
}> {
  const c = p.stats?.counts;
  if (!c) return [];
  const chips: Array<{ label: string; color: string; wash: boolean }> = [];
  if (c.queued > 0)
    chips.push({ label: `${c.queued} QUEUED`, color: C.amber, wash: false });
  if (c.running > 0)
    chips.push({
      label: `${c.running} IN PROGRESS`,
      color: C.blueS,
      wash: false,
    });
  if (c.awaiting_review > 0)
    chips.push({
      label: `${c.awaiting_review} REVIEW`,
      color: C.amber,
      wash: true,
    });
  if (c.done > 0)
    chips.push({ label: `${c.done} DONE`, color: C.green, wash: true });
  return chips;
}

/** The footer line's honest urgency: what the dot + emphasis mean. */
function nextTone(p: ProjectView, now: number): string {
  const c = p.stats?.counts;
  const next = p.stats?.nextTask ?? null;
  if (next?.dueAt != null && next.dueAt <= now + 24 * 3_600_000)
    return C.danger;
  if ((c?.awaiting_review ?? 0) > 0) return C.amber;
  if ((c?.running ?? 0) > 0) return C.blue;
  if (next) return C.t3;
  if ((c?.done ?? 0) > 0) return C.green;
  return C.t3;
}

/**
 * Exported for reuse by the HQ mission-detail page, where linked projects
 * render as a mission's initiatives with the exact same card language.
 * `onTogglePin` is optional there — the pin affordance hides when absent.
 * `missionTitle`/`onOpenMission` drive the ⟡ tag; when the tag is implied by
 * the surface (mission detail) simply omit `missionTitle`.
 */
export function ProjectCard({
  project,
  onOpen,
  onTogglePin,
  pinBusy = false,
  missionTitle,
  onOpenMission,
  now,
}: {
  project: ProjectView;
  onOpen: () => void;
  onTogglePin?: () => void;
  pinBusy?: boolean;
  missionTitle?: string | null;
  onOpenMission?: () => void;
  /** Stable reference time (no Date.now() in render); defaults to createdAt. */
  now?: number;
}) {
  const compact = useIsMobile();
  const refNow = now ?? project.updatedAt;
  const next = project.stats?.nextTask ?? null;
  const counts = project.stats?.counts;
  const tone = nextTone(project, refNow);
  const urgent = tone === C.danger;
  const chips = tallyChips(project);
  const category = project.category
    ? categoryLabel(project.category).toUpperCase()
    : null;

  const tagRow =
    project.missionId && missionTitle ? (
      <MissionTag
        label={missionTitle}
        onClick={onOpenMission}
        style={{ marginTop: compact ? 0 : 11 }}
      />
    ) : project.missionId ? null : (
      <MissionTag
        label="Standalone"
        linked={false}
        style={{ marginTop: compact ? 0 : 11 }}
      />
    );

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
        padding: compact ? "13px 14px" : "16px 17px",
        border: urgent ? `1.5px solid ${C.blue}` : `1px solid ${C.line}`,
        borderRadius: compact ? 14 : 15,
        background: C.surface,
        boxShadow: urgent
          ? `0 20px 44px -28px color-mix(in srgb, ${C.blue} 50%, transparent)`
          : "none",
        cursor: "pointer",
        color: C.ink,
        textAlign: "left",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: compact ? 36 : 40,
            height: compact ? 36 : 40,
            borderRadius: compact ? 10 : 11,
            display: "grid",
            placeItems: "center",
            fontSize: compact ? 17 : 19,
            background: project.color
              ? `color-mix(in srgb, ${project.color} 16%, ${C.sunken})`
              : C.sunken,
            flexShrink: 0,
          }}
        >
          {project.emoji ?? "📁"}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: compact ? 13.5 : 14.5,
              fontWeight: 600,
              lineHeight: 1.2,
              color: C.t1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {project.title}
          </div>
          {compact ? (
            <div style={{ marginTop: 3 }}>{tagRow}</div>
          ) : category ? (
            <div
              style={{
                fontFamily: mono,
                fontSize: 9,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: C.t3,
                marginTop: 3,
              }}
            >
              {category}
            </div>
          ) : null}
        </div>
        {onTogglePin ? (
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
              width: 26,
              height: 26,
              borderRadius: 7,
              display: "grid",
              placeItems: "center",
              border: "none",
              background: "transparent",
              color: project.pinned ? C.amber : C.t3,
              opacity: project.pinned ? 1 : 0.4,
              cursor: pinBusy ? "default" : "pointer",
            }}
          >
            <Pin size={13} fill={project.pinned ? "currentColor" : "none"} />
          </button>
        ) : null}
      </div>

      {!compact ? tagRow : null}

      {!compact && chips.length > 0 ? (
        <div
          style={{ display: "flex", gap: 6, marginTop: 11, flexWrap: "wrap" }}
        >
          {chips.map((chip) => (
            <TallyChip key={chip.label} {...chip} />
          ))}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: compact ? 11.5 : 12,
          color: C.t2,
          marginTop: compact ? 10 : 11,
          paddingTop: compact ? 10 : 11,
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span
          aria-hidden
          style={{
            width: compact ? 5 : 6,
            height: compact ? 5 : 6,
            borderRadius: 999,
            background: tone,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {next ? (
            <>
              Next: {next.title}
              {next.dueAt != null ? (
                <b style={{ fontWeight: 600, color: urgent ? C.danger : C.t2 }}>
                  {" "}
                  ·{" "}
                  {next.dueAt < refNow
                    ? "overdue"
                    : (relativeTime(next.dueAt)?.replace(/^in /, "due in ") ??
                      "due")}
                </b>
              ) : null}
            </>
          ) : (counts?.done ?? 0) > 0 ? (
            "Quiet · nothing due"
          ) : (
            "Nothing filed yet"
          )}
        </span>
        {compact && counts ? (
          <span style={{ fontFamily: mono, fontSize: 8.5, color: C.t3 }}>
            {counts.queued + counts.running}·{counts.awaiting_review}·
            {counts.done}
          </span>
        ) : (
          <span
            style={{
              color: C.blueS,
              fontWeight: 500,
              whiteSpace: "nowrap",
              fontSize: 12,
            }}
          >
            Open ›
          </span>
        )}
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const isNarrow = useIsMobile();
  const { projects, isLoading, isError } = useProjects(assistantId);
  const missionTitles = useMissionTitles(assistantId);
  const patch = usePatchProject(assistantId);
  const [showNew, setShowNew] = useState(false);
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  // Stable reference time for due-urgency (react purity: no Date.now() in
  // render) — lazily initialized once per mount.
  const [now] = useState(() => Date.now());

  const active = useMemo(
    () => projects.filter((p) => p.status === "active"),
    [projects],
  );

  const pinned = useMemo(() => active.filter((p) => p.pinned), [active]);

  // Group non-pinned actives by category bucket. Pinned projects float to the
  // top band only, to keep the "pinned" affordance meaningful.
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
        gridTemplateColumns: isNarrow
          ? "1fr"
          : "repeat(auto-fill, minmax(280px, 1fr))",
        gap: isNarrow ? 9 : 14,
      }}
    >
      {items.map((p) => (
        <ProjectCard
          key={p.id}
          project={p}
          pinBusy={pinBusyId === p.id}
          now={now}
          missionTitle={
            p.missionId ? (missionTitles.get(p.missionId) ?? null) : null
          }
          onOpenMission={
            p.missionId
              ? () => navigate(routes.hqMission(p.missionId!))
              : undefined
          }
          onOpen={() => navigate(routes.project(p.id))}
          onTogglePin={() => togglePin(p)}
        />
      ))}
    </div>
  );

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <HqStyle />
      <div
        style={{
          maxWidth: 1000,
          margin: "0 auto",
          padding: isNarrow ? "20px 16px 60px" : "30px 26px 60px",
        }}
      >
        {/* Serif hero under the mono microlabel — the B1 frame. */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <MicroLabel>
              Initiatives &amp; areas · {active.length} active
            </MicroLabel>
            <div
              style={{
                fontFamily: serif,
                fontSize: isNarrow ? 27 : 34,
                lineHeight: 1.05,
                color: C.ink,
                marginTop: 6,
              }}
            >
              Projects
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            aria-label="New project"
            style={
              isNarrow
                ? {
                    width: 32,
                    height: 32,
                    borderRadius: 999,
                    display: "grid",
                    placeItems: "center",
                    border: `1px solid ${C.line}`,
                    background: C.surface,
                    color: C.t1,
                    cursor: "pointer",
                    flexShrink: 0,
                  }
                : {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    flexShrink: 0,
                    fontSize: 12,
                    fontWeight: 500,
                    padding: "8px 14px",
                    borderRadius: 9,
                    border: "none",
                    background: C.ink,
                    color: C.bg,
                    cursor: "pointer",
                  }
            }
          >
            <Plus size={14} />
            {isNarrow ? null : "New project"}
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
          <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
            {pinned.length > 0 ? (
              <section>
                <BandHeader label="📌 PINNED" accent={C.amber} />
                {cardGrid(pinned)}
              </section>
            ) : null}
            {grouped.map((g) => (
              <section key={g.key}>
                <BandHeader label={g.label.toUpperCase()} />
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

/** Band label + hairline rule ("📌 PINNED ————", "PEOPLE & OPS ————"). */
function BandHeader({
  label,
  accent = C.t3,
}: {
  label: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "22px 0 10px",
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: accent,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span aria-hidden style={{ height: 1, flex: 1, background: C.line }} />
    </div>
  );
}

/** The editorial empty state — "Missions create them as they work…". */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        marginTop: 30,
        maxWidth: 380,
        marginLeft: "auto",
        marginRight: "auto",
        padding: "44px 32px",
        border: `1px solid ${C.line2}`,
        borderRadius: 16,
        background: C.surface,
        textAlign: "center",
        boxShadow: "0 30px 60px -40px rgba(20,28,44,.4)",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          width: 52,
          height: 52,
          borderRadius: 15,
          background: C.sunken,
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
          color: C.t2,
        }}
      >
        ◳
      </span>
      <div
        style={{
          fontFamily: serif,
          fontSize: 21,
          lineHeight: 1.2,
          marginTop: 16,
          color: C.ink,
        }}
      >
        No projects yet.
      </div>
      <div
        style={{
          fontSize: 13,
          color: C.t2,
          marginTop: 8,
          lineHeight: 1.55,
        }}
      >
        Missions create them as they work — or start one yourself.
      </div>
      <button
        type="button"
        onClick={onCreate}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          fontWeight: 500,
          background: C.ink,
          color: C.bg,
          borderRadius: 9,
          padding: "9px 16px",
          border: "none",
          cursor: "pointer",
          marginTop: 18,
        }}
      >
        <Plus size={13} /> New project
      </button>
    </div>
  );
}
