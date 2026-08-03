/**
 * Your Cue at phone width — the one contract that matters.
 *
 * **Every leaf either navigates or states why it cannot.** Nine surfaces are
 * genuinely better with a keyboard and design's ruling is that the phone names
 * them rather than hiding them; the failure mode this guards is the other one,
 * a row that renders, looks live, and lands nowhere. The phone shipped exactly
 * that once — Preferences rows that navigated to a page which immediately
 * `<Navigate>`d back where you came from.
 *
 * These are model tests, not render tests, on purpose: the rule is a property
 * of the model, so it can be checked without standing up a router, and it
 * cannot be satisfied by a component that happens to render the right thing
 * today.
 */

import { describe, expect, test } from "bun:test";

import {
  YOUR_CUE_GROUPS,
  YOUR_CUE_LEAVES,
} from "@/components/nav/your-cue-model";
import { routes } from "@/utils/routes";

import {
  CUE_SCREEN_GROUPS,
  LEAF_GLYPH,
  phoneLeafState,
  visibleLeaves,
} from "./your-cue-mobile";

describe("every leaf either navigates or states why it cannot", () => {
  test.each(YOUR_CUE_LEAVES.map((l) => [l.key, l] as const))(
    "%s resolves",
    (_key, leaf) => {
      const state = phoneLeafState(leaf);
      if (state.state === "open") {
        expect(state.to.startsWith("/")).toBe(true);
      } else {
        // A badge with no sentence is a dead row that also wastes a glance.
        expect(state.badge.length).toBeGreaterThan(0);
        expect(state.reason.length).toBeGreaterThan(20);
      }
    },
  );

  test("no leaf is silently dropped", () => {
    // Hiding a surface is the alternative design explicitly rejected: "named,
    // not hidden".
    for (const leaf of YOUR_CUE_LEAVES) {
      expect(phoneLeafState(leaf)).toBeDefined();
      expect(LEAF_GLYPH[leaf.key]).toBeDefined();
    }
  });

  test("no two leaves wear the same glyph", () => {
    // Two rows with one mark is a list you have to read twice.
    const glyphs = YOUR_CUE_LEAVES.map((l) => LEAF_GLYPH[l.key]);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  test("a closed reason is a sentence, not a TODO", () => {
    const closed = YOUR_CUE_LEAVES.map(phoneLeafState).filter(
      (s) => s.state === "closed",
    );
    expect(closed.length).toBeGreaterThan(0);
    for (const state of closed) {
      if (state.state !== "closed") continue;
      expect(/^(TBD|TODO|Coming soon)/i.test(state.reason)).toBe(false);
      expect(state.reason.trim().endsWith(".")).toBe(true);
    }
  });
});

describe("what closes, and why", () => {
  test("Cue Live is Mac only, in design's own words", () => {
    const leaf = YOUR_CUE_LEAVES.find((l) => l.key === "cue-live")!;
    const state = phoneLeafState(leaf);
    expect(state).toMatchObject({ state: "closed", badge: "Mac only" });
  });

  test("Watching admits it does not exist on ANY platform", () => {
    // The shared model's own `to: null` wins over any phone judgement: a
    // surface nobody has built is not a phone limitation, and describing it as
    // one would send someone to a desktop that also does not have it.
    const leaf = YOUR_CUE_LEAVES.find((l) => l.key === "watching")!;
    const state = phoneLeafState(leaf);
    expect(state.state).toBe("closed");
    if (state.state === "closed") expect(state.badge).toBe("Not built");
  });

  test.each(["marketplace", "agent-network"])(
    "%s says desktop rather than pointing at a lookalike",
    (key) => {
      const leaf = YOUR_CUE_LEAVES.find((l) => l.key === key)!;
      expect(phoneLeafState(leaf).state).toBe("closed");
    },
  );

  test.each([
    "schedules",
    "models",
    "usage",
    "preferences",
    "brand",
    "system-access",
    "plugins",
  ])("%s navigates — the phone HAS this screen", (key) => {
    // Six of design's nine already had touch-native screens
    // (`mobile-settings-leafs.tsx`, `mobile-usage-page.tsx`,
    // `mobile-v3/you/plugins-page.tsx`). Marking them "Mac only" would delete
    // working function to satisfy a list, which is its own kind of lie.
    const leaf = YOUR_CUE_LEAVES.find((l) => l.key === key)!;
    expect(phoneLeafState(leaf).state).toBe("open");
  });
});

describe("the two leaves whose phone destination differs", () => {
  test("Channels goes to the workbench, not to the hub's old URL", () => {
    // `/assistant/channels` is where the phone's hub used to live and now
    // redirects; sending the leaf there would be a row that loops you back to
    // the screen you tapped it on.
    const leaf = YOUR_CUE_LEAVES.find((l) => l.key === "channels")!;
    const state = phoneLeafState(leaf);
    expect(state).toEqual({ state: "open", to: routes.contacts.root });
    expect(state.state === "open" && state.to).not.toBe(routes.channels);
  });
});

describe("the ⓶ screen shows a subset, and the rest is one tap away", () => {
  test("its groups are real groups from the shared model", () => {
    for (const key of CUE_SCREEN_GROUPS) {
      expect(YOUR_CUE_GROUPS.some((g) => g.key === key)).toBe(true);
    }
  });

  test("it is a subset — the full list is a separate screen", () => {
    expect(CUE_SCREEN_GROUPS.length).toBeLessThan(YOUR_CUE_GROUPS.length);
  });
});

describe("flag-gated leaves", () => {
  test("eighteen leaves with both flags off — the number design ruled on", () => {
    expect(
      visibleLeaves({ externalPlugins: false, marketplace: false }),
    ).toHaveLength(18);
  });

  test("twenty with both on", () => {
    expect(
      visibleLeaves({ externalPlugins: true, marketplace: true }),
    ).toHaveLength(20);
  });
});
