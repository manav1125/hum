/**
 * A demonstration must not file work items, and ambient watching must not
 * build skills.
 *
 * These are two products looking at the same screen for different reasons, and
 * the loop that drives them is shared. The separation is therefore a property
 * of how the loop is CALLED, not of anything visible in either feature, which
 * makes it exactly the kind of thing that breaks silently: a demonstration
 * that filed a todo per step would bury the owner in noise for something they
 * were doing on purpose, and nothing in either feature's own tests would fail.
 */

import { describe, expect, test } from "bun:test";

import type { ScreenObservationInput } from "../cue-live/observation-capture.js";
import { startObservationDriver } from "../cue-live/observation-driver.js";

const OBSERVATION: ScreenObservationInput = {
  description: "Opened the Billing tab",
  appName: "Safari",
  at: 1_700_000_000_000,
};

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("the driver routes observations to the sink it was given", () => {
  test("an injected sink receives the observation, and only it", async () => {
    const received: ScreenObservationInput[] = [];
    const handle = startObservationDriver(async () => OBSERVATION, {
      intervalMs: 1,
      isArmed: () => true,
      sink: (o) => received.push(o),
    });

    await settle();
    await handle.stop();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0]!.description).toBe("Opened the Billing tab");
  });

  test("a disarmed session is never looked at", async () => {
    // The gate is re-read every tick rather than captured at start, so an
    // owner who stops takes effect on the next tick, not one interval later.
    let looks = 0;
    const handle = startObservationDriver(
      async () => {
        looks += 1;
        return OBSERVATION;
      },
      { intervalMs: 1, isArmed: () => false, sink: () => {} },
    );

    await settle();
    await handle.stop();

    expect(looks).toBe(0);
  });

  test("an observation arriving after stop is not delivered", async () => {
    // A step performed after the owner said stop is not part of what they
    // chose to teach, so a slow host read that lands late must be dropped.
    const received: ScreenObservationInput[] = [];
    let release: (() => void) | undefined;
    const handle = startObservationDriver(
      () =>
        new Promise<ScreenObservationInput>((resolve) => {
          release = () => resolve(OBSERVATION);
        }),
      { intervalMs: 1, isArmed: () => true, sink: (o) => received.push(o) },
    );

    // Let one capture start, then stop while it is still outstanding.
    await settle(20);
    const stopped = handle.stop();
    release?.();
    await stopped;

    expect(received).toHaveLength(0);
  });

  test("stop waits for the in-flight read rather than returning over it", async () => {
    // Returning while the host is still answering would let a step land after
    // the owner asked us to stop watching.
    let settledAfterStop = false;
    let release: (() => void) | undefined;
    const handle = startObservationDriver(
      () =>
        new Promise<ScreenObservationInput>((resolve) => {
          release = () => {
            settledAfterStop = true;
            resolve(OBSERVATION);
          };
        }),
      { intervalMs: 1, isArmed: () => true, sink: () => {} },
    );

    await settle(20);
    const stopping = handle.stop();
    release?.();
    await stopping;

    expect(settledAfterStop).toBe(true);
    expect(handle.running).toBe(false);
  });
});
