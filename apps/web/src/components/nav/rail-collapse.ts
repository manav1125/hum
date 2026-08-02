/**
 * When the rail is a full column and when it is a 52px icon strip.
 *
 * Design's sentence is *"the rail auto-collapses to a 52px icon strip the
 * moment you enter a conversation (`◧` or `⌘\` pins it open) — this is what
 * makes discoverability affordable."* That last clause is the whole argument:
 * the rail can afford to carry HQ's peek, Work's peek, five conversations, two
 * destinations and a door **because it is not there while you are reading a
 * transcript.** Without the auto-collapse, every row added to the rail is a row
 * charged against the surface you are actually looking at.
 *
 * Pure and framework-free so the rule can be tested without a router or a
 * store. The two pieces of state it reads are deliberately separate:
 *
 *   · `preferenceCollapsed` — your standing choice, everywhere else in the app.
 *   · `pinnedOpen`          — "keep it open in conversations too".
 *
 * Collapsing them into one boolean is what makes this feel broken: with a
 * single flag, pinning the rail open inside a conversation also silently
 * changes what HQ looks like when you navigate back, and collapsing it on HQ
 * un-pins conversations. Two intents, two flags.
 */

/** The icon-strip width, per the brief. */
export const RAIL_COLLAPSED_WIDTH = 52;

export interface RailCollapseInputs {
  /** The user's standing choice for the rail (persisted, app-wide). */
  preferenceCollapsed: boolean;
  /** True while a conversation transcript is the surface on screen. */
  inConversation: boolean;
  /** The user has pinned the rail open for conversations (persisted). */
  pinnedOpen: boolean;
}

/**
 * Whether the rail renders as the icon strip.
 *
 * In a conversation the default flips: collapsed unless pinned. Everywhere
 * else the standing preference wins. Note the asymmetry is intentional — a
 * pin does NOT force the rail open on HQ, because there it is not fighting
 * anything for space.
 */
export function isRailCollapsed({
  preferenceCollapsed,
  inConversation,
  pinnedOpen,
}: RailCollapseInputs): boolean {
  if (inConversation) return !pinnedOpen;
  return preferenceCollapsed;
}

/**
 * What `◧` / `⌘\` changes, given where you are.
 *
 * Inside a conversation the control is a pin; outside it, it is the standing
 * preference. Returning a patch rather than mutating keeps the decision
 * testable and keeps the layout free of the branch.
 */
export function toggleRail(inputs: RailCollapseInputs): {
  preferenceCollapsed: boolean;
  pinnedOpen: boolean;
} {
  const { preferenceCollapsed, inConversation, pinnedOpen } = inputs;
  if (inConversation) {
    return { preferenceCollapsed, pinnedOpen: !pinnedOpen };
  }
  return { preferenceCollapsed: !preferenceCollapsed, pinnedOpen };
}

/**
 * Is a conversation transcript on screen?
 *
 * `/assistant/conversations/<id>` and the bare `/assistant` (which redirects
 * into the most recent conversation) both count — landing on `/assistant` puts
 * you in a transcript, so treating it as anything else would leave the rail
 * open over the one surface it is meant to get out of the way of.
 *
 * `/assistant/conversations` (the index) does NOT count: an index is a list to
 * scan, which is exactly when you want the rail.
 */
export function isConversationSurface(pathname: string): boolean {
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (trimmed === "/assistant") return true;
  return (
    trimmed.startsWith("/assistant/conversations/") &&
    // `…/inspect` is the LLM-context inspector — a dense diagnostic page, not
    // a transcript.
    !trimmed.endsWith("/inspect")
  );
}
