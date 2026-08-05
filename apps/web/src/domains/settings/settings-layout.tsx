import { LogOut } from "lucide-react";
import { useMemo } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { hideVendorUi, useManagedMode } from "@/assistant/use-managed-mode";
import { MobileSettingsLayout } from "@/domains/settings/mobile/mobile-settings";
import { useMobileLayout } from "@/hooks/use-is-mobile";
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
  SETTINGS_SIDEBAR,
} from "@/utils/settings-navigation";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * **Desktop: this is now a pass-through.** Settings was absorbed into Your Cue
 * — the subtree is mounted under `IntelligenceLayout`, which supplies the leaf
 * strip and the Preferences sub-row — so the SidebarShell that used to wrap
 * these pages would be a second navigation inside the first. Six of these
 * panels are Your Cue leaves in their own right (Models · Brand · Schedules ·
 * System access · Usage & spend) and the rest hang off Preferences; either
 * way, the row that gets you there is above, not beside.
 *
 * **Mobile is unchanged.** The phone still gets `MobileSettingsLayout` — the
 * native v3 settings tree, a grouped index plus touch-adapted leaves. That
 * surface follows the mobile-v3 spec, which this round did not review, and it
 * carries its own header and back row (which is why `IntelligenceLayout`
 * stands its own chrome down for every `/assistant/settings/*` path on a
 * phone).
 *
 * The filtering below still runs on both platforms: `filteredItems` feeds the
 * phone's index, and the gates it applies — managed-mode, platform, billing,
 * Electron-only, developer-mode — are policy, not chrome.
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
  const isMobile = useMobileLayout();
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

  // Desktop: Your Cue's strip is the navigation. Render the page and a quiet
  // title, nothing else — a second sidebar here would be the duplication this
  // round removed, drawn one level deeper.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <h2 className="shrink-0 text-title-small text-[var(--content-default)]">
        {pageTitle}
      </h2>
      {/*
        `overflow-y-auto` is load-bearing, not cosmetic. `flex-1 min-h-0`
        without it lets the page's content paint past the bottom of its own
        box, and the Log Out block below is pinned to where that box ends — so
        on a long page (General, once Timezone and Media Embeds are there) Log
        Out rendered *through* the Timezone card, sitting between its
        description and its city picker as though it belonged to it. The
        scroll belongs to this region so the footer stays a footer.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>

      {/*
        Log Out used to be pinned to the bottom of the settings sidebar. That
        sidebar is gone, and it was the ONLY desktop control that ends a
        session — removing it silently would have left a shared laptop with no
        way to sign out. It lands on General, which is where you go to change
        who this machine belongs to.
      */}
      {showLogout && pathname === routes.settings.general ? (
        <div className="shrink-0 border-t border-[var(--border-base)] pt-4">
          <button
            type="button"
            onClick={() => void handleLogout(navigate)}
            className="inline-flex cursor-pointer items-center gap-2 rounded-[6px] border-none bg-transparent px-2 py-1.5 text-body-medium-default text-[var(--content-secondary)] outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <LogOut size={14} aria-hidden />
            Log Out
          </button>
        </div>
      ) : null}
    </div>
  );
}
