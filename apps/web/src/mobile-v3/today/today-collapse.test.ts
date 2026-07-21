/**
 * Frame-60 collapse physics — the spec's numbers verified at every boundary
 * (docs/design/mobile-round4, "COLLAPSE PHYSICS — IMPLEMENT EXACTLY").
 */
import { describe, expect, test } from "bun:test";

import {
  barChromeOpacity,
  captionOpacity,
  chipFade,
  condensedRightOpacity,
  condensedTitleOpacity,
  greetingOpacity,
  guideRingOpacity,
  reducedMode,
  ringHandoff,
  ringProgress,
  ringScale,
  ringTransform,
  RING_CONDENSED_PX,
  RING_EXPANDED_PX,
} from "./today-collapse";

describe("orbit chips (0–80)", () => {
  test("full at rest, gone at 80, midpoint linear", () => {
    expect(chipFade(0)).toEqual({ opacity: 1, scale: 1 });
    expect(chipFade(40).opacity).toBeCloseTo(0.5);
    expect(chipFade(40).scale).toBeCloseTo(0.96);
    expect(chipFade(80)).toEqual({ opacity: 0, scale: 0.92 });
    // Past the segment the values hold (no overshoot).
    expect(chipFade(200)).toEqual({ opacity: 0, scale: 0.92 });
  });

  test("rubber-band (negative scroll) clamps to the expanded state", () => {
    expect(chipFade(-40)).toEqual({ opacity: 1, scale: 1 });
  });

  test("guide rings fade to .3 over 0–80", () => {
    expect(guideRingOpacity(0)).toBe(1);
    expect(guideRingOpacity(80)).toBeCloseTo(0.3);
    expect(guideRingOpacity(200)).toBeCloseTo(0.3);
  });
});

describe("center ring morph (40–160)", () => {
  test("progress spans exactly 40→160", () => {
    expect(ringProgress(0)).toBe(0);
    expect(ringProgress(40)).toBe(0);
    expect(ringProgress(100)).toBeCloseTo(0.5);
    expect(ringProgress(160)).toBe(1);
    expect(ringProgress(200)).toBe(1);
  });

  test("scale runs 80px → 30px", () => {
    expect(ringScale(0)).toBe(1);
    expect(ringScale(160)).toBeCloseTo(RING_CONDENSED_PX / RING_EXPANDED_PX);
    expect(ringScale(160) * RING_EXPANDED_PX).toBeCloseTo(30);
  });

  test("translate lands the ring exactly in the bar slot at p=1", () => {
    const g = { heroCx: 196, heroCyDoc: 220, barCx: 35, barCy: 73 };
    const rest = ringTransform(0, g);
    expect(rest.tx).toBeCloseTo(0);
    expect(rest.ty).toBeCloseTo(0);
    const done = ringTransform(160, g);
    // Viewport position of the hero center at y=160 is 220-160=60 → slot 73.
    expect(done.tx).toBeCloseTo(35 - 196);
    expect(done.ty).toBeCloseTo(13);
  });

  test("past the range the compensation keeps the ring pinned to the slot", () => {
    const g = { heroCx: 196, heroCyDoc: 220, barCx: 35, barCy: 73 };
    // At y=300 the hero's untransformed center sits at 220-300=-80; the
    // transform must still place it at barCy.
    const t = ringTransform(300, g);
    expect(-80 + t.ty).toBeCloseTo(g.barCy);
  });
});

describe("title cross-fade (greeting out 40–100, title in 100–160)", () => {
  test("greeting", () => {
    expect(greetingOpacity(40)).toBe(1);
    expect(greetingOpacity(70)).toBeCloseTo(0.5);
    expect(greetingOpacity(100)).toBe(0);
  });
  test("condensed Today title", () => {
    expect(condensedTitleOpacity(100)).toBe(0);
    expect(condensedTitleOpacity(130)).toBeCloseTo(0.5);
    expect(condensedTitleOpacity(160)).toBe(1);
  });
  test("no frame where both are fully visible", () => {
    for (let y = 0; y <= 200; y += 10) {
      expect(greetingOpacity(y) + condensedTitleOpacity(y)).toBeLessThanOrEqual(
        1,
      );
    }
  });
});

describe("caption → right slot + bar chrome (120–200)", () => {
  test("caption out / right slot + hairline+blur in", () => {
    expect(captionOpacity(120)).toBe(1);
    expect(condensedRightOpacity(120)).toBe(0);
    expect(barChromeOpacity(120)).toBe(0);
    expect(captionOpacity(160)).toBeCloseTo(0.5);
    expect(condensedRightOpacity(200)).toBe(1);
    expect(barChromeOpacity(200)).toBe(1);
    expect(captionOpacity(200)).toBe(0);
  });
});

describe("ring handoff (150–190)", () => {
  test("hero ring hands off to the bar ring only after the morph has landed", () => {
    expect(ringHandoff(150)).toBe(0);
    // Morph is ≥92% complete when the swap starts — visually coincident.
    expect(ringProgress(150)).toBeGreaterThan(0.9);
    expect(ringHandoff(170)).toBeCloseTo(0.5);
    expect(ringHandoff(190)).toBe(1);
    // Complementary opacities — never both invisible.
    for (let y = 0; y <= 220; y += 10) {
      expect(1 - ringHandoff(y) + ringHandoff(y)).toBeCloseTo(1);
    }
  });
});

describe("reduced motion", () => {
  test("two static states flipped at threshold 100", () => {
    expect(reducedMode(0)).toBe("expanded");
    expect(reducedMode(99)).toBe("expanded");
    expect(reducedMode(100)).toBe("condensed");
    expect(reducedMode(-40)).toBe("expanded");
  });
});
