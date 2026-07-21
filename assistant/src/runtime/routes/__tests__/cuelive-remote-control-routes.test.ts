/**
 * Route-level guarantees for the Cue Live remote-control surface: the trust
 * dial really does cap what the web can do, the stream is really opt-in, and
 * stopping really does cut the picture. The pure gate is covered in
 * cuelive-input-policy.test.ts; this file proves the wiring honours it.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../../../memory/db-init.js";
import { updateCompanyProfile } from "../../../missions/mission-store.js";
import { resetCueLiveRelayForTest } from "../cuelive-input-relay.js";
import { ROUTES } from "../cuelive-routes.js";
import { resetCueLiveSessionForTest } from "../cuelive-session.js";
import {
  armStream,
  getStreamStatus,
  pushFrame,
  resetCueLiveStreamForTest,
  takeFrame,
} from "../cuelive-stream.js";
import type { RouteHandlerArgs } from "../types.js";

initializeDb();

function route(operationId: string) {
  const def = ROUTES.find((r) => r.operationId === operationId);
  if (!def) throw new Error(`route ${operationId} not registered`);
  return def;
}

function call(operationId: string, body?: Record<string, unknown>) {
  return route(operationId).handler({ body } as RouteHandlerArgs);
}

const FRAME = {
  dataBase64: "a".repeat(2_000),
  mediaType: "image/jpeg",
  width: 1280,
  height: 800,
  screenWidth: 1710,
  screenHeight: 1069,
  appName: "Figma",
};

beforeEach(() => {
  resetCueLiveSessionForTest();
  resetCueLiveStreamForTest();
  resetCueLiveRelayForTest();
  updateCompanyProfile({ workspaceMode: "assist" });
});

describe("screen stream routes", () => {
  test("the stream is off until something explicitly arms it", async () => {
    const status = (await call("cuelive_session_stream")) as {
      state: string;
      armed: boolean;
    };
    expect(status.state).toBe("off");
    expect(status.armed).toBe(false);
  });

  test("arming from the web, then stopping from the Mac", async () => {
    const armed = (await call("cuelive_session_stream_set", {
      streaming: true,
      origin: "web",
    })) as { armed: boolean; armedBy: string };
    expect(armed.armed).toBe(true);
    expect(armed.armedBy).toBe("web");

    const stopped = (await call("cuelive_session_stream_set", {
      streaming: false,
      origin: "mac",
    })) as { armed: boolean; lastStopReason: string | null };
    expect(stopped.armed).toBe(false);
    expect(stopped.lastStopReason).toBe("Stopped on your Mac.");
  });

  test("a frame push while disarmed is refused and stores nothing", async () => {
    const result = (await call("cuelive_session_frame_push", FRAME)) as {
      streaming: boolean;
    };
    expect(result.streaming).toBe(false);
    const read = (await call("cuelive_session_frame")) as {
      frame: unknown | null;
    };
    expect(read.frame).toBeNull();
  });

  test("Stop cuts the picture as well as the run", async () => {
    armStream("web");
    pushFrame(FRAME);
    expect(takeFrame().frame).not.toBeNull();

    await call("cuelive_session_takeover", { armed: true });
    const stop = (await call("cuelive_session_stop")) as {
      session: { stream: { armed: boolean }; takeover: { armed: boolean } };
    };
    expect(stop.session.stream.armed).toBe(false);
    expect(stop.session.takeover.armed).toBe(false);
    expect(getStreamStatus().state).toBe("off");
  });
});

describe("input relay routes honour the trust dial", () => {
  test("Observe refuses to arm take over at all", async () => {
    updateCompanyProfile({ workspaceMode: "observe" });
    const result = (await call("cuelive_session_takeover", {
      armed: true,
    })) as { takeover: { armed: boolean }; refused?: string };
    expect(result.takeover.armed).toBe(false);
    expect(result.refused).toContain("Observe");
  });

  test("Observe refuses relayed input even with a live frame", async () => {
    armStream("web");
    pushFrame(FRAME);
    updateCompanyProfile({ workspaceMode: "observe" });
    const result = (await call("cuelive_session_input", {
      kind: "click",
      x: 100,
      y: 100,
    })) as { performed: boolean; refused?: string };
    expect(result.performed).toBe(false);
    expect(result.refused).toContain("Observe");
  });

  test("Assist allows arming, but input still needs a live frame", async () => {
    const armed = (await call("cuelive_session_takeover", {
      armed: true,
    })) as { takeover: { armed: boolean }; refused?: string };
    expect(armed.refused).toBeUndefined();
    expect(armed.takeover.armed).toBe(true);

    const result = (await call("cuelive_session_input", {
      kind: "click",
      x: 10,
      y: 10,
    })) as { performed: boolean; refused?: string };
    expect(result.performed).toBe(false);
    expect(result.refused).toContain("live frame");
  });

  test("input without an armed take over is refused, not relayed", async () => {
    armStream("web");
    pushFrame(FRAME);
    const result = (await call("cuelive_session_input", {
      kind: "type",
      text: "hello",
    })) as { performed: boolean; refused?: string };
    expect(result.performed).toBe(false);
    expect(result.refused).toContain("Take over isn't armed");
  });
});

describe("the auto-run loop is capped by the same dial", () => {
  test("Observe ends a take-control run before it touches the mouse", async () => {
    updateCompanyProfile({ workspaceMode: "observe" });
    const result = (await call("cuelive_act", {
      goal: "open my inbox",
      imageBase64: "x",
      imageWidth: 1280,
      imageHeight: 800,
      step: 1,
    })) as { done: boolean; action: unknown | null; say: string | null };
    expect(result.done).toBe(true);
    expect(result.action).toBeNull();
    expect(result.say).toContain("Observe");
  });
});
