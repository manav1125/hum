/**
 * HQ — one surface, two densities.
 *
 * The owner reviewed the old HQ and said it was "just too much": a
 * watcher-heavy account produced a mile of scroll, with drift cards drawn above
 * the missions they named, blocked-ness drawn three times, a full-bleed rings
 * hero, an eleven-row came-in list and a twelve-lane tier rail. This is
 * design's replacement.
 *
 *   · **Glance** (default) — greeting, capture, ONE "Your next move", "N more
 *     need you ›", and a footer strip of five tappable numbers.
 *   · **Deck** — the same centre plus needs-you capped at 3 of N, and a 300px
 *     right rail carrying those same five lanes as live tiles.
 *
 * One toggle top-right, remembered per device, `⌘.` switches. Tapping any
 * Glance number opens Deck focused on that lane, so Glance is never a dead end.
 *
 * **The hinge** — and the reason the two cannot drift apart — is
 * `./hq-census`: both densities render from one exhaustive
 * `Record<HqLaneId, HqLaneReading>` built once, here, by `buildHqCensus`. The
 * strip and the rail are two views onto that record, not two readings of the
 * same queries.
 *
 * **Never a fake number.** Every lane is handed a `LaneState` that is EITHER a
 * queried payload or the sentence saying we could not ask. A query that has not
 * landed yet is `unavailable`, not an empty array — `?? []` is how a loading
 * spinner becomes a confident zero. The counts themselves come off
 * unpaginated daemon reads (`listWorkItems` and `missions` take no limit), so
 * none of them is a page size. The one place the label had to change from
 * design's frame is "filed today": `arrivals/summary` is a TRAILING window with
 * no `since` parameter, so the strip says `FILED · 24H` and the tile names the
 * window it actually covers.
 *
 * Mobile is always Glance — the phone cannot hold a rail, so it keeps the
 * strip-as-census in `@/mobile-v3` and Deck is a desktop affordance only.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { Mv3Today } from "@/mobile-v3";
import { LiveDot } from "@/components/live-dot";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import {
  arrivalsSummaryGetOptions,
  pendinginteractionsGetOptions,
  workitemsAutofileHealthGetOptions,
  usageTotalsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import {
  useDayPicture,
  useLifeHorizons,
  useWaitingOnPeople,
} from "./use-hq-k1-data";
import { getBudgetConfig } from "@/lib/budget-api";
import { haptic } from "@/utils/haptics";
import { BuildOutTiles } from "@/pages/command-center/build-out-tiles";
import {
  dismissMeter,
  hasRealUsage,
  shouldShowSetupMeter,
  useSetupProgress,
  useSetupState,
  type AccountUsageSignals,
} from "@/pages/hq-onboarding/setup-state";
import { useProjects } from "@/pages/projects/use-projects";
import { routes } from "@/utils/routes";
import { usageRangeNow } from "@/utils/usage-window";

import { readPausedApprovals } from "./paused-approvals";
import { HqFirstRun, useHqFirstRun } from "./hq-firstrun";
import { CompanyPanel } from "./company-panel";
import {
  buildHqCensus,
  type HqCensusInput,
  type HqLaneId,
  type WatcherReading,
} from "./hq-census";
import { useHqDensity } from "./hq-density";
import { DensityToggle } from "./hq-lane-ui";
import { HqGlance } from "./hq-glance";
import { HqDeckSurface } from "./hq-deck-surface";
import {
  HqDeckSkeleton,
  ReconnectBanner,
  useDegradedState,
  useNextMove,
  useTodayStart,
} from "./hq-modules";
import { HqOrientationPanel, useHqOrientation } from "./hq-orientation";
import { C, HqStyle, MODE_META, mono } from "./hq-kit";
import { EmptyState, type ArrivalsSummary } from "./hq-deck";
import {
  counted,
  deliverySentence,
  known,
  unavailable,
  type LaneState,
} from "./hq-tiers";
import { TrustChip } from "./hq-k1-modules";
import { useWatchers } from "@/mobile-v3/you/use-automations-data";
import { NewMissionModal } from "./new-mission-modal";
import {
  missionByProject,
  useCompanyProfile,
  useHqSchedules,
  useHqWorkItems,
  useAbandonedMissions,
  useMissions,
  type HqWorkItem,
  type Mission,
} from "./use-missions";

/** Current calendar-month window [start, now] in epoch ms (stable `to`). */
function monthWindow(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { from: start.getTime(), to: usageRangeNow() };
}

function dayPart(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/**
 * First line of a provider error, capped. Watcher failures can be an entire
 * HTML 404 page — Gmail returns one — and pasting that into a card tells the
 * user nothing while destroying the layout.
 */
function firstLine(raw: string, max = 120): string {
  const line = (raw.split("\n")[0] ?? "").trim();
  if (line.length === 0) return "no detail reported";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * SETTING UP · N OF M — the slim, non-shaming first-run meter. Sits above the
 * surface until every tracked step is done, or until the user dismisses it
 * ("this never nags"). The × calls `dismissMeter` (forever).
 *
 * `usage` is the honesty gate: progress lives in localStorage only, so an
 * account that never ran `/assistant/hq/setup` (or reached HQ from another
 * browser) reads a pristine "0 OF 6" however long it has been running missions.
 */
function SetupMeter({ usage }: { usage: AccountUsageSignals }) {
  const { done, total, nextStep, nextLabel } = useSetupProgress();
  // Subscribed read (not the raw snapshot) so dismissing re-renders the meter.
  const state = useSetupState();
  if (
    !shouldShowSetupMeter(
      state,
      { doneCount: done, total, next: nextStep },
      usage,
    )
  ) {
    return null;
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        background: C.blueW,
        border: `1px solid color-mix(in srgb, ${C.blue} 22%, transparent)`,
        borderRadius: 12,
        padding: "10px 15px",
        marginBottom: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.06em",
              color: C.blueS,
              whiteSpace: "nowrap",
            }}
          >
            SETTING UP · {done} OF {total}
          </span>
          {nextLabel ? (
            <span
              style={{
                fontSize: 12,
                color: C.t2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {nextLabel}
            </span>
          ) : null}
        </div>
        <div
          style={{
            height: 5,
            borderRadius: 3,
            background: C.surface,
            marginTop: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: C.blue,
              borderRadius: 3,
            }}
          />
        </div>
      </div>
      <Link
        to={routes.hqSetup}
        style={{
          fontSize: 11.5,
          color: C.blueS,
          fontWeight: 500,
          whiteSpace: "nowrap",
          textDecoration: "none",
        }}
      >
        Finish setup ›
      </Link>
      <button
        type="button"
        aria-label="Dismiss setup meter"
        title="Dismiss — this never nags"
        onClick={dismissMeter}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
          color: C.t3,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** The header pills (Company & never-lines · New mission). */
function HqHeaderActions({
  workspaceMode,
  hasMissions,
  onOpenCompany,
  onNewMission,
}: {
  workspaceMode: "observe" | "assist" | "autonomous";
  hasMissions: boolean;
  onOpenCompany: () => void;
  onNewMission: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          onOpenCompany();
        }}
        title={`Workspace runs ${MODE_META[workspaceMode].label}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: C.t2,
          padding: "4px 10px",
          borderRadius: 999,
          border: `1px solid ${C.line2}`,
          background: "transparent",
          cursor: "pointer",
        }}
      >
        ☰ Company &amp; never-lines
      </button>
      {hasMissions ? (
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onNewMission();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: C.blueS,
            padding: "4px 10px",
            borderRadius: 999,
            border: `1px solid color-mix(in srgb, ${C.blue} 32%, transparent)`,
            background: `color-mix(in srgb, ${C.blue} 10%, transparent)`,
            cursor: "pointer",
          }}
        >
          <Plus size={12} /> New mission
        </button>
      ) : null}
    </>
  );
}

export function HqPage() {
  const assistantId = useActiveAssistantId();
  const isMobile = useMobileLayout();
  // SSE keeps every lane current; polls below are 60s safety-nets.
  useActivitySync(assistantId, true);

  const {
    missions: liveMissions,
    isLoading,
    isError: missionsError,
  } = useMissions(assistantId);
  // Abandoned missions still get a ring, in the blocked tone. A goal that
  // drifted is information; omitting it made a real deck look like an empty
  // product. Appended after live ones so they never outrank active work.
  const { missions: abandonedMissions } = useAbandonedMissions(assistantId);
  const missions = useMemo(
    () => [...liveMissions, ...abandonedMissions],
    [liveMissions, abandonedMissions],
  );
  const { projects } = useProjects(assistantId);
  const review = useHqWorkItems(assistantId, "awaiting_review");
  const running = useHqWorkItems(assistantId, "running");
  const queued = useHqWorkItems(assistantId, "pending");
  const done = useHqWorkItems(assistantId, "done");
  const { schedules, isError: schedulesError } = useHqSchedules(assistantId);
  /**
   * Drives the watching lane and the "not set up" / "broken" states. Read from
   * the real watcher list rather than assumed: the moment auto-provisioning
   * lands, this flips on its own.
   */
  const watchersQuery = useWatchers();
  /**
   * Pending approvals. Deliberately NOT folded into a second definition of
   * "needs you": invariant 2 fixes ONE needs-you set shared by the badge, the
   * strip and the rows.
   */
  const interactionsQuery = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });

  const stateQuery = useHomeStateQuery(assistantId);
  const { profile } = useCompanyProfile(assistantId);
  const { move, isLoading: moveLoading } = useNextMove(assistantId);
  const { degraded, syncedLabel } = useDegradedState();
  const orientation = useHqOrientation();
  const todayStart = useTodayStart();
  const density = useHqDensity();
  // Stamped once per mount: "waiting 6 days" must not tick over mid-session
  // because something unrelated re-rendered.
  const [nowMs] = useState(() => Date.now());
  // The three modules the phone still renders. Each returns EITHER data or a
  // sentence — never an empty array standing in for "couldn't ask", which is
  // why they cannot be replaced with `[]` when desktop stops using them.
  const dayPicture = useDayPicture(assistantId);
  const life = useLifeHorizons(assistantId);
  const waitingOn = useWaitingOnPeople(assistantId, nowMs);

  const month = monthWindow();
  const usage = useQuery({
    ...usageTotalsGetOptions({
      path: { assistant_id: assistantId },
      query: { from: month.from, to: month.to },
    }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const budget = useQuery({
    queryKey: ["budget", "config", assistantId],
    queryFn: () => getBudgetConfig(assistantId),
    staleTime: 60_000,
    retry: false,
  });

  const [showNewMission, setShowNewMission] = useState<
    { open: false } | { open: true; presetTitle?: string }
  >({ open: false });
  const [showCompany, setShowCompany] = useState(false);
  const navigate = useNavigate();

  // Stamped once per mount — keeps the clock out of the render path.
  const [hour] = useState(() => new Date().getHours());

  const byProject = useMemo(() => missionByProject(missions), [missions]);
  const cameIn = queued.items;

  // Filing health. Polled on the slow lane — a stalled filer is measured in
  // sweeps, not seconds, and this must never add load to the surface.
  const autoFileHealth = useQuery({
    ...workitemsAutofileHealthGetOptions({
      path: { assistant_id: assistantId },
    }),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const arrivalsQuery = useQuery({
    ...arrivalsSummaryGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const workspaceMode = profile?.workspaceMode ?? "assist";

  // The live surfaces show only OPEN rings — an achieved mission is done, not
  // "on track", and belongs to its detail page's achieved banner instead.
  // `byProject` stays unfiltered so review items keep their mission tag.
  const deckMissions = useMemo(
    () => missions.filter((m) => m.status !== "achieved"),
    [missions],
  );
  const hasMissions = deckMissions.length > 0;

  // Real-usage evidence for the first-run meter.
  const setupUsage: AccountUsageSignals = useMemo(
    () => ({
      missionCount: missions.length,
      projectCount: projects.length,
      scheduleCount: schedules.length,
      workItemCount:
        review.items.length +
        running.items.length +
        queued.items.length +
        done.items.length,
      hasIdentity:
        (profile?.identity ?? "").trim().length > 0 ||
        (profile?.direction ?? "").trim().length > 0,
    }),
    [
      missions.length,
      projects.length,
      schedules.length,
      review.items.length,
      running.items.length,
      queued.items.length,
      done.items.length,
      profile?.identity,
      profile?.direction,
    ],
  );

  // The next-move card and the needs-you rows read the same stores — when the
  // move IS one of the review items, the emphasised card replaces its row.
  const reviewItems = review.items.filter((item) => item.id !== move.itemId);
  const doneToday = done.items.filter(
    (item) => (item.updatedAt ?? item.createdAt) >= todayStart,
  );
  /**
   * Whether the next-move card represents work that is NOT already one of the
   * review rows, and so genuinely adds one to the needs-you count. Adding 1
   * unconditionally double-counted a move that is neither a review row nor an
   * approval, which is what made the headline read 6 while the sidebar read 5.
   */
  const moveIsExtraToNeedsYou =
    move.hasMove &&
    (review.items.length !== reviewItems.length || move.kind === "approval");
  const extraApprovalItems = useMemo(() => {
    const all = readPausedApprovals(interactionsQuery.data?.interactions);
    // The next-move card already carries the top one; the rest need to be
    // decidable here rather than counted here and decidable nowhere.
    return move.hasMove && move.kind === "approval" ? all.slice(1) : all;
  }, [interactionsQuery.data, move.hasMove, move.kind]);

  /**
   * The ONE needs-you number — reviews + the extra move + paused runs. Shared
   * with `use-needs-you-badge`, the strip, the Deck block and mobile.
   */
  const glanceCount =
    reviewItems.length +
    (moveIsExtraToNeedsYou ? 1 : 0) +
    extraApprovalItems.length;

  // ── Watchers, split by health ─────────────────────────────────────────────
  // A watcher that EXISTS is not a watcher that WORKS: counting rows would let
  // two provisioned-but-failing watchers retire the "not watching" card and
  // imply Cue is observing the inbox. `data === undefined` is `unavailable`
  // rather than an empty list, because `?? []` is how a pending query becomes a
  // confident zero.
  const watchers = watchersQuery.data;
  const liveWatchers = (watchers ?? []).filter((w) => w.enabled && !w.lastError);
  const failingWatchers = (watchers ?? []).filter(
    (w) => w.enabled && w.lastError,
  );
  const asReading = (w: (typeof liveWatchers)[number]): WatcherReading => ({
    id: w.id,
    name: w.name,
    lastPollAt: w.lastPollAt ?? null,
  });

  // ── The census — one build, both densities ────────────────────────────────
  const needsYouState: LaneState<number> = review.isError
    ? unavailable("Cue couldn't read your review queue just now.")
    : review.isLoading
      ? unavailable("Still reading your queue…")
      : known(glanceCount);
  const missionsState: LaneState<Mission[]> = missionsError
    ? unavailable("Cue couldn't load your missions just now.")
    : isLoading
      ? unavailable("Still loading your missions…")
      : known(deckMissions);
  const holdingState: LaneState<HqWorkItem[]> = queued.isError
    ? unavailable("Cue couldn't read what it's holding.")
    : queued.isLoading
      ? unavailable("Still reading the queue…")
      : known(cameIn);
  const arrivalsState: LaneState<ArrivalsSummary & { windowHours: number }> =
    arrivalsQuery.isError
      ? unavailable("Cue couldn't read what arrived.")
      : arrivalsQuery.data == null
        ? unavailable("Still reading what arrived…")
        : known({
            total: arrivalsQuery.data.arrived,
            filed: arrivalsQuery.data.filed,
            kept: arrivalsQuery.data.kept,
            // Off the response, never a constant here: the label is only
            // honest if the window comes from the same payload as the count.
            windowHours: arrivalsQuery.data.windowHours,
          });
  const inMotionState = running.isError
    ? unavailable<{ running: HqWorkItem[]; schedules: typeof schedules }>(
        "Cue couldn't read what's running.",
      )
    : running.isLoading
      ? unavailable<{ running: HqWorkItem[]; schedules: typeof schedules }>(
          "Still reading what's running…",
        )
      : known({
          running: running.items,
          // A schedules failure must not silently become "nothing on a
          // schedule" — an empty list there is a claim we cannot make.
          schedules: schedulesError ? [] : schedules,
        });
  const watchingState = watchersQuery.isError
    ? unavailable<{ live: WatcherReading[]; failing: WatcherReading[] }>(
        "Cue couldn't read what it watches.",
      )
    : watchers == null
      ? unavailable<{ live: WatcherReading[]; failing: WatcherReading[] }>(
          "Still reading what Cue watches…",
        )
      : known({
          live: liveWatchers.map(asReading),
          failing: failingWatchers.map(asReading),
        });

  const censusInput: HqCensusInput = {
    needsYou: needsYouState,
    missions: missionsState,
    holding: holdingState,
    arrivals: arrivalsState,
    inMotion: inMotionState,
    watching: watchingState,
  };
  // Built on every render rather than memoised: it is a handful of string
  // joins over data the queries already hold, and a stale memo here would be a
  // number that disagrees with the lane beside it — the exact failure the
  // hinge exists to prevent.
  const census = buildHqCensus(censusInput);

  // The receipts line. `Queried` cannot be minted from a literal, so a lane we
  // could not read contributes nothing rather than a zero.
  const deliveredCount = counted(
    done.isError
      ? unavailable<HqWorkItem[]>("unreadable")
      : done.isLoading
        ? unavailable<HqWorkItem[]>("loading")
        : known(doneToday),
    (items) => items.length,
  );
  const deliveredSentence = deliverySentence(deliveredCount, null, hour);

  const userName = stateQuery.data?.userName?.trim() || null;
  const greeting = userName
    ? `Good ${dayPart()}, ${userName}.`
    : `Good ${dayPart()}.`;

  const firstRun = useHqFirstRun({ established: hasRealUsage(setupUsage) });

  // MOBILE → the v3 native Today screen. Mobile is ALWAYS Glance: the phone
  // cannot hold a rail, so it keeps the strip-as-census and Deck never renders
  // there. Same model, different density.
  if (isMobile) {
    return (
      <Mv3Today
        assistantId={assistantId}
        userName={userName}
        move={move}
        moveLoading={moveLoading}
        review={reviewItems}
        reviewError={review.isError}
        // Computed ONCE, here, and handed to both surfaces — the badge, the
        // strip and the rows are provably the same set (invariant 2).
        glanceCount={glanceCount}
        running={running.items}
        cameIn={cameIn}
        done={doneToday}
        doneError={done.isError}
        missions={deckMissions}
        missionsError={missionsError}
        day={dayPicture.day}
        dayUnavailable={dayPicture.unavailable}
        lifeGroups={life.groups}
        lifeUnavailable={life.unavailable}
        arrivals={
          arrivalsState.kind === "known"
            ? arrivalsState.payload
            : { total: 0, filed: 0, kept: 0 }
        }
        arrivalsError={arrivalsState.kind !== "known"}
        waiting={waitingOn.items}
        waitingUnavailable={waitingOn.unavailable}
        schedules={schedules}
        schedulesError={schedulesError}
        watchingCount={liveWatchers.length}
        heartbeatRuns={null}
        degraded={degraded}
      />
    );
  }

  const autoFileDegraded = autoFileHealth.data?.degraded
    ? (autoFileHealth.data.degradedReason ??
      "Cue has stopped filing work into projects.")
    : null;

  /**
   * The screen-OWNING states. These keep their cards on BOTH densities: a filer
   * that has silently stopped and a watcher that cannot be reached are not
   * routine emptiness — they are the product being less than the owner
   * believes it is, which is the most literal answer to "what needs me right
   * now" this surface can give.
   */
  const brokenStates = (
    <>
      {autoFileDegraded ? (
        <EmptyState
          kind="broken"
          title="Cue has stopped filing"
          body={autoFileDegraded}
          action={
            <Link
              to={routes.allWork}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: C.amberText,
                textDecoration: "none",
              }}
            >
              See the unfiled work ›
            </Link>
          }
        />
      ) : null}
      {failingWatchers.length > 0 ? (
        <EmptyState
          kind="broken"
          title={`${failingWatchers.length === 1 ? failingWatchers[0]!.name : `${failingWatchers.length} sources`} can't be reached`}
          body={
            failingWatchers.length === 1
              ? `Cue set up watching but the last check failed: ${firstLine(failingWatchers[0]!.lastError ?? "")}`
              : `Cue set up watching but the last checks failed. First error: ${firstLine(failingWatchers[0]!.lastError ?? "")}`
          }
          action={
            <Link
              to={routes.automations}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: C.amberText,
                textDecoration: "none",
              }}
            >
              See what Cue watches ›
            </Link>
          }
        />
      ) : null}
      {/* Only once the watcher list has actually landed — "nothing is
          watching" is a claim, and a pending query is not evidence for it. */}
      {watchers != null &&
      liveWatchers.length === 0 &&
      failingWatchers.length === 0 ? (
        <EmptyState
          kind="not_set_up"
          title="Cue can see your inbox — but it isn't watching it"
          body="Right now Cue works when you ask. Turn on watching and things start arriving on their own — and your missions fill themselves in."
          action={
            <Link
              to={routes.connectors}
              className="cue-pressable"
              style={{
                display: "inline-block",
                fontSize: 12.5,
                fontWeight: 600,
                background: C.blue,
                color: "#fff",
                borderRadius: 9,
                padding: "9px 15px",
                textDecoration: "none",
              }}
            >
              Start watching
            </Link>
          }
        />
      ) : null}
    </>
  );

  const openLane = (id: HqLaneId) => density.setDensity("deck", id);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: C.bg,
      }}
    >
      <HqStyle />
      {/* Degraded: the cached surface stays readable under a quiet line. */}
      {degraded ? <ReconnectBanner syncedLabel={syncedLabel} /> : null}

      <div
        data-slot="hq-chrome"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 30px 0",
          opacity: degraded ? 0.72 : 1,
          transition: "opacity .3s ease",
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.14em",
            color: C.blueS,
          }}
        >
          HQ
        </span>
        <span style={{ flex: 1 }} />
        {/* Trust lives where the work is, not in Settings — the chip is the
            contextual door to Guardrails. It is chrome here rather than a deck
            card: it answers a standing question, not "what needs me now". */}
        <TrustChip
          mode={workspaceMode}
          spentCents={
            usage.data?.totalEstimatedCostUsd != null
              ? Math.round(usage.data.totalEstimatedCostUsd * 100)
              : null
          }
          capCents={
            budget.data?.monthlyCapUsd != null
              ? Math.round(budget.data.monthlyCapUsd * 100)
              : null
          }
        />
        <HqHeaderActions
          workspaceMode={workspaceMode}
          hasMissions={hasMissions}
          onOpenCompany={() => setShowCompany(true)}
          onNewMission={() => setShowNewMission({ open: true })}
        />
        <LiveDot />
        <DensityToggle
          density={density.density}
          onChange={(next) => density.setDensity(next)}
        />
      </div>

      {/* Onboarding chrome — each self-gates and retires for good, which is
          why it can sit above BOTH densities without competing with either. */}
      {!isLoading ? (
        <div style={{ padding: "12px 30px 0" }}>
          <SetupMeter usage={setupUsage} />
          <BuildOutTiles assistantId={assistantId} />
          {firstRun.show ? <HqFirstRun onDismiss={firstRun.dismiss} /> : null}
        </div>
      ) : null}

      {isLoading ? (
        <div style={{ padding: "0 30px 40px", overflowY: "auto" }}>
          <HqDeckSkeleton />
        </div>
      ) : density.density === "glance" ? (
        <HqGlance
          assistantId={assistantId}
          greeting={greeting}
          deliveredSentence={deliveredSentence}
          census={census}
          move={move}
          needsYouCount={
            census.needs_you.stat.kind === "count"
              ? census.needs_you.stat.value
              : null
          }
          onOpenLane={openLane}
          brokenStates={brokenStates}
        />
      ) : (
        <HqDeckSurface
          assistantId={assistantId}
          greeting={greeting}
          deliveredSentence={deliveredSentence}
          census={census}
          missions={deckMissions}
          move={move}
          needsYouCount={
            census.needs_you.stat.kind === "count"
              ? census.needs_you.stat.value
              : null
          }
          approvals={extraApprovalItems}
          reviewItems={reviewItems}
          missionsByProjectId={byProject}
          focus={density.focus}
          onFocusConsumed={density.clearFocus}
          brokenStates={brokenStates}
        />
      )}

      {showNewMission.open ? (
        <NewMissionModal
          assistantId={assistantId}
          presetTitle={showNewMission.presetTitle}
          workspaceMode={workspaceMode}
          onClose={() => setShowNewMission({ open: false })}
          onCreated={(id) => {
            setShowNewMission({ open: false });
            navigate(routes.hqMission(id));
          }}
        />
      ) : null}
      {showCompany ? (
        <CompanyPanel
          assistantId={assistantId}
          onClose={() => setShowCompany(false)}
        />
      ) : null}
      {/* One-time switch-over orientation — "Your Home is now HQ". */}
      {orientation.show ? (
        <HqOrientationPanel onDismiss={orientation.dismiss} />
      ) : null}
    </div>
  );
}
