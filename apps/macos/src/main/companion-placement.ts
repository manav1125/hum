import {
  avatarCentreOf,
  cardGrowthFor,
  geometryFor,
  growthFor,
  placeCanvas,
  type CompanionCardGrowth,
  type CompanionGeometry,
  type CompanionGrowth,
  type CompanionSize,
} from "./companion-geometry";

/**
 * Where the companion is, and which way it has room to unfurl — design `C3`.
 *
 * **The canvas never resizes.** The old companion grew its window from 72×72
 * to 260×148 to show a card, which is the thing this design explicitly avoids:
 * a window that resizes on every phase change resizes constantly, and it is
 * also what makes real glass impossible (a vibrancy material fills its window,
 * so a canvas that keeps changing size frosts a changing rectangle of
 * desktop). One canvas, sized for the widest state, and only the surface
 * inside it changes shape.
 *
 * **Main owns growth because only main knows the display.** Which way the pill
 * can unfurl and which way the card can grow are facts about the work area the
 * creature is parked in, and the renderer has no access to that. They are also
 * not static: a display arriving or leaving, or the menu bar changing height,
 * moves the work area under a surface that never moved.
 *
 * Kept free of Electron so the arithmetic can be tested without a window —
 * the host supplies bounds and work areas, and receives moves.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementHost {
  /** The window's current bounds, or null when there is no window. */
  bounds(): Rect | null;
  /** The work area of the display nearest a point. */
  workAreaNear(point: { x: number; y: number }): Rect;
  /** Move the window. */
  setPosition(x: number, y: number): void;
  /** Resize the canvas — only ever on a SIZE change, never a phase change. */
  setSize(width: number, height: number): void;
  /** Tell the renderer what changed. */
  publish(state: {
    avatarBox: number;
    growth: CompanionGrowth;
    cardGrowth: CompanionCardGrowth;
  }): void;
}

export class CompanionPlacement {
  private geometry: CompanionGeometry;
  private growth: CompanionGrowth = "right";
  private cardGrowth: CompanionCardGrowth = "up";

  constructor(
    private readonly host: PlacementHost,
    private size: CompanionSize,
  ) {
    this.geometry = geometryFor(size);
  }

  current(): {
    geometry: CompanionGeometry;
    growth: CompanionGrowth;
    cardGrowth: CompanionCardGrowth;
  } {
    return {
      geometry: this.geometry,
      growth: this.growth,
      cardGrowth: this.cardGrowth,
    };
  }

  /** Where the creature actually is on screen. */
  centre(): { x: number; y: number } | null {
    const bounds = this.host.bounds();
    if (!bounds) return null;
    return avatarCentreOf(bounds, this.geometry, this.growth, this.cardGrowth);
  }

  /**
   * Put the creature's centre here, choosing the growth directions that the
   * display allows.
   */
  moveTo(centre: { x: number; y: number }): void {
    const workArea = this.host.workAreaNear(centre);
    const nextGrowth = growthFor(centre.x, workArea, this.geometry);
    const nextCardGrowth = cardGrowthFor(centre.y, workArea, this.geometry);
    const changed =
      nextGrowth !== this.growth || nextCardGrowth !== this.cardGrowth;
    this.growth = nextGrowth;
    this.cardGrowth = nextCardGrowth;

    const origin = placeCanvas(
      centre,
      this.geometry,
      this.growth,
      this.cardGrowth,
    );
    this.host.setPosition(origin.x, origin.y);
    if (changed) this.publish();
  }

  /**
   * The work area moved under a surface that did not.
   *
   * A display arriving or leaving, or the menu bar's height changing, can flip
   * which way there is room without the creature moving at all. Re-deciding
   * without re-placing would leave the window's origin meaning something
   * different from what it meant a moment ago — so the creature is put back
   * where it was, under the new directions.
   */
  refresh(): void {
    const centre = this.centre();
    if (!centre) return;
    this.moveTo(centre);
  }

  /**
   * A named size step.
   *
   * The one thing that legitimately resizes the canvas — and a stored choice
   * is never overridden, so this only ever runs because someone asked.
   */
  setSize(size: CompanionSize): void {
    if (size === this.size) return;
    const centre = this.centre();
    this.size = size;
    this.geometry = geometryFor(size);
    this.host.setSize(this.geometry.canvasWidth, this.geometry.canvasHeight);
    // Put the creature back where it was, at the new scale: growing the
    // creature must not walk it across the desktop.
    if (centre) this.moveTo(centre);
    else this.publish();
  }

  /**
   * Snap to the nearest edge and settle.
   *
   * `C8`: the creature lives on the left or right edge only — free in height,
   * snapped horizontally. A creature mid-desktop is furniture; on an edge it
   * is a companion. The glide itself is the renderer's, this only decides
   * where it lands.
   */
  settle(centre: { x: number; y: number }): { x: number; y: number } {
    const workArea = this.host.workAreaNear(centre);
    const left = workArea.x + this.geometry.nearEdge;
    const right = workArea.x + workArea.width - this.geometry.nearEdge;
    const nearestX =
      Math.abs(centre.x - left) <= Math.abs(centre.x - right) ? left : right;
    // Height is free, but the creature must stay wholly on the work area.
    const top = workArea.y + this.geometry.nearEdge;
    const bottom = workArea.y + workArea.height - this.geometry.nearEdge;
    const y = Math.min(Math.max(centre.y, top), bottom);
    const landed = { x: nearestX, y };
    this.moveTo(landed);
    return landed;
  }

  publish(): void {
    this.host.publish({
      avatarBox: this.geometry.avatarBox,
      growth: this.growth,
      cardGrowth: this.cardGrowth,
    });
  }
}
