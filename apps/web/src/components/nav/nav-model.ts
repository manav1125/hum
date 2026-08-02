/**
 * The navigation model — ONE declaration of the primary destinations, shared
 * by the phone's tab bar and the desktop sidebar.
 *
 * Why this file exists: v10's navigation model was drawn phone-only, so the
 * two platforms briefly disagreed about the information model — which is worse
 * than either being wrong alone (v11 finding 2: desktop still said "Missions"
 * while the phone had already moved to "Work"). The fix is structural rather
 * than editorial: both surfaces import {@link PRIMARY_NAV}, so a label or a
 * destination cannot drift on one platform without moving on the other.
 *
 *   Phone   ◈ HQ · ◉ Talk to Cue · ▤ Work        (three tabs, mark centred)
 *   Desktop ✎ Talk to Cue · ◈ HQ · ▤ Work        (then conversations, then
 *                                                 the CUE group's six)
 *
 * The ORDER differs by platform on purpose — the phone centres the mark
 * because the centre slot is the thumb's home and the mark is the fastest
 * route back to talking; a vertical rail has no centre, so it reads top-down
 * in frequency order. The SET is identical, and `nav-model.test.ts` asserts
 * that it stays identical.
 *
 * What is deliberately NOT here: Voice (a mode, not a place — it lives as a
 * mic in the composer plus a long-press on ◉), past conversations (☰,
 * top-left) and the account cluster (avatar, top-right). Each moved out of a
 * primary slot because it is touched weekly or less, and two of the old five
 * phone tabs were spent on exactly that.
 */

import { routes } from "@/utils/routes";

/** The three destinations that exist on every platform. */
export type PrimaryNavKey = "talk" | "hq" | "work";

export interface PrimaryDestination {
  key: PrimaryNavKey;
  /** User-facing label. Identical on both platforms — that is the point. */
  label: string;
  /** Where the destination lands. */
  to: string;
  /**
   * Whether `pathname` is inside this destination. Kept beside the label so
   * "which tab is lit" and "which rail row is active" can never diverge.
   */
  match: (pathname: string) => boolean;
}

/**
 * HQ owns the landing deck plus the four surfaces that folded into it
 * (Mission Control · Activity · Agents-at-work · Next moves), all of which
 * still resolve as redirects.
 *
 * `/hq/agents` is excluded: the agent org chart is a DEEPER surface reached
 * from HQ's rail, not HQ itself. Lighting HQ there would claim the user is
 * on the landing deck when they are two levels into the roster.
 */
function matchHq(pathname: string): boolean {
  if (pathname.includes("/hq/agents")) return false;
  return (
    pathname.includes("/hq") ||
    pathname.endsWith("/home") ||
    pathname.includes("/mission-control") ||
    pathname.includes("/dashboard") ||
    pathname.includes("/activity") ||
    pathname.includes("/next-moves") ||
    // The bare /agents path is a momentary redirect to /hq.
    (pathname.includes("/agents") && !pathname.includes("/hq/agents"))
  );
}

/**
 * Work owns the things list, a thing's room, and the flat ledger — including
 * the legacy `/assistant/work` URL, which redirects into Work → Everything
 * but must still light the right tab during the hop.
 */
function matchWork(pathname: string): boolean {
  return (
    pathname.includes("/projects") ||
    pathname.endsWith("/work") ||
    pathname.includes("/work/")
  );
}

/**
 * Talk owns the conversation surface. `/assistant` itself redirects into the
 * most recent conversation, which is what "fastest route back to talking"
 * means in practice.
 */
function matchTalk(pathname: string): boolean {
  return (
    pathname === routes.assistant ||
    pathname === `${routes.assistant}/` ||
    pathname.includes("/conversations")
  );
}

/**
 * The primary destinations, in DESKTOP order (a vertical rail reads top-down
 * by frequency). The phone reorders via {@link MOBILE_TAB_ORDER}.
 */
export const PRIMARY_NAV: readonly PrimaryDestination[] = [
  {
    key: "talk",
    label: "Talk to Cue",
    to: routes.assistant,
    match: matchTalk,
  },
  { key: "hq", label: "HQ", to: routes.hq, match: matchHq },
  { key: "work", label: "Work", to: routes.projects, match: matchWork },
] as const;

/**
 * Phone tab order. The mark sits in the middle — a real destination with a
 * real active state, not a floating no-op, and the element that pulses while
 * agents are working. One element doing three jobs.
 */
export const MOBILE_TAB_ORDER: readonly PrimaryNavKey[] = [
  "hq",
  "talk",
  "work",
] as const;

export function primaryDestination(key: PrimaryNavKey): PrimaryDestination {
  const found = PRIMARY_NAV.find((d) => d.key === key);
  // Unreachable via the type system; throwing beats rendering a dead tab.
  if (!found) throw new Error(`Unknown primary destination: ${key}`);
  return found;
}

/** Which primary destination owns `pathname`, or null when none does. */
export function activePrimaryKey(pathname: string): PrimaryNavKey | null {
  return PRIMARY_NAV.find((d) => d.match(pathname))?.key ?? null;
}

// --- Work's two views -------------------------------------------------------

/**
 * Work has two views over ONE destination, not two destinations.
 *
 *   · Things     — the containers. The default.
 *   · Everything — the flat ledger, keeping its filters, search, bulk select
 *                  and the "Not in anything yet" bucket.
 *
 * Both surfaces were called "work" (the tab and the old "All work" ledger),
 * which is the second naming collision the word caused in a week. The fix is
 * a merge, not another rename: grouping headers in Everything are the same
 * things listed in Things, so the two views are provably the same data.
 */
export type WorkView = "things" | "everything";

export const WORK_VIEWS: readonly {
  key: WorkView;
  label: string;
  to: string;
}[] = [
  { key: "things", label: "Things", to: routes.workView("things") },
  { key: "everything", label: "Everything", to: routes.workView("everything") },
] as const;

/**
 * Read the current view off a location's search string. Anything unrecognised
 * (including no param at all) falls back to Things — a bad `?view=` value must
 * land somewhere real, never on a blank screen.
 */
export function readWorkView(search: string | URLSearchParams): WorkView {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get("view") === "everything" ? "everything" : "things";
}

// --- The accumulating destinations ------------------------------------------

/**
 * The two rows between the dividers — Tier 2, and the ONLY survivors of what
 * v15 called "the CUE group".
 *
 * v15 put six rows here (Agents · Skills · Rhythms · Memory · Library ·
 * Watching) and v20 laid them out as a two-column grid to fit. Design
 * overturned both: a grid *"reads as a keypad, breaks vertical scanning, and
 * truncates labels"* — it shipped with "Watching" rendered as "Wat…" — and
 * four of the six were configuration, not destinations.
 *
 * The admission test is no longer "does it explain the product" (which admits
 * everything) but one you can check against the database:
 *
 *   **Does the data accumulate on its own?**  → a sidebar row.
 *   **Do you only go there to change something?** → a leaf inside Your Cue.
 *
 * People and Library pass; Agents, Skills, Rhythms/Schedules and Watching do
 * not, and they now live in {@link ../../domains/intelligence/your-cue-model}.
 * That test is a property of the surface rather than a matter of taste, which
 * is why it should not drift the way "does it demo well" did.
 *
 * **One column, same left margin as HQ and Work.** Rendering is the rail's
 * job, but the shape of this array is what makes a single column the only
 * natural rendering: two entries have nothing to pair off into.
 */
export interface SidebarDestination {
  key: "people" | "library";
  label: string;
  to: string;
  match: (pathname: string) => boolean;
}

export const SIDEBAR_DESTINATIONS: readonly SidebarDestination[] = [
  {
    /**
     * **Ungated, by an explicit owner decision that overrules design.**
     *
     * There used to be a `shouldShowPeopleRow` predicate here, and a
     * `usePeopleSignal` hook feeding it, implementing design's ruling:
     * *"Promote it when contact memories are non-zero and growing
     * week-over-week — not when the code ships. A prominent destination with 2
     * rows teaches people the slot is worthless."*
     *
     * The owner overruled that directly: *"people is still buried and should
     * be out near library as we want to surface that. i know its showing more
     * domains vs people now but i believe over time that will clutter out and
     * it's nice for people to think this is a crm / people system that will
     * learn and grow."* A People surface that visibly fills in over time is
     * worth more to him than a hidden one, and that is his call to make.
     *
     * **The gate and its hook were DELETED, not left returning true.** A
     * predicate that exists but never closes is worse than no predicate: the
     * next reader assumes it works, and the round after that someone "fixes"
     * it back into a gate. If this ever needs gating again it should be
     * rewritten deliberately, against whatever the rule is then — not
     * resurrected from a stub. The count beside the row (a real contact count,
     * queried) is what tells the truth about how full the surface is.
     */
    key: "people",
    label: "People",
    to: routes.people,
    match: (p) => p === routes.people || p.startsWith(`${routes.people}/`),
  },
  {
    key: "library",
    label: "Library",
    to: routes.library.root,
    match: (p) => p.includes("/library"),
  },
] as const;

// --- The phone's ◍ menu (compatibility) -------------------------------------

export interface CueDestination {
  key: string;
  label: string;
  /** `null` when the surface does not exist. The ◍ menu filters those out. */
  to: string | null;
  unavailableReason?: string;
  match: (pathname: string) => boolean;
}

/**
 * @deprecated Desktop no longer reads this. The rail's Tier-2 group is now
 * {@link SIDEBAR_DESTINATIONS} (two rows) plus {@link YOUR_CUE_DOOR}, and the
 * four rows that used to live here are leaves inside Your Cue.
 *
 * It survives because `mobile-v3/overflow-menu.tsx` renders it, and the phone
 * follows the v3 NATIVE spec rather than this brief — changing it here would
 * silently restructure a surface this round did not review. Left byte-identical
 * on purpose: when the phone's ◍ menu is next revisited, delete this and read
 * `your-cue-model.ts` instead.
 */
export const CUE_NAV: readonly CueDestination[] = [
  {
    key: "agents",
    label: "Agents",
    to: routes.hqAgents,
    match: (p) => p.includes("/hq/agents"),
  },
  {
    key: "skills",
    label: "Skills",
    to: routes.skills,
    match: (p) => p.includes("/skills") || p.includes("/marketplace"),
  },
  {
    key: "rhythms",
    label: "Rhythms",
    to: routes.automations,
    match: (p) => p.includes("/automations"),
  },
  {
    key: "memory",
    label: "Memory",
    to: routes.memory,
    match: (p) => p.includes("/memory"),
  },
  {
    key: "library",
    label: "Library",
    to: routes.library.root,
    match: (p) => p.includes("/library"),
  },
  {
    key: "watching",
    label: "Watching",
    to: null,
    unavailableReason: "Not built yet — sources live under Skills › Channels",
    match: () => false,
  },
] as const;

// --- The door ---------------------------------------------------------------

/**
 * `⚙ Your Cue` — the last row above the account line, and the single door to
 * every configuration surface in the app.
 *
 * It is a door, not a destination: nothing accumulates behind it, you go there
 * to change something and come back. Settings used to be a second door to the
 * same rooms; it now redirects here (see `routes.tsx`), because a second nav
 * path to one destination is the exact duplication this round removed.
 */
export const YOUR_CUE_DOOR = {
  key: "your-cue",
  label: "Your Cue",
  to: routes.yourCue,
  /**
   * Every leaf, plus the legacy `/assistant/settings/*` URLs that still
   * resolve into the shell. Kept as a path test rather than a list of routes
   * so a new leaf cannot forget to light the door.
   */
  match: (pathname: string): boolean =>
    pathname.startsWith(routes.yourCue) ||
    pathname.startsWith(routes.settings.root) ||
    YOUR_CUE_LEAF_PATHS.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    ),
} as const;

/**
 * The leaf paths the door lights on. Declared here (rather than imported from
 * the Your Cue model) to keep this module free of anything that imports React
 * — the phone renders the same model.
 */
const YOUR_CUE_LEAF_PATHS: readonly string[] = [
  routes.identity,
  routes.hqAgents,
  routes.skills,
  routes.plugins,
  routes.marketplace,
  routes.connectors,
  routes.channels,
  routes.agentNetwork,
  routes.contacts.root,
  routes.cueLive,
  routes.desktopControl,
  routes.memory,
  routes.automations,
  routes.guardrails,
  routes.workspace,
  routes.explore,
  routes.impact,
] as const;

// --- The peek ---------------------------------------------------------------

/**
 * How many rows a rail section may ever show. **Three. Not "the first three
 * that fit".**
 *
 * This is the whole design. A rail that grows with workload recreates exactly
 * the problem the calm page was built to solve: at three items or thirty, only
 * the number in "N more ›" moves, and the rail's height does not. Raise this
 * constant and `rail-peek.test.ts` fails — that is deliberate, because every
 * previous cap in this codebase was a comment and every one of them drifted.
 */
export const RAIL_PEEK_LIMIT = 3;

/** The two sections that can expand. Only ever one at a time. */
export type PeekSectionKey = "hq" | "work";

export interface PeekItem {
  id: string;
  title: string;
  /**
   * The one thing allowed on the right: a deadline for HQ, a live-state phrase
   * for Work. Never a button — acting happens on the surface; the rail is a
   * reminder, not a workspace.
   */
  meta: string | null;
}

/**
 * A lane's readable state.
 *
 * `unreadable` exists because the alternative is worse: a lane that cannot
 * reach its data rendering `0` is indistinguishable from a lane that
 * legitimately has nothing, and "nothing needs you" is the single most
 * expensive lie this rail could tell. A lane that cannot read says so.
 */
export type PeekStatus = "ready" | "loading" | "unreadable";

export interface PeekLane {
  status: PeekStatus;
  /** Candidates, already sorted by the lane's own comparator. */
  items: readonly PeekItem[];
  /**
   * The section's badge count — the SAME number the rail renders beside the
   * label. "N more" is derived from this rather than from `items.length`, so
   * the badge and the arithmetic under it cannot disagree. (They already did
   * once: the HQ headline read 6 while the sidebar badge read 5.)
   */
  total: number;
}

export interface PeekView {
  shown: readonly PeekItem[];
  /** How many the peek is NOT showing. Never negative. */
  moreCount: number;
}

/**
 * Cap a lane at {@link RAIL_PEEK_LIMIT} and work out the remainder.
 *
 * `moreCount` comes off `total`, not off `items.length`: a lane may know its
 * count without having fetched every row (HQ's badge counts parked approvals
 * that carry no title), and under-reporting the remainder would make the rail
 * quietly disagree with the badge two pixels above it.
 */
export function takePeek(lane: PeekLane): PeekView {
  const shown =
    lane.status === "ready" ? lane.items.slice(0, RAIL_PEEK_LIMIT) : [];
  return {
    shown,
    moreCount: Math.max(0, lane.total - shown.length),
  };
}

/**
 * "10:30" · "Fri" · "31 Jul" · "overdue".
 *
 * Rail-local on purpose. The three formatters that already exist speak their
 * own surface's dialect — mobile's `dueLabel` shouts `DUE 10:30`, activity's
 * `relativeTime` says `in 2h` — and neither is the quiet right-aligned form
 * the rail draws. Accepts seconds or milliseconds, because daemon timestamps
 * are inconsistent about which they send.
 */
export function peekDeadline(
  dueAt: number | null | undefined,
  now: number,
): string | null {
  if (dueAt == null || !Number.isFinite(dueAt)) return null;
  const ms = dueAt < 1e12 ? dueAt * 1000 : dueAt;
  if (ms < now) return "overdue";
  const due = new Date(ms);
  if (new Date(now).toDateString() === due.toDateString()) {
    return due.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (ms - now < 7 * 86_400_000) {
    return due.toLocaleDateString(undefined, { weekday: "short" });
  }
  return due.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
