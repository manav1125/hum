import { describe, expect, test } from "bun:test";

import {
  dialAllowsCueLiveAction,
  evaluateInputRelay,
  type InputRelayContext,
} from "../cuelive-input-policy.js";
import { scalePoint, toolNameForAction } from "../cuelive-input-relay.js";

const ready: InputRelayContext = {
  dial: "autonomous",
  takeoverArmed: true,
  liveFrame: true,
  paused: false,
};

describe("cue live input relay — the trust dial is the ceiling", () => {
  test("Observe forbids acting on every surface", () => {
    expect(dialAllowsCueLiveAction("observe")).toBe(false);
    expect(dialAllowsCueLiveAction("assist")).toBe(true);
    expect(dialAllowsCueLiveAction("autonomous")).toBe(true);
  });

  test("web input cannot bypass an Observe dial, however armed it is", () => {
    const decision = evaluateInputRelay({ ...ready, dial: "observe" });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.code).toBe("trust_dial");
    expect(decision.reason).toContain("Observe");
  });

  test("the dial is checked before anything else, so the refusal names it", () => {
    const decision = evaluateInputRelay({
      dial: "observe",
      takeoverArmed: false,
      liveFrame: false,
      paused: true,
    });
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.code).toBe("trust_dial");
  });

  test("Assist and Autonomous both permit attended steering", () => {
    expect(evaluateInputRelay({ ...ready, dial: "assist" }).allowed).toBe(true);
    expect(evaluateInputRelay({ ...ready, dial: "autonomous" }).allowed).toBe(
      true,
    );
  });
});

describe("cue live input relay — no implicit input channel", () => {
  test("an unarmed take over refuses input", () => {
    const decision = evaluateInputRelay({ ...ready, takeoverArmed: false });
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.code).toBe("takeover_not_armed");
  });

  test("you may not steer a screen you cannot see", () => {
    const decision = evaluateInputRelay({ ...ready, liveFrame: false });
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.code).toBe("no_live_frame");
  });

  test("a paused session refuses input", () => {
    const decision = evaluateInputRelay({ ...ready, paused: true });
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.code).toBe("paused");
  });
});

describe("cue live input relay — gesture translation", () => {
  test("every gesture maps onto an existing computer-use tool", () => {
    expect(toolNameForAction("click")).toBe("computer_use_click");
    expect(toolNameForAction("double_click")).toBe("computer_use_double_click");
    expect(toolNameForAction("type")).toBe("computer_use_type_text");
    expect(toolNameForAction("key")).toBe("computer_use_key");
    expect(toolNameForAction("scroll")).toBe("computer_use_scroll");
  });

  test("frame pixels scale onto screen points and clamp to the display", () => {
    const geometry = {
      width: 1280,
      height: 800,
      screenWidth: 1710,
      screenHeight: 1069,
    };
    expect(scalePoint({ x: 640, y: 400 }, geometry)).toEqual({
      x: 855,
      y: 535,
    });
    expect(scalePoint({ x: -50, y: 99_999 }, geometry)).toEqual({
      x: 0,
      y: 1069,
    });
  });
});
