/**
 * The drag, and the reason it cannot end on the canvas — design `C3`'s
 * engineering notes, fixing upstream's `56405459`.
 *
 * **What goes wrong without this.** The surface is its own drag handle, so a
 * press is a grab until the hand moves. If that press is only ended by a
 * `mouseup` delivered to the page, then a drag that finishes with the pointer
 * over *another application* never ends at all: the event goes to that app, not
 * to us. And it will finish there routinely, because a fast drag outruns a
 * window that is moved one IPC message at a time — the pointer is simply
 * somewhere the page is not by the time the button comes up.
 *
 * The press then never ends. Every later pointer move reads as a drag frame,
 * so the surface chases a pointer with no button held; the first move after the
 * pointer comes back carries the whole distance travelled in between; and the
 * hit-test never resumes, so the window keeps claiming a canvas many times the
 * size of the pill and **swallows clicks meant for other applications**.
 *
 * **The rule, therefore:** a drag ends on a *global* mouse-up — one the host
 * reports wherever the pointer happens to be — or on losing the window, and
 * never on a `mouseup` the page had to receive.
 */

export interface DragPoint {
  x: number;
  y: number;
}

export interface DragHost {
  /** Move the window so the creature's centre lands here. */
  moveTo(centre: DragPoint): void;
  /** Settle to the nearest edge slot. `C8`: it settles, it does not stop. */
  settle(centre: DragPoint): void;
  /** Clicks are ours while dragging, and handed back the moment it ends. */
  setInteractive(interactive: boolean): void;
}

export class CompanionDrag {
  private from: DragPoint | null = null;
  private origin: DragPoint | null = null;
  private moved = false;

  constructor(private readonly host: DragHost) {}

  /** A press landed on the creature. Not yet a drag — a grab. */
  begin(pointer: DragPoint, centre: DragPoint): void {
    this.from = pointer;
    this.origin = centre;
    this.moved = false;
    this.host.setInteractive(true);
  }

  /**
   * The pointer moved while held.
   *
   * Ignored entirely when no press is outstanding, which is the guard that
   * stops a surface chasing a pointer with no button down — the visible
   * symptom of the bug above.
   */
  move(pointer: DragPoint): void {
    if (!this.from || !this.origin) return;
    this.moved = true;
    this.host.moveTo({
      x: this.origin.x + (pointer.x - this.from.x),
      y: this.origin.y + (pointer.y - this.from.y),
    });
  }

  /**
   * The button came up — **wherever it came up**.
   *
   * Called from a global mouse-up hook rather than a page event, and also on
   * window blur/destroy, so there is no path where a press outlives the
   * gesture that started it.
   */
  end(pointer?: DragPoint): { dragged: boolean } {
    const wasDragging = this.from !== null;
    const dragged = wasDragging && this.moved;
    if (dragged && this.origin && this.from && pointer) {
      this.host.settle({
        x: this.origin.x + (pointer.x - this.from.x),
        y: this.origin.y + (pointer.y - this.from.y),
      });
    }
    this.from = null;
    this.origin = null;
    this.moved = false;
    // Hand the canvas back immediately: whether the pointer is still over
    // something is the renderer's to report on its next frame, and claiming it
    // in the meantime is what steals other applications' clicks.
    this.host.setInteractive(false);
    return { dragged };
  }

  /** Is a press outstanding? */
  isHeld(): boolean {
    return this.from !== null;
  }

  /** Did this gesture actually move, or was it a click? */
  hasMoved(): boolean {
    return this.moved;
  }
}
