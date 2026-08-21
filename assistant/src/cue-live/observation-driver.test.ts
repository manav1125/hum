/**
 * The driver's decisions, which are all of the risk it carries.
 *
 * The mutation checks guard the four ways a watching loop misbehaves: watching
 * when nobody armed it, watching after being told to stop, stacking captures
 * on a slow host, and letting one failed read end the session silently.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  _resetObservationCaptureStateForTests,
  _setObservationCaptureOverridesForTests,
  startObservationCaptureSession,
  stopObservationCaptureSession,
} from "./observation-capture.js";
import { startObservationDriver } from "./observation-driver.js";

const TICK = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Arm a real session so the driver's gate reads the real thing. */
function arm(): void {
  _setObservationCaptureOverridesForTests({
    settings: { enabled: true, intervalSeconds: 0 },
  });
  startObservationCaptureSession({ durationMinutes: 5 });
}

beforeEach(() => {
  _resetObservationCaptureStateForTests();
});

afterEach(() => {
  _resetObservationCaptureStateForTests();
});

describe("it only watches while a session is armed", () => {
  test("MUTATION CHECK: an unarmed daemon is never asked for the screen", async () => {
    // The config switch alone must not start watching, and neither must the
    // driver merely existing. If this ever passes with no session, the loop
    // has become ambient surveillance by accident.
    const capture = mock(async () => null);
    const driver = startObservationDriver(capture, { intervalMs: TICK });
    await sleep(TICK * 4);
    await driver.stop();
    expect(capture).not.toHaveBeenCalled();
  });

  test("an armed session gets observed", async () => {
    arm();
    const capture = mock(async () => ({ description: "a screen" }));
    const driver = startObservationDriver(capture, { intervalMs: TICK });
    await sleep(TICK * 4);
    await driver.stop();
    expect(capture.mock.calls.length).toBeGreaterThan(0);
  });

  test("stopping the SESSION stops the watching, without stopping the driver", async () => {
    // The gate is re-read every tick on purpose: an owner who stops a session
    // must be obeyed on the next tick, not one interval after the loop
    // happened to notice.
    arm();
    const capture = mock(async () => ({ description: "a screen" }));
    const driver = startObservationDriver(capture, { intervalMs: TICK });
    await sleep(TICK * 3);
    stopObservationCaptureSession();
    const afterStop = capture.mock.calls.length;
    await sleep(TICK * 4);
    await driver.stop();
    expect(capture.mock.calls.length).toBe(afterStop);
  });
});

describe("stopping means quiet, not merely unscheduled", () => {
  test("MUTATION CHECK: stop() waits for an in-flight read to settle", async () => {
    // Returning from stop() while the host is still answering would let an
    // observation arrive after the owner asked Cue to stop looking.
    arm();
    let settled = false;
    const driver = startObservationDriver(
      async () => {
        await sleep(TICK * 3);
        settled = true;
        return null;
      },
      { intervalMs: TICK },
    );
    await sleep(TICK * 2); // let one capture start
    await driver.stop();
    expect(settled).toBe(true);
    expect(driver.running).toBe(false);
  });

  test("no further captures are requested after stop", async () => {
    arm();
    const capture = mock(async () => ({ description: "x" }));
    const driver = startObservationDriver(capture, { intervalMs: TICK });
    await sleep(TICK * 3);
    await driver.stop();
    const atStop = capture.mock.calls.length;
    await sleep(TICK * 4);
    expect(capture.mock.calls.length).toBe(atStop);
  });
});

describe("a slow or failing host does not break the loop", () => {
  test("MUTATION CHECK: captures never stack up on a slow host", async () => {
    // Scheduling the next tick on a timer regardless of the previous read
    // would queue reads behind a slow host and deliver them as a burst on
    // recovery — the opposite of an interval.
    arm();
    let concurrent = 0;
    let peak = 0;
    const driver = startObservationDriver(
      async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(TICK * 3);
        concurrent -= 1;
        return null;
      },
      { intervalMs: TICK },
    );
    await sleep(TICK * 10);
    await driver.stop();
    expect(peak).toBe(1);
  });

  test("a thrown read is survived and retried", async () => {
    arm();
    let calls = 0;
    const driver = startObservationDriver(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("host disconnected");
        return { description: "recovered" };
      },
      { intervalMs: TICK },
    );
    await sleep(TICK * 6);
    await driver.stop();
    expect(calls).toBeGreaterThan(1);
  });

  test("a null read is not an error and not an empty screen", async () => {
    // `null` means "could not look". It must not reach the capture seam,
    // where an empty description would be a claim about what was on screen.
    arm();
    const capture = mock(async () => null);
    const driver = startObservationDriver(capture, { intervalMs: TICK });
    await sleep(TICK * 4);
    await driver.stop();
    expect(capture.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("the config floor", () => {
  test("a mis-set CONFIG interval cannot make the loop spin against the gate", async () => {
    // Each observation crosses the host bridge, so a config of 0 seconds would
    // burn round-trips being told "too soon". The floor guards the config
    // path only — an explicitly passed interval is a caller who means it.
    _setObservationCaptureOverridesForTests({
      settings: { enabled: true, intervalSeconds: 0 },
    });
    startObservationCaptureSession({ durationMinutes: 5 });
    const capture = mock(async () => null);
    const driver = startObservationDriver(capture); // no explicit interval
    await sleep(150);
    await driver.stop();
    expect(capture).not.toHaveBeenCalled();
  });
});
