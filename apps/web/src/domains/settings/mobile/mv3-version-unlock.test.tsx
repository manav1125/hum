/**
 * The developer unlock, on a phone.
 *
 * The gesture is seven taps on the version value, and it is the only way in to
 * Debug / Advanced / Developer. On desktop that value lives on the General
 * page. On a phone `/assistant/settings/general` renders `Mv3AppearanceLeaf`
 * instead — which had a theme picker and no version anywhere — so the gesture
 * was not merely hard to find, it could not be performed at all. Worse, the
 * developer route's `?locked=developer` bounce landed here and said nothing.
 *
 * What is pinned here:
 *
 *  · the row shows the version the desktop status panel would show, resolved
 *    the same way (healthz → the platform release record → the daemon identity
 *    a self-host gateway reports instead of a platform record);
 *  · seven taps flip `settingsDeveloperNav` and PATCH it, on this surface too;
 *  · the countdown starts at tap 3 here as well — the phone reuses the desktop
 *    control rather than growing a second copy of the counter that could drift;
 *  · the redirect from the developer page is explained;
 *  · and the panels themselves stay off this screen, before AND after the
 *    unlock. Revealing them is the settings nav's job, gated on the flag; this
 *    leaf only carries the door.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const patchMock = mock(async (_args: unknown) => ({
  response: new Response(null, { status: 200 }),
}));

mock.module("@/generated/api/client.gen", () => ({
  client: {
    patch: patchMock,
    getConfig: () => ({ baseUrl: "http://test.local" }),
  },
}));

// The three version sources, swapped per test: a single fixture cannot show
// the fallback chain, which is the part that decides whether the row is a
// version at all or another "—".
let healthzVersion: string | null = "0.9.4";
let healthzLoading = false;
let releaseVersion: string | null = "0.9.1";

const reactQuery = await import("@tanstack/react-query");
mock.module("@tanstack/react-query", () => ({
  ...reactQuery,
  useQuery: (options: { queryKey?: unknown }) => {
    const key = JSON.stringify(options.queryKey ?? []);
    if (key.includes("healthzGet")) {
      return {
        data: healthzVersion ? { version: healthzVersion } : undefined,
        isLoading: healthzLoading,
      };
    }
    if (key.includes("currentAssistant")) {
      return {
        data: { id: "a1", current_release_version: releaseVersion },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  },
  useMutation: () => ({
    mutate: () => {},
    mutateAsync: async () => {},
    isPending: false,
  }),
  useQueryClient: () => ({
    setQueryData: () => {},
    invalidateQueries: () => {},
    getQueryData: () => undefined,
  }),
}));

const { useAssistantFeatureFlagStore } = await import(
  "@/stores/assistant-feature-flag-store"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { TAP_THRESHOLD, HINT_AFTER_TAPS, unlockResultMessage } = await import(
  "@/domains/settings/components/dev-mode-version-unlock"
);
const { DEVELOPER_PANEL_IDS, SETTINGS_SIDEBAR } = await import(
  "@/utils/settings-navigation"
);
const { Mv3AppearanceLeaf } = await import(
  "@/domains/settings/mobile/mobile-settings-leafs"
);
const { Mv3SettingsIndex } = await import(
  "@/domains/settings/mobile/mobile-settings"
);

const developerNav = () =>
  useAssistantFeatureFlagStore.getState().settingsDeveloperNav;

function renderLeaf(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/assistant/settings/general${search}`]}>
      <Mv3AppearanceLeaf />
    </MemoryRouter>,
  );
}

/** Taps the version value, whatever it currently reads. */
function tapVersion(times: number) {
  const button = screen.getByRole("button", { name: currentVersion() });
  for (let i = 0; i < times; i++) {
    fireEvent.click(button);
  }
}

function currentVersion(): string {
  return healthzVersion ?? releaseVersion ?? "0.9.0";
}

beforeEach(() => {
  useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
  useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
  useAssistantIdentityStore.getState().clearIdentity();
  patchMock.mockClear();
  healthzVersion = "0.9.4";
  healthzLoading = false;
  releaseVersion = "0.9.1";
});

afterEach(cleanup);

describe("the mobile version row", () => {
  test("shows the healthz version, the way the desktop panel resolves it", () => {
    renderLeaf();
    expect(screen.getByText("Version")).toBeTruthy();
    expect(screen.getByRole("button", { name: "0.9.4" })).toBeTruthy();
  });

  test("falls back to the platform release version when healthz has none", () => {
    healthzVersion = null;
    renderLeaf();
    expect(screen.getByRole("button", { name: "0.9.1" })).toBeTruthy();
  });

  test("falls back to the daemon identity on a self-host gateway", () => {
    // No platform assistant record and no healthz reading: the deployment the
    // owner actually holds. Without this leg the row reads "—" and the gesture
    // is unreachable for a second time, in a new place.
    healthzVersion = null;
    releaseVersion = null;
    useAssistantIdentityStore.getState().setIdentity("Cue", "0.9.0");
    renderLeaf();
    expect(screen.getByRole("button", { name: "0.9.0" })).toBeTruthy();
  });
});

describe("the seven-tap unlock, on the phone", () => {
  test("seven taps flip the flag and PATCH it", () => {
    renderLeaf();
    expect(developerNav()).toBe(false);

    tapVersion(TAP_THRESHOLD - 1);
    expect(developerNav()).toBe(false);

    tapVersion(1);
    expect(developerNav()).toBe(true);
    expect(patchMock).toHaveBeenCalledTimes(1);
    const args = patchMock.mock.calls[0][0] as {
      url: string;
      body: { enabled: boolean };
    };
    expect(args.url).toBe(
      "/v1/assistants/a1/feature-flags/settings-developer-nav",
    );
    expect(args.body).toEqual({ enabled: true });
  });

  test("two taps say nothing; the third starts the countdown", () => {
    renderLeaf();
    tapVersion(HINT_AFTER_TAPS - 1);
    expect(screen.queryByText(/more tap/)).toBeNull();

    tapVersion(1);
    expect(
      screen.getByText("4 more taps to unlock developer settings"),
    ).toBeTruthy();

    tapVersion(3);
    expect(
      screen.getByText("1 more tap to unlock developer settings"),
    ).toBeTruthy();
  });

  test("the seventh confirms in words", () => {
    renderLeaf();
    tapVersion(TAP_THRESHOLD);
    expect(screen.getByText(unlockResultMessage(true))).toBeTruthy();
    expect(screen.queryByText(/more tap/)).toBeNull();
  });

  test("the developer page's redirect is explained here too", () => {
    renderLeaf("?locked=developer");
    expect(
      screen.getByText(
        "Developer settings are locked. Tap the version above 7× to unlock them.",
      ),
    ).toBeTruthy();
  });
});

describe("the panels stay hidden", () => {
  test("this screen never lists Debug, Advanced or Developer — before or after", () => {
    const { container } = renderLeaf();
    const developerHrefs = SETTINGS_SIDEBAR.filter((item) =>
      DEVELOPER_PANEL_IDS.has(item.id),
    );
    expect(developerHrefs.length).toBe(3);

    // Naming the panels is allowed — the confirmation says where they went,
    // which is the whole point of it. Offering a WAY IN is not: no link to a
    // developer route, and no row that acts as one.
    const screenHasPanels = () =>
      developerHrefs.some(
        (item) =>
          container.querySelector(`[href="${item.href}"]`) !== null ||
          screen.queryByRole("link", { name: item.label }) !== null ||
          screen.queryByRole("button", { name: item.label }) !== null,
      );

    expect(screenHasPanels()).toBe(false);
    tapVersion(TAP_THRESHOLD);
    expect(developerNav()).toBe(true);
    // The gesture flipped a flag. It did not turn this leaf into a nav.
    expect(screenHasPanels()).toBe(false);
  });

  test("the mobile settings index lists none of them with the flag off", () => {
    // The layout's gate, verbatim: developer panels are dropped from the item
    // list unless the flag is on. This is the default every phone owner has.
    const items = SETTINGS_SIDEBAR.filter(
      (item) => !(DEVELOPER_PANEL_IDS.has(item.id) && !developerNav()),
    );
    expect(items.some((item) => DEVELOPER_PANEL_IDS.has(item.id))).toBe(false);

    const { container } = render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <Mv3SettingsIndex items={items} showLogout={false} />
      </MemoryRouter>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Settings");
    expect(text).not.toContain("Debug");
    expect(text).not.toContain("Advanced");
    expect(text).not.toContain("Developer");
  });
});
