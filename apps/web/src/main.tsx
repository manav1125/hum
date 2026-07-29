// Run localStorage migrations before any other app import.
// MUST stay above the routes import — routes → onboarding-store and
// client-feature-flag-store read localStorage at module level.
import "@/utils/run-storage-migrations";

import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AppProviders } from "@/components/providers";
import { WindowDragRegion } from "@/components/window-drag-region";
import { isChunkLoadError } from "@/lib/chunk-errors";
import { isLocalMode, loadLockfile } from "@/lib/local-mode";
import { CueConnectScreen } from "@/lib/self-hosted/cue-connect-screen";
import { DesktopHandoffBanner } from "@/lib/self-hosted/desktop-handoff-banner";
import {
  bootstrapCueSelfHost,
  shouldShowCueConnectAsync,
} from "@/lib/self-hosted/cue-self-host";
import { markHqNativeIfFresh } from "@/pages/hq/hq-native-marker";
import { initSentry } from "@/lib/sentry/sentry-init";
import { setupAuthListeners, useAuthStore } from "@/stores/auth-store";
import { setupOrganizationStore } from "@/stores/organization-store";
import { router } from "./routes";

import "@/lib/api-interceptors";
import "./index.css";

import { initSafeAreaBridge } from "@/runtime/native-safe-area";
import { initInputModality } from "@vellumai/design-library";

async function boot() {
  // Fresh profiles are "HQ-native": pre-set the HQ-orientation seen-flag
  // before onboarding/selection can write any localStorage, so the
  // "Your Home is now HQ" what-changed modal only ever shows to profiles
  // with pre-HQ usage evidence. See `pages/hq/hq-native-marker.ts`.
  markHqNativeIfFresh();

  // Seed a self-hosted gateway token from `?cueToken=` (if present) before the
  // auth/lifecycle layer reads it, so the hosted SPA boots into a `self`
  // session against its same-origin gateway. No-op outside self-host mode.
  bootstrapCueSelfHost();

  initInputModality();
  await initSafeAreaBridge();
  initSentry();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  // Self-host deploy, fresh browser, no seeded token: render the Cue Connect
  // screen instead of booting the router (which would otherwise fall into the
  // Vellum-Platform login / local-vs-cloud onboarding that doesn't apply to a
  // single-tenant self-host). Once a token is pasted + seeded, the screen
  // reloads into the normal authenticated boot below.
  if (await shouldShowCueConnectAsync()) {
    createRoot(rootEl).render(
      <StrictMode>
        <AppProviders>
          <WindowDragRegion />
          <CueConnectScreen />
        </AppProviders>
      </StrictMode>,
    );
    return;
  }

  setupOrganizationStore();
  if (isLocalMode()) {
    await loadLockfile();
    await useAuthStore.getState().initSession();
  } else {
    useAuthStore.getState().initSession();
  }
  setupAuthListeners();

  createRoot(rootEl).render(
    <StrictMode>
      <AppProviders>
        <WindowDragRegion />
        {/* Magic-link sign-ins land in the browser even when the user started
            in the desktop app; this offers the trip back. Renders nothing
            inside Electron or on an ordinary page load. */}
        <DesktopHandoffBanner />
        <RouterProvider
          router={router}
          onError={(error) => {
            // Single Sentry capture point for every router error.
            // `RouteErrorBoundary` (used at every layer of the tree) owns
            // only the UI variant and intentionally does NOT capture again
            // to avoid duplicate events.
            Sentry.captureException(error, {
              tags: {
                context: "RouterProvider",
                boundary: isChunkLoadError(error)
                  ? "lazy-route"
                  : "route-render",
              },
            });
          }}
        />
      </AppProviders>
    </StrictMode>,
  );
}

boot();
