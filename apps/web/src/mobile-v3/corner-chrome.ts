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
 */
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

/**
 * Height of the band the two buttons occupy, in px. A screen's own header must
 * hold this much open above its first line of content so the buttons land in
 * empty space rather than on top of a title.
 */
export const CORNER_CHROME_BAND = 34;

/**
 * Horizontal inset a screen's header needs on BOTH edges to clear the buttons,
 * in px, measured from inside the standard 22px screen gutter.
 *
 * The buttons sit on an 18px gutter and are 34px wide, so their inner edges are
 * at 52px. `52 - 22 + 8` — the screen gutter subtracted, plus a gap.
 */
export const CORNER_CHROME_INSET = 38;
