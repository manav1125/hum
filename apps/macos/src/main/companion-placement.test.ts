import { beforeEach, describe, expect, test } from "bun:test";

import { CompanionPlacement, type Rect } from "./companion-placement";
import { geometryFor } from "./companion-geometry";

/**
 * Placement — design `C3`.
 *
 * The properties worth pinning are the ones whose failure is invisible until
 * it lands in another application: a canvas that is wrong about where its
 * creature is claims clicks in the wrong place, and a canvas that resizes on a
 * phase change is the thing the fixed canvas exists to prevent.
 */

const DISPLAY: Rect = { x: 0, y: 0, width: 1440, height: 860 };

function host(initial?: Partial<Rect>) {
  let bounds: Rect = {
    x: 100,
    y: 100,
    width: 0,
    height: 0,
    ...initial,
  };
  const moves: Array<{ x: number; y: number }> = [];
  const sizes: Array<{ width: number; height: number }> = [];
  const published: Array<Record<string, unknown>> = [];
  return {
    moves,
    sizes,
    published,
    setBounds: (b: Rect) => (bounds = b),
    api: {
      bounds: () => bounds,
      workAreaNear: () => DISPLAY,
      setPosition: (x: number, y: number) => {
        moves.push({ x, y });
        bounds = { ...bounds, x, y };
      },
      setSize: (width: number, height: number) => {
        sizes.push({ width, height });
        bounds = { ...bounds, width, height };
      },
      publish: (s: Record<string, unknown>) => published.push(s),
    },
  };
}

describe("the creature lands where it was put", () => {
  test("moveTo then centre round-trips", () => {
    const h = host();
    const g = geometryFor("medium");
    h.setBounds({ x: 0, y: 0, width: g.canvasWidth, height: g.canvasHeight });
    const p = new CompanionPlacement(h.api, "medium");
    p.moveTo({ x: 620, y: 500 });
    expect(p.centre()).toEqual({ x: 620, y: 500 });
  });
});

describe("growth follows the display, not the surface", () => {
  let h: ReturnType<typeof host>;
  let p: CompanionPlacement;

  beforeEach(() => {
    h = host();
    const g = geometryFor("medium");
    h.setBounds({ x: 0, y: 0, width: g.canvasWidth, height: g.canvasHeight });
    p = new CompanionPlacement(h.api, "medium");
  });

  test("mid-screen it grows right", () => {
    p.moveTo({ x: 600, y: 500 });
    expect(p.current().growth).toBe("right");
  });

  test("against the right edge it flips, the way a menu does", () => {
    p.moveTo({ x: 1425, y: 500 });
    expect(p.current().growth).toBe("left");
  });

  test("near the top the card flips downward", () => {
    p.moveTo({ x: 600, y: 40 });
    expect(p.current().cardGrowth).toBe("down");
  });

  test("a direction change is published, so the renderer can mirror it", () => {
    p.moveTo({ x: 600, y: 500 });
    h.published.length = 0;
    p.moveTo({ x: 1425, y: 500 });
    expect(h.published.at(-1)).toMatchObject({ growth: "left" });
  });
});

describe("the canvas resizes for a SIZE change and nothing else", () => {
  test("a phase change never reaches setSize — only an explicit size does", () => {
    const h = host();
    const g = geometryFor("medium");
    h.setBounds({ x: 0, y: 0, width: g.canvasWidth, height: g.canvasHeight });
    const p = new CompanionPlacement(h.api, "medium");

    // Moving, settling and refreshing are the everyday operations; none of
    // them may resize. The old companion grew its window to show a card, and
    // that is exactly what the fixed canvas exists to stop.
    p.moveTo({ x: 600, y: 500 });
    p.settle({ x: 30, y: 500 });
    p.refresh();
    expect(h.sizes).toHaveLength(0);

    p.setSize("large");
    expect(h.sizes).toHaveLength(1);
  });

  test("growing the creature does not walk it across the desktop", () => {
    const h = host();
    const g = geometryFor("medium");
    h.setBounds({ x: 0, y: 0, width: g.canvasWidth, height: g.canvasHeight });
    const p = new CompanionPlacement(h.api, "medium");
    p.moveTo({ x: 700, y: 500 });
    p.setSize("huge");
    expect(p.centre()).toEqual({ x: 700, y: 500 });
  });

  test("the same size again is a no-op", () => {
    const h = host();
    const p = new CompanionPlacement(h.api, "medium");
    p.setSize("medium");
    expect(h.sizes).toHaveLength(0);
  });
});

describe("it settles on an edge, because mid-desktop is furniture", () => {
  let h: ReturnType<typeof host>;
  let p: CompanionPlacement;

  beforeEach(() => {
    h = host();
    const g = geometryFor("medium");
    h.setBounds({ x: 0, y: 0, width: g.canvasWidth, height: g.canvasHeight });
    p = new CompanionPlacement(h.api, "medium");
  });

  test("released left of centre, it lands on the left edge", () => {
    const landed = p.settle({ x: 300, y: 400 });
    expect(landed.x).toBe(geometryFor("medium").nearEdge);
  });

  test("released right of centre, it lands on the right edge", () => {
    const landed = p.settle({ x: 1200, y: 400 });
    expect(landed.x).toBe(1440 - geometryFor("medium").nearEdge);
  });

  test("height is free, but never off the work area", () => {
    expect(p.settle({ x: 300, y: -500 }).y).toBe(geometryFor("medium").nearEdge);
    expect(p.settle({ x: 300, y: 9999 }).y).toBe(
      860 - geometryFor("medium").nearEdge,
    );
  });
});

describe("the work area can move under a surface that did not", () => {
  test("refresh re-places rather than only re-deciding", () => {
    // A display arriving or the menu bar changing height flips which way there
    // is room without the creature moving. Re-deciding without re-placing
    // would leave the origin meaning something different from a moment ago.
    const h = host();
    const g = geometryFor("medium");
    h.setBounds({ x: 0, y: 0, width: g.canvasWidth, height: g.canvasHeight });
    const p = new CompanionPlacement(h.api, "medium");
    p.moveTo({ x: 700, y: 500 });
    const before = p.centre();
    h.moves.length = 0;
    p.refresh();
    expect(h.moves).toHaveLength(1);
    expect(p.centre()).toEqual(before);
  });
});
