/**
 * **Your Cue** — one configuration shell, six groups, eighteen leaves.
 *
 * This is the model behind what used to be two separate places: "About
 * Assistant" (the Intelligence tab strip) and Settings (its own SidebarShell).
 * They grew independently and overlapped, which is how the app ended up with
 * two connector catalogs, two autonomy surfaces and two spend pages.
 *
 * The grouping is not decoration. Each heading is a **question the leaves under
 * it answer**, and that is the admission test for anything new:
 *
 *   WHO CUE IS              · who is this thing
 *   WHO WORKS FOR YOU       · who does the work
 *   HOW CUE REACHES YOU     · how it gets to me
 *   WHAT CUE KNOWS & SEES   · what it knows
 *   WHAT IT DOES ALONE      · what it may do unattended
 *   RUNNING CUE             · the machine itself
 *
 * If a candidate answers none of them it probably belongs *on* an existing leaf
 * rather than beside it. If it answers "does the data accumulate on its own?"
 * instead, it is a sidebar destination — see `nav-model.ts`.
 *
 * ## Four things that look alike and are not
 *
 * Skills · Plugins · Marketplace · Connectors were collapsed into one tab in an
 * earlier round on the strength of their labels sounding similar. Design calls
 * that its own error, and the general rule it produced is the one enforced
 * here: **two things merge only if they share a lifecycle, not a label.**
 *
 *   Skills       learned or authored          (98, categorised, made from chat)
 *   Plugins      installed and pinned to a commit (reviewed, uninstallable)
 *   Marketplace  browsed and installed        (1,288 across 7 GitHub sources)
 *   Connectors   connected and authorised     (500 services with live health)
 *
 * Four objects, four trust models, four separate leaves.
 */

import { routes } from "@/utils/routes";

export type YourCueGroupKey =
  | "who-cue-is"
  | "who-works-for-you"
  | "how-cue-reaches-you"
  | "what-cue-knows"
  | "what-it-does-alone"
  | "running-cue";

export interface YourCueLeaf {
  key: string;
  label: string;
  /**
   * Where the leaf lands, or `null` when the surface genuinely does not exist.
   *
   * `null` renders a disabled row carrying {@link YourCueLeaf.unavailableReason}
   * and a `⊘` glyph. It is not a TODO marker — it is the honest state, and it
   * exists specifically to stop the failure mode of pointing a leaf at the
   * nearest lookalike surface. A row that lies about where it goes costs more
   * than a row that admits it has nowhere to go.
   */
  to: string | null;
  unavailableReason?: string;
  /**
   * Feature flag that must be on for this leaf to appear. Flag-gated leaves
   * whose page also self-redirects when the flag is off, so a deep link is
   * safe either way.
   */
  flag?: "externalPlugins" | "marketplace";
  match: (pathname: string) => boolean;
}

export interface YourCueGroup {
  key: YourCueGroupKey;
  title: string;
  leaves: readonly YourCueLeaf[];
}

/** `pathname === to`, or a child of it. The test every leaf uses. */
function at(to: string): (pathname: string) => boolean {
  return (pathname) => pathname === to || pathname.startsWith(`${to}/`);
}

export const YOUR_CUE_GROUPS: readonly YourCueGroup[] = [
  {
    key: "who-cue-is",
    title: "Who Cue is",
    leaves: [
      {
        key: "identity",
        label: "Identity",
        to: routes.identity,
        match: at(routes.identity),
      },
      {
        // The Brand *Kit* at `/assistant/brand` is a different surface: that
        // one is the read/apply screen, this is the capture flow. Only the
        // authoring surface is a configuration leaf.
        key: "brand",
        label: "Brand",
        to: routes.settings.brand,
        match: at(routes.settings.brand),
      },
    ],
  },
  {
    key: "who-works-for-you",
    title: "Who works for you",
    leaves: [
      {
        // The org chart, at its existing `/assistant/hq/agents` URL. The URL
        // deliberately did NOT move — the agent chip, the mobile You row and
        // the coach tour all point at it — but the route was re-parented under
        // the Your Cue shell so it stops opening in its own container.
        key: "agents",
        label: "Agents",
        to: routes.hqAgents,
        match: at(routes.hqAgents),
      },
      {
        key: "skills",
        label: "Skills",
        to: routes.skills,
        match: at(routes.skills),
      },
      {
        key: "plugins",
        label: "Plugins",
        to: routes.plugins,
        flag: "externalPlugins",
        match: at(routes.plugins),
      },
      {
        key: "marketplace",
        label: "Marketplace",
        to: routes.marketplace,
        flag: "marketplace",
        match: at(routes.marketplace),
      },
      {
        // Was "Tools & Apps". Renamed back to Connectors because that is the
        // word the rest of the product uses, and because Settings →
        // Integrations — a second catalog over a second backend — now
        // redirects here. One catalog, one name.
        key: "connectors",
        label: "Connectors",
        to: routes.connectors,
        match: at(routes.connectors),
      },
    ],
  },
  {
    key: "how-cue-reaches-you",
    title: "How Cue reaches you",
    leaves: [
      {
        key: "channels",
        label: "Channels",
        to: routes.channels,
        match: at(routes.channels),
      },
      {
        // Split out of the Channels page, where it rendered as an unlinkable
        // section below the channel grid. Pairing with another agent and
        // connecting Slack are different trust decisions and now have
        // different URLs.
        key: "agent-network",
        label: "Agent network",
        to: routes.agentNetwork,
        match: at(routes.agentNetwork),
      },
      {
        // A subsystem, not a mode: Look / Point / Take control / Stream, each
        // behind its own permission gate. `/assistant/desktop-control` is the
        // live-run remote it links into, not a sibling leaf.
        key: "cue-live",
        label: "Cue Live",
        to: routes.cueLive,
        match: (p) => at(routes.cueLive)(p) || at(routes.desktopControl)(p),
      },
    ],
  },
  {
    key: "what-cue-knows",
    title: "What Cue knows & sees",
    leaves: [
      {
        key: "memory",
        label: "Memory",
        to: routes.memory,
        match: at(routes.memory),
      },
      {
        // v17 E3's per-source accounting — "199 in — 147 filed, 52 became
        // work", the fail-open explanation, "nothing arrived in the sampled
        // window" — is built and live at `routes.watching`. This leaf carried
        // `to: null` and an "unavailableReason" long after that shipped, so
        // the nav advertised a working surface as missing and nobody opened
        // it. A "Not built" label outlives the gap it described unless
        // something forces it to be revisited; the guard for that is the
        // navigation test asserting this leaf resolves to a route.
        //
        // Worth keeping open specifically because Watching is where Cue is
        // most honest about its own failures — it is the surface that reports
        // "11 runs in a row read nothing", and the one that would have caught
        // the 697 contact extractions that completed and wrote nothing.
        key: "watching",
        label: "Watching",
        to: routes.watching,
        match: at(routes.watching),
      },
    ],
  },
  {
    key: "what-it-does-alone",
    title: "What it does alone",
    leaves: [
      {
        // HQ's ⟳ Rhythms lane links here (`hq-tiers.tsx` LANE_META.rhythms),
        // which is the contextual entry design asked to keep working.
        key: "schedules",
        label: "Schedules",
        to: routes.settings.schedules,
        match: at(routes.settings.schedules),
      },
      {
        // NOT in design's list, and kept anyway — see the report. Watchers and
        // playbooks are a real surface with real data behind HQ's ○ Pulse
        // lane; they are not schedules (cron you author) and they are not
        // Watching (accounting that doesn't exist). Omitting the leaf would
        // have orphaned a live surface to satisfy an arithmetic.
        key: "automations",
        label: "Automations",
        to: routes.automations,
        match: at(routes.automations),
      },
      {
        // Checkpoints · agent scopes · autonomy · trust rules — all four, in
        // one place. The same four controls also existed on Permissions &
        // Privacy; they were removed from there, not duplicated.
        key: "guardrails",
        label: "Guardrails",
        to: routes.guardrails,
        match: (p) => at(routes.guardrails)(p) || at(routes.trust)(p),
      },
      {
        // Was "Permissions & Privacy". Deliberately NOT merged into
        // Guardrails: an OS permission grant is something the Mac decides,
        // and a trust rule is something you decide. Different lifecycles, so
        // by design's own merging test they stay apart.
        key: "system-access",
        label: "System access",
        to: routes.settings.privacy,
        match: at(routes.settings.privacy),
      },
    ],
  },
  {
    key: "running-cue",
    title: "Running Cue",
    leaves: [
      {
        key: "models",
        label: "Models",
        to: routes.settings.ai,
        match: at(routes.settings.ai),
      },
      {
        // Spend caps + the kill switch + the usage analytics, on one page.
        // `/assistant/logs/usage` redirects here preserving its query string,
        // so the schedule detail's "View usage" deep link still lands on the
        // right filter.
        key: "usage",
        label: "Usage & spend",
        to: routes.settings.budget,
        match: at(routes.settings.budget),
      },
      {
        key: "workspace",
        label: "Workspace",
        to: routes.workspace,
        match: at(routes.workspace),
      },
      {
        // The folder leaf: General, Notifications, Sounds, Voice, Keyboard
        // shortcuts, Devices, Billing, Archive and the developer panels. They
        // render inside this shell with a second, quieter row — see
        // `YOUR_CUE_SUBLEAVES`.
        key: "preferences",
        label: "Preferences",
        to: routes.settings.general,
        match: (p) => at(routes.settings.root)(p) && !isOwnLeafSettingsPath(p),
      },
    ],
  },
] as const;

/**
 * Settings paths that are leaves in their own right, so Preferences must not
 * claim them. Without this, Brand / Schedules / System access / Usage & spend
 * would light two rows at once — they live under `/assistant/settings/*` and
 * would otherwise match the Preferences prefix as well as their own.
 */
const OWN_LEAF_SETTINGS_PATHS: readonly string[] = [
  routes.settings.brand,
  routes.settings.schedules,
  routes.settings.privacy,
  routes.settings.ai,
  routes.settings.budget,
];

function isOwnLeafSettingsPath(pathname: string): boolean {
  return OWN_LEAF_SETTINGS_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * The second-level rows under Preferences.
 *
 * Design gave Preferences one slot, and behind it are nine panels that are all
 * genuinely "set this once and forget it". Rather than promote nine leaves or
 * hide eight routes, the shell renders these as a quieter row beneath the leaf
 * strip — visible only while a Preferences page is open, so they cost nothing
 * on the other seventeen leaves.
 *
 * These are NOT a second nav path: none of them is reachable from the leaf
 * strip, and none of them is a leaf.
 */
export interface YourCueSubLeaf {
  key: string;
  label: string;
  to: string;
  /** Hidden unless developer mode is unlocked. */
  developerOnly?: boolean;
  /**
   * What must be true for this panel to do anything. `undefined` means it
   * always works. See {@link SubLeafRequirement}.
   */
  requires?: SubLeafRequirement;
}

/**
 * The conditions a Preferences panel can depend on.
 *
 * ## Why this is in the model
 *
 * Every one of these gates already existed — in `settings-layout.tsx`, which
 * filtered them out of the settings sidebar. Then Settings was absorbed into
 * Your Cue, that sidebar stopped being rendered on desktop, and its filter was
 * left feeding only the phone's index. The desktop sub-row list
 * ({@link YOUR_CUE_SUBLEAVES}) inherited no gating at all.
 *
 * The result was four rows that rendered, navigated, and landed on a page that
 * immediately `<Navigate>`d back to where you came from — Keyboard shortcuts,
 * Billing, Self-hosted and Notifications. The owner's words: *"under
 * preferences some things are not working like keyboard and billing & self
 * hosted point no where."* Each page even carries a comment saying "the sidebar
 * entry is already gated in settings-layout.tsx", which had quietly stopped
 * being true.
 *
 * So the policy moves **onto the row itself**, where both surfaces read one
 * declaration. A gate that lives next to the thing it gates cannot be orphaned
 * by moving the thing somewhere else.
 */
export type SubLeafRequirement =
  | "desktop-app"
  | "platform-hosted-assistant"
  | "platform-billing"
  | "platform-notifications";

/**
 * Why a panel is unavailable, in the second person, naming the actual cause.
 *
 * A disabled row that does not say why is a dead row that also wastes a
 * glance. These are rendered on the row and read out to screen readers.
 */
export const SUB_LEAF_UNAVAILABLE_REASON: Record<SubLeafRequirement, string> = {
  "desktop-app":
    "Shortcuts are registered by the desktop app — there's nothing to rebind in a browser tab.",
  "platform-hosted-assistant":
    "This assistant is self-hosted, so there's no Cue-hosted infrastructure to manage here.",
  "platform-billing":
    "Billing is handled on the Cue platform, and this assistant isn't signed in to one.",
  "platform-notifications":
    "Platform alerts are a Cue-hosted feature and aren't switched on for this assistant.",
};

/**
 * `null` when the panel works, otherwise the sentence explaining why not.
 *
 * `met` is supplied by the shell, which owns the live reads (Electron, platform
 * gates, feature flags). Keeping this a pure function over a boolean record is
 * what makes the whole rule testable without standing up a router or a query
 * client — and every one of these rows now has a click-through test.
 */
export function subLeafUnavailableReason(
  subLeaf: YourCueSubLeaf,
  met: Readonly<Partial<Record<SubLeafRequirement, boolean>>>,
): string | null {
  if (!subLeaf.requires) return null;
  return met[subLeaf.requires]
    ? null
    : SUB_LEAF_UNAVAILABLE_REASON[subLeaf.requires];
}

export const YOUR_CUE_SUBLEAVES: readonly YourCueSubLeaf[] = [
  // General is deliberately absent: the **Preferences leaf itself is General**.
  // Listing it here as well would put two rows one line apart pointing at the
  // same page, which is the duplication this round exists to remove — and
  // `your-cue-model.test.ts` fails if it comes back.
  {
    key: "notifications",
    label: "Notifications",
    to: routes.settings.notifications,
    requires: "platform-notifications",
  },
  { key: "sounds", label: "Sounds", to: routes.settings.sounds },
  { key: "voice", label: "Voice", to: routes.settings.voice },
  {
    key: "keyboard",
    label: "Keyboard",
    to: routes.settings.keyboardShortcuts,
    requires: "desktop-app",
  },
  {
    key: "devices",
    label: "Self-hosted",
    to: routes.settings.devices,
    requires: "platform-hosted-assistant",
  },
  {
    key: "billing",
    label: "Billing",
    to: routes.settings.billing,
    requires: "platform-billing",
  },
  {
    // Archived CONVERSATIONS. Design's fourth duplication assumed this
    // overlapped Workspace's file tree; it does not — see the report. It stays
    // here rather than becoming a filter on a file browser it shares nothing
    // with.
    key: "archive",
    label: "Archive",
    to: routes.settings.archive,
  },
  {
    key: "debug",
    label: "Debug",
    to: routes.settings.debug,
    developerOnly: true,
  },
  {
    key: "advanced",
    label: "Advanced",
    to: routes.settings.advanced,
    developerOnly: true,
  },
  {
    key: "developer",
    label: "Developer",
    to: routes.settings.developer,
    developerOnly: true,
  },
] as const;

const NO_PANELS: readonly YourCueSubLeaf[] = [];

/**
 * The second-level rows to render beneath the active leaf, or an empty list.
 *
 * One function rather than a branch per leaf, so the shell renders sub-rows by
 * ONE mechanism, and the next leaf that grows a second level costs an array
 * rather than another special case in the layout.
 *
 * **Memory used to have one too**: a `People` tab at `/assistant/memory/people`,
 * design's interim home for the relationship surface while the sidebar row was
 * gated. The owner ungated the sidebar row (see `nav-model.ts`), which made the
 * tab a *second* nav path to a *second* People page — the exact duplication
 * this round exists to remove, and the third time this codebase has had it. The
 * tab is gone, its page is deleted, and `/assistant/memory/people` redirects to
 * `/assistant/people` so every bookmark still resolves.
 */
export function panelsForPath(pathname: string): readonly YourCueSubLeaf[] {
  if (isPreferencesPath(pathname)) return YOUR_CUE_SUBLEAVES;
  return NO_PANELS;
}

/** Every leaf, flattened, in strip order. */
export const YOUR_CUE_LEAVES: readonly YourCueLeaf[] = YOUR_CUE_GROUPS.flatMap(
  (group) => group.leaves,
);

/**
 * The leaf that owns `pathname`, or null.
 *
 * Longest-match wins so a sub-path can't be claimed by a shorter sibling.
 */
export function activeYourCueLeaf(pathname: string): YourCueLeaf | null {
  const hits = YOUR_CUE_LEAVES.filter((leaf) => leaf.match(pathname));
  if (hits.length === 0) return null;
  return hits.reduce((best, leaf) =>
    (leaf.to?.length ?? 0) > (best.to?.length ?? 0) ? leaf : best,
  );
}

/**
 * True while Preferences or one of its panels is open, so the sub-row renders.
 *
 * Derived from the Preferences leaf's own `match` rather than from
 * {@link YOUR_CUE_SUBLEAVES}, because General is the leaf and not a sub-leaf —
 * testing the sub-leaf list alone would hide the sub-row on the one page the
 * leaf lands you on.
 */
export function isPreferencesPath(pathname: string): boolean {
  const preferences = YOUR_CUE_LEAVES.find(
    (leaf) => leaf.key === "preferences",
  );
  return preferences?.match(pathname) ?? false;
}
