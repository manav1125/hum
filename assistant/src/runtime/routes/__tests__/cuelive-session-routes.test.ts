import { beforeEach, describe, expect, test } from "bun:test";

import { ROUTES } from "../cuelive-routes.js";
import type { CueLiveSessionView } from "../cuelive-session.js";
import {
  consumeRemoteStop,
  getSessionView,
  recordActStep,
  recordGuidance,
  recordLook,
  requestRemoteStop,
  resetCueLiveSessionForTest,
  setRemotePaused,
} from "../cuelive-session.js";

function route(operationId: string) {
  const def = ROUTES.find((r) => r.operationId === operationId);
  if (!def) throw new Error(`route ${operationId} not registered`);
  return def;
}

beforeEach(() => {
  resetCueLiveSessionForTest();
});

describe("cue-live session tracker", () => {
  test("starts inactive with nothing recorded", () => {
    const view = getSessionView();
    expect(view.active).toBe(false);
    expect(view.lastSeenAt).toBeNull();
    expect(view.watching).toBeNull();
    expect(view.observations).toEqual([]);
  });

  test("a look marks the session live and feeds the stream", () => {
    const t = Date.now();
    recordLook(
      {
        question: "What's on my screen?",
        answer: "You're in Figma, on the pricing frame.",
        imageWidth: 2560,
        imageHeight: 1440,
      },
      t,
    );
    const view = getSessionView(t + 1000);
    expect(view.active).toBe(true);
    expect(view.watching?.screen).toEqual({ width: 2560, height: 1440 });
    expect(view.observations[0]).toMatchObject({
      kind: "look",
      summary: "What's on my screen?",
      detail: "You're in Figma, on the pricing frame.",
      status: "done",
    });
  });

  test("goes idle after the active window and hides watching metadata", () => {
    const t = Date.now();
    recordGuidance({ appName: "Figma" }, t);
    const live = getSessionView(t + 60_000);
    expect(live.active).toBe(true);
    expect(live.watching?.appName).toBe("Figma");
    const idle = getSessionView(t + 10 * 60_000);
    expect(idle.active).toBe(false);
    // Stale "watching" metadata would claim the Mac is still being watched.
    expect(idle.watching).toBeNull();
    expect(idle.sessionStartedAt).toBeNull();
  });

  test("a long gap starts a new session clock", () => {
    const t = Date.now();
    recordGuidance({ appName: "Notes" }, t);
    recordGuidance({ appName: "Notes" }, t + 20 * 60_000);
    const view = getSessionView(t + 20 * 60_000 + 1000);
    expect(view.sessionStartedAt).toBe(new Date(t + 20 * 60_000).toISOString());
  });

  test("act steps accumulate onto one goal and finish it", () => {
    const t = Date.now();
    recordActStep(
      { goal: "Open Notes", step: 1, say: "Opening.", done: false },
      t,
    );
    recordActStep({ goal: "Open Notes", step: 2, done: true }, t + 5000);
    const view = getSessionView(t + 6000);
    expect(view.goal).toMatchObject({
      text: "Open Notes",
      step: 2,
      done: true,
    });
    expect(view.observations[0].summary).toContain("Run finished");
  });

  test("observation stream is capped", () => {
    const t = Date.now();
    for (let i = 0; i < 50; i++) {
      recordLook({ question: `q${i}` }, t + i);
    }
    expect(getSessionView(t + 100).observations.length).toBe(30);
    expect(getSessionView(t + 100).observations[0].summary).toBe("q49");
  });

  test("stop request expires unconsumed after its TTL", () => {
    const t = Date.now();
    requestRemoteStop(t);
    expect(getSessionView(t + 1000).stopPending).toBe(true);
    expect(consumeRemoteStop(t + 5 * 60_000)).toBe(false);
  });
});

describe("cue-live session routes", () => {
  test("GET cuelive/session returns the view", async () => {
    recordGuidance({ appName: "Safari" });
    const view = (await route("cuelive_session").handler(
      {},
    )) as CueLiveSessionView;
    expect(view.active).toBe(true);
    expect(view.paused).toBe(false);
    expect(view.observations[0].summary).toBe("Summoned over Safari");
  });

  test("pause holds look answers and the viewer reflects it", async () => {
    const paused = (await route("cuelive_session_pause").handler({
      body: { paused: true },
    })) as CueLiveSessionView;
    expect(paused.paused).toBe(true);

    // A look while paused is answered inertly — no model call, honest error.
    const look = (await route("cuelive_look").handler({
      body: {
        question: "What's here?",
        imageBase64: "aGk=",
        imageWidth: 100,
        imageHeight: 100,
      },
    })) as { answer: string; error?: string };
    expect(look.answer).toBe("");
    expect(look.error).toBe("Paused from your phone.");
    expect(getSessionView().observations[0].status).toBe("held");

    const resumed = (await route("cuelive_session_pause").handler({
      body: { paused: false },
    })) as CueLiveSessionView;
    expect(resumed.paused).toBe(false);
  });

  test("pause rejects a malformed body", () => {
    expect(() =>
      route("cuelive_session_pause").handler({ body: { paused: "yes" } }),
    ).toThrow("Invalid Cue Live pause request body");
  });

  test("stop ends the auto-run at its next act step", async () => {
    recordActStep({ goal: "Tidy inbox", step: 3, done: false });
    const stop = (await route("cuelive_session_stop").handler({})) as {
      stopped: boolean;
      note: string;
    };
    expect(stop.stopped).toBe(true);

    const act = (await route("cuelive_act").handler({
      body: {
        goal: "Tidy inbox",
        imageBase64: "aGk=",
        imageWidth: 100,
        imageHeight: 100,
        step: 4,
      },
    })) as { say: string | null; done: boolean; action: unknown };
    expect(act).toEqual({
      say: "Stopped from your phone.",
      done: true,
      action: null,
    });
    const view = getSessionView();
    expect(view.goal?.done).toBe(true);
    expect(view.goal?.stoppedRemotely).toBe(true);
    expect(view.stopPending).toBe(false);
  });

  test("stop with nothing in flight says so", async () => {
    const stop = (await route("cuelive_session_stop").handler({})) as {
      stopped: boolean;
      note: string;
    };
    expect(stop.stopped).toBe(false);
    expect(stop.note).toContain("No auto-run in flight");
  });

  test("paused act ends the run and says why", async () => {
    setRemotePaused(true);
    const act = (await route("cuelive_act").handler({
      body: {
        goal: "Open Notes",
        imageBase64: "aGk=",
        imageWidth: 100,
        imageHeight: 100,
        step: 1,
      },
    })) as { say: string | null; done: boolean };
    expect(act.done).toBe(true);
    expect(act.say).toBe("Paused from your phone.");
  });
});
