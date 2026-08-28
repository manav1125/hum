/**
 * The companion's geometry, derived once for both processes.
 *
 * Design `C3`, adopted from upstream verbatim because they paid for it:
 *
 *   · **The avatar is the fixed point.** One x-position in every phase, only
 *     `width` animates, and placement is a *position* rather than a transform.
 *     That is what makes the surface read as one creature changing shape
 *     instead of several that share a colour.
 *   · **The near-edge offset is a cross-process constant.** Main places the
 *     window by it and the renderer anchors the creature by it. Two copies of
 *     this formula drifting is the creature drawn somewhere main does not
 *     believe it is — so it is derived here, once, and imported by both.
 *   · **The canvas is asymmetric.** It reserves the card's height only on the
 *     side the card grows into. A canvas that reserved it on both sides could
 *     never be dragged to the top of the screen: macOS declines any window
 *     origin above the work area, so the creature would stop short by half the
 *     canvas — upstream measured 270pt (`c634722e`).
 */

/** The avatar box the layout is authored at; every other length scales from it. */
export const COMPANION_BASE_AVATAR_BOX = 44;

/** Room the surface's shadow paints outside its box, at the base size. */
export const COMPANION_BASE_CANVAS_PAD = 24;

/**
 * How far the creature's centre sits from the canvas edge the card does *not*
 * grow into: its own half-box, plus the shadow's room.
 *
 * **The cross-process invariant.** See this file's header for why it lives in
 * exactly one place.
 */
export const COMPANION_NEAR_EDGE =
  COMPANION_BASE_AVATAR_BOX / 2 + COMPANION_BASE_CANVAS_PAD;

/**
 * Size as a named step, not a number.
 *
 * Five steps are five layouts, each checkable. A continuous scale would be a
 * layout nobody had ever looked at. `ridiculous` is the joke at the end of the
 * scale and a real step: every length is stated in `small`, so it costs one
 * number here and is drawn by the same code as the other four — which means it
 * gets checked like the others (`C12`).
 */
export const COMPANION_SIZES = [
  "small",
  "medium",
  "large",
  "huge",
  "ridiculous",
] as const;

export type CompanionSize = (typeof COMPANION_SIZES)[number];

export const COMPANION_SIZE_BOXES: Record<CompanionSize, number> = {
  small: 44,
  medium: 66,
  large: 88,
  huge: 110,
  ridiculous: 220,
};

/**
 * The second step, not the third.
 *
 * The companion arrives without anyone having asked for it, over whatever the
 * user was already working in — so it arrives at the size of an uninvited
 * guest: big enough to be recognised, small enough that nobody has to move it
 * before carrying on. A stored choice is never overridden.
 */
export const DEFAULT_COMPANION_SIZE: CompanionSize = "medium";

/** Which way the pill grows out of the creature, which holds its place. */
export type CompanionGrowth = "right" | "left";

/** Which way the typing card unfurls out of the composer row. */
export type CompanionCardGrowth = "up" | "down";

/** The widest the pill ever gets, at the base size. */
/**
 * The widest the surface ever gets, at the base size.
 *
 * Sized for the **caught drop** (`C10`), which is the widest state there is:
 * creature, a chip naming the file, "Got it —", three choices and a ✕ on one
 * row. It was 316 — enough for the hover pill and nothing else — so a dropped
 * file rendered a pill wider than its own canvas and was clipped at both
 * ends, with "Read it" cut in half.
 *
 * The canvas is fixed and never resizes on a phase, which is the whole design;
 * the consequence is that this number has to be the widest state, not the
 * commonest one. The extra width is transparent and click-through, so it costs
 * nothing but the arithmetic.
 */
export const COMPANION_BASE_PILL_MAX = 520;
/** The typing card's height at the base size. */
export const COMPANION_BASE_CARD_HEIGHT = 196;

export interface CompanionGeometry {
  /** The creature's box in points — the whole of the surface's scale. */
  avatarBox: number;
  /** Scale factor over the authored size. */
  scale: number;
  /** Canvas width: room for the widest pill on either side of the creature. */
  canvasWidth: number;
  /** Canvas height: the creature, plus the card's height on ONE side only. */
  canvasHeight: number;
  /** The creature's centre offset from the near edge, scaled. */
  nearEdge: number;
}

export function geometryFor(size: CompanionSize): CompanionGeometry {
  const avatarBox = COMPANION_SIZE_BOXES[size];
  const scale = avatarBox / COMPANION_BASE_AVATAR_BOX;
  const nearEdge = COMPANION_NEAR_EDGE * scale;
  // Wide enough for the widest pill to unfurl either way without the window
  // ever resizing — the property that buys a canvas which never resizes, and
  // the reason glass is unavailable (`C3`, Q3).
  const canvasWidth = Math.round(
    COMPANION_BASE_PILL_MAX * scale + nearEdge * 2,
  );
  const canvasHeight = Math.round(
    avatarBox + COMPANION_BASE_CANVAS_PAD * scale * 2 +
      COMPANION_BASE_CARD_HEIGHT * scale,
  );
  return { avatarBox, scale, canvasWidth, canvasHeight, nearEdge };
}

/**
 * Which way the pill may grow, given where the creature sits.
 *
 * It grows away from the edge it runs into, the way a menu does. Main decides,
 * because main owns the window position and is the only side that knows which
 * display it is on.
 */
export function growthFor(
  centreX: number,
  workArea: { x: number; width: number },
  geometry: CompanionGeometry,
): CompanionGrowth {
  const needed = COMPANION_BASE_PILL_MAX * geometry.scale;
  const roomRight = workArea.x + workArea.width - centreX;
  return roomRight >= needed ? "right" : "left";
}

/** Which way the typing card unfurls. Up by the Dock; down near a top edge. */
export function cardGrowthFor(
  centreY: number,
  workArea: { y: number; height: number },
  geometry: CompanionGeometry,
): CompanionCardGrowth {
  const needed = COMPANION_BASE_CARD_HEIGHT * geometry.scale;
  const roomAbove = centreY - workArea.y;
  return roomAbove >= needed ? "up" : "down";
}

/**
 * Where to put the window so the creature lands on `centre`.
 *
 * The asymmetry is the whole point: the canvas reserves the card's height only
 * on the side the card grows into, so the creature can be dragged right to the
 * top of the screen. See the header.
 */
export function placeCanvas(
  centre: { x: number; y: number },
  geometry: CompanionGeometry,
  growth: CompanionGrowth,
  cardGrowth: CompanionCardGrowth,
): { x: number; y: number } {
  const x =
    growth === "right"
      ? Math.round(centre.x - geometry.nearEdge)
      : Math.round(centre.x - (geometry.canvasWidth - geometry.nearEdge));
  const y =
    cardGrowth === "up"
      ? Math.round(centre.y - (geometry.canvasHeight - geometry.nearEdge))
      : Math.round(centre.y - geometry.nearEdge);
  return { x, y };
}

/** The creature's centre, given where the window actually is. */
export function avatarCentreOf(
  bounds: { x: number; y: number; width: number; height: number },
  geometry: CompanionGeometry,
  growth: CompanionGrowth,
  cardGrowth: CompanionCardGrowth,
): { x: number; y: number } {
  const x =
    growth === "right"
      ? bounds.x + geometry.nearEdge
      : bounds.x + bounds.width - geometry.nearEdge;
  const y =
    cardGrowth === "up"
      ? bounds.y + bounds.height - geometry.nearEdge
      : bounds.y + geometry.nearEdge;
  return { x, y };
}
