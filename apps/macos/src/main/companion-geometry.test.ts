import { describe, expect, test } from "bun:test";

import {
  COMPANION_NEAR_EDGE,
  COMPANION_SIZE_BOXES,
  avatarCentreOf,
  cardGrowthFor,
  geometryFor,
  growthFor,
  placeCanvas,
} from "./companion-geometry";

/**
 * The geometry, and the two properties every one of upstream's placement bugs
 * came down to.
 *
 * This is worth testing rather than eyeballing because the failures are not
 * subtle-looking-but-harmless: a canvas that is wrong about where its creature
 * is renders an always-on-top window that **eats clicks meant for other
 * applications**. Three of upstream's five bugs ended that way.
 */

describe("the cross-process constant", () => {
  test("is derived, not stated twice", () => {
    // 44/2 + 24. If this ever needs changing, it changes here and both
    // processes follow — which is the entire point of the constant.
    expect(COMPANION_NEAR_EDGE).toBe(46);
  });
});

describe("place then read back — the round trip that must hold", () => {
  /**
   * Main places the window by the creature's centre; the renderer anchors the
   * creature by the same offset. If these two disagree the creature is drawn
   * somewhere main does not believe it is, and every hit-test after that is
   * against the wrong rectangle.
   */
  for (const size of Object.keys(COMPANION_SIZE_BOXES) as Array<
    keyof typeof COMPANION_SIZE_BOXES
  >) {
    for (const growth of ["right", "left"] as const) {
      for (const cardGrowth of ["up", "down"] as const) {
        test(`${size} · ${growth} · ${cardGrowth}`, () => {
          const g = geometryFor(size);
          const centre = { x: 900, y: 600 };
          const origin = placeCanvas(centre, g, growth, cardGrowth);
          const back = avatarCentreOf(
            { ...origin, width: g.canvasWidth, height: g.canvasHeight },
            g,
            growth,
            cardGrowth,
          );
          expect(back.x).toBe(centre.x);
          expect(back.y).toBe(centre.y);
        });
      }
    }
  }
});

describe("it grows away from the edge it runs into", () => {
  const g = geometryFor("medium");
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };

  test("mid-screen grows right, the shape it is designed around", () => {
    expect(growthFor(600, workArea, g)).toBe("right");
  });

  test("against the right edge it flips, the way a menu does", () => {
    expect(growthFor(1420, workArea, g)).toBe("left");
  });

  test("by the Dock the card grows up", () => {
    expect(cardGrowthFor(860, workArea, g)).toBe("up");
  });

  test("near the top it flips down", () => {
    expect(cardGrowthFor(40, workArea, g)).toBe("down");
  });
});

describe("REGRESSION: the creature can reach the top of the screen", () => {
  /**
   * Upstream's `c634722e`. macOS declines any window origin above the work
   * area, whatever the window level — so a canvas reserving the card's height
   * on BOTH sides can never be dragged to the top: it stops short by that
   * reserve, and the clamp is asking correctly and being overruled. They
   * measured 270pt short.
   *
   * The fix is the asymmetric canvas: reserve on the side the card grows into
   * only. Growing DOWN puts the creature near the canvas top, so the origin
   * needed is barely above the creature itself.
   */
  test("growing down, the origin is within a near-edge of the creature", () => {
    const g = geometryFor("medium");
    const origin = placeCanvas({ x: 700, y: 40 }, g, "right", "down");
    expect(40 - origin.y).toBe(Math.round(g.nearEdge));
    // …and nowhere near the canvas height, which is what used to be reserved.
    expect(40 - origin.y).toBeLessThan(g.canvasHeight / 2);
  });
});

describe("scale", () => {
  test("every length derives from the avatar box", () => {
    expect(geometryFor("small").scale).toBe(1);
    expect(geometryFor("medium").scale).toBeCloseTo(66 / 44);
    expect(geometryFor("ridiculous").scale).toBe(5);
  });

  test("the canvas grows with the creature", () => {
    expect(geometryFor("ridiculous").canvasWidth).toBeGreaterThan(
      geometryFor("small").canvasWidth,
    );
  });
});
