/**
 * The two push budgets must not drift.
 *
 * Design's ceiling is enforced twice, because two layers can each reach the
 * phone and neither can see the other: the web client gates *local*
 * notifications fired from an SSE event (`apps/web/src/mobile-v3/states/
 * push-budget.ts`), and this daemon composes and sends *remote* APNs pushes
 * that never enter the client at all.
 *
 * Nothing in the type system connects them — the web app builds from a
 * generated daemon SDK, not from this source tree — so this test is the
 * connection. It reads the client module and asserts that the numbers and the
 * vocabulary are identical. Change either one and this goes red, which is the
 * point: two ceilings that quietly disagree are worse than one.
 *
 * It asserts the SHARED rule only. One divergence is deliberate and is pinned
 * below with its reasoning.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  CORRECTION_EVENTS,
  PUSH_DAILY_CEILING,
  TIME_CRITICAL_EVENTS,
} from "../push-budget.js";

const CLIENT_MODULE = join(
  import.meta.dir,
  "../../../../apps/web/src/mobile-v3/states/push-budget.ts",
);

function clientSource(): string {
  if (!existsSync(CLIENT_MODULE)) {
    throw new Error(
      `The client push budget was not found at ${CLIENT_MODULE}. ` +
        "If it moved, point this test at the new path — do not delete it: " +
        "it is the only thing keeping the daemon's ceiling and the client's " +
        "from drifting apart.",
    );
  }
  return readFileSync(CLIENT_MODULE, "utf-8");
}

/** Pull the string literals out of a `const NAME = [ ... ]` declaration. */
function stringArray(source: string, name: string): string[] {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!match) throw new Error(`could not find ${name} in the client module`);
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("daemon and client push budgets agree", () => {
  test("the ceiling is the same number in both", () => {
    const match = /PUSH_DAILY_CEILING\s*=\s*(\d+)/.exec(clientSource());
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(PUSH_DAILY_CEILING);
  });

  test("the three tiers are named the same in both", () => {
    const match = /export type PushTier =([^;]+);/.exec(clientSource());
    expect(match).not.toBeNull();
    const clientTiers = [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(clientTiers.sort()).toEqual(
      ["ambient", "correction", "time_critical"].sort(),
    );
  });

  test("an event Cue admits a mistake with tiers the same in both", () => {
    expect(stringArray(clientSource(), "CORRECTION_EVENTS").sort()).toEqual(
      [...CORRECTION_EVENTS].sort(),
    );
  });

  test("an event with a clock on it tiers the same in both", () => {
    expect(stringArray(clientSource(), "TIME_CRITICAL_EVENTS").sort()).toEqual(
      [...TIME_CRITICAL_EVENTS].sort(),
    );
  });
});

describe("the one pinned divergence", () => {
  /**
   * Design §5 grants the quiet-hours exemption to the correction tier alone:
   * "a correction that breaks quiet hours · one time-critical approval with
   * Send it inline · the 7:30 brief". The daemon implements exactly that. The
   * client currently also lets `time_critical` through a quiet window — it
   * returns a decision for that tier BEFORE it tests `quietNow`.
   *
   * The daemon is the layer that can wake a phone at 3am, so it follows design
   * rather than following the client. This test pins the divergence so it
   * cannot be forgotten: when the client is brought in line, this goes red and
   * whoever fixed it deletes the pin.
   */
  test("the client still lets time_critical break quiet hours", () => {
    const source = clientSource();
    const timeCriticalBranch = source.indexOf('if (tier === "time_critical")');
    const quietBranch = source.indexOf("if (quietNow) {");
    expect(timeCriticalBranch).toBeGreaterThan(-1);
    expect(quietBranch).toBeGreaterThan(-1);
    expect(timeCriticalBranch).toBeLessThan(quietBranch);
  });
});
