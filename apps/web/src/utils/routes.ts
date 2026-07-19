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
  projects: r("/assistant/projects"),
  project: (id: string) => dyn(r("/assistant/projects"), id),
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
  voice: r("/assistant/voice"),
  identity: r("/assistant/identity"),
  cueLive: r("/assistant/cue-live"),
  connectors: r("/assistant/connectors"),
  connector: (slug: string) => dyn(r("/assistant/connectors"), slug),
  channels: r("/assistant/channels"),
  impact: r("/assistant/impact"),
  plugins: r("/assistant/plugins"),
  plugin: (name: string) => dyn(r("/assistant/plugins"), name),
  skills: r("/assistant/skills"),
  // Skill marketplace — Explore / Sources / Installed over GitHub-ingested
  // SKILL.md sources. Lives next to Skills in the Intelligence tab rail and
  // is gated by the `marketplace` assistant feature flag.
  marketplace: r("/assistant/marketplace"),
  memory: r("/assistant/memory"),
  workspace: r("/assistant/workspace"),
  library: {
    root: r("/assistant/library"),
    app: (slug: string) => dyn(r("/assistant/library"), slug),
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
