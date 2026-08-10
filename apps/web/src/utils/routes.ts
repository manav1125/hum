/**
 * Centralized URL registry for app-internal navigation.
 *
 * All paths are absolute browser paths — pass them directly to
 * `<Link to>`, `navigate()`, `window.location.href`, and pathname
 * comparisons. No React Router basename is in play; the router runs
 * at `/` and matches these paths as-is.
 *
 * Captured paths (e.g. inputs to `sanitizeReturnTo`, query-string round-trips)
 * are values, not constants — do NOT rewrite those through this module.
 */

import { isElectron } from "@/runtime/is-electron";

const r = <const T extends string>(path: T): T => path;

const dyn = (parent: string, id: string): string => `${parent}/${id}`;
const LOCAL_ADMIN_ORIGIN = "http://localhost:3000";
const LOGS_USAGE_PATH = r("/assistant/logs/usage");

export const routes = {
  assistant: r("/assistant"),
  /**
   * Standalone About page. Lives under `/assistant/*` so it falls inside
   * `apps/web/vite.config.ts`'s `base: "/assistant/"` and Vite's SPA
   * fallback serves it in dev. Declared as a sibling of `/assistant`
   * in `routes.tsx` rather than a child, so it bypasses the app's auth
   * middleware and `RootLayout` — it's metadata, not the app.
   *
   * Mounted from the Electron host (`apps/macos/src/main/about.ts`)
   * into a frameless BrowserWindow; the route is also reachable from
   * the web build, where the runtime wrapper degrades to a "—" fallback.
   */
  about: r("/assistant/about"),
  /**
   * Bundle confirmation page. Standalone like About — sits under
   * `/assistant/*` for Vite SPA fallback but outside the auth tree so
   * bundles can be confirmed before sign-in. Mounted by the Electron
   * host (`apps/macos/src/main/bundle-confirmation.ts`) into a
   * dedicated BrowserWindow.
   */
  bundleConfirm: r("/assistant/bundle/confirm"),
  quickInput: r("/assistant/quick-input"),
  conversations: r("/assistant/conversations"),
  conversation: (key: string) => dyn(r("/assistant/conversations"), key),
  /**
   * LLM-context inspector for a single conversation. The conversation id
   * lives in the URL path so the link is sharable and the page can route
   * directly to its data without leaning on captured search params.
   */
  inspect: (conversationId: string) =>
    `${dyn(r("/assistant/conversations"), conversationId)}/inspect`,
  logs: {
    root: r("/assistant/logs"),
    trace: r("/assistant/logs/trace"),
    usage: LOGS_USAGE_PATH,
    usageForSchedule: (scheduleId: string) => {
      const params = new URLSearchParams({
        range: "7d",
        groupBy: "schedule",
        scheduleId,
      });
      return `${LOGS_USAGE_PATH}?${params.toString()}`;
    },
    emails: r("/assistant/logs/emails"),
    systemEvents: r("/assistant/logs/system-events"),
  },
  account: {
    root: r("/account"),
    login: r("/account/login"),
    signup: r("/account/signup"),
    providerSignup: r("/account/provider/signup"),
    providerCallback: r("/account/provider/callback"),
    oauth: {
      popupComplete: r("/account/oauth/popup-complete"),
      complete: r("/account/oauth/complete"),
      desktopComplete: r("/account/oauth/desktop-complete"),
    },
  },

  welcome: r("/assistant/welcome"),
  selectAssistant: r("/assistant/select-assistant"),
  reviewTerms: r("/assistant/review-terms"),

  onboarding: {
    /**
     * The self-host first-run intro (you're in → consent → names). Not part
     * of the platform funnel below and deliberately outside its
     * completed-onboarding middleware: a gateway session has its assistant
     * already and must never be routed into `hatching`.
     */
    hello: r("/assistant/onboarding/hello"),
    hosting: r("/assistant/onboarding/hosting"),
    apiKey: r("/assistant/onboarding/api-key"),
    privacy: r("/assistant/onboarding/privacy"),
    prechat: r("/assistant/onboarding/prechat"),
    hatching: r("/assistant/onboarding/hatching"),
  },

  // Legacy landing — redirects to HQ ("Home grew up. There's one landing
  // surface now."). Kept so captured URLs and old links still resolve.
  home: r("/assistant/home"),
  // HQ — THE landing surface: the rings deck with the folded Home modules.
  hq: r("/assistant/hq"),
  // HQ first-run setup — the Step-0 fork + five-step founding flow. Progress
  // persists to localStorage so the HQ setup meter can read N-of-5.
  hqSetup: r("/assistant/hq/setup"),
  hqMission: (id: string) => dyn(r("/assistant/hq"), id),
  // Agents · the org — the company view of the agent roster ("Your company,
  // staffed by agents."). Reached from the HQ rail's "Agents ›" link.
  hqAgents: r("/assistant/hq/agents"),
  /**
   * Work — the tab. Called `projects` here because that is the path and the
   * table; the user-facing word is **Work** (v11 vocabulary: `project` →
   * *thing*, and the tab that holds them is Work).
   */
  projects: r("/assistant/projects"),
  project: (id: string) => dyn(r("/assistant/projects"), id),
  /**
   * Work's three views. `Things` (containers), `Everything` (the flat ledger)
   * and `Library` (what Cue made) are views of ONE destination — the ledger
   * stopped being its own place in v11, because having both the tab and the
   * ledger answer to the word "work" was the second collision that word caused
   * in a week; Library joined them in v23, because the phone's tab bar is
   * three slots and full, and Library *is* work output.
   *
   * This deliberately returns a query on `routes.projects` rather than a
   * second path: a view is not a destination, and this codebase has already
   * had to clean up duplicate nav once.
   */
  workView: (view: "things" | "everything" | "library") =>
    `${r("/assistant/projects")}?view=${view}`,
  /**
   * Legacy standalone ledger URL. Now redirects into Work → Everything.
   * Kept as a constant (not deleted) so every bookmark, tour target and
   * cross-surface link that already points here still resolves.
   */
  allWork: r("/assistant/work"),
  // Mobile v3 surfaces (docs/design/mobile-v3/). Registered centrally here so
  // the parallel cluster builds never edit this file or routes.tsx.
  // Morning Brief — the 7:30 three-beat ritual (frame 5).
  brief: r("/assistant/brief"),
  // Came in today — inbound triage with swipe confirm/dismiss (frame 15).
  cameIn: r("/assistant/came-in"),
  // Watch live — a running work item's step stream (frame 17).
  workLive: (id: string) => `${dyn(r("/assistant/work"), id)}/live`,
  // Review pager — full-bleed deliverable review queue (frame 16).
  reviewQueue: r("/assistant/review-queue"),
  // Review index — the round-4 frame 55 list (Today's "See all" entry; rows
  // seed the pager, "Play all ›" plays it from the top).
  reviewIndex: r("/assistant/review-queue/list"),
  // Brand kit — palette/type/logos/voice + apply-everywhere (frame 19).
  brandKit: r("/assistant/brand"),
  // "What do you want to get done?" template / asset-creation picker.
  create: r("/assistant/create"),
  // v0.3 flagship surfaces. Demoted off the primary nav rail (per the clean-rail
  // design) but still routable + linked from their new homes: Next moves from
  // Home's feed, Meeting from Home's record action, People from Contacts.
  nextMoves: r("/assistant/next-moves"),
  dashboard: r("/assistant/dashboard"),
  // Mission Control — the unified five-lane command center (Inbound · Awaiting
  // you · In progress · Scheduled · Done). The primary activity surface; the
  // standalone Activity + Agents pages remain routable as fallbacks.
  missionControl: r("/assistant/mission-control"),
  activity: r("/assistant/activity"),
  agentsAtWork: r("/assistant/agents"),
  meeting: r("/assistant/meeting"),
  // Guardrails — checkpoints · agent scopes · the ledger. Took over the
  // Trust console's slot; the old /trust URL redirects here.
  guardrails: r("/assistant/guardrails"),
  trust: r("/assistant/trust"),
  people: r("/assistant/people"),
  /**
   * One person (design v24 frame F4). A real URL rather than in-page state so
   * the phone's swipe-back gesture and the browser's back button are the same
   * gesture — People lost its tab slot in v23, so every arrival here is
   * contextual (a name in a task, a search hit) and must be linkable.
   *
   * Desktop renders the same `PeoplePage` with this contact preselected in the
   * master–detail split; there is one People page at one URL family.
   */
  person: (contactId: string) => dyn(r("/assistant/people"), contactId),
  /**
   * Watching (design v24 frame F5) — every source states what flowed through
   * it and how much became work, plus the two honesty cards.
   */
  watching: r("/assistant/watching"),
  /**
   * Weekly review (design v24 frame F3) — the Friday four beats, paged.
   */
  weekly: r("/assistant/weekly"),
  voice: r("/assistant/voice"),
  /**
   * **Your Cue** — the door. One URL for "the place I change things", which
   * every configuration surface now lives under and which `/assistant/settings`
   * redirects to.
   *
   * On DESKTOP it is a redirect, not a page: a door with its own landing
   * screen would be a seventh thing to read before getting to the leaf you
   * came for, and the rail already renders the leaf column beside it. It lands
   * on Identity, the first leaf of the first group.
   *
   * On the PHONE there is no leaf column, so the same redirect drops you
   * *inside a single setting with no map*. The phone renders the ⓶ screen here
   * instead (v24 F2): what Cue is doing now, the two accumulating surfaces,
   * then the config groups that work on a phone. {@link yourCueAll} is the
   * full leaf list behind it.
   */
  yourCue: r("/assistant/your-cue"),
  /**
   * Every leaf of Your Cue, grouped, as a pushed list (v22 M5) — the phone's
   * answer to the desktop leaf column. Desktop redirects it to the door.
   */
  yourCueAll: r("/assistant/your-cue/all"),
  identity: r("/assistant/identity"),
  /**
   * Agent network — the A2A peering surface (invite, pair, revoke). Split out
   * of `/assistant/channels`, which rendered it as an unlinkable section below
   * the channel grid: design's "Agent network" is its own leaf because pairing
   * with another agent and connecting Slack are different trust decisions.
   *
   * `/assistant/channels` used to render the whole v3 "You" hub on mobile.
   * That hub is now {@link yourCue} (design R2: one name on both platforms),
   * and the phone's `/assistant/channels` redirects there so every screen that
   * shipped with `back={routes.channels}` still lands somewhere real.
   */
  agentNetwork: r("/assistant/agent-network"),
  cueLive: r("/assistant/cue-live"),
  // Desktop control — approve + mirror a run that executes on the paired Mac
  // (web W5 serif / mobile organizer remote frames 71/72).
  desktopControl: r("/assistant/desktop-control"),
  connectors: r("/assistant/connectors"),
  connector: (slug: string) => dyn(r("/assistant/connectors"), slug),
  channels: r("/assistant/channels"),
  // "What Cue can now do" — capability discovery (design D1 mobile / D2 HQ).
  // Full-screen at first run, then persistent at You → Explore.
  explore: r("/assistant/explore"),
  impact: r("/assistant/impact"),
  plugins: r("/assistant/plugins"),
  plugin: (name: string) => dyn(r("/assistant/plugins"), name),
  // Automations (WS-F) — Watchers + Playbooks. Mobile: a You-cluster leaf
  // (frames 69/70). Desktop: the serif-HQ board (web W3).
  automations: r("/assistant/automations"),
  skills: r("/assistant/skills"),
  // Skill marketplace — Explore / Sources / Installed over GitHub-ingested
  // SKILL.md sources. Lives next to Skills in the Intelligence tab rail and
  // is gated by the `marketplace` assistant feature flag.
  marketplace: r("/assistant/marketplace"),
  memory: r("/assistant/memory"),
  /**
   * The old interim People tab under Memory. **Now a redirect to
   * {@link routes.people}**, which is the one People page.
   *
   * Design sequenced People as a tab here while the sidebar row was gated on
   * relationship extraction. The owner ungated the row, at which point this was
   * a second nav path to a second page with the same name — so the tab and its
   * page are gone and the URL redirects.
   *
   * Kept as a constant rather than deleted so the redirect has a single spelling
   * and any captured link keeps resolving. Nothing should navigate *to* this.
   */
  memoryPeople: r("/assistant/memory/people"),
  workspace: r("/assistant/workspace"),
  library: {
    root: r("/assistant/library"),
    app: (slug: string) => dyn(r("/assistant/library"), slug),
  },
  // VentureVerse apps — the embedded parent-org app store (a Tier-2 "Apps"
  // sidebar row beside Library, gated by the `ventureverse-apps` assistant
  // feature flag). The detail route embeds the VentureVerse shell in an
  // iframe with the app launched; users sign into VentureVerse in-frame.
  ventureverseApps: {
    root: r("/assistant/apps"),
    app: (slug: string) => dyn(r("/assistant/apps"), slug),
  },

  document: (surfaceId: string) => dyn(r("/assistant/documents"), surfaceId),

  connect: r("/assistant/connect"),

  contacts: {
    root: r("/assistant/contacts"),
  },

  settings: {
    root: r("/assistant/settings"),
    general: r("/assistant/settings/general"),
    ai: r("/assistant/settings/ai"),
    integrations: r("/assistant/settings/integrations"),
    brand: r("/assistant/settings/brand"),
    schedules: r("/assistant/settings/schedules"),
    schedule: (id: string) => dyn(r("/assistant/settings/schedules"), id),
    notifications: r("/assistant/settings/notifications"),
    keyboardShortcuts: r("/assistant/settings/keyboard-shortcuts"),
    sounds: r("/assistant/settings/sounds"),
    voice: r("/assistant/settings/voice"),
    devices: r("/assistant/settings/devices"),
    privacy: r("/assistant/settings/privacy"),
    budget: r("/assistant/settings/budget"),
    archive: r("/assistant/settings/archive"),
    // Retired leaf (v37 ruling 3: bookmarks live with conversations). The
    // path stays mounted as a redirect to the Bookmarked filter, so the
    // constant stays for anything still linking here.
    bookmarks: r("/assistant/settings/bookmarks"),
    billing: r("/assistant/settings/billing"),
    debug: r("/assistant/settings/debug"),
    developer: r("/assistant/settings/developer"),
    advanced: r("/assistant/settings/advanced"),
    dangerZone: r("/assistant/settings/danger-zone"),
    systemEvents: r("/assistant/settings/system-events"),
    upgradeCancel: r("/assistant/settings/billing/upgrade/cancel"),
    upgradeSuccess: r("/assistant/settings/billing/upgrade/success"),
  },

  admin: {
    root: r("/admin"),
  },

  docs: {
    hostingOptions: r("/docs/hosting-options"),
    legal: {
      privacyPolicy: r("/docs/privacy-policy"),
      termsOfUse: r("/docs/vellum-terms-of-use"),
      dataSharing: r("/docs/data-sharing"),
      prohibitedUse: r("/docs/prohibited-use"),
      privacyAndData: r("/docs/trust-security/privacy-and-data"),
    },
  },
} as const;

const WWW_DOMAIN = "vellum.ai";

/** Full external URL for a legal/docs page hosted on the marketing site. */
export function legalUrl(
  path: (typeof routes.docs.legal)[keyof typeof routes.docs.legal],
): string {
  return docsUrl(path);
}

/** Full external URL for a docs page hosted on the marketing site. */
export function docsUrl(path: string): string {
  return `https://${WWW_DOMAIN}${path}`;
}

/** URL for the platform-hosted admin UI. */
export function adminUrl(): string {
  if (isElectron()) {
    const config = (
      window as unknown as { __VELLUM_CONFIG__?: { webUrl?: string } }
    ).__VELLUM_CONFIG__;
    return `${config?.webUrl ?? window.location.origin}${routes.admin.root}`;
  }
  if (import.meta.env.DEV) {
    return `${LOCAL_ADMIN_ORIGIN}${routes.admin.root}`;
  }
  return routes.admin.root;
}
