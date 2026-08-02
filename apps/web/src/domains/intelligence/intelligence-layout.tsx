import { useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { Typography, cn } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import {
  YOUR_CUE_GROUPS,
  YOUR_CUE_SUBLEAVES,
  activeYourCueLeaf,
  isPreferencesPath,
  type YourCueGroup,
  type YourCueLeaf,
} from "@/components/nav/your-cue-model";
import { PageShell } from "@/components/page-shell";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * **Your Cue** — the one configuration shell.
 *
 * Renamed from Intelligence, which named the machinery rather than the thing
 * you came to change. It now absorbs Settings: the `/assistant/settings/*`
 * subtree is mounted as children of this layout (see `routes.tsx`), so the
 * eleven panels that used to live behind their own SidebarShell render here,
 * with this strip above them, at unchanged URLs.
 *
 * ## Two rows, not eighteen tabs
 *
 * The strip is the same mechanism it always was — the base design asked me not
 * to rebuild — but eighteen leaves laid end to end is a horizontal scroll nobody
 * can scan. So the strip is grouped: a row of the six questions, then the
 * leaves of whichever one you are inside. Deep links are unaffected, because
 * the active group is *derived* from the active leaf rather than selected: you
 * never pay the second click unless you are browsing.
 *
 *   Who Cue is · Who works for you · How Cue reaches you · What Cue knows &
 *   sees · What it does alone · Running Cue
 *
 * A third row appears under Preferences alone, carrying the panels that are
 * genuinely "set once" (Notifications, Sounds, Voice, Keyboard, Self-hosted,
 * Billing, Archive, and the developer panels). It is not a second nav path:
 * none of those rows exists anywhere else.
 *
 * ## Every leaf, same shell
 *
 * Agents and Guardrails were the two outliers — both opened in their own
 * container. They are children of this layout now. Both paint their own canvas
 * (background, max-width, serif heading), so they are exempted from the outlet
 * wrapper's padding rather than being wrapped twice; see
 * {@link SELF_CANVAS_PATHS}.
 *
 * Mounted as a pathless layout route so the child routes keep their existing
 * URL paths.
 *
 * @see https://reactrouter.com/start/framework/routing#layout-routes
 */

/**
 * Surfaces that paint their own full canvas — background, max-width, padding
 * and heading. The outlet wrapper stands its padding down for these so the
 * page is not inset inside a second frame.
 *
 * This is the concrete fix for "Agents opens in its own container": the answer
 * was never to restyle the page, it was to stop the shell from double-wrapping
 * one.
 */
const SELF_CANVAS_PATHS: readonly string[] = [
  routes.hqAgents,
  routes.guardrails,
  routes.connectors,
  routes.agentNetwork,
];

export function IntelligenceLayout() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();
  const marketplace = useAssistantFeatureFlagStore.use.marketplace();
  const settingsDeveloperNav =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const { pathname } = useLocation();
  const isMobile = useMobileLayout();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const navigate = useNavigate();

  // Flag-gated leaves are hidden until the first /feature-flags response lands
  // rather than flashing in and out. Each gated page also self-redirects when
  // its flag is off, so a deep link is safe either way.
  const groups: readonly YourCueGroup[] = YOUR_CUE_GROUPS.map((group) => ({
    ...group,
    leaves: group.leaves.filter((leaf) => {
      if (!leaf.flag) return true;
      if (!hasHydrated) return false;
      return leaf.flag === "externalPlugins" ? externalPlugins : marketplace;
    }),
  })).filter((group) => group.leaves.length > 0);

  const activeLeaf = activeYourCueLeaf(pathname);
  const activeGroup =
    groups.find((group) =>
      group.leaves.some((leaf) => leaf.key === activeLeaf?.key),
    ) ?? groups[0];

  const showPreferenceRow = isPreferencesPath(pathname);
  const subLeaves = YOUR_CUE_SUBLEAVES.filter(
    (sub) => !sub.developerOnly || settingsDeveloperNav,
  );

  // Tabs whose mobile rendering is a full-bleed designed surface that paints
  // its own background + padding (the mobile-v3 You cluster). For those the
  // outlet wrapper drops its mobile padding so the surface reaches the viewport
  // edges — and the strip + top-bar title stand down too: the v3 screens carry
  // their own `‹ You` navigation, and the siblings stay reachable through the
  // You screen's quiet footer links.
  //
  // Every `/assistant/settings/*` path is in this set as well, and that is
  // load-bearing rather than incidental: on a phone those routes render
  // `MobileSettingsLayout`, which supplies its own header and back row. Letting
  // this strip render above it would stack two navigations on one screen.
  const isFullBleedMobileTab =
    isMobile &&
    (pathname.startsWith(routes.settings.root) ||
      [
        routes.channels,
        routes.memory,
        routes.connectors,
        routes.skills,
        routes.identity,
        routes.contacts.root,
        routes.workspace,
        routes.guardrails,
        routes.hqAgents,
        routes.agentNetwork,
      ].some((to) => pathname === to || pathname.startsWith(to + "/")));

  const isSelfCanvas = SELF_CANVAS_PATHS.some(
    (to) => pathname === to || pathname.startsWith(to + "/"),
  );

  // Mobile section identity lives in the v3 back row below ("‹ You" + the
  // section title), so the shared top-bar center stays empty everywhere —
  // desktop keeps the in-body <h1>.
  useEffect(() => {
    setTopBarCenter(null);
    return () => {
      setTopBarCenter(null);
    };
  }, [setTopBarCenter]);

  return (
    // On mobile the shell goes edge-to-edge (no padding): the strip and the
    // outlet wrapper below own their gutters so full-bleed tabs can fill the
    // viewport width instead of floating inside a padded panel.
    <PageShell className="max-md:px-0 max-md:py-0">
      {/* Hidden via the JS gate, not `max-md:hidden`: the phone branch below
          is platform-guarded, so a CSS-only width test would hide the title in
          a narrow Electron window that never gets the `‹ You` row. */}
      <h1
        className={cn(
          "mb-4 shrink-0 text-title-large text-[var(--content-default)]",
          (isMobile || isSelfCanvas) && "hidden",
        )}
      >
        Your Cue
      </h1>

      {/* MOBILE: the desktop strip never renders on a phone — the
          non-full-bleed leaves get a v3-grammar back row instead: `‹ You` +
          the section title. */}
      {isMobile && !isFullBleedMobileTab ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-2 pb-1 md:hidden"
          style={{
            paddingTop:
              "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
          }}
        >
          <button
            type="button"
            onClick={() => navigate(routes.channels)}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1 border-none bg-transparent px-2 text-body-medium-default text-[var(--content-secondary)]"
            aria-label="Back to You"
          >
            ‹ You
          </button>
          <Typography
            variant="body-medium-default"
            className="truncate text-[var(--content-default)]"
          >
            {activeLeaf?.label ?? "Your Cue"}
          </Typography>
        </div>
      ) : null}

      {isMobile ? null : (
        <div className="mb-4 flex shrink-0 flex-col max-md:mb-0">
          {/* Row 1 — the six questions. */}
          <nav
            className="flex items-center gap-1 overflow-x-auto"
            style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
            aria-label="Your Cue groups"
          >
            {groups.map((group) => {
              const isActive = group.key === activeGroup?.key;
              const first = group.leaves.find((leaf) => leaf.to !== null);
              return (
                <button
                  key={group.key}
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => {
                    if (first?.to) navigate(first.to);
                  }}
                  className={cn(
                    "cursor-pointer whitespace-nowrap rounded-[6px] border-none bg-transparent px-2.5 py-1.5",
                    "text-body-small-default uppercase tracking-[0.06em]",
                    // Recede by weight, never by contrast: the inactive groups
                    // sit on `--content-secondary`, which clears 4.5:1 on this
                    // ground. Nothing here is distinguished by colour alone —
                    // the active group also carries the ▸ leaf row beneath it.
                    "text-[var(--content-secondary)] transition-colors",
                    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                    "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
                    isActive &&
                      "bg-[var(--surface-hover)] font-medium text-[var(--content-default)]",
                  )}
                >
                  {group.title}
                </button>
              );
            })}
          </nav>

          {/* Row 2 — the active group's leaves. */}
          <nav
            className="-mb-px flex items-center overflow-x-auto border-b border-[var(--border-base)]"
            style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
            aria-label={`${activeGroup?.title ?? "Your Cue"} sections`}
          >
            {(activeGroup?.leaves ?? []).map((leaf) => (
              <LeafTab key={leaf.key} leaf={leaf} pathname={pathname} />
            ))}
          </nav>

          {/* Row 3 — Preferences only. */}
          {showPreferenceRow ? (
            <nav
              className="flex items-center gap-1 overflow-x-auto pt-2"
              style={{
                scrollbarWidth: "none",
                WebkitOverflowScrolling: "touch",
              }}
              aria-label="Preferences panels"
            >
              {subLeaves.map(({ key, label, to }) => {
                const isActive =
                  pathname === to || pathname.startsWith(to + "/");
                return (
                  <NavLink
                    key={key}
                    to={to}
                    className={cn(
                      "cursor-pointer whitespace-nowrap rounded-[6px] px-2 py-1",
                      "text-body-small-default text-[var(--content-secondary)] transition-colors",
                      "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                      "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
                      isActive &&
                        "bg-[var(--surface-hover)] font-medium text-[var(--content-default)]",
                    )}
                  >
                    {label}
                  </NavLink>
                );
              })}
            </nav>
          ) : null}
        </div>
      )}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          !isFullBleedMobileTab && !isSelfCanvas && "max-md:px-4 max-md:py-3",
        )}
      >
        <Outlet />
      </div>
    </PageShell>
  );
}

/**
 * One leaf in the strip.
 *
 * A leaf with `to: null` renders disabled and says why. That is the honest
 * state for Watching, which v17 specifies and nothing implements — and it
 * carries a `⊘` glyph rather than relying on the dimmed tint, because no state
 * in this app is allowed to be colour-only.
 */
function LeafTab({ leaf, pathname }: { leaf: YourCueLeaf; pathname: string }) {
  const base =
    "relative -mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent bg-transparent px-2.5 py-[7px] text-body-medium-default whitespace-nowrap transition-colors outline-none";

  if (leaf.to === null) {
    return (
      <span
        aria-disabled="true"
        title={leaf.unavailableReason}
        className={cn(base, "cursor-default text-[var(--content-secondary)]")}
      >
        <span aria-hidden>⊘</span>
        {leaf.label}
        <span className="sr-only"> — {leaf.unavailableReason}</span>
      </span>
    );
  }

  const isActive = leaf.match(pathname);
  return (
    <NavLink
      to={leaf.to}
      className={cn(
        base,
        "cursor-pointer text-[var(--content-secondary)]",
        "focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        isActive &&
          "border-[var(--border-active)] font-medium text-[var(--primary-active)] hover:bg-transparent",
      )}
    >
      {leaf.label}
    </NavLink>
  );
}
