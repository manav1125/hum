import type { BrowserWindow } from "electron";

/**
 * Who owns the clicks over the companion's canvas — design `C3`'s engineering
 * notes, and the fix for three of upstream's five bugs.
 *
 * **The problem this exists for.** The companion's window is a canvas many
 * times the size of anything drawn in it: it has to be, because the pill
 * unfurls either way and the card grows up or down, and a window that resized
 * on every phase change would be a window resizing constantly. So most of the
 * canvas is empty — and an always-on-top window that claims the whole of it
 * **swallows presses meant for whatever is behind**. Upstream shipped that
 * three separate times (`56405459`, `db9392ef`, and the intro leak in
 * `64e3eead`), and it is the single most damaging thing this class of surface
 * does wrong, because the damage lands in other people's applications.
 *
 * **The technique.** `setIgnoreMouseEvents(true, { forward: true })` keeps
 * delivering mouse-move to the page while letting presses through. That is
 * what lets the surface know it is being pointed at without having claimed
 * anything — so hover becomes a phase main publishes, and the renderer never
 * has to guess.
 *
 * The window is interactive only while the pointer is genuinely over something
 * drawn, and goes back to transparent the moment it is not — including after a
 * card is removed from under a stationary pointer, which is the leak upstream
 * found last: nothing recomputes a hit-test on its own if the mouse never
 * moves again.
 */

export interface HitTestHost {
  /** The live window, or null when there isn't one. */
  window(): BrowserWindow | null;
}

export class CompanionHitTest {
  private interactive = false;

  constructor(private readonly host: HitTestHost) {}

  /**
   * Claim clicks, or hand them back.
   *
   * Idempotent on purpose: this is called from pointer moves, from phase
   * changes, and from teardown, and the cheap guard means none of those have
   * to know about the others.
   */
  set(interactive: boolean): void {
    const win = this.host.window();
    if (!win || win.isDestroyed()) {
      this.interactive = false;
      return;
    }
    if (interactive === this.interactive) return;
    this.interactive = interactive;
    if (interactive) {
      win.setIgnoreMouseEvents(false);
      return;
    }
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  /**
   * Hand the clicks back after anything is removed from under the pointer.
   *
   * **The bug this closes.** Dismissing the introduction, answering a nudge, or
   * a call arriving all take a card out from under a stationary pointer. No
   * mouse-move follows, so nothing recomputes — and the window stays claiming
   * the whole canvas until the user happens to move the mouse. Upstream shipped
   * exactly this in the intro (`64e3eead`).
   *
   * The renderer reports hover again on its next frame if the pointer really is
   * still over something, so releasing first is always safe and never sticks.
   */
  releaseAfterRemoval(): void {
    this.set(false);
  }

  /** For teardown and tests. */
  isInteractive(): boolean {
    return this.interactive;
  }
}
