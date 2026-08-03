/**
 * The toggle: what it remembers, and when the chord is allowed to fire.
 *
 * The keyboard test is the load-bearing one. `⌘.` toggling while somebody is
 * mid-sentence in the capture bar would be a control that fights the surface it
 * belongs to, so the guard checks the event target — and a guard about typing
 * has to be tested by actually typing into something.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_DENSITY,
  isToggleChord,
  readDensity,
} from "./hq-density";

function chord(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: ".",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: document.body,
    ...over,
  } as unknown as KeyboardEvent;
}

describe("remembered per device", () => {
  beforeEach(() => localStorage.clear());

  test("lands on Glance — the 30-second check is the default", () => {
    expect(readDensity()).toBe("glance");
    expect(DEFAULT_DENSITY).toBe("glance");
  });

  test("reads back a stored choice", () => {
    localStorage.setItem("cue.hq.density", "deck");
    expect(readDensity()).toBe("deck");
  });

  test("a corrupted value falls back rather than rendering nothing", () => {
    localStorage.setItem("cue.hq.density", "hologram");
    expect(readDensity()).toBe("glance");
  });
});

describe("the ⌘. chord", () => {
  test("fires on meta and on ctrl", () => {
    expect(isToggleChord(chord())).toBe(true);
    expect(isToggleChord(chord({ metaKey: false, ctrlKey: true }))).toBe(true);
  });

  test("ignores a bare period, and the modified variants", () => {
    expect(isToggleChord(chord({ metaKey: false }))).toBe(false);
    expect(isToggleChord(chord({ shiftKey: true }))).toBe(false);
    expect(isToggleChord(chord({ altKey: true }))).toBe(false);
    expect(isToggleChord(chord({ key: "," }))).toBe(false);
  });

  test("never fires while the owner is typing", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isToggleChord(chord({ target: input }))).toBe(false);
    expect(isToggleChord(chord({ target: textarea }))).toBe(false);
    expect(isToggleChord(chord({ target: editable }))).toBe(false);
  });
});
