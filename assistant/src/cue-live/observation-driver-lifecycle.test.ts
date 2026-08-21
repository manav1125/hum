/**
 * The driver's lifecycle rules.
 *
 * One driver, started when watching first begins, idle between sessions. The
 * mutation check guards the failure that would matter to a person: two drivers
 * running, which would double every capture tick and burn the session's
 * extraction budget at twice the rate the UI reports.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetObservationCaptureStateForTests,
  startObservationCaptureSession,
  stopObservationCaptureSession,
} from "./observation-capture.js";
import {
  _observationDriverStartCountForTests,
  _resetObservationDriverStartCountForTests,
  ensureObservationDriverStarted,
  isObservationDriverRunning,
  stopObservationDriver,
} from "./observation-driver-lifecycle.js";

afterEach(async () => {
  await stopObservationDriver();
  _resetObservationDriverStartCountForTests();
  _resetObservationCaptureStateForTests();
});

describe("there is exactly one driver", () => {
  test("MUTATION CHECK: starting twice does not create a second loop", async () => {
    // Two drivers would each tick the capture seam, spending the session's
    // extraction budget twice as fast as the countdown the owner is shown.
    ensureObservationDriverStarted();
    ensureObservationDriverStarted();
    ensureObservationDriverStarted();
    // Not `isObservationDriverRunning()` — a second driver would overwrite the
    // handle, so that would read `true` either way and prove nothing.
    expect(_observationDriverStartCountForTests()).toBe(1);
    expect(isObservationDriverRunning()).toBe(true);
  });

  test("it can be started again after being stopped", async () => {
    ensureObservationDriverStarted();
    await stopObservationDriver();
    expect(isObservationDriverRunning()).toBe(false);
    ensureObservationDriverStarted();
    expect(isObservationDriverRunning()).toBe(true);
    expect(_observationDriverStartCountForTests()).toBe(2);
  });
});

describe("it is not running before anyone asks to be watched", () => {
  test("a fresh daemon has no capture loop", () => {
    expect(isObservationDriverRunning()).toBe(false);
  });

  test("stopping a session leaves the idle driver in place", async () => {
    // The driver outlives a session on purpose: it re-reads the gate every
    // tick, so re-arming from any surface just works.
    startObservationCaptureSession({ durationMinutes: 5 });
    ensureObservationDriverStarted();
    stopObservationCaptureSession();
    expect(isObservationDriverRunning()).toBe(true);
  });
});
