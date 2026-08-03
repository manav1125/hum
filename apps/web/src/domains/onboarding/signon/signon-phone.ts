/**
 * M7 — sign-in at phone width, as arithmetic.
 *
 * Design's ruling (v22 · R5), verbatim:
 *
 *   "Bottom sheet, plus two changes. The orbit SCALES TO 40% as the sheet rises
 *    rather than being cropped — the brand moment survives the keyboard.
 *    Detents: 55% at rest, 90% with keyboard."
 *
 * Two things follow from that sentence and they are the whole module:
 *
 * 1. **The sheet's height is a fraction of the SCREEN, not of the space left
 *    over above the keyboard.** A sheet that shrank to 90% of the visible strip
 *    would leave ~54px of brand region on a 390×844 device, and a 40% orbit is
 *    92px, so the two numbers design gave could never both be true. Taking the
 *    detent against the layout viewport — the way a UIKit sheet actually
 *    behaves, the keys overlapping its lower edge while its content scrolls —
 *    puts the brand strip at 10% of 844 = 84px, which is the 92px orbit design
 *    drew in the M7 frame to within a hair. That agreement is the evidence the
 *    reading is right.
 *
 * 2. **"Scales rather than being cropped" is a constraint, not a decoration.**
 *    So the orbit's LAYOUT box shrinks with it (a `transform` alone would leave
 *    a 230px hole and push the mark under the sheet), and the scale is the
 *    smaller of design's rule and what actually fits. On a device with a deep
 *    top inset the fit clamp engages and the mark gets smaller still — smaller
 *    is the brand moment surviving; clipped is not.
 *
 * Pure. No DOM, no React, no window — the geometry is asserted directly in
 * `signon-phone.test.ts` at the exact viewport design drew (390×844) rather
 * than inferred from a rendered tree.
 */
import { KEYBOARD_OPEN_THRESHOLD_PX } from "@/mobile-v3/chats/phone-keyboard";

/** Sheet height as a fraction of the layout viewport, at rest. */
export const SIGNON_DETENT_REST = 0.55;
/** …and with the keyboard up. */
export const SIGNON_DETENT_KEYBOARD = 0.9;

/** The orbit's diameter at rest. 40% of it is the 92px design drew on M7. */
export const ORBIT_FULL_PX = 230;
/** Design's target scale once the sheet has fully risen. */
export const ORBIT_KEYBOARD_SCALE = 0.4;
/**
 * The floor the fit clamp may not go below. Under this the mark stops reading
 * as the mark, and at that point the honest move is a smaller brand strip, not
 * a smudge — no device in the drawn set gets near it.
 */
export const ORBIT_MIN_SCALE = 0.28;

/** What the brand strip spends on its own breathing room. */
export const BRAND_STRIP_PADDING_PX = 10;

export { KEYBOARD_OPEN_THRESHOLD_PX };

export interface SignonSheetInput {
  /** The LAYOUT viewport height — the screen, with the keyboard ignored. */
  viewportHeight: number;
  /** Keyboard height in px; `0` when down. */
  keyboardHeight: number;
  /** Top safe-area inset (Dynamic Island / notch). Eats the brand strip. */
  safeTop?: number;
  /**
   * Padding inside the brand strip that the orbit does not get to use.
   *
   * Not a detail: the first build of this omitted it, the orbit was sized to
   * the strip exactly, the strip's own 10px bottom padding pushed it up, and
   * `overflow: hidden` sheared the top off the mark — the precise failure
   * design ruled out. Anything the strip spends on itself has to come out of
   * the number the orbit is measured against.
   */
  brandPadding?: number;
}

export interface SignonSheet {
  /** Past the chrome-drift threshold — the same one the chat frame uses. */
  keyboardOpen: boolean;
  /** 0 at the resting detent → 1 at the keyboard detent. Drives everything. */
  progress: number;
  /** Sheet height as a fraction of the viewport. */
  detent: number;
  sheetHeight: number;
  /** The strip above the sheet the brand moment lives in. */
  brandHeight: number;
  orbitScale: number;
  /** The orbit's LAYOUT size — it shrinks, it is not clipped. */
  orbitSize: number;
  /** Padding the sheet adds so its content clears the keys. */
  sheetBottomInset: number;
  /**
   * The two marketing lines under the mark. They yield as the strip closes;
   * the mark itself never does. Opacity only — the block keeps its box until
   * it is gone, so nothing reflows mid-transition.
   */
  wordmarkOpacity: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve the M7 frame from the viewport and the keyboard.
 *
 * `progress` is derived from the keyboard's real height rather than a boolean,
 * which is what makes the orbit scale *with* the rise instead of snapping when
 * a threshold trips. On a 390×844 device the detent delta is 0.35 × 844 = 295px
 * and iOS's keyboard is ~291px, so a fully-open keyboard lands on ~1.0 — the
 * detents and the hardware agree without a magic number.
 */
export function resolveSignonSheet(input: SignonSheetInput): SignonSheet {
  const viewportHeight = Math.max(0, input.viewportHeight);
  const keyboardHeight = Math.max(0, input.keyboardHeight);
  const safeTop = Math.max(0, input.safeTop ?? 0);
  const brandPadding = Math.max(0, input.brandPadding ?? BRAND_STRIP_PADDING_PX);

  const detentSpan = SIGNON_DETENT_KEYBOARD - SIGNON_DETENT_REST;
  const rise = viewportHeight * detentSpan;
  const progress = rise > 0 ? clamp(keyboardHeight / rise, 0, 1) : 0;

  // The sheet may not rise past the point where the mark stops fitting at its
  // floor. Two constraints — "90% with keyboard" and "the brand moment
  // survives" — collide on a small device, and design ruled which one wins by
  // calling the orbit the thing that has to survive. So the DETENT yields, not
  // the mark: on a 6.7" phone this clamp never engages (the strip is 84px and
  // the floor is 64px); on an SE the sheet stops a few percent short.
  const chrome = safeTop + brandPadding;
  const maxSheetHeight = Math.max(
    0,
    viewportHeight - chrome - ORBIT_FULL_PX * ORBIT_MIN_SCALE,
  );
  const wantedHeight =
    viewportHeight * (SIGNON_DETENT_REST + progress * detentSpan);
  const sheetHeight = Math.min(wantedHeight, maxSheetHeight);
  const detent = viewportHeight > 0 ? sheetHeight / viewportHeight : 0;
  const brandHeight = Math.max(0, viewportHeight - sheetHeight - chrome);

  // Design's rule…
  const byDetent = 1 - progress * (1 - ORBIT_KEYBOARD_SCALE);
  // …and the promise that it is never cropped.
  const byFit = ORBIT_FULL_PX > 0 ? brandHeight / ORBIT_FULL_PX : 0;
  const orbitScale = clamp(Math.min(byDetent, byFit), ORBIT_MIN_SCALE, 1);

  return {
    keyboardOpen: keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX,
    progress,
    detent,
    sheetHeight,
    brandHeight,
    orbitScale,
    orbitSize: ORBIT_FULL_PX * orbitScale,
    sheetBottomInset: keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX ? keyboardHeight : 0,
    wordmarkOpacity: clamp(1 - progress * 1.8, 0, 1),
  };
}
