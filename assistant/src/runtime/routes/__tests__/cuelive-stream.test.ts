import { beforeEach, describe, expect, test } from "bun:test";

import {
  __testing,
  armStream,
  disarmStream,
  getLiveFrameGeometry,
  getStreamStatus,
  MAX_FRAME_BASE64_BYTES,
  pushFrame,
  resetCueLiveStreamForTest,
  takeFrame,
} from "../cuelive-stream.js";

const T0 = 1_800_000_000_000;

function frame(overrides: Partial<Parameters<typeof pushFrame>[0]> = {}) {
  return {
    dataBase64: "a".repeat(40_000),
    mediaType: "image/jpeg",
    width: 1280,
    height: 800,
    screenWidth: 1710,
    screenHeight: 1069,
    appName: "Figma",
    ...overrides,
  };
}

beforeEach(() => {
  resetCueLiveStreamForTest();
});

describe("cue live stream — opt-in", () => {
  test("starts off and holds no frame", () => {
    const status = getStreamStatus(T0);
    expect(status.state).toBe("off");
    expect(status.armed).toBe(false);
    expect(takeFrame(T0).frame).toBeNull();
  });

  test("a push while disarmed is dropped and tells the Mac to stop", () => {
    const result = pushFrame(frame(), T0);
    expect(result.streaming).toBe(false);
    expect(takeFrame(T0).frame).toBeNull();
    expect(getStreamStatus(T0).state).toBe("off");
  });

  test("arming alone does not conjure a frame", () => {
    armStream("web", T0);
    const status = getStreamStatus(T0);
    expect(status.armed).toBe(true);
    expect(status.state).toBe("starting");
    expect(takeFrame(T0).frame).toBeNull();
  });
});

describe("cue live stream — state machine", () => {
  test("armed → starting → live → stalled", () => {
    armStream("web", T0);
    expect(getStreamStatus(T0).state).toBe("starting");

    pushFrame(frame(), T0 + 500);
    expect(getStreamStatus(T0 + 600).state).toBe("live");

    // Keep a viewer attached so the stall (not the unwatched timeout) fires.
    takeFrame(T0 + 5_000);
    expect(getStreamStatus(T0 + 5_100).state).toBe("live");
    takeFrame(T0 + 10_000);
    expect(getStreamStatus(T0 + 10_100).state).toBe("stalled");
  });

  test("a frame older than the TTL is never served as live", () => {
    armStream("web", T0);
    pushFrame(frame(), T0);
    expect(takeFrame(T0 + 1_000).frame).not.toBeNull();
    const stale = takeFrame(T0 + __testing.FRAME_TTL_MS + 1);
    expect(stale.frame).toBeNull();
  });

  test("stop from either side drops the held frame", () => {
    armStream("web", T0);
    pushFrame(frame(), T0);
    const status = disarmStream("mac", T0 + 100);
    expect(status.state).toBe("off");
    expect(status.lastStopReason).toBe("Stopped on your Mac.");
    expect(takeFrame(T0 + 200).frame).toBeNull();
  });

  test("a stream nobody reads from stops itself", () => {
    armStream("web", T0);
    pushFrame(frame(), T0);
    const later = T0 + __testing.VIEWER_TIMEOUT_MS + 1;
    const status = getStreamStatus(later);
    expect(status.armed).toBe(false);
    expect(status.lastStopReason).toBe("Stopped — nobody was watching.");
    // And the Mac is told to stop on its next push.
    expect(pushFrame(frame(), later).streaming).toBe(false);
  });

  test("reading a frame keeps the stream alive past the unwatched timeout", () => {
    armStream("web", T0);
    pushFrame(frame(), T0);
    takeFrame(T0 + 15_000);
    pushFrame(frame(), T0 + 15_500);
    expect(getStreamStatus(T0 + 16_000).armed).toBe(true);
  });
});

describe("cue live stream — bandwidth negotiation", () => {
  test("a small frame gets a fast cadence, a big one gets backed off", () => {
    armStream("web", T0);
    const small = pushFrame(frame({ dataBase64: "a".repeat(20_000) }), T0);
    expect(small.intervalMs).toBe(__testing.MIN_INTERVAL_MS);

    takeFrame(T0 + 100);
    const big = pushFrame(frame({ dataBase64: "a".repeat(600_000) }), T0 + 200);
    expect(big.intervalMs).toBe(__testing.MAX_INTERVAL_MS);
    expect(big.maxWidth).toBeLessThan(small.maxWidth);
  });

  test("an oversized frame is refused rather than stored", () => {
    armStream("web", T0);
    const result = pushFrame(
      frame({ dataBase64: "a".repeat(MAX_FRAME_BASE64_BYTES + 1) }),
      T0,
    );
    expect(result.rejected).toBe("frame too large");
    expect(result.streaming).toBe(true);
    expect(takeFrame(T0).frame).toBeNull();
  });
});

describe("cue live stream — geometry for input mapping", () => {
  test("geometry is exposed only while a frame is live", () => {
    expect(getLiveFrameGeometry(T0)).toBeNull();
    armStream("web", T0);
    expect(getLiveFrameGeometry(T0)).toBeNull();
    pushFrame(frame(), T0);
    expect(getLiveFrameGeometry(T0 + 100)).toEqual({
      width: 1280,
      height: 800,
      screenWidth: 1710,
      screenHeight: 1069,
    });
    disarmStream("web", T0 + 200);
    expect(getLiveFrameGeometry(T0 + 300)).toBeNull();
  });
});
