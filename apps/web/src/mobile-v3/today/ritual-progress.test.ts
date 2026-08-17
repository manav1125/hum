/**
 * The slot's memory — the two things that make "Later" mean *later* rather
 * than *never*.
 *
 * The period key is the whole mechanism: dismiss today's brief and tomorrow's
 * asks again, with nothing having to reset anything. A boolean would have been
 * a switch somebody has to remember to flip, and the day it is not flipped the
 * ritual is silently gone.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  dismissRitual,
  markRitualRead,
  periodKey,
  readRitualProgress,
} from "./ritual-progress";

const at = (day: number, hour = 9) => new Date(2026, 7, day, hour, 0, 0);

beforeEach(() => localStorage.clear());

describe("period keys", () => {
  test("the brief's period is the local day", () => {
    expect(periodKey("brief", at(19))).toBe("2026-08-19");
    // Late enough that a UTC-based key would already have rolled over.
    expect(periodKey("brief", new Date(2026, 7, 19, 23, 30))).toBe(
      "2026-08-19",
    );
  });

  test("Friday, Saturday and Sunday are ONE weekly period", () => {
    const friday = periodKey("weekly", at(21, 13));
    expect(friday).toBe("2026-08-21");
    expect(periodKey("weekly", at(22))).toBe(friday); // Saturday
    expect(periodKey("weekly", at(23))).toBe(friday); // Sunday
  });
});

describe("what it remembers", () => {
  test("dismissing today does not dismiss tomorrow", () => {
    dismissRitual("brief", at(19));
    expect(readRitualProgress("brief", at(19))).toEqual({
      read: false,
      dismissed: true,
    });
    expect(readRitualProgress("brief", at(20))).toEqual({
      read: false,
      dismissed: false,
    });
  });

  test("dismissing on Friday keeps the review quiet on Sunday", () => {
    dismissRitual("weekly", at(21, 13));
    expect(readRitualProgress("weekly", at(23)).dismissed).toBe(true);
  });

  test("read and dismissed accumulate rather than overwrite", () => {
    dismissRitual("brief", at(19));
    markRitualRead("brief", at(19));
    expect(readRitualProgress("brief", at(19))).toEqual({
      read: true,
      dismissed: true,
    });
  });

  test("a write prunes its own older periods", () => {
    dismissRitual("brief", at(17));
    dismissRitual("brief", at(18));
    markRitualRead("brief", at(19));
    const briefKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith("cue.mv3.ritual.brief."),
    );
    expect(briefKeys).toEqual(["cue.mv3.ritual.brief.2026-08-19"]);
  });

  test("the two rituals do not prune each other", () => {
    dismissRitual("weekly", at(21, 13));
    markRitualRead("brief", at(21, 8));
    expect(readRitualProgress("weekly", at(21, 13)).dismissed).toBe(true);
    expect(readRitualProgress("brief", at(21, 8)).read).toBe(true);
  });

  test("a corrupt entry reads as not-done rather than throwing", () => {
    localStorage.setItem("cue.mv3.ritual.brief.2026-08-19", "{not json");
    expect(readRitualProgress("brief", at(19))).toEqual({
      read: false,
      dismissed: false,
    });
  });
});
