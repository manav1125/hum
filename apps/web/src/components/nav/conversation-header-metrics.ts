/**
 * The phone conversation header's horizontal budget — declared, so it can be
 * measured before it ships instead of after.
 *
 * The header is `‹ ☰ <title> ⋯`: two 44px controls on the left, one on the
 * right, and a title that takes what is left. The ☰ (your chats) is the newest
 * of the four and the reason this module exists — the last time a control was
 * added to a phone header on feel, the Work screen's large title shipped
 * reading `☰ork`, twice. happy-dom has no layout engine, so the only thing a
 * test can assert on is the geometry both sides DECLARE; that only works if
 * there is one declaration, and the header reads its paddings from here.
 *
 * The invariant is not "nothing overlaps" — this row is flex, so it cannot
 * overlap; it is that the title keeps a legible share of the narrowest phone
 * this app runs on. `conversation-header-metrics.test.ts` fails if a fifth
 * control, or a wider one, pushes it under {@link MIN_TITLE_WIDTH}.
 */

/** Hit target for every control in the row (the build's floor). */
export const HEADER_CONTROL = 44;

/** The row's own horizontal padding. */
export const HEADER_GUTTER = 20;

/** Gap between the row's children. */
export const HEADER_GAP = 6;

/**
 * The leading control's optical pull toward the edge: a 44px hit target around
 * a 22px chevron leaves 11px of air, and the chevron should sit on the gutter,
 * not 11px inside it.
 */
export const HEADER_LEADING_PULL = 14;

/** Same trick on the trailing ⋯, whose glyph is smaller. */
export const HEADER_TRAILING_PULL = 12;

/**
 * The narrowest phone the mobile SPA is expected to render on — iPhone 12/13
 * mini and the 5.4" Android class. Anything narrower is a browser window, not
 * a device, and truncates gracefully.
 */
export const NARROWEST_PHONE = 360;

/**
 * The floor for the title's share of the row. ~24 characters at 15px/600 — a
 * conversation title that truncates mid-word is fine; one that shows three
 * characters and an ellipsis is not a title.
 */
export const MIN_TITLE_WIDTH = 180;

/**
 * Width left for the conversation title at a given screen width, given how
 * many leading controls the header carries (1 = ‹ only, 2 = ‹ and ☰).
 */
export function conversationTitleWidth(
  screenWidth: number,
  leadingControls: number,
): number {
  const leading =
    HEADER_GUTTER -
    HEADER_LEADING_PULL +
    leadingControls * HEADER_CONTROL +
    leadingControls * HEADER_GAP;
  const trailing =
    HEADER_CONTROL - HEADER_TRAILING_PULL + HEADER_GUTTER + HEADER_GAP;
  return screenWidth - leading - trailing;
}
