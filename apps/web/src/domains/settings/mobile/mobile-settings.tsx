/**
 * Mobile-v3 Settings (task #101) — the phone-native settings tree.
 *
 * `⋯ → Settings` (and the You footer) land on `/assistant/settings`, which
 * used to render the desktop `SidebarShell` layout on a phone. On mobile the
 * layout now renders this instead:
 *
 *   · Mv3SettingsIndex — a native grouped "Settings" list (You-cluster row
 *     grammar) at the settings root; rows push the leaf routes.
 *   · MOBILE_LEAF_PAGES — the touch-adapted v3 leafs (AI models, Privacy,
 *     Schedules, Voice, Sounds, Appearance) rendered INSTEAD of the desktop
 *     page component at their route (see `mobile-settings-leafs.tsx`).
 *   · Everything else (Integrations, Brand, Billing, Budget, Archive,
 *     Devices, Debug, Advanced, Notifications, schedule detail) keeps its
 *     existing page, wrapped in the v3 screen shell so the push flow +
 *     back chevron still hold.
 *
 * Desktop keeps `SidebarShell` byte-identical — `SettingsLayout` branches on
 * `useIsMobile()` before any desktop markup renders. mv3 foundation is
 * consumed read-only from `@/mobile-v3`.
 */
import { Outlet, useLocation, useNavigate } from "react-router";

import { handleLogout } from "@/lib/auth/handle-logout";
import { GlassCard } from "@/mobile-v3/glass-card";
import { rise } from "@/mobile-v3/mv3-kit";
import { Eyebrow, NavRow, YouScreen } from "@/mobile-v3/you/you-kit";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";
import {
  SETTINGS_SIDEBAR,
  type PanelId,
  type SidebarItem,
} from "@/utils/settings-navigation";

import { MOBILE_LEAF_PAGES } from "@/domains/settings/mobile/mobile-settings-leafs";
import { Mv3SettingsScreen } from "@/domains/settings/mobile/mobile-settings-kit";

// ---------------------------------------------------------------------------
// The grouped index screen.
// ---------------------------------------------------------------------------

/** Index grouping + per-row hue (You-cluster icon-tile grammar). */
const INDEX_GROUPS: ReadonlyArray<{
  eyebrow: string;
  ids: PanelId[];
}> = [
  {
    eyebrow: "Preferences",
    ids: ["assistant-status", "notifications", "sounds", "voice"],
  },
  {
    eyebrow: "Intelligence",
    ids: ["model", "schedules", "privacy"],
  },
  {
    eyebrow: "Workspace",
    ids: ["integrations", "brand", "budget", "billing", "archive", "devices"],
  },
  {
    eyebrow: "System",
    ids: ["keyboard-shortcuts", "assistant-debug", "advanced", "developer"],
  },
];

const ROW_HUES: Partial<Record<PanelId, string>> = {
  "assistant-status": "var(--mv3-violet, #A79FF0)",
  notifications: "var(--mv3-amber)",
  sounds: "var(--mv3-teal)",
  voice: "var(--mv3-green)",
  model: "var(--mv3-accent)",
  schedules: "var(--mv3-teal)",
  privacy: "var(--mv3-green)",
  integrations: "var(--mv3-accent)",
  brand: "var(--mv3-violet, #A79FF0)",
  budget: "var(--mv3-amber)",
  billing: "var(--mv3-amber)",
  archive: "var(--mv3-muted)",
  devices: "var(--mv3-muted)",
  "assistant-debug": "var(--mv3-muted)",
  advanced: "var(--mv3-muted)",
  developer: "var(--mv3-muted)",
};

/** Friendlier phone labels where the desktop sidebar label reads wide. */
const ROW_LABELS: Partial<Record<PanelId, string>> = {
  "assistant-status": "Appearance & general",
  model: "AI models",
  devices: "Self-hosted assistants",
  privacy: "Privacy & permissions",
};

export function Mv3SettingsIndex({
  items,
  showLogout,
}: {
  items: SidebarItem[];
  showLogout: boolean;
}) {
  const navigate = useNavigate();
  const byId = new Map(items.map((item) => [item.id, item]));

  const groups = INDEX_GROUPS.map((group) => ({
    ...group,
    rows: group.ids
      .map((id) => byId.get(id))
      .filter((item): item is SidebarItem => item !== undefined),
  })).filter((group) => group.rows.length > 0);

  let cardIndex = 0;

  return (
    <YouScreen
      tint="lavender"
      testId="mv3-settings"
      back={routes.channels}
      backLabel="You"
      title="Settings"
      sub="Everything Cue does, tuned here"
    >
      {groups.map((group) => {
        const delay = 0.1 + Math.min(cardIndex++, 3) * 0.13;
        return (
          <div key={group.eyebrow} style={rise(delay)}>
            <div style={{ padding: "4px 4px 8px" }}>
              <Eyebrow>{group.eyebrow}</Eyebrow>
            </div>
            <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
              {group.rows.map((item, i) => {
                const hue = ROW_HUES[item.id] ?? "var(--mv3-muted)";
                const Icon = item.icon;
                return (
                  <NavRow
                    key={item.id}
                    icon={<Icon size={15} strokeWidth={1.9} color={hue} />}
                    iconBg={`color-mix(in srgb, ${hue} 14%, transparent)`}
                    label={ROW_LABELS[item.id] ?? item.label}
                    isLast={i === group.rows.length - 1}
                    onPress={() => navigate(item.href)}
                  />
                );
              })}
            </GlassCard>
          </div>
        );
      })}

      {showLogout ? (
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.medium();
            void handleLogout(navigate);
          }}
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "#E5675B",
            background: "none",
            border: "none",
            padding: "12px 0",
            minHeight: 44,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Log out
        </button>
      ) : null}
    </YouScreen>
  );
}

// ---------------------------------------------------------------------------
// The mobile layout — index vs adapted leaf vs shell-wrapped desktop page.
// ---------------------------------------------------------------------------

export function MobileSettingsLayout({
  items,
  showLogout,
}: {
  items: SidebarItem[];
  showLogout: boolean;
}) {
  const { pathname } = useLocation();

  if (pathname === routes.settings.root) {
    return <Mv3SettingsIndex items={items} showLogout={showLogout} />;
  }

  const AdaptedLeaf = MOBILE_LEAF_PAGES[pathname];
  if (AdaptedLeaf) {
    return <AdaptedLeaf />;
  }

  // Not-yet-adapted leafs (and nested detail routes): keep the existing page
  // component, framed in the v3 shell so back/push still hold on a phone.
  const match = SETTINGS_SIDEBAR.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return (
    <Mv3SettingsScreen
      title={match ? (ROW_LABELS[match.id] ?? match.label) : "Settings"}
      testId="mv3-settings-passthrough"
    >
      {/* Desktop-styled panel content (design-library controls) inside the
          v3 push — functional on touch, full v3 adaptation pending. */}
      <div data-slot="mv3-settings-desktop-leaf" style={{ paddingBottom: 8 }}>
        <Outlet />
      </div>
    </Mv3SettingsScreen>
  );
}
