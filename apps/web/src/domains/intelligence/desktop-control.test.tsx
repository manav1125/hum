/**
 * Desktop control — "never show a state the system cannot back up".
 *
 * The reported bug had one screen claiming, simultaneously, that a run was
 * executing on the Mac AND that no Mac was connected — with a step list that
 * repeated the request verbatim four times, two rows stamped `verified` and two
 * `verifying`. Every one of those claims came from state the daemon never made.
 *
 * These tests pin the four honesty rules:
 *   1. No Mac on the other end → the card never says "Running".
 *   2. A goal that has stopped reporting steps is not "running" either.
 *   3. `verified` appears only on an observation carrying the daemon's own
 *      verify beat; a merely-recorded step says "done".
 *   4. The step list carries steps, not echoes of the request.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`). The
 * generated SDK is mocked so both reads resolve locally instead of reaching for
 * a daemon.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type {
  CueliveSessionGetResponse,
  OrganizerSessionGetResponse,
} from "@/generated/daemon/types.gen";

type Observation = CueliveSessionGetResponse["observations"][number];
type Target = OrganizerSessionGetResponse["targets"][number];

const GOAL =
  "go to grab and order fruits for our breakfast this morning we are 4 adults and 2 kids and need a lot of fruits";

const okResponse = { response: new Response(), error: undefined };

let liveSession: CueliveSessionGetResponse;
let targets: Target[];

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  cueliveSessionGet: mock(async () => ({ data: liveSession, ...okResponse })),
  organizerSessionGet: mock(async () => ({
    data: {
      session: {
        active: false,
        machineName: null,
        lastSeenAt: null,
        sessionStartedAt: null,
        plan: null,
        progress: null,
        done: null,
      },
      targets,
    },
    ...okResponse,
  })),
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-1",
}));
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  useMobileLayout: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const { DesktopControlPage, stepRows, stripGoalEcho, stepStatusLabel } =
  await import("./desktop-control-page");

function observation(over: Partial<Observation> & { id: number }): Observation {
  return {
    kind: "act",
    at: new Date().toISOString(),
    summary: `Step ${over.id} — ${GOAL}`,
    status: "active",
    ...over,
  };
}

/** The exact stream the reported screenshot was rendering. */
function echoObservations(at: string): Observation[] {
  return [
    observation({ id: 4, at, status: "active" }),
    observation({ id: 3, at, status: "active" }),
    observation({ id: 2, at, status: "done" }),
    observation({ id: 1, at, status: "done" }),
  ];
}

function session(
  over: Partial<CueliveSessionGetResponse> = {},
): CueliveSessionGetResponse {
  const at = new Date().toISOString();
  return {
    active: true,
    paused: false,
    stopPending: false,
    lastSeenAt: at,
    sessionStartedAt: at,
    watching: { appName: "Safari", screen: null, at },
    goal: { text: GOAL, step: 1, done: false, startedAt: at },
    observations: echoObservations(at),
    stream: {
      state: "off",
      armed: false,
      armedBy: null,
      armedAt: null,
      lastFrameAt: null,
      seq: 0,
      intervalMs: 1000,
      maxWidth: 1280,
      viewerAttached: false,
      lastStopReason: null,
      mac: null,
    },
    takeover: { armed: false, armedAt: null, steps: 0, maxSteps: 10 },
    trustDial: "assist",
    ...over,
  };
}

function connectedMac(): Target {
  return {
    clientId: "client-1",
    machineName: "Manav's MacBook Pro",
    interfaceId: "macos",
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    online: true,
  };
}

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/desktop-control"]}>
        <DesktopControlPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  liveSession = session();
  targets = [];
});

afterEach(() => {
  cleanup();
});

describe("Desktop control · the two panels must agree", () => {
  test("no Mac connected → the card does not claim the run is running", async () => {
    // GIVEN the daemon still holds an open goal, but no Mac is listed and
    // nothing has reported a step recently
    liveSession = session({
      observations: echoObservations(new Date(Date.now() - 300_000).toISOString()),
    });

    renderPage();

    // THEN the connection panel's claim stands…
    await waitFor(() =>
      expect(screen.getByText(/No Mac is connected right now/)).toBeDefined(),
    );
    // …and the run card agrees with it instead of contradicting it
    expect(screen.getByText("Waiting for a Mac")).toBeDefined();
    expect(screen.queryByText(/^Running on/)).toBeNull();
    expect(
      screen.getByText(/No Mac is connected, so nothing is executing/),
    ).toBeDefined();
  });

  test("a Mac reporting steps but absent from the roster is named as such", async () => {
    // GIVEN fresh observations (a Mac IS talking to Cue) but an empty roster
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/isn’t\s+listed as a paired target/),
      ).toBeDefined(),
    );
    // The picker no longer flatly denies a Mac that is demonstrably reporting.
    expect(screen.queryByText(/No Mac is connected right now/)).toBeNull();
  });

  test("a connected Mac with a stalled goal says so rather than 'running'", async () => {
    targets = [connectedMac()];
    liveSession = session({
      observations: echoObservations(new Date(Date.now() - 300_000).toISOString()),
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No step reported")).toBeDefined(),
    );
    expect(screen.queryByText(/^Running on/)).toBeNull();
    expect(screen.getByText(/hasn’t reported a step/)).toBeDefined();
  });

  test("a connected Mac reporting steps right now IS allowed to say running", async () => {
    targets = [connectedMac()];
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/^Running on Safari · step 1$/)).toBeDefined(),
    );
  });

  test("a finished goal is reported in the past tense, with no Pause", async () => {
    targets = [connectedMac()];
    const at = new Date().toISOString();
    liveSession = session({
      goal: { text: GOAL, step: 6, done: true, startedAt: at },
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Last run · finished")).toBeDefined(),
    );
    expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
  });
});

describe("Desktop control · the step list", () => {
  test("does not repeat the request back as its own steps", async () => {
    targets = [connectedMac()];
    renderPage();

    // The goal is the headline — exactly once, not once per 'step'.
    await waitFor(() => expect(screen.getAllByText(GOAL).length).toBe(1));
    // And nothing is stamped verified, because nothing was verified.
    expect(screen.queryByText("verified")).toBeNull();
    expect(
      screen.getByText(/No step detail reported/),
    ).toBeDefined();
  });

  test("renders what Cue actually did, once, with honest labels", async () => {
    targets = [connectedMac()];
    const at = new Date().toISOString();
    liveSession = session({
      observations: [
        observation({
          id: 3,
          at,
          status: "done",
          detail: "Opened the Grab basket.",
          verify: "verified",
        }),
        // Same text twice — the stream repeats, the list must not.
        observation({ id: 2, at, status: "done", detail: "Searched for fruit" }),
        observation({ id: 1, at, status: "done", detail: "Searched for fruit" }),
      ],
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Opened the Grab basket.")).toBeDefined(),
    );
    expect(screen.getAllByText("Searched for fruit").length).toBe(1);
    // Verified only where the daemon said so; the bare recorded step is "done".
    expect(screen.getAllByText("verified").length).toBe(1);
    expect(screen.getAllByText("done").length).toBe(1);
  });
});

describe("Desktop control · row derivation", () => {
  test("strips the goal echo the daemon appends to every summary", () => {
    expect(stripGoalEcho(`Step 3 — ${GOAL}`, GOAL)).toBe("Step 3");
    expect(stripGoalEcho(`Run finished — ${GOAL}`, GOAL)).toBe("Run finished");
    expect(stripGoalEcho("Summoned over Safari", GOAL)).toBe(
      "Summoned over Safari",
    );
  });

  test("drops rows whose only content was a step counter", () => {
    const at = new Date().toISOString();
    expect(stepRows(echoObservations(at), GOAL)).toEqual([]);
  });

  test("keeps run-boundary rows even without detail", () => {
    const at = new Date().toISOString();
    const rows = stepRows(
      [
        observation({
          id: 1,
          at,
          status: "done",
          summary: `Run finished — ${GOAL}`,
        }),
      ],
      GOAL,
    );
    expect(rows.map((r) => r.text)).toEqual(["Run finished"]);
  });

  test("only calls a step verified when the daemon verified it", () => {
    expect(stepStatusLabel({ status: "done" })).toBe("done");
    expect(stepStatusLabel({ status: "done", verify: "verified" })).toBe(
      "verified",
    );
    expect(stepStatusLabel({ status: "done", verify: "stuck" })).toBe("stuck");
    expect(stepStatusLabel({ status: "active" })).toBe("working");
    expect(stepStatusLabel({ status: "held" })).toBe("held");
  });
});
