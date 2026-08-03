/**
 * Mv3Projects — Work / Things (v23 C2), the phone's default Work view.
 *
 * Header (C2): "Work" · the counts line ("5 things · 31 open · 3 need you") ·
 * the ONE segmented control, Things · Everything · Library. Three segments is
 * the phone's ceiling, so the Professional/Personal filter and the Active/Done
 * split both moved into a sheet behind the ⚟ button rather than becoming a
 * second and third row of pills.
 *
 * Body: cards carrying a corner mini-orbit (moving = agents active, still =
 * quiet), a status microlabel, the live agent line off the running work items,
 * and the doorway counts line with who is on it — a row is a doorway, not a
 * tile.
 *
 * "Personal as one Ongoing row" (C2): personal things collapse to a single
 * ONGOING row instead of competing with the professional deck. Tapping it
 * flips the filter to Personal, which is where the row's contents live.
 *
 * DATA MAPPING — nothing invented:
 *   · `useProjects` (GET /projects, incl. per-project stats)  → cards + tallies
 *   · `useHqWorkItems`                                        → live agent line
 *   · `categoryBucket(project.category)`                      → the P/P filter
 *   · Active = status "active", Done = status "archived". The design's
 *     "Someday" segment has NO backing project state, so it is omitted rather
 *     than faked, and the frame's "recurring" flavour of ONGOING has no
 *     backing field either — only the Personal roll-up lives there.
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useActivitySync } from "@/hooks/use-activity-sync";
import {
  AuroraBackdrop,
  GlassCard,
  SheetShell,
  cardBody,
  microLabel,
  rise,
} from "@/mobile-v3";
import {
  MiniBars,
  WorkHeader,
  sectionMicro,
  shortDate,
} from "@/mobile-v3/work-kit";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { Mv3NewProjectSheet } from "./mv3-new-project-sheet";
import { categoryBucket } from "./project-kit";
import { describeWorkers } from "./work-views";
import {
  useArchivedProjects,
  useProjects,
  type ProjectView,
} from "./use-projects";

type Segment = "active" | "done";

/** The Professional/Personal lens the C2 filter sheet sets. */
type Lens = "all" | "professional" | "personal";

const LENS_LABEL: Record<Lens, string> = {
  all: "Everything",
  professional: "Professional",
  personal: "Personal",
};

function inLens(project: ProjectView, lens: Lens): boolean {
  if (lens === "all") return true;
  const bucket = categoryBucket(project.category);
  if (lens === "personal") return bucket === "personal";
  // "Professional" holds the professional bucket and anything uncategorised —
  // an unlabelled thing is work until someone says otherwise, and hiding it
  // behind a filter nobody set would lose it.
  return bucket !== "personal";
}

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
  workers = [],
}: {
  project: ProjectView;
  /** The thing's first running work item — drives the live agent line. */
  liveItem: HqWorkItem | null;
  delay: number;
  /** Rendering inside the Done (archived) segment. */
  done?: boolean;
  /** Distinct assignees on this thing's live items. */
  workers?: string[];
}) {
  const navigate = useNavigate();
  const posture = done ? "quiet" : postureOf(project);
  const c = project.stats?.counts;
  const running = c?.running ?? 0;
  const review = c?.awaiting_review ?? 0;
  const total = c?.total ?? 0;
  const next = project.stats?.nextTask ?? null;

  // Microlabel: ‖ NEEDS YOU · … / ON TRACK · JUL 31 / QUIET (frame 6).
  let micro: string;
  if (done) micro = "✓ Done";
  else if (posture === "needs_you") micro = `‖ Needs you · ${review} review`;
  else if (posture === "on_track")
    micro =
      next?.dueAt != null ? `On track · ${shortDate(next.dueAt)}` : "On track";
  else
    micro =
      next?.dueAt != null ? `Quiet · next ${shortDate(next.dueAt)}` : "Quiet";
  const microColor = done ? "var(--mv3-green)" : POSTURE_COLOR[posture];

  // The doorway line: "1 needs you · 2 running · 9 total", then who is on it.
  //
  // A ring and a status word alone reads as a dashboard tile — something you
  // look at. Counts plus the people working make it a door with a room behind
  // it. This replaced a percentage: "68% of keep-the-pipeline-warm" is exactly
  // the fake number the rules forbid, and the count is the honest version.
  const subParts: string[] = [];
  if (review > 0) subParts.push(`${review} needs you`);
  if (running > 0) subParts.push(`${running} running`);
  if (total > 0) subParts.push(`${total} total`);
  if (workers.length > 0) subParts.push(workers.slice(0, 2).join(", "));
  const sub =
    subParts.length > 0
      ? subParts.join(" · ")
      : next
        ? `Next: ${next.title}`
        : "Nothing in it yet";

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
      aria-label={`Thing: ${project.title}`}
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
  useActivitySync(assistantId, true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [segment, setSegment] = useState<Segment>("active");
  // C2: the Professional/Personal lens lives in a sheet, not a fourth pill.
  const [lens, setLens] = useState<Lens>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  // Structured new-project sheet (spec frame 42); the sheet itself keeps the
  // "Just tell Cue instead ›" escape to the conversational + Create surface.
  const [newOpen, setNewOpen] = useState(false);

  const { projects, isLoading, isError } = useProjects(assistantId);
  // The default projects list is ACTIVE-only daemon-side; the Done segment
  // reads the archived list through its own status=archived query (filtering
  // the active list for "archived" matched nothing — the post-archive
  // "Nothing archived yet" bug).
  const archivedQuery = useArchivedProjects(assistantId);
  // Unfiltered — the same query key the sidebar counts and the ledger read,
  // so the live line, the doorway counts and the rail can never disagree.
  const allItems = useHqWorkItems(assistantId);

  const active = useMemo(
    () => projects.filter((p) => p.status === "active"),
    [projects],
  );
  const archived = archivedQuery.projects;

  // projectId → first running item (newest activity first) for the live line.
  const liveByProject = useMemo(() => {
    const map = new Map<string, HqWorkItem>();
    const sorted = [...allItems.items]
      .filter((i) => i.status === "running")
      .sort(
        (a, b) =>
          (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt),
      );
    for (const item of sorted) {
      if (item.projectId && !map.has(item.projectId))
        map.set(item.projectId, item);
    }
    return map;
  }, [allItems.items]);

  // projectId → who is on its live items. Terminal items are excluded: Cue is
  // not "on" a thing because it finished something there last week.
  const workersByProject = useMemo(() => {
    const map = new Map<string, (string | null)[]>();
    for (const item of allItems.items) {
      if (!item.projectId) continue;
      if (item.status === "done" || item.status === "failed") continue;
      const arr = map.get(item.projectId) ?? [];
      arr.push(item.assignee ?? null);
      map.set(item.projectId, arr);
    }
    return new Map(
      [...map].map(([id, assignees]) => [id, describeWorkers(assignees)]),
    );
  }, [allItems.items]);

  const shown = segment === "active" ? active : archived;

  // "Personal as one Ongoing row" (C2): while no lens is set, personal things
  // are held out of the deck and roll up into a single row beneath it.
  const rollUpPersonal = lens === "all" && segment === "active";
  const personal = useMemo(
    () => (rollUpPersonal ? active.filter((p) => !inLens(p, "professional")) : []),
    [active, rollUpPersonal],
  );

  const inScope = useMemo(
    () =>
      shown.filter((p) =>
        rollUpPersonal ? inLens(p, "professional") : inLens(p, lens),
      ),
    [shown, lens, rollUpPersonal],
  );

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
    return [...inScope].sort((a, b) => rank(a) - rank(b));
  }, [inScope]);

  // The roll-up row's own honest summary — real open counts, or the titles.
  const personalOpen = useMemo(
    () =>
      personal.reduce((sum, p) => sum + (p.stats?.counts.open ?? 0), 0),
    [personal],
  );
  const personalLine =
    personalOpen > 0
      ? `${personalOpen} open · ${personal.length} ${personal.length === 1 ? "thing" : "things"}`
      : personal
          .slice(0, 3)
          .map((p) => p.title)
          .join(" · ");

  // The filter is only worth showing when it can change what you see.
  const lensActive = lens !== "all" || segment !== "active";

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

      <div
        style={{
          height:
            "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 8px)",
          flexShrink: 0,
        }}
      />

      {/* C2's header: title · counts · the one segmented control. */}
      <WorkHeader
        assistantId={assistantId}
        current="things"
        trailing={
          <button
            type="button"
            aria-label={`Filter things — showing ${LENS_LABEL[lens]}, ${segment === "active" ? "active" : "done"}`}
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setFilterOpen(true);
            }}
            style={{
              minHeight: 34,
              padding: "0 11px",
              borderRadius: 10,
              background: lensActive
                ? "var(--mv3-text)"
                : "var(--mv3-btn2-bg)",
              border: lensActive
                ? "1px solid transparent"
                : "1px solid var(--mv3-btn2-border)",
              color: lensActive ? "var(--mv3-bg)" : "var(--mv3-muted)",
              fontSize: 11.5,
              fontWeight: lensActive ? 600 : 400,
              cursor: "pointer",
              fontFamily: "inherit",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            ⚟{" "}
            {lensActive
              ? segment === "done"
                ? "Done"
                : LENS_LABEL[lens]
              : "Filter"}
          </button>
        }
      />

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
              Loading your work…
            </div>
          ) : isError ? (
            <div style={{ ...cardBody, padding: "8px 6px" }}>
              I couldn’t load your work just now — try again in a moment.
            </div>
          ) : (
            <>
              {ordered.length > 0 && rollUpPersonal ? (
                <div style={{ ...sectionMicro, padding: "2px 6px 0" }}>
                  Finishing
                </div>
              ) : null}
              {ordered.map((p, i) => (
                <ProjectCardV3
                  key={p.id}
                  project={p}
                  liveItem={liveByProject.get(p.id) ?? null}
                  delay={0.1 + 0.12 * Math.min(i, 4)}
                  done={segment === "done"}
                  workers={workersByProject.get(p.id) ?? []}
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
                    : lens === "personal"
                      ? "Nothing personal filed yet — a thing becomes personal when you file it that way."
                      : "A thing is whatever you’re trying to get done — a deal, a launch, a raise. Name one, or tell Cue what you’re working on."}
                </div>
              ) : null}

              {/* ONGOING — C2's ruling: Personal is ONE row, not a competing
                  deck. Tapping it flips the lens to Personal, which is where
                  its contents actually live. The frame's other Ongoing
                  flavour (a recurring thing) has no backing field on a
                  project, so nothing is invented to fill the section. */}
              {personal.length > 0 ? (
                <>
                  <div style={{ ...sectionMicro, padding: "8px 6px 0" }}>
                    Ongoing
                  </div>
                  <button
                    type="button"
                    className="cue-pressable"
                    aria-label={`Personal — ${personal.length} ${personal.length === 1 ? "thing" : "things"}`}
                    onClick={() => {
                      haptic.light();
                      setLens("personal");
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      width: "100%",
                      textAlign: "left",
                      background: "var(--mv3-card)",
                      border: "1px solid var(--mv3-card-border)",
                      borderRadius: 16,
                      padding: "11px 13px",
                      minHeight: 52,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      ...rise(0.5),
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 11,
                        background:
                          "color-mix(in srgb, var(--mv3-teal) 15%, transparent)",
                        color: "var(--mv3-teal)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13,
                        flexShrink: 0,
                      }}
                    >
                      ⌂
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--mv3-text)",
                        }}
                      >
                        Personal
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 10.5,
                          color: "var(--mv3-faint)",
                          marginTop: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {personalLine}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      style={{ color: "var(--mv3-faint)", fontSize: 15 }}
                    >
                      ›
                    </span>
                  </button>
                </>
              ) : null}

              {/* Add — opens the structured new-project sheet (frame 42). */}
              {segment === "active" ? (
                <button
                  type="button"
                  aria-label="New thing — tell Cue what you're working on"
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
                    border:
                      "1.5px dashed color-mix(in srgb, var(--mv3-text) 16%, transparent)",
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
            </>
          )}
        </div>
      </div>

      <Mv3NewProjectSheet
        assistantId={assistantId}
        open={newOpen}
        onClose={() => setNewOpen(false)}
      />

      {/* C2: "three segments is the phone's ceiling" — so the lens and the
          active/done split live here rather than as more rows of pills. */}
      <SheetShell
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        label="Filter things"
      >
        <div
          style={{ fontSize: 17, fontWeight: 700, color: "var(--mv3-text)" }}
        >
          Show me
        </div>
        <div style={{ ...sectionMicro, margin: "16px 0 8px" }}>Kind</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(["all", "professional", "personal"] as const).map((key) => (
            <FilterRow
              key={key}
              label={LENS_LABEL[key]}
              selected={lens === key}
              onPick={() => {
                setLens(key);
                setFilterOpen(false);
              }}
            />
          ))}
        </div>
        <div style={{ ...sectionMicro, margin: "18px 0 8px" }}>State</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(
            [
              { key: "active" as Segment, label: `Active · ${active.length}` },
              { key: "done" as Segment, label: "Done" },
            ]
          ).map((s) => (
            <FilterRow
              key={s.key}
              label={s.label}
              selected={segment === s.key}
              onPick={() => {
                setSegment(s.key);
                setFilterOpen(false);
              }}
            />
          ))}
        </div>
      </SheetShell>
    </div>
  );
}

/** One row of the filter sheet — a glyph carries the selection, not colour. */
function FilterRow({
  label,
  selected,
  onPick,
}: {
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="cue-pressable"
      onClick={() => {
        haptic.light();
        onPick();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        minHeight: 48,
        borderRadius: 12,
        padding: "12px 14px",
        textAlign: "left",
        fontSize: 14,
        fontFamily: "inherit",
        background: "var(--mv3-btn2-bg)",
        border: selected
          ? "1px solid var(--mv3-micro)"
          : "1px solid var(--mv3-btn2-border)",
        color: "var(--mv3-text)",
        fontWeight: selected ? 600 : 400,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          color: selected ? "var(--mv3-micro)" : "var(--mv3-faint)",
        }}
      >
        {selected ? "✓" : "·"}
      </span>
      {label}
    </button>
  );
}
