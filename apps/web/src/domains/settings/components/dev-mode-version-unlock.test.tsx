/**
 * The developer-mode unlock gesture on the General panel's version row.
 *
 * This is the only way in to Debug / Advanced / Developer, and it had no test
 * at all — which is how it stayed technically-working and practically
 * unreachable. What is pinned here:
 *
 *  · seven taps really do flip `settingsDeveloperNav` (the mechanism);
 *  · six do not, and the seventh from a fresh count toggles back (no drift);
 *  · the gesture is silent for two taps and then counts itself down (the
 *    discoverability fix — a control that never answers reads as dead);
 *  · unlocking says so, in words, and names where the panels appeared;
 *  · arriving from the developer page's redirect explains the lock, and only
 *    while it is actually locked.
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

const { useAssistantFeatureFlagStore } = await import(
  "@/stores/assistant-feature-flag-store"
);
const {
  DevModeVersionUnlock,
  HINT_AFTER_TAPS,
  TAP_THRESHOLD,
  unlockProgressHint,
  unlockResultMessage,
} = await import("@/domains/settings/components/dev-mode-version-unlock");

const VERSION = "0.8.12";

function renderRow(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/assistant/settings/general${search}`]}>
      <DevModeVersionUnlock version={VERSION} loading={false} assistantId="a1" />
    </MemoryRouter>,
  );
}

function tap(times: number) {
  const button = screen.getByRole("button", { name: VERSION });
  for (let i = 0; i < times; i++) {
    fireEvent.click(button);
  }
}

const developerNav = () =>
  useAssistantFeatureFlagStore.getState().settingsDeveloperNav;

beforeEach(() => {
  useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
  patchMock.mockClear();
});

afterEach(cleanup);

describe("unlockProgressHint", () => {
  test("silent until the gesture is unambiguous, then counts down", () => {
    expect(unlockProgressHint(0)).toBeNull();
    expect(unlockProgressHint(HINT_AFTER_TAPS - 1)).toBeNull();
    expect(unlockProgressHint(3)).toBe(
      "4 more taps to unlock developer settings",
    );
    expect(unlockProgressHint(TAP_THRESHOLD - 1)).toBe(
      "1 more tap to unlock developer settings",
    );
    // At and past the threshold the gesture has fired; the countdown would be
    // describing a state that no longer exists.
    expect(unlockProgressHint(TAP_THRESHOLD)).toBeNull();
  });
});

describe("the seven-tap unlock", () => {
  test("seven taps flip the flag and PATCH it for the assistant", () => {
    renderRow();
    expect(developerNav()).toBe(false);

    tap(TAP_THRESHOLD - 1);
    expect(developerNav()).toBe(false);

    tap(1);
    expect(developerNav()).toBe(true);
    expect(patchMock).toHaveBeenCalledTimes(1);
    const args = patchMock.mock.calls[0][0] as {
      url: string;
      body: { enabled: boolean };
    };
    expect(args.url).toBe("/v1/assistants/a1/feature-flags/settings-developer-nav");
    expect(args.body).toEqual({ enabled: true });
  });

  test("the count resets after firing, so it toggles rather than drifting", () => {
    renderRow();
    tap(TAP_THRESHOLD);
    expect(developerNav()).toBe(true);
    // One more tap must not re-fire — the counter restarted at zero.
    tap(1);
    expect(developerNav()).toBe(true);
    tap(TAP_THRESHOLD - 1);
    expect(developerNav()).toBe(false);
  });

  test("with no assistant id it still works locally, and skips the PATCH", () => {
    render(
      <MemoryRouter>
        <DevModeVersionUnlock
          version={VERSION}
          loading={false}
          assistantId={null}
        />
      </MemoryRouter>,
    );
    tap(TAP_THRESHOLD);
    expect(developerNav()).toBe(true);
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe("the gesture narrates itself", () => {
  test("two taps say nothing; the third starts counting down", () => {
    renderRow();
    tap(2);
    expect(screen.queryByText(/more tap/)).toBeNull();

    tap(1);
    expect(
      screen.getByText("4 more taps to unlock developer settings"),
    ).toBeTruthy();
    tap(3);
    expect(
      screen.getByText("1 more tap to unlock developer settings"),
    ).toBeTruthy();
  });

  test("the seventh tap confirms, and says where the panels went", () => {
    renderRow();
    tap(TAP_THRESHOLD);
    expect(screen.getByText(unlockResultMessage(true))).toBeTruthy();
    expect(screen.getByText(/in the settings list/)).toBeTruthy();
    // It must NOT name individual panels: mobile prunes Advanced always and
    // Debug on self-host, so an enumeration sends a phone owner looking for
    // panels that will never appear on their surface.
    expect(screen.queryByText(/Debug, Advanced and Developer/)).toBeNull();
    // The countdown is gone — the gesture completed.
    expect(screen.queryByText(/more tap/)).toBeNull();
  });

  test("locking back says that too", () => {
    renderRow();
    tap(TAP_THRESHOLD * 2);
    expect(developerNav()).toBe(false);
    expect(screen.getByText(unlockResultMessage(false))).toBeTruthy();
  });

  test("the countdown is announced, not just drawn", () => {
    const { container } = renderRow();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    tap(HINT_AFTER_TAPS);
    expect(live!.textContent).toBe("4 more taps to unlock developer settings");
  });
});

describe("arriving from the developer page's redirect", () => {
  test("the bounce is explained instead of leaving a silent dead end", () => {
    renderRow("?locked=developer");
    expect(
      screen.getByText(
        "Developer settings are locked. Tap the version above 7× to unlock them.",
      ),
    ).toBeTruthy();
  });

  test("no tag, no notice — the door stays closed for everyone else", () => {
    renderRow();
    expect(screen.queryByText(/Developer settings are locked/)).toBeNull();
  });

  test("once unlocked the notice goes away, tag or no tag", () => {
    renderRow("?locked=developer");
    tap(TAP_THRESHOLD);
    expect(developerNav()).toBe(true);
    expect(screen.queryByText(/Developer settings are locked/)).toBeNull();
  });
});
