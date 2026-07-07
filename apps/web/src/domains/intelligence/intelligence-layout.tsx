import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { Typography, cn } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { routes } from "@/utils/routes";

interface IntelligenceTab {
  readonly label: string;
  readonly to: string;
}

const BASE_INTELLIGENCE_TABS: readonly IntelligenceTab[] = [
  { label: "Identity", to: routes.identity },
  // "Tools & Apps" = the MCP/SaaS connector catalog (route stays `/connectors`).
  // Renamed from "Connectors" so it no longer collides with the people/
  // reachability surfaces below.
  { label: "Tools & Apps", to: routes.connectors },
  // "Channels & Agents" = the merged reach overview (channel status) + A2A
  // agent pairing. The actual per-channel setup + invite flow lives in the
  // Connections workbench, which this surface deep-links into.
  { label: "Channels & Agents", to: routes.channels },
  // "Connections" = the channel/agent setup workbench (Slack/Telegram/phone/
  // email tokens + A2A invites). Lives under Intelligence; reached primarily
  // via "Channels & Agents". The primary-rail "Contacts" item points at the
  // relationship dossier (/assistant/people) instead.
  { label: "Connections", to: routes.contacts.root },
  { label: "Cue Live", to: routes.cueLive },
  { label: "Skills", to: routes.skills },
  { label: "Memory", to: routes.memory },
  { label: "Workspace", to: routes.workspace },
];

const PLUGINS_TAB: IntelligenceTab = {
  label: "Plugins",
  to: routes.plugins,
};

const MARKETPLACE_TAB: IntelligenceTab = {
  label: "Marketplace",
  to: routes.marketplace,
};

/**
 * Shared layout for the "About Assistant" pages (Identity, Skills,
 * Workspace, Contacts). Renders a heading + tab bar above an
 * `<Outlet />` for the active tab's content.
 *
 * Mounted as a pathless layout route in `routes.tsx` so the child
 * routes keep their existing URL paths (`/assistant/identity`, etc.)
 * while inheriting the shared chrome.
 *
 * @see https://reactrouter.com/start/framework/routing#layout-routes
 */
export function IntelligenceLayout() {
  const assistantName = useAssistantIdentityStore.use.name();
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();

  // On mobile the title moves out of the page body and into the shared top
  // bar — centered between the hamburger menu and the search icon — so the
  // tab row can rise directly beneath the header. Desktop keeps the in-body
  // <h1> and leaves the top-bar center empty.
  useEffect(() => {
    if (isMobile) {
      setTopBarCenter(
        <Typography
          variant="body-medium-default"
          className="truncate text-[var(--content-secondary)]"
        >
          About {assistantName || "Assistant"}
        </Typography>,
      );
    } else {
      setTopBarCenter(null);
    }
    return () => {
      setTopBarCenter(null);
    };
  }, [isMobile, assistantName, setTopBarCenter]);

  const marketplace = useAssistantFeatureFlagStore.use.marketplace();

  // Insert the Plugins tab between Identity and Skills when the
  // `external-plugins` flag is on. Gated on `hasHydrated` so we don't
  // flash the tab in/out — until the first /feature-flags response
  // lands, render the baseline tabs (Identity + Skills + Memories).
  // The PluginsPage route itself also waits for hydration before
  // deciding to redirect, so a deep-link to /assistant/plugins is safe.
  // The Marketplace tab slots in right after Skills under the same
  // hydration rule (its page also redirects when the flag is off).
  const tabs: readonly IntelligenceTab[] = (() => {
    let result: IntelligenceTab[] = [...BASE_INTELLIGENCE_TABS];
    if (hasHydrated && externalPlugins) {
      result = [result[0], PLUGINS_TAB, ...result.slice(1)];
    }
    if (hasHydrated && marketplace) {
      const skillsIndex = result.findIndex((tab) => tab.to === routes.skills);
      result.splice(skillsIndex + 1, 0, MARKETPLACE_TAB);
    }
    return result;
  })();

  // Tabs whose mobile rendering is a full-bleed designed surface that paints
  // its own background + padding (the "You" screen on Channels & Agents, the
  // Memory surface). For those the outlet wrapper drops its mobile padding so
  // the surface reaches the viewport edges; every other tab keeps a standard
  // gutter.
  const isFullBleedMobileTab =
    isMobile &&
    [routes.channels, routes.memory].some(
      (to) => pathname === to || pathname.startsWith(to + "/"),
    );

  return (
    // On mobile the shell goes edge-to-edge (no padding): the tab strip and
    // the outlet wrapper below own their gutters so full-bleed tabs can fill
    // the viewport width instead of floating inside a padded panel.
    <PageShell className="max-md:px-0 max-md:py-0">
      <h1 className="mb-4 shrink-0 text-title-large text-[var(--content-default)] max-md:hidden">
        About {assistantName || "Assistant"}
      </h1>

      <nav
        className="mb-4 flex shrink-0 items-center overflow-x-auto border-b border-[var(--border-base)] max-md:mb-0 max-md:px-2"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
        aria-label="About assistant sections"
      >
        {tabs.map(({ label, to }) => {
          const isActive = pathname === to || pathname.startsWith(to + "/");
          return (
            <NavLink
              key={to}
              to={to}
              className={cn(
                "relative -mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent bg-transparent px-2.5 py-[7px]",
                "text-body-medium-default whitespace-nowrap",
                "text-[var(--content-secondary)] transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-0",
                "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
                isActive &&
                  "border-[var(--border-active)] text-[var(--primary-active)]",
                isActive && "hover:bg-transparent",
              )}
            >
              {label}
            </NavLink>
          );
        })}
      </nav>

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          !isFullBleedMobileTab && "max-md:px-4 max-md:py-3",
        )}
      >
        <Outlet />
      </div>
    </PageShell>
  );
}
