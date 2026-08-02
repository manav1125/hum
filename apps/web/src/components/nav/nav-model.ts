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
 *   Desktop ◉ Talk to Cue · ◈ HQ · ▤ Work        (then Things/Everything,
 *                                                 then the deeper surfaces)
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

// --- Deeper surfaces --------------------------------------------------------

/**
 * The surfaces below the "deeper" divider on desktop. On the phone these hang
 * off the avatar menu — the same set, one level down, reached at the same
 * cost on both platforms.
 */
export interface DeeperDestination {
  key: string;
  label: string;
  to: string;
  match: (pathname: string) => boolean;
}

export const DEEPER_NAV: readonly DeeperDestination[] = [
  {
    key: "agents",
    label: "Agents",
    to: routes.hqAgents,
    match: (p) => p.includes("/hq/agents"),
  },
  {
    // "Rhythms" is the design's word for recurring work. The surface that
    // holds it today is Automations (Watchers + Playbooks) — the label moves
    // now, the surface stays where it is.
    key: "rhythms",
    label: "Rhythms",
    to: routes.automations,
    match: (p) => p.includes("/automations"),
  },
  {
    key: "people",
    label: "People",
    to: routes.people,
    match: (p) => p.includes("/people") || p.includes("/contacts"),
  },
  {
    key: "explore",
    label: "What Cue does",
    to: routes.explore,
    match: (p) => p.includes("/explore"),
  },
  {
    key: "guardrails",
    label: "Trust & guardrails",
    to: routes.guardrails,
    match: (p) => p.includes("/guardrails") || p.includes("/trust"),
  },
] as const;
