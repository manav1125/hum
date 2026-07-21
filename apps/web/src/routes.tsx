import {
  createBrowserRouter,
  Navigate,
  useParams,
  useSearchParams,
} from "react-router";

import { authMiddleware } from "@/lib/auth/auth-middleware";
import {
  localModeOnlyMiddleware,
  onboardingCompletedMiddleware,
} from "@/lib/onboarding-middleware";
import { RootLayout } from "@/root-layout";
import { AccountLayout } from "@/domains/account/account-layout";
import { NotFound } from "@/components/not-found";
import type { PrefetchableSurface } from "@/lib/route-prefetch";
import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { RootHydrateFallback } from "@/components/root-hydrate-fallback";
import { ActiveAssistantGate } from "@/components/layout/active-assistant-gate";
import { routes } from "@/utils/routes";

/**
 * Redirects legacy `/account/oauth/desktop-complete` to the canonical
 * `/account/oauth/complete`, preserving all query parameters. Older macOS
 * and iOS Capacitor builds have the old path baked in.
 */
function OAuthDesktopCompleteRedirect() {
  const [searchParams] = useSearchParams();
  const qs = searchParams.toString();
  return (
    <Navigate
      to={`${routes.account.oauth.complete}${qs ? `?${qs}` : ""}`}
      replace
    />
  );
}

/**
 * Redirects bare pre-app paths (`/onboarding/*`, `/welcome`, …) into their
 * `/assistant/*` homes. Externally-minted links (magic-link emails, older
 * builds) use the short paths; the gateway now serves the SPA shell for
 * them (see gateway `spa-shell-paths.ts`), and this component completes the
 * hop client-side. `/onboarding/welcome` maps onto the Welcome screen — the
 * funnel has no "welcome" step of its own.
 */
function OnboardingPathRedirect() {
  const params = useParams();
  const splat = params["*"] ?? "";
  const target =
    splat === "" || splat === "welcome"
      ? routes.welcome
      : `/assistant/onboarding/${splat}`;
  return <Navigate to={target} replace />;
}

/**
 * Fire-and-forget query prefetch for a main surface. React Router resolves
 * a route's static `loader` in parallel with its `lazy` component, so this
 * starts the surface's primary API reads while the route chunk is still
 * downloading — killing the chunk→data serial chain. Never blocks the
 * navigation: the prefetch module is itself dynamically imported and the
 * loader returns immediately. See `lib/route-prefetch.ts`.
 */
function surfaceLoader(surface: PrefetchableSurface) {
  return () => {
    void import("@/lib/route-prefetch").then((m) => m.prefetchRoute(surface));
    return null;
  };
}

// Route tree — no basename, routes are absolute browser paths.
// To view the full hierarchy at a glance:
//   grep -n 'path:' apps/web/src/routes.tsx
//
// Non-critical route groups use the object-based `lazy` property so Vite
// splits them into separate chunks that are fetched on first navigation.
// The router resolves each lazy property before transitioning, so the
// previous route stays visible while the new chunk downloads — no flash.
//
// References:
// - React Router data mode routing: https://reactrouter.com/start/data/routing
// - React Router route object: https://reactrouter.com/start/data/route-object
// - React Router lazy (data mode): https://reactrouter.com/start/data/custom#3-lazy-loading
// - React Router error boundaries: https://reactrouter.com/how-to/error-boundary
// - React Router middleware: https://reactrouter.com/how-to/middleware
// Exported separately from `router` so the route tree can be asserted in
// tests: `createBrowserRouter` consumes `Component`, so structural checks
// (e.g. "the OAuth popup pages are NOT under AccountLayout") must run against
// these raw definitions.
export const routeTree = [
  // Account routes — standalone auth pages, no app chrome.
  // Lazy-loaded: only needed for unauthenticated flows.
  {
    path: "/account",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    children: [
      // Pathless wrapper so lazy-chunk failures render the chunk-fail
      // variant of `RouteErrorBoundary` (inline copy + Reload button)
      // rather than the full-page variant inherited from the top.
      {
        ErrorBoundary: RouteErrorBoundary,
        children: [
          // Auth screens that render in the MAIN window. AccountLayout sizes
          // it compact (440×630) for these, matching onboarding.
          {
            Component: AccountLayout,
            children: [
              {
                index: true,
                lazy: {
                  Component: () =>
                    import("@/domains/account/pages/account-page").then(
                      (m) => m.AccountPage,
                    ),
                },
              },
              {
                path: "login",
                lazy: {
                  Component: () =>
                    import("@/domains/account/pages/login-page").then(
                      (m) => m.LoginPage,
                    ),
                },
              },
              {
                path: "signup",
                lazy: {
                  Component: () =>
                    import("@/domains/account/pages/signup-page").then(
                      (m) => m.SignupPage,
                    ),
                },
              },
              {
                path: "provider/callback",
                lazy: {
                  Component: () =>
                    import("@/domains/account/pages/provider-callback-page").then(
                      (m) => m.ProviderCallbackPage,
                    ),
                },
              },
              {
                path: "provider/signup",
                lazy: {
                  Component: () =>
                    import("@/domains/account/pages/provider-signup-page").then(
                      (m) => m.ProviderSignupPage,
                    ),
                },
              },
              {
                path: "password/reset",
                lazy: {
                  Component: () =>
                    import("@/domains/account/pages/password-reset-page").then(
                      (m) => m.PasswordResetPage,
                    ),
                },
              },
              {
                path: "password/reset/key/:key",
                lazy: {
                  Component: () =>
                    import("@/domains/account/pages/password-reset-page").then(
                      (m) => m.PasswordResetPage,
                    ),
                },
              },
            ],
          },
          // OAuth completion / loopback machinery. These render inside the
          // OAuth popup child window (or are transient redirects), NOT the
          // main window — so they're deliberately OUTSIDE AccountLayout and
          // never mount the sizing hook. The resize IPC targets the
          // module-scoped main window, so sizing from a popup would shrink
          // the wrong window. See `use-onboarding-window-size`.
          {
            path: "oauth/popup-complete",
            lazy: {
              Component: () =>
                import("@/domains/account/pages/oauth-popup-complete-page").then(
                  (m) => m.OAuthPopupCompletePage,
                ),
            },
          },
          {
            path: "oauth/complete",
            lazy: {
              Component: () =>
                import("@/domains/account/pages/oauth-complete-page").then(
                  (m) => m.OAuthCompletePage,
                ),
            },
          },
          {
            path: "oauth/desktop-complete",
            Component: OAuthDesktopCompleteRedirect,
          },
          {
            path: "platform-callback",
            lazy: {
              Component: () =>
                import("@/domains/account/pages/platform-loopback-page").then(
                  (m) => m.PlatformLoopbackPage,
                ),
            },
          },
        ],
      },
    ],
  },

  // Pre-app short paths — externally-minted links (magic-link emails, older
  // builds) land on `/onboarding/*` / `/welcome` / `/select-assistant` /
  // `/review-terms` without the `/assistant` prefix. The gateway serves the
  // SPA shell for these GET paths; the router completes the redirect into
  // the canonical `/assistant/*` homes.
  {
    path: "/onboarding/*",
    ErrorBoundary: RouteErrorBoundary,
    Component: OnboardingPathRedirect,
  },
  {
    path: "/welcome",
    ErrorBoundary: RouteErrorBoundary,
    element: <Navigate to={routes.welcome} replace />,
  },
  {
    path: "/select-assistant",
    ErrorBoundary: RouteErrorBoundary,
    element: <Navigate to={routes.selectAssistant} replace />,
  },
  {
    path: "/review-terms",
    ErrorBoundary: RouteErrorBoundary,
    element: <Navigate to={routes.reviewTerms} replace />,
  },

  // Logout — standalone page, no app chrome
  {
    path: "/logout",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    lazy: {
      Component: () =>
        import("@/domains/account/pages/logout-page").then((m) => m.LogoutPage),
    },
  },

  // About — standalone metadata page rendered inside the Electron
  // About BrowserWindow. Declared as a sibling of `/assistant` (not
  // a child) so React Router's most-specific matcher picks it for
  // `/assistant/about` BEFORE falling into the auth-protected app
  // tree below. URL sits under `/assistant/*` so it's served by
  // Vite's SPA fallback in dev (which is scoped to the `base`).
  {
    path: "/assistant/about",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    lazy: {
      Component: () =>
        import("@/components/about-page").then((m) => m.AboutPage),
    },
  },

  // Bundle confirmation — standalone page rendered inside the Electron
  // bundle-confirmation BrowserWindow. No auth required so bundles can
  // be opened before the user logs in. Same sibling pattern as About.
  {
    path: "/assistant/bundle/confirm",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    lazy: {
      Component: () =>
        import("@/pages/BundleConfirmPage").then((m) => m.BundleConfirmPage),
    },
  },

  // Quick Input — lightweight input panel rendered inside the Electron
  // quick input BrowserWindow (a frameless, always-on-top panel invoked
  // via Cmd+Shift+/). Same pattern as About: sibling of `/assistant`,
  // outside auth middleware and RootLayout for fast load.
  {
    path: "/assistant/quick-input",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    lazy: {
      Component: () =>
        import("@/components/quick-input-page").then((m) => m.QuickInputPage),
    },
  },

  // Command palette — focused floating Electron BrowserWindow opened by
  // the app menu's Cmd/Ctrl+K accelerator. Standalone and unauthenticated
  // so it does not depend on ChatLayout being mounted in the main window.
  {
    path: "/assistant/floating/command-palette",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    lazy: {
      Component: () =>
        import("@/components/command-palette/command-palette-window-page").then(
          (m) => m.CommandPaletteWindowPage,
        ),
    },
  },

  // Dictation overlay — live transcription pill rendered inside the
  // Electron dictation overlay BrowserWindow (a click-through floating
  // panel pinned top-center of the screen while push-to-talk dictation
  // is active). Same pattern as Quick Input: sibling of `/assistant`,
  // outside auth middleware and RootLayout for fast load.
  {
    path: "/assistant/floating/dictation-overlay",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    lazy: {
      Component: () =>
        import("@/components/dictation-overlay-page").then(
          (m) => m.DictationOverlayPage,
        ),
    },
  },
  // Legacy direct path retained so old dev windows do not blank during
  // rolling Electron/web updates.
  {
    path: "/assistant/dictation-overlay",
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    lazy: {
      Component: () =>
        import("@/components/dictation-overlay-page").then(
          (m) => m.DictationOverlayPage,
        ),
    },
  },

  // Assistant routes — auth-protected app with layout
  {
    path: "/assistant",
    middleware: [authMiddleware],
    ErrorBoundary: RouteErrorBoundary,
    HydrateFallback: RootHydrateFallback,
    Component: RootLayout,
    children: [
      // Pathless wrapper attaching `RouteErrorBoundary` at the layer
      // *inside* RootLayout. Any error from a child route (chunk-fetch
      // failure or genuine render bug) is caught here — React Router
      // doesn't support selective bubbling. The boundary picks a UI
      // variant based on the error shape:
      //   - chunk fail  → inline "section couldn't load" within
      //                   RootLayout's chrome (sidebar stays visible)
      //   - other error → full-page "Something went wrong" treatment
      //                   (full-viewport `min-h-svh` so it reads as a
      //                   takeover even when mounted inside chrome)
      // The outer boundary on `/assistant` only fires for errors that
      // happen *during* the resolution of `/assistant` itself (loader,
      // middleware, RootLayout render) — not for child-route errors.
      {
        ErrorBoundary: RouteErrorBoundary,
        children: [
          // Standalone pre-app routes (not part of the new-user onboarding funnel).
          {
            path: "welcome",
            lazy: {
              Component: () =>
                import("@/domains/onboarding/pages/welcome-screen").then(
                  (m) => m.WelcomeScreen,
                ),
            },
          },
          {
            path: "select-assistant",
            lazy: {
              Component: () =>
                import("@/domains/onboarding/pages/select-assistant-screen").then(
                  (m) => m.SelectAssistantScreen,
                ),
            },
          },
          {
            path: "review-terms",
            lazy: {
              Component: () =>
                import("@/domains/onboarding/pages/review-terms-screen").then(
                  (m) => m.ReviewTermsScreen,
                ),
            },
          },

          // Onboarding funnel — new-user setup flow (privacy → prechat → hatching).
          {
            middleware: [onboardingCompletedMiddleware],
            children: [
              {
                middleware: [localModeOnlyMiddleware],
                children: [
                  {
                    path: "onboarding/hosting",
                    lazy: {
                      Component: () =>
                        import("@/domains/onboarding/pages/hosting-screen").then(
                          (m) => m.HostingScreen,
                        ),
                    },
                  },
                  {
                    path: "onboarding/api-key",
                    lazy: {
                      Component: () =>
                        import("@/domains/onboarding/pages/api-key-screen").then(
                          (m) => m.ApiKeyScreen,
                        ),
                    },
                  },
                ],
              },
              {
                path: "onboarding/privacy",
                lazy: {
                  Component: () =>
                    import("@/domains/onboarding/pages/privacy-screen").then(
                      (m) => m.PrivacyScreen,
                    ),
                },
              },
              {
                path: "onboarding/prechat",
                lazy: {
                  Component: () =>
                    import("@/domains/onboarding/pages/pre-chat-flow").then(
                      (m) => m.PreChatFlow,
                    ),
                },
              },
              {
                path: "onboarding/hatching",
                lazy: {
                  Component: () =>
                    import("@/domains/onboarding/pages/hatching-screen").then(
                      (m) => m.HatchingScreen,
                    ),
                },
              },
            ],
          },

          // Settings and logs require a resolved assistant. The gate
          // defers child rendering until the lifecycle reaches active/
          // self_hosted, so route components can use useActiveAssistantId().
          {
            Component: ActiveAssistantGate,
            children: [
              // Settings routes — full-screen overlay panel (no ChatLayout sidebar).
              // SidebarShell provides its own layout with back-arrow, sidebar nav,
              // and content area — the main app sidebar is intentionally hidden.
              // Lazy-loaded: visited occasionally, heavy deps (Stripe, schedules, voice).
              {
                path: "settings",
                lazy: {
                  Component: () =>
                    import("@/domains/settings/settings-layout").then(
                      (m) => m.SettingsLayout,
                    ),
                },
                children: [
                  {
                    index: true,
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/general-page").then(
                          (m) => m.GeneralPage,
                        ),
                    },
                  },
                  {
                    path: "general",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/general-page").then(
                          (m) => m.GeneralPage,
                        ),
                    },
                  },
                  {
                    path: "ai",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/ai/ai-page").then(
                          (m) => m.AiPage,
                        ),
                    },
                  },
                  {
                    path: "integrations",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/integrations-page").then(
                          (m) => m.IntegrationsPage,
                        ),
                    },
                  },
                  {
                    // Settings → Brand — the Brand Kit surface (Create Studio
                    // SET 2). Owns its own area under `@/pages/brand-kit` and
                    // wires to the daemon `/brand-profiles` routes.
                    path: "brand",
                    lazy: {
                      Component: () =>
                        import("@/pages/brand-kit/brand-settings-page").then(
                          (m) => m.BrandSettingsPage,
                        ),
                    },
                  },
                  {
                    path: "schedules",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/schedules-page").then(
                          (m) => m.SchedulesPage,
                        ),
                    },
                  },
                  {
                    path: "schedules/:scheduleId",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/schedules-page").then(
                          (m) => m.SchedulesPage,
                        ),
                    },
                  },
                  {
                    path: "notifications",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/notifications-page").then(
                          (m) => m.NotificationsPage,
                        ),
                    },
                  },
                  {
                    path: "keyboard-shortcuts",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/keyboard-shortcuts/keyboard-shortcuts-page").then(
                          (m) => m.KeyboardShortcutsPage,
                        ),
                    },
                  },
                  {
                    path: "sounds",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/sounds-page").then(
                          (m) => m.SoundsPage,
                        ),
                    },
                  },
                  {
                    path: "voice",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/voice-page").then(
                          (m) => m.VoicePage,
                        ),
                    },
                  },
                  {
                    path: "devices",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/devices-page").then(
                          (m) => m.DevicesPage,
                        ),
                    },
                  },
                  {
                    path: "privacy",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/privacy-page").then(
                          (m) => m.PrivacyPage,
                        ),
                    },
                  },
                  {
                    path: "budget",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/budget-page").then(
                          (m) => m.BudgetPage,
                        ),
                    },
                  },
                  {
                    path: "archive",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/archive-page").then(
                          (m) => m.ArchivePage,
                        ),
                    },
                  },
                  {
                    path: "billing",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/billing/billing-page").then(
                          (m) => m.BillingPage,
                        ),
                    },
                  },
                  {
                    path: "billing/upgrade/cancel",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/billing/upgrade-cancel-page").then(
                          (m) => m.UpgradeCancelPage,
                        ),
                    },
                  },
                  {
                    path: "billing/upgrade/success",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/billing/upgrade-success-page").then(
                          (m) => m.UpgradeSuccessPage,
                        ),
                    },
                  },
                  {
                    path: "debug",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/debug-page").then(
                          (m) => m.DebugPage,
                        ),
                    },
                  },
                  {
                    path: "developer",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/developer-page").then(
                          (m) => m.DeveloperPage,
                        ),
                    },
                  },
                  {
                    path: "advanced",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/advanced-page").then(
                          (m) => m.AdvancedPage,
                        ),
                    },
                  },
                  {
                    path: "danger-zone",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/danger-zone-redirect-page").then(
                          (m) => m.DangerZoneRedirectPage,
                        ),
                    },
                  },
                  {
                    path: "system-events",
                    lazy: {
                      Component: () =>
                        import("@/domains/settings/pages/system-events-redirect-page").then(
                          (m) => m.SystemEventsRedirectPage,
                        ),
                    },
                  },
                ],
              },

              // Logs routes — full-screen overlay panel (like SettingsLayout).
              // LogsLayout reuses SidebarShell for visual consistency.
              // Lazy-loaded: analytics-only.
              {
                path: "logs",
                lazy: {
                  Component: () =>
                    import("@/domains/logs/logs-layout").then(
                      (m) => m.LogsLayout,
                    ),
                },
                children: [
                  {
                    index: true,
                    lazy: {
                      Component: () =>
                        import("@/domains/logs/pages/usage-page").then(
                          (m) => m.UsagePage,
                        ),
                    },
                  },
                  {
                    path: "trace",
                    lazy: {
                      Component: () =>
                        import("@/domains/logs/pages/trace-page").then(
                          (m) => m.TracePage,
                        ),
                    },
                  },
                  {
                    path: "usage",
                    lazy: {
                      Component: () =>
                        import("@/domains/logs/pages/usage-page").then(
                          (m) => m.UsagePage,
                        ),
                    },
                  },
                  {
                    path: "system-events",
                    lazy: {
                      Component: () =>
                        import("@/domains/logs/pages/system-events-page").then(
                          (m) => m.SystemEventsPage,
                        ),
                    },
                  },
                  {
                    path: "emails",
                    lazy: {
                      Component: () =>
                        import("@/domains/logs/pages/emails-page").then(
                          (m) => m.EmailsPage,
                        ),
                    },
                  },
                ],
              },
            ],
          },

          {
            // ChatLayout (and the chat domain behind it) was statically
            // imported, putting the entire chat transcript sub-tree in the
            // main chunk for every surface. Lazy like the sibling routes;
            // the loader warms the sidebar's conversation-list query in
            // parallel with the chunk download.
            lazy: {
              Component: () =>
                import("@/domains/chat/chat-layout").then((m) => m.ChatLayout),
            },
            loader: surfaceLoader("chats"),
            children: [
              // Inner pathless wrapper: catches every error from chat-side
              // routes (home, library, identity, inspector, etc.) one layer
              // deeper than the `/assistant` boundary so the chunk-fail UI
              // variant renders *inside* ChatLayout's chrome (sidebar stays
              // visible). Non-chunk render errors are caught here too —
              // `RouteErrorBoundary` shows the full-page variant in that
              // case (`min-h-svh`), which visually takes over the route
              // content area.
              {
                ErrorBoundary: RouteErrorBoundary,
                children: [
                  // ChatPage / DocumentViewerPage own their own lifecycle UI
                  // (loading screens, hatching, version-selection, errors) and
                  // must render in every assistant state — they are NOT placed
                  // under <ActiveAssistantGate>.
                  {
                    index: true,
                    lazy: {
                      Component: () =>
                        import("@/domains/chat/conversation-redirect").then(
                          (m) => m.ConversationRedirect,
                        ),
                    },
                  },
                  {
                    // Bare chats index (no id): the mobile v3 Chats screen
                    // (spec frame 21) — the ⋯ overflow's "Chats" destination.
                    // Desktop redirects to /assistant (the sidebar rail IS
                    // the index there); previously this URL 404'd.
                    path: "conversations",
                    lazy: {
                      Component: () =>
                        import("@/mobile-v3/chats/chats-index-page").then(
                          (m) => m.ChatsIndexPage,
                        ),
                    },
                  },
                  {
                    path: "conversations/:conversationId",
                    lazy: {
                      Component: () =>
                        import("@/domains/chat/chat-page").then(
                          (m) => m.ChatPage,
                        ),
                    },
                  },
                  {
                    path: "documents/:surfaceId",
                    lazy: {
                      Component: () =>
                        import("@/domains/chat/document-viewer-page").then(
                          (m) => m.DocumentViewerPage,
                        ),
                    },
                  },
                  // Everything below requires a resolved assistantId AND an
                  // active daemon. The gate defers child rendering until the
                  // lifecycle resolves so route components can rely on a
                  // non-null assistantId via useActiveAssistantId().
                  {
                    Component: ActiveAssistantGate,
                    children: [
                      {
                        // Home retired into HQ ("Home grew up. There's one
                        // landing surface now." — Cue-HQ-Build §1). Every
                        // old-Home module has a home on the HQ deck (Your Next
                        // Move · Queued & scheduled · Watching · Done today),
                        // so /home redirects like the other legacy landing
                        // surfaces. The Command Center page component stays
                        // importable (HQ reuses its next-move hook) but is no
                        // longer routed.
                        path: "home",
                        element: <Navigate to={routes.hq} replace />,
                      },
                      {
                        // HQ — THE landing surface: rings hero + the folded
                        // Home modules (next move · queued & scheduled ·
                        // watching · done today) + agents-at-work.
                        path: "hq",
                        loader: surfaceLoader("hq"),
                        lazy: {
                          Component: () =>
                            import("@/pages/hq/hq-page").then((m) => m.HqPage),
                        },
                      },
                      {
                        // HQ first-run setup — the Step-0 fork + five-step
                        // founding flow. MUST precede `hq/:id` so "setup"
                        // isn't captured as a mission id.
                        path: "hq/setup",
                        lazy: {
                          Component: () =>
                            import("@/pages/hq-onboarding/setup-page").then(
                              (m) => m.HqSetupPage,
                            ),
                        },
                      },
                      {
                        // Agents · the org — the roster/org-chart surface.
                        // MUST precede `hq/:id` so "agents" isn't captured as
                        // a mission id.
                        path: "hq/agents",
                        lazy: {
                          Component: () =>
                            import("@/pages/hq-agents/agents-org-page").then(
                              (m) => m.AgentsOrgPage,
                            ),
                        },
                      },
                      // -- Mobile v3 surfaces (docs/design/mobile-v3/) -------
                      // Registered here centrally; the cluster builds own the
                      // page modules under src/mobile-v3/ and never edit this
                      // file. Paths mirror utils/routes.ts.
                      {
                        // Morning Brief — the 7:30 three-beat ritual (frame 5).
                        path: "brief",
                        lazy: {
                          Component: () =>
                            import("@/mobile-v3/brief/brief-page").then(
                              (m) => m.BriefPage,
                            ),
                        },
                      },
                      {
                        // Came in today — swipe triage (frame 15).
                        path: "came-in",
                        lazy: {
                          Component: () =>
                            import("@/mobile-v3/triage/came-in-page").then(
                              (m) => m.CameInPage,
                            ),
                        },
                      },
                      {
                        // Watch live — running work-item step stream (frame 17).
                        path: "work/:workItemId/live",
                        lazy: {
                          Component: () =>
                            import("@/mobile-v3/watch/watch-live-page").then(
                              (m) => m.WatchLivePage,
                            ),
                        },
                      },
                      {
                        // Review pager — full-bleed deliverable queue (frame 16).
                        path: "review-queue",
                        lazy: {
                          Component: () =>
                            import("@/mobile-v3/review/review-queue-page").then(
                              (m) => m.ReviewQueuePage,
                            ),
                        },
                      },
                      {
                        // Review index — round-4 frame 55 list → seeded pager.
                        path: "review-queue/list",
                        lazy: {
                          Component: () =>
                            import("@/mobile-v3/review/review-index-page").then(
                              (m) => m.ReviewIndexPage,
                            ),
                        },
                      },
                      {
                        // Brand kit (frame 19).
                        path: "brand",
                        lazy: {
                          Component: () =>
                            import("@/mobile-v3/brand/brand-kit-page").then(
                              (m) => m.BrandKitPage,
                            ),
                        },
                      },
                      {
                        path: "hq/:id",
                        lazy: {
                          Component: () =>
                            import("@/pages/hq/mission-detail-page").then(
                              (m) => m.MissionDetailPage,
                            ),
                        },
                      },
                      {
                        path: "projects",
                        loader: surfaceLoader("projects"),
                        lazy: {
                          Component: () =>
                            import("@/pages/projects/projects-page").then(
                              (m) => m.ProjectsPage,
                            ),
                        },
                      },
                      {
                        path: "projects/:projectId",
                        lazy: {
                          Component: () =>
                            import("@/pages/projects/project-detail-page").then(
                              (m) => m.ProjectDetailPage,
                            ),
                        },
                      },
                      {
                        path: "work",
                        lazy: {
                          Component: () =>
                            import("@/pages/projects/all-work-page").then(
                              (m) => m.AllWorkPage,
                            ),
                        },
                      },
                      {
                        // Full-bleed Core surface (reached from the impact rail), not an
                        // "About Assistant" tab.
                        path: "impact",
                        lazy: {
                          Component: () =>
                            import("@/domains/intelligence/impact-page").then(
                              (m) => m.ImpactPage,
                            ),
                        },
                      },
                      // ── Consolidated surfaces → HQ ──────────────────────────────────
                      // The founder found Home / Mission Control / Activity / Agents
                      // redundant ("the same thing in different displays"). They — and
                      // now Home itself — all redirect to the one landing surface at
                      // /hq (single hop, not a chain through /home). Handlers are not
                      // deleted — every legacy URL still resolves.
                      {
                        // Mission Control folded into the HQ deck.
                        path: "mission-control",
                        element: <Navigate to={routes.hq} replace />,
                      },
                      {
                        // Next-moves lives as "◆ Your next move" atop Needs-you.
                        path: "next-moves",
                        element: <Navigate to={routes.hq} replace />,
                      },
                      {
                        // The Dashboard folded into HQ.
                        path: "dashboard",
                        element: <Navigate to={routes.hq} replace />,
                      },
                      {
                        // Activity (background-work command center) folded into the
                        // deck's queued/needs-you/done modules.
                        path: "activity",
                        element: <Navigate to={routes.hq} replace />,
                      },
                      {
                        // Agents-at-work (live subagent fleet) folded into HQ's
                        // "Agents at work" rail.
                        path: "agents",
                        element: <Navigate to={routes.hq} replace />,
                      },
                      {
                        path: "meeting",
                        lazy: {
                          Component: () =>
                            import("@/domains/meeting/meeting-capture-page").then(
                              (m) => m.MeetingCapturePage,
                            ),
                        },
                      },
                      {
                        // Guardrails — the Trust console evolved into the
                        // unified rules/scopes/ledger surface (same nav slot).
                        path: "guardrails",
                        lazy: {
                          Component: () =>
                            import(
                              "@/domains/guardrails/guardrails-page"
                            ).then((m) => m.GuardrailsPage),
                        },
                      },
                      {
                        // The old Trust console URL redirects to Guardrails.
                        path: "trust",
                        element: <Navigate to={routes.guardrails} replace />,
                      },
                      {
                        path: "people",
                        lazy: {
                          Component: () =>
                            import("@/domains/people/people-page").then(
                              (m) => m.PeoplePage,
                            ),
                        },
                      },
                      {
                        path: "voice",
                        lazy: {
                          Component: () =>
                            import("@/domains/chat/voice/voice-mode-page").then(
                              (m) => m.VoiceModePage,
                            ),
                        },
                      },
                      {
                        lazy: {
                          Component: () =>
                            import("@/domains/intelligence/intelligence-layout").then(
                              (m) => m.IntelligenceLayout,
                            ),
                        },
                        children: [
                          {
                            path: "identity",
                            lazy: {
                              Component: () =>
                                import("@/identity-page-route").then(
                                  (m) => m.IdentityPageRoute,
                                ),
                            },
                          },
                          {
                            path: "cue-live",
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/cue-live-page").then(
                                  (m) => m.CueLivePage,
                                ),
                            },
                          },
                          {
                            // Desktop control — web W5 / mobile 71-72 remote of
                            // a run that executes on the paired Mac.
                            path: "desktop-control",
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/desktop-control-page").then(
                                  (m) => m.DesktopControlPage,
                                ),
                            },
                          },
                          {
                            path: "connectors",
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/connectors-page").then(
                                  (m) => m.ConnectorsPage,
                                ),
                            },
                          },
                          {
                            path: "connectors/:slug",
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/connector-detail-page").then(
                                  (m) => m.ConnectorDetailPage,
                                ),
                            },
                          },
                          {
                            path: "channels",
                            loader: surfaceLoader("channels"),
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/channels-agents-page").then(
                                  (m) => m.ChannelsAgentsPage,
                                ),
                            },
                          },
                          {
                            path: "plugins",
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/plugins-page").then(
                                  (m) => m.PluginsPage,
                                ),
                            },
                          },
                          {
                            // Automations (WS-F) — Watchers + Playbooks.
                            path: "automations",
                            lazy: {
                              Component: () =>
                                import("@/domains/automations/automations-page").then(
                                  (m) => m.AutomationsPage,
                                ),
                            },
                          },
                          {
                            path: "plugins/:name",
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/plugin-detail-page").then(
                                  (m) => m.PluginDetailPage,
                                ),
                            },
                          },
                          {
                            path: "skills",
                            loader: surfaceLoader("skills"),
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/skills-page").then(
                                  (m) => m.SkillsPage,
                                ),
                            },
                          },
                          {
                            // Skill marketplace (WS1) — gated by the
                            // `marketplace` assistant feature flag; the page
                            // redirects to Skills when the flag is off.
                            path: "marketplace",
                            lazy: {
                              Component: () =>
                                import("@/pages/marketplace/marketplace-page").then(
                                  (m) => m.MarketplacePage,
                                ),
                            },
                          },
                          {
                            path: "memory",
                            lazy: {
                              Component: () =>
                                import("@/domains/intelligence/memories-page").then(
                                  (m) => m.MemoriesPage,
                                ),
                            },
                          },
                          {
                            path: "workspace",
                            lazy: {
                              Component: () =>
                                import("@/domains/workspace/workspace-page").then(
                                  (m) => m.WorkspacePage,
                                ),
                            },
                          },
                          {
                            path: "contacts",
                            lazy: {
                              Component: () =>
                                import("@/contacts-page-route").then(
                                  (m) => m.ContactsPageRoute,
                                ),
                            },
                          },
                        ],
                      },
                      {
                        path: "create",
                        lazy: {
                          Component: () =>
                            import("@/domains/create/create-page").then(
                              (m) => m.CreatePage,
                            ),
                        },
                      },
                      {
                        path: "library",
                        lazy: {
                          Component: () =>
                            import("@/domains/library/library-page").then(
                              (m) => m.LibraryPage,
                            ),
                        },
                      },
                      {
                        path: "library/:appId",
                        lazy: {
                          Component: () =>
                            import("@/domains/library/library-detail-page").then(
                              (m) => m.LibraryDetailPage,
                            ),
                        },
                      },
                      {
                        path: "connect",
                        lazy: {
                          Component: () =>
                            import("@/domains/contacts/connect-page").then(
                              (m) => m.ConnectPage,
                            ),
                        },
                      },
                      {
                        path: "conversations/:conversationId/inspect",
                        lazy: {
                          Component: () =>
                            import("@/domains/chat/inspector/inspect-page").then(
                              (m) => m.InspectPage,
                            ),
                        },
                      },
                      {
                        path: "memory-router-playground",
                        lazy: {
                          Component: () =>
                            import("@/domains/chat/inspector/memory-router-playground-page").then(
                              (m) => m.MemoryRouterPlaygroundPage,
                            ),
                        },
                      },
                    ],
                  },
                ], // end inner chunk-fail boundary (chat-side)
              },
            ],
          },

          // Catch-all within /assistant/*
          { path: "*", Component: NotFound },
        ], // end outer chunk-fail boundary (/assistant)
      },
    ],
  },

  // Top-level catch-all
  { path: "*", ErrorBoundary: RouteErrorBoundary, Component: NotFound },
];

export const router = createBrowserRouter(routeTree as never, {
  future: { v8_middleware: true },
});
