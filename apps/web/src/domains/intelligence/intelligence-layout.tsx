import { useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { Typography, cn } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import {
  YOUR_CUE_GROUPS,
  activeYourCueLeaf,
  panelsForPath,
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
 * ## A left column, not two rows on top
 *
 * The shipped build put the six group names across the top and a *second*
 * horizontal row of leaves beneath them — the owner's words were "top down
 * with second / third nav". Design (v19 frame N3, and §3 of the final brief)
 * draws **left-hand tabs, grouped by the question each answers**:
 *
 *   WHO CUE IS              Identity · Brand
 *   WHO WORKS FOR YOU       Agents · Skills · Plugins · Marketplace · Connectors
 *   HOW CUE REACHES YOU     Channels · Agent network · Cue Live
 *   WHAT CUE KNOWS & SEES   Memory · Watching
 *   WHAT IT DOES ALONE      Schedules · Automations · Guardrails · System access
 *   RUNNING CUE             Models · Usage & spend · Workspace · Preferences
 *
 * This is not a style preference. Stacked horizontal rows cost two lines of
 * chrome above every one of eighteen surfaces, put the group and the leaf on
 * different axes, and — the reason it kept mattering — hid every leaf of every
 * group you were not currently in. A column shows all eighteen at once, which
 * is the point of collapsing two navigations into one destination.
 *
 * The grouping and the URLs are unchanged: this moves where the model is
 * drawn, not what it says.
 *
 * ## Sub-rows
 *
 * Two leaves have a second level, rendered indented beneath them and only while
 * you are inside them (`panelsForPath`):
 *
 *   · **Preferences** — the nine "set once" panels (Notifications, Sounds,
 *     Voice, Keyboard, Self-hosted, Billing, Archive, developer).
 *   · **Memory** — People, design's interim home for the relationship surface.
 *
 * Neither is a second nav path: in both cases the leaf itself is the first tab,
 * and no sub-row is reachable from anywhere else.
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

  // The sub-rows for whichever leaf owns this path — Preferences' nine panels
  // or Memory's People tab — filtered by developer mode. One mechanism for
  // both, so the next leaf that grows a second level costs an array rather
  // than another branch here.
  const panels = panelsForPath(pathname).filter(
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

      {/*
        DESKTOP: the column on the left, the surface on the right.

        `min-h-0` on the row and on both children is load-bearing — without it
        the flex children take their content height and the page grows a second
        scrollbar instead of scrolling the column and the surface separately.
      */}
      <div className="flex min-h-0 flex-1 gap-6 max-md:gap-0">
        {isMobile ? null : (
          <nav
            aria-label="Your Cue"
            className="w-[200px] shrink-0 overflow-y-auto border-r border-[var(--border-base)] pr-3"
          >
            {groups.map((group) => (
              <div key={group.key} className="mb-4 last:mb-0">
                {/* The question the leaves under it answer. A heading, not a
                    control: clicking a group used to navigate to its first
                    leaf, which is a second way to reach a page that is already
                    one row below. */}
                <h2 className="px-2 pb-1 text-body-small-default uppercase tracking-[0.06em] text-[var(--content-secondary)]">
                  {group.title}
                </h2>
                <div className="flex flex-col gap-[1px]">
                  {group.leaves.map((leaf) => (
                    <LeafRow
                      key={leaf.key}
                      leaf={leaf}
                      pathname={pathname}
                      panels={activeLeaf?.key === leaf.key ? panels : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
          </nav>
        )}

        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto",
            !isFullBleedMobileTab && !isSelfCanvas && "max-md:px-4 max-md:py-3",
          )}
        >
          <Outlet />
        </div>
      </div>
    </PageShell>
  );
}

/**
 * One leaf in the left column, plus its sub-rows when it is the active one.
 *
 * A leaf with `to: null` renders disabled and says why — the honest state for
 * Watching, which v17 specifies and nothing implements. It carries a `⊘` glyph
 * rather than relying on a dimmed tint, and the active row carries a `▸`,
 * because no state in this app is allowed to be colour-only.
 */
function LeafRow({
  leaf,
  pathname,
  panels,
}: {
  leaf: YourCueLeaf;
  pathname: string;
  /** The leaf's second level, when this is the leaf you are inside. */
  panels?: readonly { key: string; label: string; to: string }[];
}) {
  const base =
    "flex w-full items-center gap-1.5 rounded-[6px] px-2 py-[6px] text-left text-body-medium-default transition-colors outline-none";

  if (leaf.to === null) {
    return (
      <span
        aria-disabled="true"
        title={leaf.unavailableReason}
        className={cn(base, "cursor-default text-[var(--content-secondary)]")}
      >
        <span aria-hidden>⊘</span>
        <span className="min-w-0 flex-1 truncate">{leaf.label}</span>
        <span className="sr-only"> — {leaf.unavailableReason}</span>
      </span>
    );
  }

  const isActive = leaf.match(pathname);
  // A sub-row can be the page while its leaf is merely the section you are in.
  // Only the deepest match claims `aria-current="page"` — two "current page"
  // markers in one column is noise a screen reader has to disambiguate.
  const panelIsPage = (panels ?? []).some(
    (panel) => pathname === panel.to || pathname.startsWith(panel.to + "/"),
  );
  return (
    <>
      <NavLink
        to={leaf.to}
        data-active={isActive ? "true" : undefined}
        aria-current={isActive ? (panelIsPage ? "true" : "page") : undefined}
        className={cn(
          base,
          "cursor-pointer text-[var(--content-secondary)]",
          "focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
          isActive &&
            "bg-[var(--surface-active)] font-medium text-[var(--content-emphasised)]",
        )}
      >
        <span
          aria-hidden
          className={cn("w-[8px] shrink-0", !isActive && "opacity-0")}
        >
          ▸
        </span>
        <span className="min-w-0 flex-1 truncate">{leaf.label}</span>
      </NavLink>
      {panels && panels.length > 0 ? (
        <div
          role="group"
          aria-label={`${leaf.label} panels`}
          className="mb-1 flex flex-col gap-[1px]"
        >
          {panels.map(({ key, label, to }) => {
            const subActive = pathname === to || pathname.startsWith(to + "/");
            return (
              <NavLink
                key={key}
                to={to}
                aria-current={subActive ? "page" : undefined}
                className={cn(
                  // Indented, and quieter by SIZE rather than by contrast —
                  // `--content-secondary` clears 4.5:1 on this ground.
                  "flex items-center gap-1.5 rounded-[6px] py-[4px] pl-[26px] pr-2",
                  "text-body-small-default text-[var(--content-secondary)] transition-colors",
                  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
                  subActive &&
                    "bg-[var(--surface-hover)] font-medium text-[var(--content-default)]",
                )}
              >
                <span
                  aria-hidden
                  className={cn("w-[6px] shrink-0", !subActive && "opacity-0")}
                >
                  ·
                </span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </NavLink>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
