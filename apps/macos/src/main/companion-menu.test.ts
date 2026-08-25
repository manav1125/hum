import { describe, expect, test } from "bun:test";

import {
  buildCompanionMenu,
  type CompanionMenuItem,
  type CompanionMenuState,
} from "./companion-menu";

/**
 * The right-click menu — design `C5`.
 *
 * The rule worth a test rather than a review is that **hide is never buried**.
 * It is the kind of rule that survives the first version and quietly dies the
 * third time somebody tidies the menu, and its failure mode is a user who
 * cannot make an uninvited guest leave.
 */

const state = (patch: Partial<CompanionMenuState> = {}): CompanionMenuState => ({
  size: "medium",
  blink: "calm",
  weight: "regular",
  quietHours: { start: "22:00", end: "07:30" },
  watching: false,
  ...patch,
});

const labels = (items: CompanionMenuItem[]): string[] =>
  items.filter((i) => i.label).map((i) => i.label as string);

describe("hide is never buried", () => {
  test("both hide options sit at the top level", () => {
    const top = labels(buildCompanionMenu(state()));
    expect(top).toContain("Hide until tomorrow");
    expect(top).toContain("Hide Cue");
  });

  test("neither is hidden inside a submenu", () => {
    for (const item of buildCompanionMenu(state())) {
      for (const sub of item.submenu ?? []) {
        expect(sub.label ?? "").not.toContain("Hide");
      }
    }
  });

  test("leaving carries no confirmation and no guilt copy", () => {
    const hide = buildCompanionMenu(state()).find(
      (i) => i.label === "Hide Cue",
    );
    // Just the way back, stated plainly.
    expect(hide?.sublabel).toBe("bring back from the menu bar");
  });
});

describe("reading a window is an explicit act, and stoppable from the same row", () => {
  test("off: it asks first, and says so", () => {
    const read = buildCompanionMenu(state()).find(
      (i) => i.label === "Read this window",
    );
    expect(read?.sublabel).toBe("asks first");
  });

  test("on: the same row is what stops it", () => {
    // The thing you look for when you want it to stop is the thing that
    // started it.
    const top = labels(buildCompanionMenu(state({ watching: true })));
    expect(top).toContain("Stop reading this window");
    expect(top).not.toContain("Read this window");
  });
});

describe("what is currently chosen is visible without opening anything", () => {
  test("the size row names the current size and checks it in the submenu", () => {
    const size = buildCompanionMenu(state({ size: "huge" })).find(
      (i) => i.label === "Size",
    );
    expect(size?.sublabel).toBe("huge");
    expect(size?.submenu?.find((i) => i.checked)?.label).toBe("Huge");
  });

  test("the joke size is a real size, offered like the others", () => {
    const size = buildCompanionMenu(state()).find((i) => i.label === "Size");
    expect(labels(size?.submenu ?? [])).toContain("Ridiculous");
  });

  test("character names itself by the trait you can see at a glance", () => {
    const character = buildCompanionMenu(state({ blink: "lively" })).find(
      (i) => i.label === "Character",
    );
    expect(character?.sublabel).toBe("lively");
    // Three traits, composed live — the ring weight lives in the same submenu.
    expect(labels(character?.submenu ?? [])).toContain("Bold ring");
  });

  test("quiet hours off says off, rather than showing hours that do not apply", () => {
    const quiet = buildCompanionMenu(state({ quietHours: null })).find(
      (i) => i.label === "Quiet hours",
    );
    expect(quiet?.sublabel).toBe("off");
    expect(quiet?.submenu?.find((i) => i.label === "Off")?.checked).toBe(true);
  });
});
