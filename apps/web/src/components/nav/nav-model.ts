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
 *   Phone   ◈ Today · ◉ (the mark) · ▤ Work      (three tabs, mark centred)
 *   Desktop ✎ Talk to Cue · ◈ HQ · ▤ Work        (then conversations, then
 *                                                 People, Library, Your Cue)
 *
 * **Three is the ceiling and it is full.** A fourth destination displaces one
 * or becomes a view inside an existing tab — the Library precedent, see
 * {@link WORK_VIEWS}. Design's reason is about the mark rather than about
 * counting: with four slots the mark sits at position 2 of 4, off-centre,
 * "which reads as an accident. The raised centre button only works when it IS
 * the centre." People went to the ⓶ surfaces plus contextual entry from every
 * name in the app; Library became Work's third view.
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
  /**
   * What the PHONE's tab bar prints under the glyph, when that differs.
   *
   * Not a licence to drift: the destination, the match and the set stay one
   * declaration, and this field exists because a 9.5px tab label and a rail
   * row are different typographic budgets. "Talk to Cue" does not fit under a
   * 27px mark; v24's final frames print `Today` on the phone where the rail
   * says `HQ`, because the phone's deck is a day and the rail's is a room.
   *
   * It replaces an inline `label === "Talk to Cue" ? "Cue" : label` ternary in
   * the tab bar — the same drift, just undeclared and unreadable from here.
   */
  phoneLabel?: string;
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
    phoneLabel: "Cue",
    to: routes.assistant,
    match: matchTalk,
  },
  {
    key: "hq",
    label: "HQ",
    phoneLabel: "Today",
    to: routes.hq,
    match: matchHq,
  },
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

/** What the phone prints under a tab glyph. See {@link PrimaryDestination.phoneLabel}. */
export function tabLabel(destination: PrimaryDestination): string {
  return destination.phoneLabel ?? destination.label;
}

/** Which primary destination owns `pathname`, or null when none does. */
export function activePrimaryKey(pathname: string): PrimaryNavKey | null {
  return PRIMARY_NAV.find((d) => d.match(pathname))?.key ?? null;
}

// --- Work's two views -------------------------------------------------------

/**
 * Work has three views over ONE destination, not three destinations.
 *
 *   · Things     — the containers. The default.
 *   · Everything — the flat ledger, keeping its filters, search, bulk select
 *                  and the "Not in anything yet" bucket.
 *   · Library    — what Cue made. Its gallery form, kept whole.
 *
 * Both of the first two were called "work" (the tab and the old "All work"
 * ledger), which is the second naming collision the word caused in a week. The
 * fix is a merge, not another rename: grouping headers in Everything are the
 * same things listed in Things, so the two views are provably the same data.
 *
 * **Library is the third view, not a fourth destination** (v23 R1). The phone's
 * tab bar is three slots and full; a new destination either displaces one or
 * becomes a view inside an existing tab, and Library *is* work output, so it
 * belongs inside the tab called Work rather than competing with it. Desktop
 * already read this way (Things · Everything · Files). One segmented control,
 * no new place.
 *
 * The Library ROUTE (`routes.library.root`) is untouched: the desktop rail
 * still lists it as a Tier-2 destination, and the artefact sheet (v24 F1) opens
 * over whatever you are doing rather than navigating. This constant is only
 * about what the Work segmented control offers.
 */
export type WorkView = "things" | "everything" | "library";

export const WORK_VIEWS: readonly {
  key: WorkView;
  label: string;
  to: string;
}[] = [
  { key: "things", label: "Things", to: routes.workView("things") },
  { key: "everything", label: "Everything", to: routes.workView("everything") },
  { key: "library", label: "Library", to: routes.workView("library") },
] as const;

/**
 * Read the current view off a location's search string. Anything unrecognised
 * (including no param at all) falls back to Things — a bad `?view=` value must
 * land somewhere real, never on a blank screen.
 *
 * Derived from {@link WORK_VIEWS} rather than a hand-written union of string
 * literals, so a view added above cannot be one the parser refuses to read.
 */
export function readWorkView(search: string | URLSearchParams): WorkView {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get("view");
  return WORK_VIEWS.find((v) => v.key === raw)?.key ?? "things";
}

// --- The accumulating destinations ------------------------------------------

/**
 * The rows between the dividers — Tier 2, the accumulating and the
 * product-surface destinations.
 *
 * v15 put six rows here (Agents · Skills · Rhythms · Memory · Library ·
 * Watching) and v20 laid them out as a two-column grid to fit. Design
 * overturned both: a grid *"reads as a keypad, breaks vertical scanning, and
 * truncates labels"* — it shipped with "Watching" rendered as "Wat…" — and it
 * cut the set to two with an admission test you can check against the database:
 *
 *   **Does the data accumulate on its own?**  → a sidebar row.
 *   **Do you only go there to change something?** → a leaf inside Your Cue.
 *
 * People and Library pass that test cleanly; Apps was the first row the owner
 * added over it (2026-08-10, flag-gated dark).
 *
 * **Owner decision (2026-08-11): Connectors, Skills and Agents rejoin, under
 * Apps.** They do not pass the accumulation test — they are where you go to
 * configure and inspect — but the owner overruled it deliberately, the way he
 * overruled the People gate: *"these are key places we want the user to
 * navigate to to understand the breadth of our product."* Discoverability of
 * what Cue can do beat the purity of "only what accumulates," and that is his
 * call. Because they now own a top-level row, they are **removed from
 * {@link YOUR_CUE_LEAF_PATHS}** so the Your Cue door no longer lights on their
 * URLs — one lit destination per place, not two. Their pages still render
 * inside the Your Cue shell (`IntelligenceLayout`); only the rail ownership
 * moved. Rhythms/Schedules, Memory and Watching stay leaves inside Your Cue.
 *
 * **One column, same left margin as HQ and Work.** Rendering is the rail's
 * job; the shape of this array is what makes a single column the natural one.
 */
export interface SidebarDestination {
  key:
    | "notes"
    | "people"
    | "library"
    | "apps"
    | "learn"
    | "design"
    | "connectors"
    | "skills"
    | "agents";
  label: string;
  to: string;
  /**
   * Assistant feature flag (store key) that must be ON for the row to render.
   * The rail hides flag-gated rows until the first real `/feature-flags`
   * response lands (`hasHydrated`), and the row's page self-redirects when
   * the flag is off, so a deep link is safe either way — the same contract
   * as {@link ../../domains/intelligence/your-cue-model} leaves.
   */
  flag?: "ventureverseApps" | "learnApp" | "designApp";
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
  {
    /**
     * The THIRD accumulating destination, and it sits after the People/Library
     * pair rather than between them — the pair is the design's own block and
     * `nav-model.test.ts` guards it.
     *
     * Notes passes the same admission test People and Library pass: it gets
     * richer on its own, you browse it, and it is worth more at month six than
     * at month one. It is deliberately NOT in {@link PRIMARY_NAV} — three is
     * the ceiling there and it is full — and it has no Your Cue leaf, because
     * a leaf is for things you go and change, not places that accumulate. Its
     * phone door is the drawer (see {@link MOBILE_DRAWER_DESTINATION_KEYS}).
     */
    key: "notes",
    label: "Notes",
    to: routes.notes,
    match: (p) => p === routes.notes || p.startsWith(`${routes.notes}/`),
  },
  {
    /**
     * VentureVerse apps — the parent-org app store (24 founder-focused AI
     * apps) embedded in Cue. **Owner decision (2026-08-10): a Tier-2 row
     * beside Library**, which widens the "exactly two rows" ruling the same
     * way the People ungating did — deliberately, on the owner's call.
     *
     * Flag-gated dark (`ventureverse-apps`, default OFF) rather than
     * admission-tested: the catalog doesn't accumulate on its own, but it is
     * a destination users return to, not configuration — and until the flag
     * flips on, the rail renders exactly the two rows design signed off on.
     */
    key: "apps",
    label: "Apps",
    to: routes.ventureverseApps.root,
    flag: "ventureverseApps",
    match: (p) =>
      p === routes.ventureverseApps.root ||
      p.startsWith(`${routes.ventureverseApps.root}/`),
  },
  {
    /**
     * Learn — the embedded OpenMAIC interactive classroom (owner decision,
     * 2026-09-02: "our next big feature will be called learn"). Like Apps it
     * is a flag-gated destination (`learn-app`, default OFF) rather than
     * admission-tested: courses the user generates do accumulate, but the
     * row ships dark until the OpenMAIC sidecar is deployed for the
     * instance, and until the flag flips the rail renders exactly what
     * design signed off on. The page is a same-origin iframe of the
     * gateway's /learn proxy; its phone door is the drawer (see
     * {@link MOBILE_DRAWER_DESTINATION_KEYS}).
     */
    key: "learn",
    label: "Learn",
    to: routes.learn,
    flag: "learnApp",
    match: (p) => p === routes.learn || p.startsWith(`${routes.learn}/`),
  },
  {
    /**
     * Design — the embedded Cue Design studio (OpenDesign fork). Same
     * contract as Learn: a flag-gated destination (`design-app`, default
     * OFF) that ships dark until the Cue Design sidecar is deployed for the
     * instance; until the flag flips the rail renders exactly what design
     * signed off on. The page is a same-site iframe of the design hostname
     * dispatched by the gateway's design host proxy; its phone door is the
     * drawer (see {@link MOBILE_DRAWER_DESTINATION_KEYS}).
     */
    key: "design",
    label: "Design",
    to: routes.design,
    flag: "designApp",
    match: (p) => p === routes.design || p.startsWith(`${routes.design}/`),
  },
  {
    /**
     * The integrations surface (Composio connectors + their detail pages).
     * Owner-promoted from a Your Cue leaf — see the block above. Lights on the
     * list and on any `connectors/:slug` detail.
     */
    key: "connectors",
    label: "Connectors",
    to: routes.connectors,
    match: (p) =>
      p === routes.connectors || p.startsWith(`${routes.connectors}/`),
  },
  {
    /** The skills catalog — what Cue can do. Owner-promoted (block above). */
    key: "skills",
    label: "Skills",
    to: routes.skills,
    match: (p) => p === routes.skills || p.startsWith(`${routes.skills}/`),
  },
  {
    /**
     * The agents surface — "Your company, staffed by agents" (the org/roster
     * at `/assistant/hq/agents`, NOT the bare `/assistant/agents` which
     * redirects to HQ). Owner-promoted (block above). `matchHq` explicitly
     * excludes `/hq/agents`, so this row is the only nav element that lights
     * there.
     */
    key: "agents",
    label: "Agents",
    to: routes.hqAgents,
    match: (p) => p === routes.hqAgents || p.startsWith(`${routes.hqAgents}/`),
  },
] as const;

/**
 * Which `SIDEBAR_DESTINATIONS` rows the MOBILE conversation drawer carries.
 *
 * The rail (`AssistantSideMenu`) renders only when `!isMobile` — `chat-layout`
 * swaps in `Mv3ChatsIndex` on a phone. So a row added to the rail has no phone
 * door unless something else provides one, and most of these rows do have one:
 * People, Library and HQ are primary mobile surfaces, and Connectors, Skills
 * and Agents kept their Your Cue leaves when they were promoted to the rail.
 *
 * `apps` did not. It was added straight to the rail (owner decision,
 * 2026-08-10) with no leaf behind it, which left the VentureVerse catalog —
 * and the native iOS overlay built to display it — unreachable on a phone
 * entirely. This list is the drawer's half of that fix.
 *
 * It is exported so `nav-model.test.ts` can assert the invariant rather than
 * trust a comment: **every sidebar destination must have a phone door.** That
 * property has now failed twice on this branch (see
 * `your-cue-reachable.test.tsx`), and a rule nobody can run is a rule that
 * fails a third time.
 */
export const MOBILE_DRAWER_DESTINATION_KEYS: readonly string[] = [
  // Notes, like Apps, was added to the rail with no Your Cue leaf behind it —
  // it is a destination you visit, not a thing you configure, so a leaf would
  // be the wrong shape. The drawer is its phone door, which is also what the
  // design specifies: "same three-tab shell, Notes reached from the ⓶ menu."
  "notes",
  "apps",
  // Learn, like Apps and Notes, is a rail destination with no Your Cue leaf —
  // the drawer is its phone door.
  "learn",
  // Design follows the same shape as Learn: rail destination, no leaf, the
  // drawer is its phone door.
  "design",
];

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
  // Agents (routes.hqAgents), Skills (routes.skills) and Connectors
  // (routes.connectors) were promoted to their own Tier-2 rail rows on
  // 2026-08-11 (see SIDEBAR_DESTINATIONS) and deliberately do NOT light the
  // door any more — the promoted row owns their active state.
  routes.plugins,
  routes.marketplace,
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
