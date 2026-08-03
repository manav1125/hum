/**
 * Where the phone's fixed corner chrome renders, and how much room it needs.
 *
 * `Mv3OverflowMenu` paints two 34px buttons — ☰ top-left, the owner's initial
 * top-right — at `position: fixed`, on the safe-area offset. They are NOT in
 * the document flow, so nothing below them knows they are there. Every v3
 * screen that renders on one of these routes also paints its own header at the
 * same safe-area offset, and the two collided in production: the Work screen's
 * large title read `☰ork`, and HQ's date eyebrow read `☰DAY · 2 AUG`.
 *
 * That is why this module exists rather than a `hasCornerChrome` prop. The
 * question "is the global chrome above me?" has exactly one right answer per
 * route, and a prop makes every new screen re-answer it — which is how the
 * collision shipped on two surfaces at once. `LargeTitleHeader` and `Mv3Today`
 * both read the predicate here, so a screen added to the chrome's route list
 * gets the inset without anyone remembering to pass anything.
 *
 * It also breaks a cycle: `root-layout` imports the chrome, so the chrome
 * cannot import the route list back from `root-layout`. The list belongs with
 * the chrome anyway — it is a property of the chrome, not of the shell.
 *
 * ## Why that first fix was not enough
 *
 * Moving the predicate here fixed every screen that renders `LargeTitleHeader`
 * or `Mv3Today`. Work renders NEITHER — it has a third header, `WorkHeader`
 * (`work-kit.tsx`), shared by its three views. So the module-scoped predicate
 * was read by two of the three headers on these routes and the Work title kept
 * rendering as `☰ork`. The lesson is one level up from "don't use a prop": the
 * clearance has to be a thing a header SPREADS, and something has to enumerate
 * the headers. Hence {@link cornerChromeProps} below, and the route-by-route
 * `corner-chrome.test.tsx` that walks every screen on every listed route and
 * fails on any header that does not carry the marker those props emit.
 */
import type React from "react";

import { routes } from "@/utils/routes";

/**
 * The primary v3 tab landings whose own header (and its conversations /
 * search / settings reachability) was removed when the tab bar went to three
 * slots. One entry per primary destination: HQ, Work (`projects`), and the
 * bare chats index that ◉ lands beside. `/home` is the legacy landing that
 * redirects to HQ; it stays listed so the chrome is present during the hop.
 */
export const MV3_OVERFLOW_SURFACES: readonly string[] = [
  routes.hq,
  routes.home,
  routes.projects,
  routes.conversations,
];

/**
 * Exact-match only: detail screens (e.g. a project) carry their own ‹ back and
 * ⋯ in the v3 grammar — a second global menu button would double the chrome.
 */
export function overflowVisible(pathname: string): boolean {
  return MV3_OVERFLOW_SURFACES.some((p) => p === pathname);
}

/* -------------------------------------------------------------------------- *
 * The buttons' geometry — read off `overflow-menu.tsx`'s `CornerButton`.       *
 * Every number below is derived from these three, so a change to the chrome    *
 * moves the clearances with it instead of leaving them behind.                 *
 * -------------------------------------------------------------------------- */

/** Offset of the buttons' top edge below the safe-area inset, in px. */
export const CORNER_CHROME_TOP = 8;
/** Diameter of each button, in px. */
export const CORNER_CHROME_SIZE = 34;
/** Gutter the buttons sit on, measured from the screen edge, in px. */
export const CORNER_CHROME_GUTTER = 18;
/** Breathing room between a button and whatever clears it, in px. */
export const CORNER_CHROME_GAP = 8;

/**
 * Height of the band the two buttons occupy, in px. A screen's own header must
 * hold this much open above its first line of content so the buttons land in
 * empty space rather than on top of a title.
 */
export const CORNER_CHROME_BAND = CORNER_CHROME_SIZE;

/**
 * Horizontal inset a screen's header needs on BOTH edges to clear the buttons,
 * in px, measured from inside the standard 22px screen gutter.
 *
 * The buttons sit on an 18px gutter and are 34px wide, so their inner edges are
 * at 52px. `52 - 22 + 8` — the screen gutter subtracted, plus a gap.
 */
export const CORNER_CHROME_INSET =
  CORNER_CHROME_GUTTER + CORNER_CHROME_SIZE - 22 + CORNER_CHROME_GAP;

/**
 * How a header gets out of the buttons' way.
 *
 * - `"band"` — hold the buttons' height open ABOVE the header's content, so
 *   nothing shares their row. The plain choice, and the only safe one for a
 *   header whose top row is full edge-to-edge (Work: title + a trailing filter
 *   chip, which collided with the ☰ and the avatar respectively).
 * - `"row"` — keep the header's first row INSIDE the buttons' band and inset it
 *   horizontally instead. iOS nav-bar grammar, and what HQ's date eyebrow and
 *   the large-title condensed row want: a mono microlabel reads correctly
 *   between the two buttons, and pushing it down would cost 34px of hero.
 */
export type CornerChromeReserve = "band" | "row";

/**
 * Props a header spreads onto the element that has to clear the buttons.
 *
 * Returns empty props off the chrome's routes, so a header can spread this
 * unconditionally. The `data-corner-chrome` marker is emitted from the SAME
 * call that produces the style, which is what makes it worth asserting on:
 * `corner-chrome.test.tsx` walks each screen on each listed route and fails any
 * header that does not carry it. A header cannot claim the clearance without
 * taking it, and cannot take it without being visible to the test.
 */
export function cornerChromeProps(
  pathname: string,
  reserve: CornerChromeReserve,
): { "data-corner-chrome"?: CornerChromeReserve; style: React.CSSProperties } {
  if (!overflowVisible(pathname)) return { style: {} };
  return {
    "data-corner-chrome": reserve,
    style:
      reserve === "band"
        ? { paddingTop: CORNER_CHROME_BAND }
        : {
            minHeight: CORNER_CHROME_BAND,
            paddingLeft: CORNER_CHROME_INSET,
            paddingRight: CORNER_CHROME_INSET,
          },
  };
}
