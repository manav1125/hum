/**
 * The Developer page's lock, and — the part that made it a dead end — what it
 * leaves behind when it turns someone away.
 *
 * The page has always redirected to General with the flag off. Nothing on
 * General mentioned developer settings, so the redirect read as "that URL does
 * nothing". It now tags the redirect, and the version row on General answers
 * the tag (see `dev-mode-version-unlock.test.tsx`). Hiding stays; silence goes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

// The tab panels pull the whole developer toolchain in. The redirect happens
// before any of them render, so they are stubbed to keep this a test of the
// gate rather than of three unrelated panels.
mock.module(
  "@/domains/settings/components/panels/assistant-lifecycle-panel",
  () => ({ AssistantLifecyclePanel: () => null }),
);
mock.module(
  "@/domains/settings/components/panels/environment-config-panel",
  () => ({ EnvironmentConfigPanel: () => null }),
);
mock.module("@/domains/settings/components/panels/feature-flags-panel", () => ({
  FeatureFlagsPanel: () => <div>Feature Flags Panel</div>,
}));
mock.module("@/domains/settings/components/panels/sentry-testing-panel", () => ({
  SentryTestingPanel: () => null,
}));

const { useAssistantFeatureFlagStore } = await import(
  "@/stores/assistant-feature-flag-store"
);
const { DeveloperPage } = await import(
  "@/domains/settings/pages/developer-page"
);
const { routes } = await import("@/utils/routes");

/** Renders the developer route and reports where it ended up. */
function renderAt() {
  return render(
    <MemoryRouter initialEntries={[routes.settings.developer]}>
      <Routes>
        <Route path={routes.settings.developer} element={<DeveloperPage />} />
        <Route
          path={routes.settings.general}
          element={<LandedOnGeneral />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function LandedOnGeneral() {
  const location = useLocation();
  return <div data-testid="general">{location.search}</div>;
}

beforeEach(() => {
  useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
});

afterEach(cleanup);

describe("DeveloperPage gate", () => {
  test("un-hydrated flags render the page — a default is not an answer yet", () => {
    renderAt();
    expect(screen.getByText("Feature Flags Panel")).toBeTruthy();
  });

  test("hydrated and locked redirects to General, tagged so it can explain", () => {
    const store = useAssistantFeatureFlagStore.getState();
    store.setFlags({ settingsDeveloperNav: false });
    store.markHydrated();
    renderAt();
    expect(screen.queryByText("Feature Flags Panel")).toBeNull();
    // The tag is the whole point: General's version row keys off it.
    expect(screen.getByTestId("general").textContent).toBe("?locked=developer");
  });

  test("unlocked renders the page", () => {
    const store = useAssistantFeatureFlagStore.getState();
    store.setFlags({ settingsDeveloperNav: true });
    store.markHydrated();
    renderAt();
    expect(screen.getByText("Feature Flags Panel")).toBeTruthy();
  });
});
