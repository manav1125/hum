import { LogOut } from "lucide-react";
import { useMemo } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { hideVendorUi, useManagedMode } from "@/assistant/use-managed-mode";
import { MobileSettingsLayout } from "@/domains/settings/mobile/mobile-settings";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { handleLogout } from "@/lib/auth/handle-logout";
import { isLocalMode } from "@/lib/local-mode";
import { isSelfHostMode } from "@/lib/self-hosted/cue-self-host";
import { isElectron } from "@/runtime/is-electron";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import {
  DEVELOPER_PANEL_IDS,
  groupSidebarItems,
  SETTINGS_SIDEBAR,
} from "@/utils/settings-navigation";
import { SettingsSidebar } from "@/domains/settings/components/settings-sidebar";
import { SidebarShell } from "@/components/sidebar-shell";
import { type SidebarItem } from "@/components/sidebar-tree";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SidebarShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 */
export function SettingsLayout() {
  const settingsDeveloperNav =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const platformNotifications =
    useClientFeatureFlagStore.use.platformNotifications();
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingGate = usePlatformGate();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // Hide logout in pure local mode unless there's a session to end. A local
  // daemon has no credential to sign out of, so the control would be a no-op —
  // but a self-host instance very much does (the durable `actor_client_v1`
  // token), and it was being hidden because a self-host build leaves
  // VITE_PLATFORM_MODE unset and so reads as "local". That left a shared laptop
  // with no way to end the session at all.
  const hasPlatformSession = useHasPlatformSession();
  const showLogout = !isLocalMode() || hasPlatformSession || isSelfHostMode();
  const managed = useManagedMode();

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        // Managed (Cue-hosted) instances never expose the BYO Models &
        // Services page — provider keys and model plumbing are provisioned
        // by HQ. Hidden until self-host is *confirmed* (see use-managed-mode
        // flash policy).
        if (item.id === "model" && hideVendorUi(managed)) {
          return false;
        }
        if (
          item.id === "notifications" &&
          (!platformNotifications || platformGate === "gated")
        ) {
          return false;
        }
        if (item.id === "billing" && billingGate !== "full") {
          return false;
        }
        if (item.id === "devices" && platformGate === "gated") {
          return false;
        }
        // Hotkey rebinding drives Electron globalShortcut + menu accelerators,
        // which have no web/iOS analogue. Hide the entry off the desktop app;
        // the page itself also redirects as defense in depth.
        if (item.id === "keyboard-shortcuts" && !isElectron()) {
          return false;
        }
        // Debug / Advanced / Developer are engineering surfaces, not user
        // settings. They stay off every nav until developer mode is unlocked
        // (7 taps on the version value in General), which flips the
        // `settings-developer-nav` assistant flag. Their routes stay mounted,
        // so they remain URL-reachable for the owner either way.
        if (DEVELOPER_PANEL_IDS.has(item.id) && !settingsDeveloperNav) {
          return false;
        }
        return true;
      }),
    [
      platformNotifications,
      platformGate,
      billingGate,
      managed,
      settingsDeveloperNav,
    ],
  );

  const sections = useMemo(
    () => groupSidebarItems(filteredItems),
    [filteredItems],
  );

  const bottomItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = [];
    // Log Out is pinned to the very bottom of the nav as an action item.
    if (showLogout) {
      items.push({
        id: "logout",
        label: "Log Out",
        icon: LogOut,
        onSelect: () => void handleLogout(navigate),
      });
    }
    return items;
  }, [showLogout, navigate]);

  const pageTitle = useMemo(() => {
    if (pathname === routes.settings.root) return "Settings";
    const match = SETTINGS_SIDEBAR.find(
      (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) return match.label;
    return "Settings";
  }, [pathname]);

  // MOBILE (task #101): the phone gets the native v3 settings tree — a
  // grouped index at the root plus touch-adapted / shell-wrapped leafs —
  // instead of the desktop SidebarShell. Branch after every hook so the
  // hook count never changes across a breakpoint flip; desktop markup
  // below stays byte-identical.
  if (isMobile) {
    return (
      <MobileSettingsLayout items={filteredItems} showLogout={showLogout} />
    );
  }

  return (
    <SidebarShell
      backHref={routes.assistant}
      sidebar={
        <SettingsSidebar
          sections={sections}
          bottomItems={bottomItems}
          indexPath={routes.settings.root}
        />
      }
      title={pageTitle}
    >
      <Outlet />
    </SidebarShell>
  );
}
