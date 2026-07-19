/**
 * Mv3Projects — the mobile v3 Projects list (spec frame 6): "every project is
 * a living system". Replaces the MOBILE rendering of ProjectsPage only;
 * desktop keeps the serif B1 deck untouched.
 *
 * Layout (spec-verbatim): "Projects" large title → segment pills → project
 * cards, each carrying a corner mini-orbit (moving = agents active, still =
 * quiet), a status microlabel (ON TRACK · JUL 31 / ‖ NEEDS YOU / QUIET), the
 * live agent line off the project's running work items, and one CTA when it
 * needs you. "+ Tell Cue what you're working on" is conversational (routes to
 * the + Create surface), not a form.
 *
 * DATA MAPPING — nothing invented:
 *   · `useProjects` (GET /projects, incl. per-project stats)  → cards + tallies
 *   · `useHqWorkItems(assistantId, "running")`                → live agent line
 *   · segments: Active = status "active", Done = status "archived". The
 *     design's third "Someday" segment has NO backing project state, so it is
 *     omitted rather than faked.
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useActivitySync } from "@/hooks/use-activity-sync";
import {
  AuroraBackdrop,
  GlassCard,
  LargeTitleHeader,
  cardBody,
  microLabel,
  rise,
} from "@/mobile-v3";
import { MiniBars, shortDate } from "@/mobile-v3/work-kit";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { Mv3NewProjectSheet } from "./mv3-new-project-sheet";
import { useProjects, type ProjectView } from "./use-projects";

type Segment = "active" | "done";

/** Honest per-project posture, derived from the live stats rollup. */
function postureOf(p: ProjectView): "needs_you" | "on_track" | "quiet" {
  const c = p.stats?.counts;
  if ((c?.awaiting_review ?? 0) > 0) return "needs_you";
  if ((c?.running ?? 0) > 0) return "on_track";
  return "quiet";
}

const POSTURE_COLOR: Record<string, string> = {
  needs_you: "var(--mv3-amber)",
  on_track: "var(--mv3-micro)",
  quiet: "var(--mv3-teal)",
};

/**
 * Corner mini-orbit (frame 6): 150px, top-right, opacity .5 — a guide ring
 * with 1–2 glowing dots. Moving = the project has running items; still =
 * quiet (dots rest in place). Amber second dot only when the project needs
 * you. Decorative closed circles are orbits, not the mark.
 */
function CornerOrbit({
  color,
  spinning,
  secondColor,
}: {
  color: string;
  spinning: boolean;
  secondColor?: string;
}) {
  const dot = (offset: number, size: number, dotColor: string) => (
    <span
      style={{
        position: "absolute",
        transform: `translateX(${offset}px)`,
        width: size,
        height: size,
        borderRadius: "50%",
        background: dotColor,
        boxShadow: `0 0 8px color-mix(in srgb, ${dotColor} 90%, transparent)`,
      }}
    />
  );
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: -30,
        right: -30,
        width: 150,
        height: 150,
        opacity: 0.5,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 20,
          borderRadius: "50%",
          border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          ...(spinning ? { animation: "mv3Spin 14s linear infinite" } : {}),
        }}
      >
        {dot(55, 6, color)}
      </div>
      {secondColor ? (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            ...(spinning
              ? { animation: "mv3SpinR 20s linear infinite" }
              : { transform: "rotate(140deg)" }),
          }}
        >
          {dot(40, 5, secondColor)}
        </div>
      ) : null}
    </div>
  );
}

function ProjectCardV3({
  project,
  liveItem,
  delay,
  done,
}: {
  project: ProjectView;
  /** The project's first running work item — drives the live agent line. */
  liveItem: HqWorkItem | null;
  delay: number;
  /** Rendering inside the Done (archived) segment. */
  done?: boolean;
}) {
  const navigate = useNavigate();
  const posture = done ? "quiet" : postureOf(project);
  const c = project.stats?.counts;
  const running = c?.running ?? 0;
  const review = c?.awaiting_review ?? 0;
  const total = c?.total ?? 0;
  const pct =
    total > 0 ? Math.round(((c?.done ?? 0) / total) * 100) : null;
  const next = project.stats?.nextTask ?? null;

  // Microlabel: ‖ NEEDS YOU · … / ON TRACK · JUL 31 / QUIET (frame 6).
  let micro: string;
  if (done) micro = "✓ Done";
  else if (posture === "needs_you")
    micro = `‖ Needs you · ${review} review`;
  else if (posture === "on_track")
    micro = next?.dueAt != null ? `On track · ${shortDate(next.dueAt)}` : "On track";
  else micro = next?.dueAt != null ? `Quiet · next ${shortDate(next.dueAt)}` : "Quiet";
  const microColor = done ? "var(--mv3-green)" : POSTURE_COLOR[posture];

  // Sub line: live tallies, or the honest quiet line.
  const subParts: string[] = [];
  if (running > 0) subParts.push(`${running} running`);
  if (review > 0) subParts.push(`${review} needs you`);
  if (pct != null && total > 0) subParts.push(`${pct}%`);
  const sub =
    subParts.length > 0
      ? subParts.join(" · ")
      : next
        ? `Next: ${next.title}`
        : (c?.done ?? 0) > 0
          ? "Quiet · nothing due"
          : "Nothing filed yet";

  const open = () => {
    haptic.light();
    navigate(routes.project(project.id));
  };

  return (
    <GlassCard
      radius={24}
      padding="15px 16px"
      blur={delay < 0.4}
      style={{ position: "relative", overflow: "hidden", ...rise(delay) }}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <CornerOrbit
        color={
          posture === "needs_you"
            ? "var(--mv3-violet)"
            : posture === "quiet"
              ? "var(--mv3-teal)"
              : "var(--mv3-micro)"
        }
        spinning={!done && running > 0}
        secondColor={posture === "needs_you" ? "var(--mv3-amber)" : undefined}
      />
      <div style={{ position: "relative" }}>
        <div style={{ ...microLabel, fontSize: 9.5, color: microColor }}>
          {micro}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: "-0.4px",
            marginTop: 6,
            color: "var(--mv3-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.emoji ? `${project.emoji} ` : ""}
          {project.title}
        </div>
        <div style={{ ...cardBody, fontSize: 12.5 }}>{sub}</div>

        {/* Live agent line — the project's running work item, verbatim off
            the runner's progress note (frame 6: "Growth is compiling…"). */}
        {!done && liveItem ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
            }}
          >
            <MiniBars />
            <span
              style={{
                fontSize: 11.5,
                color: "var(--mv3-micro)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {liveItem.lastProgressNote ?? liveItem.title}
            </span>
          </div>
        ) : null}

        {/* One CTA when the project needs you (frame 6, amber). */}
        {!done && posture === "needs_you" ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={(e) => {
              e.stopPropagation();
              haptic.medium();
              navigate(routes.reviewQueue);
            }}
            style={{
              width: "max-content",
              background: "var(--mv3-amber)",
              color: "var(--mv3-amber-btn-text)",
              border: "none",
              borderRadius: 10,
              padding: "8px 14px",
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: "inherit",
              marginTop: 10,
              cursor: "pointer",
              minHeight: 34,
            }}
          >
            Review
          </button>
        ) : null}
      </div>
    </GlassCard>
  );
}

export function Mv3Projects() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [segment, setSegment] = useState<Segment>("active");
  // Structured new-project sheet (spec frame 42); the sheet itself keeps the
  // "Just tell Cue instead ›" escape to the conversational + Create surface.
  const [newOpen, setNewOpen] = useState(false);

  const { projects, isLoading, isError } = useProjects(assistantId);
  const runningItems = useHqWorkItems(assistantId, "running");

  const active = useMemo(
    () => projects.filter((p) => p.status === "active"),
    [projects],
  );
  const archived = useMemo(
    () => projects.filter((p) => p.status === "archived"),
    [projects],
  );

  // projectId → first running item (newest activity first) for the live line.
  const liveByProject = useMemo(() => {
    const map = new Map<string, HqWorkItem>();
    const sorted = [...runningItems.items].sort(
      (a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt),
    );
    for (const item of sorted) {
      if (item.projectId && !map.has(item.projectId))
        map.set(item.projectId, item);
    }
    return map;
  }, [runningItems.items]);

  const shown = segment === "active" ? active : archived;
  // Needs-you projects float first, then live ones — the eye lands on the
  // card that needs a decision (frame 6 orders exactly this way).
  const ordered = useMemo(() => {
    const rank = (p: ProjectView) => {
      const posture = postureOf(p);
      if (p.pinned) return 0;
      if (posture === "needs_you") return 1;
      if (posture === "on_track") return 2;
      return 3;
    };
    return [...shown].sort((a, b) => rank(a) - rank(b));
  }, [shown]);

  const segments: Array<{ key: Segment; label: string }> = [
    { key: "active", label: `Active · ${active.length}` },
    { key: "done", label: "Done" },
  ];

  return (
    <div
      data-mv3
      data-slot="mv3-projects"
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
      <LargeTitleHeader title="Projects" scrollRef={scrollRef} />

      {/* Segment pills (frame 6). */}
      <div
        role="radiogroup"
        aria-label="Project filter"
        style={{
          display: "flex",
          gap: 7,
          padding: "10px 22px 10px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        {segments.map((s) => {
          const selected = segment === s.key;
          return (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={selected}
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                setSegment(s.key);
              }}
              style={{
                fontSize: 12.5,
                fontWeight: selected ? 600 : 400,
                color: selected ? "var(--mv3-bg)" : "var(--mv3-muted)",
                background: selected
                  ? "var(--mv3-text)"
                  : "var(--mv3-btn2-bg)",
                border: selected
                  ? "1px solid transparent"
                  : "1px solid var(--mv3-btn2-border)",
                borderRadius: 99,
                padding: "7px 15px",
                minHeight: 34,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "2px 16px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {isLoading ? (
            <div style={{ ...cardBody, padding: "8px 6px" }}>
              Loading projects…
            </div>
          ) : isError ? (
            <div style={{ ...cardBody, padding: "8px 6px" }}>
              Couldn’t load projects just now — try again in a moment.
            </div>
          ) : (
            <>
              {ordered.map((p, i) => (
                <ProjectCardV3
                  key={p.id}
                  project={p}
                  liveItem={liveByProject.get(p.id) ?? null}
                  delay={0.1 + 0.12 * Math.min(i, 4)}
                  done={segment === "done"}
                />
              ))}
              {ordered.length === 0 ? (
                <div
                  style={{
                    ...cardBody,
                    textAlign: "center",
                    padding: "14px 6px 4px",
                  }}
                >
                  {segment === "done"
                    ? "Nothing archived yet."
                    : "Missions create them as they work — or start one yourself."}
                </div>
              ) : null}

              {/* Add — opens the structured new-project sheet (frame 42). */}
              {segment === "active" ? (
                <button
                  type="button"
                  className="cue-pressable"
                  onClick={() => {
                    haptic.light();
                    setNewOpen(true);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 9,
                    border: "1.5px dashed color-mix(in srgb, var(--mv3-text) 16%, transparent)",
                    borderRadius: 20,
                    padding: 14,
                    minHeight: 48,
                    color: "var(--mv3-muted)",
                    background: "transparent",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    ...rise(0.55),
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      background:
                        "color-mix(in srgb, var(--mv3-accent) 20%, transparent)",
                      color: "var(--mv3-micro)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                    }}
                  >
                    +
                  </span>
                  <span style={{ fontSize: 13.5 }}>
                    Tell Cue what you&apos;re working on
                  </span>
                </button>
              ) : null}

              {/* All work — the flat, groupable list (/assistant/work),
                  parity audit §3 P0: previously unreachable on mobile. */}
              <button
                type="button"
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  navigate(routes.allWork);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--mv3-card)",
                  border: "1px solid var(--mv3-card-border)",
                  borderRadius: 16,
                  padding: "12px 15px",
                  minHeight: 48,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  textAlign: "left",
                  ...rise(0.62),
                }}
              >
                <span
                  aria-hidden
                  style={{ fontSize: 13, color: "var(--mv3-micro)" }}
                >
                  ⌗
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: "var(--mv3-text)",
                    }}
                  >
                    All work
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--mv3-faint)",
                      marginTop: 1,
                    }}
                  >
                    Everything Cue is tracking, one list
                  </span>
                </span>
                <span
                  aria-hidden
                  style={{ fontSize: 15, color: "var(--mv3-faint)" }}
                >
                  ›
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      <Mv3NewProjectSheet
        assistantId={assistantId}
        open={newOpen}
        onClose={() => setNewOpen(false)}
      />
    </div>
  );
}
