/**
 * Typed sidebar model for the Settings page.
 *
 * The Settings page uses route-based navigation (e.g. /settings/general).
 * This module defines:
 *  - The canonical set of panel IDs.
 *  - The flat sidebar item list (the source of truth for label/href/icon).
 *  - `SETTINGS_SECTIONS`: the grouping every settings surface renders, so the
 *    desktop rail and the mobile index can't drift apart.
 *  - `DEVELOPER_PANEL_IDS`: the panels that stay hidden until developer mode
 *    is unlocked (see `settings-developer-nav` in the feature-flag registry).
 */

import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Bell,
  Bookmark,
  Bug,
  CalendarClock,
  Code,
  Cpu,
  CreditCard,
  Keyboard,
  Laptop,
  Mic,
  Palette,
  Settings,
  Volume2,
  Wallet,
  Puzzle,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// Panel IDs
// ---------------------------------------------------------------------------

/** All panel IDs supported by the Settings page. */
export const PANEL_IDS = [
  "integrations",
  "brand",
  "model",
  "notifications",
  "keyboard-shortcuts",
  "sounds",
  "voice",
  "devices",
  "privacy",
  "budget",
  "schedules",
  "archive",
  "bookmarks",
  "billing",
  "assistant-status",
  "assistant-debug",
  "advanced",
  "developer",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

// ---------------------------------------------------------------------------
// Sidebar item model
// ---------------------------------------------------------------------------

/** A single item in the flat settings sidebar. */
export interface SidebarItem {
  /** Unique panel ID. */
  id: PanelId;
  /** Human-readable label shown in the sidebar. */
  label: string;
  /** Route path used for Link-based navigation. */
  href: string;
  /** Lucide icon component rendered beside the label. */
  icon: LucideIcon;
}

/**
 * Flat sidebar items for the Settings page, matching the macOS desktop app
 * layout. Each item has a Lucide icon.
 */
export const SETTINGS_SIDEBAR: SidebarItem[] = [
  {
    id: "assistant-status",
    label: "General",
    href: routes.settings.general,
    icon: SlidersHorizontal,
  },
  {
    id: "model",
    label: "Models & Services",
    href: routes.settings.ai,
    icon: Cpu,
  },
  {
    id: "integrations",
    label: "Integrations",
    href: routes.settings.integrations,
    icon: Puzzle,
  },
  {
    id: "brand",
    label: "Brand",
    href: routes.settings.brand,
    icon: Palette,
  },
  {
    id: "schedules",
    label: "Schedules",
    href: routes.settings.schedules,
    icon: CalendarClock,
  },
  {
    id: "notifications",
    label: "Notifications",
    href: routes.settings.notifications,
    icon: Bell,
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard Shortcuts",
    href: routes.settings.keyboardShortcuts,
    icon: Keyboard,
  },
  {
    id: "sounds",
    label: "Sounds",
    href: routes.settings.sounds,
    icon: Volume2,
  },
  { id: "voice", label: "Voice", href: routes.settings.voice, icon: Mic },
  {
    id: "devices",
    label: "Self-Hosted Assistants",
    href: routes.settings.devices,
    icon: Laptop,
  },
  {
    id: "privacy",
    label: "Permissions & Privacy",
    href: routes.settings.privacy,
    icon: ShieldCheck,
  },
  {
    id: "budget",
    label: "Budget & Spend",
    href: routes.settings.budget,
    icon: Wallet,
  },
  {
    id: "archive",
    label: "Archive",
    href: routes.settings.archive,
    icon: Archive,
  },
  {
    id: "bookmarks",
    label: "Bookmarks",
    href: routes.settings.bookmarks,
    icon: Bookmark,
  },
  {
    id: "billing",
    label: "Billing",
    href: routes.settings.billing,
    icon: CreditCard,
  },
  {
    id: "assistant-debug",
    label: "Debug",
    href: routes.settings.debug,
    icon: Bug,
  },
  {
    id: "advanced",
    label: "Advanced",
    href: routes.settings.advanced,
    icon: Settings,
  },
  {
    id: "developer",
    label: "Developer",
    href: routes.settings.developer,
    icon: Code,
  },
];

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Panels that are developer surfaces, not user settings. They are hidden from
 * every settings nav unless the `settings-developer-nav` assistant flag is on
 * (unlocked by tapping the version value 7× on the General panel — see
 * `dev-mode-version-unlock.tsx`). The routes themselves stay mounted, so a
 * developer with the flag off can still reach them by URL.
 */
export const DEVELOPER_PANEL_IDS: ReadonlySet<PanelId> = new Set<PanelId>([
  "assistant-debug",
  "advanced",
  "developer",
]);

export interface SettingsSectionModel {
  /** Stable key for React lists. */
  id: string;
  /** Group heading shown above the rows. */
  title: string;
  /** Panels in this group, in display order. */
  items: readonly PanelId[];
}

/**
 * The one grouping of the settings panels. Ordered; every `PanelId` appears
 * exactly once (enforced at compile time by `_everyPanelIsSectioned` below, so
 * a newly added panel can never silently drop out of the nav).
 */
export const SETTINGS_SECTIONS = [
  {
    id: "preferences",
    title: "Preferences",
    items: [
      "assistant-status",
      "notifications",
      "sounds",
      "voice",
      "keyboard-shortcuts",
    ],
  },
  {
    id: "intelligence",
    title: "Intelligence",
    items: ["model", "schedules", "privacy"],
  },
  {
    id: "workspace",
    title: "Workspace",
    items: ["integrations", "brand", "archive", "bookmarks", "devices"],
  },
  {
    id: "account",
    title: "Account",
    items: ["budget", "billing"],
  },
  {
    id: "developer",
    title: "Developer",
    items: ["assistant-debug", "advanced", "developer"],
  },
] as const satisfies readonly SettingsSectionModel[];

type SectionedPanelId = (typeof SETTINGS_SECTIONS)[number]["items"][number];

/**
 * Compile-time exhaustiveness: if a `PanelId` is missing from every section
 * above, `Exclude<...>` is non-never and this assignment fails to typecheck.
 */
const _everyPanelIsSectioned: Exclude<PanelId, SectionedPanelId> extends never
  ? true
  : never = true;
void _everyPanelIsSectioned;

export interface SettingsSection {
  id: string;
  title: string;
  items: SidebarItem[];
}

/**
 * Project an already-filtered flat item list onto `SETTINGS_SECTIONS`.
 * Sections whose every item was filtered out are dropped, so callers never
 * render an empty heading.
 */
export function groupSidebarItems(items: SidebarItem[]): SettingsSection[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    items: section.items
      .map((id) => byId.get(id))
      .filter((item): item is SidebarItem => item !== undefined),
  })).filter((section) => section.items.length > 0);
}

const SETTINGS_TAB_ID_ALIASES: Record<string, PanelId> = {
  developer: "assistant-debug",
  debug: "assistant-debug",
  model: "model",
  privacy: "privacy",
};

function normalizeSettingsTabName(tab: string): string {
  return tab.trim().toLowerCase();
}

export function getSettingsRouteForClientTab(tab: string): string | null {
  const normalizedTab = normalizeSettingsTabName(tab);

  // Check aliases first so legacy native-client tab names (e.g. "Developer" → debug)
  // are not shadowed by newer sidebar items with the same label.
  const aliasedId = SETTINGS_TAB_ID_ALIASES[normalizedTab];
  if (aliasedId) {
    const aliasedItem = SETTINGS_SIDEBAR.find((item) => item.id === aliasedId);
    if (aliasedItem) {
      return aliasedItem.href;
    }
  }

  const matchingItem = SETTINGS_SIDEBAR.find(
    (item) =>
      normalizeSettingsTabName(item.label) === normalizedTab ||
      item.id === normalizedTab,
  );

  return matchingItem?.href ?? null;
}
