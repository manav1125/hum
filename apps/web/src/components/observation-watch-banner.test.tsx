/**
 * The watching indicator's rules.
 *
 * This is the surface that tells someone Cue is looking at their screen, so
 * the mutation checks guard the two ways it could fail them: staying silent
 * while a session is armed, and offering no way out of one.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-1";

// The banner mounts in the root layout, which is not under
// `<ActiveAssistantGate>`, so it reads the nullable store rather than the
// throwing hook. Seed the real store instead of mocking it — that exercises
// the same path the app takes, and leaves the module registry untouched.
useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });

type SessionView = {
  armed: boolean;
  secondsRemaining: number;
  itemsFiled: number;
};

let sessionView: SessionView = {
  armed: false,
  secondsRemaining: 0,
  itemsFiled: 0,
};
let stopCalls = 0;

const genActual = await import("@/generated/daemon/@tanstack/react-query.gen");
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...genActual,
  cueliveObservationSessionGetOptions: () => ({
    queryKey: ["cuelive-session-stub"],
    queryFn: async () => sessionView,
  }),
  cueliveObservationSessionGetQueryKey: () => ["cuelive-session-stub"],
  cueliveObservationSessionStopPostMutation: () => ({
    mutationFn: async () => {
      stopCalls += 1;
      sessionView = { ...sessionView, armed: false };
      return {};
    },
  }),
}));

const { ObservationWatchBanner } = await import("./observation-watch-banner");

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ObservationWatchBanner),
    ),
  );
}

/** The query resolves on a microtask; give React a tick to paint it. */
const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  cleanup();
  stopCalls = 0;
  sessionView = { armed: false, secondsRemaining: 0, itemsFiled: 0 };
});

describe("it is silent when nothing is being watched", () => {
  test("an unarmed session renders nothing at all", async () => {
    renderBanner();
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("it is unmissable when something is", () => {
  test("MUTATION CHECK: an armed session always shows the indicator", async () => {
    // The failure this guards is the one that matters: watching happening
    // with nothing on screen to say so.
    sessionView = { armed: true, secondsRemaining: 125, itemsFiled: 0 };
    renderBanner();
    await settle();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/watching your screen/i)).toBeTruthy();
  });

  test("the countdown is the session's own number, formatted", async () => {
    sessionView = { armed: true, secondsRemaining: 125, itemsFiled: 0 };
    renderBanner();
    await settle();
    expect(screen.getByText(/2:05 left/)).toBeTruthy();
  });

  test("filed items are stated once there are any", async () => {
    sessionView = { armed: true, secondsRemaining: 60, itemsFiled: 1 };
    renderBanner();
    await settle();
    expect(screen.getByText(/1 item filed/)).toBeTruthy();
  });

  test("a zero count is NOT stated — this bar does not reassure", async () => {
    sessionView = { armed: true, secondsRemaining: 60, itemsFiled: 0 };
    renderBanner();
    await settle();
    expect(screen.queryByText(/0 items/)).toBeNull();
  });
});

describe("there is always a way out", () => {
  test("MUTATION CHECK: stopping is one tap and reaches the daemon", async () => {
    // A local-only stop would hide the indicator while capture continued —
    // worse than never showing it, because it would be a false all-clear.
    sessionView = { armed: true, secondsRemaining: 300, itemsFiled: 0 };
    renderBanner();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /stop watching/i }));
    await settle();
    expect(stopCalls).toBe(1);
  });

  test("the control is a real button, reachable by name", async () => {
    sessionView = { armed: true, secondsRemaining: 300, itemsFiled: 0 };
    renderBanner();
    await settle();
    expect(screen.getByRole("button", { name: /stop watching/i })).toBeTruthy();
  });
});
