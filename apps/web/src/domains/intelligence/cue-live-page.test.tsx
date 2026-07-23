/**
 * Cue Live — "never claim a capability the system can't back up".
 *
 * The page was rebuilt from a ~1,800-line control panel into one honest screen.
 * These tests pin the honesty invariants of the rebuild:
 *   1. The Mac grant flow lights exactly one "Grant" at a time, Screen Recording
 *      first, and vanishes once both grants are held.
 *   2. On the desktop app a missing grant means take-control is blocked and SAYS
 *      why — it never silently pretends the switch worked.
 *   3. The capability list is honest: it states plainly what is NOT built yet.
 *   4. Off the desktop app (no bridge) the page hands to the explainer rather
 *      than rendering dead desktop controls.
 *
 * The runtime bridge is mocked so state is controllable without Electron; the
 * off-desktop explainer is stubbed (it owns its own react-query data layer).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type {
  CueLivePermissions,
  CueLiveStatus,
} from "@vellumai/ipc-contract";

let available = true;
let status: CueLiveStatus;
let permissions: CueLivePermissions;

mock.module("@/runtime/cue-live", () => ({
  isCueLiveAvailable: () => available,
  isCueLivePermissionsSupported: () => true,
  isRunGoalSupported: () => false,
  getCueLiveStatus: mock(async () => status),
  getCueLivePermissions: mock(async () => permissions),
  setCueLiveEnabled: mock(async () => status),
  setCueLiveTakeControl: mock(async () => status),
  summonCueLive: mock(async () => {}),
  stopCueLive: mock(async () => {}),
  runGoal: mock(async () => {}),
  openCueLiveSystemSettings: mock(async () => {}),
}));

// The explainer owns react-query + assistant-id plumbing; stub it so the
// off-desktop branch is observable without a daemon.
mock.module("@/domains/intelligence/cue-live-explainer", () => ({
  CueLiveWebExplainer: () => <div>explainer-stub</div>,
}));

const { CueLivePage, PermissionsBanner } = await import("./cue-live-page");

function baseStatus(over: Partial<CueLiveStatus> = {}): CueLiveStatus {
  return {
    enabled: true,
    running: true,
    accessibilityTrusted: true,
    screenRecordingGranted: true,
    hotkey: "Control+Option+Space",
    takeControl: false,
    streamingScreen: false,
    ...over,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/assistant/cue-live"]}>
      <CueLivePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  available = true;
  status = baseStatus();
  permissions = { accessibilityTrusted: true, screenRecordingGranted: true };
});

afterEach(() => {
  cleanup();
});

describe("PermissionsBanner · one lit grant at a time", () => {
  test("hides entirely once both grants are held", () => {
    render(
      <PermissionsBanner
        permissions={{ accessibilityTrusted: true, screenRecordingGranted: true }}
      />,
    );
    expect(screen.queryByText("Screen Recording")).toBeNull();
  });

  test("Screen Recording is the single lit step when nothing is granted", () => {
    render(
      <PermissionsBanner
        permissions={{ accessibilityTrusted: false, screenRecordingGranted: false }}
      />,
    );
    // Exactly one Grant button, and it belongs to the first (Screen Recording)
    // step — Accessibility is dimmed/"later", never a second competing action.
    expect(screen.getAllByRole("button", { name: "Grant" }).length).toBe(1);
    expect(screen.getByText("Screen Recording")).toBeDefined();
    expect(screen.getByText("Accessibility")).toBeDefined();
  });

  test("once Screen Recording is held, Accessibility becomes the lit step", () => {
    render(
      <PermissionsBanner
        permissions={{ accessibilityTrusted: false, screenRecordingGranted: true }}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Grant" }).length).toBe(1);
    expect(screen.getByText("Granted")).toBeDefined();
  });
});

describe("Cue Live · on the desktop app", () => {
  test("a missing grant blocks take-control and says why", async () => {
    status = baseStatus({ accessibilityTrusted: false, screenRecordingGranted: false });
    permissions = { accessibilityTrusted: false, screenRecordingGranted: false };

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Let Cue take control")).toBeDefined(),
    );
    // The switch cannot lie: with a grant missing it explains the block.
    expect(
      screen.getByText(/Needs Screen Recording — grant it above/),
    ).toBeDefined();
  });

  test("states plainly what is not built yet", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Not built yet/)).toBeDefined(),
    );
    // And it answers the "why does the overlay appear" question honestly.
    expect(screen.getByText("Why the overlay appears")).toBeDefined();
    expect(
      screen.getByText(/not a background watcher/),
    ).toBeDefined();
  });
});

describe("Cue Live · off the desktop app", () => {
  test("hands to the explainer instead of dead desktop controls", () => {
    available = false;
    renderPage();
    expect(screen.getByText("explainer-stub")).toBeDefined();
    expect(screen.queryByText("What it can do right now")).toBeNull();
  });
});
