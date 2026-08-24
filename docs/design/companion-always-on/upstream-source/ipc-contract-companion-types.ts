// Companion surface
// ---------------------------------------------------------------------------

/**
 * Which way the companion pill grows out of the avatar, which holds its place.
 *
 * `right` is the shape the surface is designed around; `left` is what it
 * degrades to when the right edge of the display is closer than the pill's
 * widest state needs. Main decides: it owns the window position and is the only
 * side that knows which display the surface is on.
 *
 * The avatar does not move either way. That is the whole point of naming a
 * *direction* rather than an anchor: the mascot is the fixed thing the user
 * aims at, and the pill is what changes shape around it.
 */
export const COMPANION_GROWTHS = ["right", "left"] as const;

export type CompanionGrowth = (typeof COMPANION_GROWTHS)[number];

/**
 * Which way the typing card grows out of the composer row, which holds the line
 * the pill occupied.
 *
 * The vertical half of {@link CompanionGrowth}, decided the same way and for a
 * sharper reason. macOS refuses to place a window frame above the top of the
 * work area, so the canvas cannot hang off the top of the display the way it
 * hangs off the bottom. With the avatar pinned to the canvas's centre the
 * avatar could therefore never get closer to the top of the screen than half
 * the canvas, which fences it out of the top of the display entirely.
 *
 * So the avatar's offset inside the canvas is not fixed: `up` puts it low in
 * the canvas with the card's height reserved above it, `down` puts it high with
 * that height reserved below. Main picks from the room the display actually
 * has, and the avatar still does not move: the canvas moves around it.
 *
 * `up` is the shape the surface is designed around, since it lives by the Dock
 * where a card growing downward would grow off the bottom of the screen.
 */
export const COMPANION_CARD_GROWTHS = ["up", "down"] as const;

export type CompanionCardGrowth = (typeof COMPANION_CARD_GROWTHS)[number];

/**
 * How big the companion is drawn, as a named step rather than a number.
 *
 * Named rather than free, because the avatar's box is not a style: it is the
 * geometry both sides of the bridge agree on, and everything derives from it:
 * the pill's reach, the card's height, and the canvas sized to hold the largest
 * state. A continuous scale would be a layout nobody had ever looked at; five
 * steps are five layouts, each checkable in Storybook.
 *
 * `medium` is the default. `small` is the size the surface's layout is authored
 * at, which every other step scales from. `ridiculous` is the joke at the end
 * of the scale, and it is a real step rather than a gag drawn some other way:
 * every length on the surface is stated in `small`, so the largest step costs
 * one number here and is drawn by the same code as the other four.
 */
export const COMPANION_SIZES = [
  "small",
  "medium",
  "large",
  "huge",
  "ridiculous",
] as const;

export type CompanionSize = (typeof COMPANION_SIZES)[number];

/** The avatar's box in points, per named size. The scale is this over `small`. */
export const COMPANION_SIZE_BOXES: Record<CompanionSize, number> = {
  small: 44,
  medium: 66,
  large: 88,
  huge: 110,
  // Five times the authored size, which puts the canvas well past the width of
  // any display it will be shown on. That is allowed: a canvas may hang off the
  // left and right freely, and the card flips to growing downward when the
  // display is too short for it, so the oversize step lands on paths the other
  // four already take near an edge.
  ridiculous: 220,
};

/**
 * What the surface is drawn at when nothing has been chosen.
 *
 * The second step rather than the third. The companion arrives on the desktop
 * without anyone having asked for it, over whatever the user was already
 * working in, so it arrives at the size of an uninvited guest: big enough to be
 * recognised as the creature it is, small enough that nobody has to move it
 * before they can carry on. The steps above are for the users who then want it
 * bigger, and the introduction's last beat is where they are told to find
 * them (see {@link COMPANION_INTRO_BEATS}).
 */
export const DEFAULT_COMPANION_SIZE: CompanionSize = "medium";

/**
 * The avatar's box the companion's layout is authored at, and the size every
 * other length in that layout is stated in.
 *
 * The scale is the box in {@link COMPANION_SIZE_BOXES} over this one. The
 * renderer draws at this size and scales the whole surface by that factor, so
 * the two processes never hold two sets of dimensions.
 */
export const COMPANION_BASE_AVATAR_BOX = COMPANION_SIZE_BOXES.small;

/** Room the pill's shadow paints outside its box, at the base size. */
export const COMPANION_BASE_CANVAS_PAD = 24;

/**
 * How far the avatar's centre sits from the canvas edge the card does *not*
 * grow into: its own half-box, plus the shadow's room.
 *
 * **The cross-process invariant.** Main places the window by it and the
 * renderer anchors the avatar by it, so the two agreeing is what makes the
 * avatar appear where the window was put. Derived once here rather than on each
 * side, because two copies of this formula drifting is the avatar drawn
 * somewhere other than where main believes it is.
 *
 * The far edge is however far away the canvas is, which neither side has to
 * state: `100%` names the canvas in the renderer, and main sizes it.
 */
export const COMPANION_NEAR_EDGE =
  COMPANION_BASE_AVATAR_BOX / 2 + COMPANION_BASE_CANVAS_PAD;

/**
 * The assistant's character, as the three trait ids it is composed from.
 *
 * Structurally the fields of the web layer's `CharacterTraits` that
 * `composeSvg` actually consumes, restated here rather than imported: that type
 * is generated from the daemon's OpenAPI schema, and the contract package must
 * not depend on it.
 *
 * Traits rather than pixels, because the surface renders the *live* character
 * from them: an avatar that blinks and breathes cannot be shipped as a still.
 * Absent for an assistant whose avatar is a custom uploaded image, which has no
 * traits to compose from and stays a still.
 */
export interface CompanionCharacter {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

/**
 * One side of one exchange, condensed for the companion surface's card.
 *
 * Text and a side, and nothing else: no ids, no attachments, no tool calls, no
 * surfaces. The card is a glance at where the conversation got to, so anything
 * richer crossing this bridge would be an invitation to render a transcript on
 * a surface floating over someone else's work.
 */
export interface CompanionTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Where a finished watch session's summary has got to.
 *
 * A session ends the moment the user presses stop, and the account of it does
 * not: the runtime spends a full turn reading the timeline back before there is
 * anything to show. Those are the two states worth a surface, and neither is
 * `watching`, which is over by the time either is true.
 *
 * - `pending`: the turn is running. The surface says so, because a session that
 *   ends into silence reads as one that was thrown away.
 * - `ready`: there is a report to read, and the surface asks whether to open
 *   it.
 *
 * Absent is the resting answer, and covers both ends of the life: no session
 * has finished, or the last one that did was answered, dismissed, or produced
 * nothing to read.
 */
export type CompanionWatchRetro = "pending" | "ready";

/**
 * What the app's own window knows that the surface cannot.
 *
 * The surface is a renderer with no assistant and no conversation in it, so
 * both facts are published by the window that has them. One payload rather than
 * two channels: they describe the same assistant at the same moment, and a
 * surface drawing one assistant's name over another's words is exactly the skew
 * two independently-pushed facts would produce.
 */
export interface CompanionContext {
  /**
   * The assistant's display name, already resolved: the surface renders it
   * verbatim rather than deciding what an unnamed assistant is called.
   */
  assistantName: string;
  /** The conversation's tail, most recent last. */
  turns: CompanionTurn[];
  /**
   * Whether a turn is in flight right now.
   *
   * The surface has the tail of the conversation but no idea whether it is
   * still being written: the last turn on a finished exchange and the last turn
   * on one the assistant is still working through are the same rows. This is
   * the difference, and it is what the surface draws its working ring from.
   *
   * Published rather than inferred for the same reason the turns are. The turn
   * lives in the window that owns the conversation, and a surface guessing from
   * the shape of the tail would be wrong in both directions: a user message with
   * no reply yet is not proof of a live turn, and an assistant message already
   * on screen is no proof the turn behind it has ended.
   */
  working: boolean;
  /**
   * Whether a watch session is running, when the publisher knows.
   *
   * Optional here, and defaulted in `companionContextSchema`, because a
   * publisher that runs no watch session has nothing to report, and an omitted
   * value reads as no session of its running. Publishers that do run sessions
   * always send it.
   */
  watching?: boolean;
  /**
   * Where the last session's summary has got to, when the publisher knows.
   *
   * Optional for the same reason `watching` is, and answered by the same
   * window: the runtime reports the retrospective on the assistant's event
   * stream, which the app's window is subscribed to and the surface's is not.
   *
   * See {@link CompanionWatchRetro}. Omitted means there is nothing to say.
   */
  watchRetro?: CompanionWatchRetro;

  /**
   * How many times the running session has read the screen, counted from the
   * moment it started.
   *
   * A count rather than a timestamp: it crosses a process boundary, and two
   * sides comparing "when" would be two clocks, where comparing "how many"
   * only ever asks whether the number moved. Reset to zero by the session that
   * owns it, so a fresh session never inherits the last one's total and its
   * first read is unambiguously its first.
   *
   * Optional and defaulted for the same reason {@link CompanionContext.watching}
   * is: a publisher with no session to report says nothing, and zero reads is
   * the truthful reading of silence.
   */
  captureCount?: number;
}

/**
 * The feature flag key Teach is behind, as the app's window wrote it into
 * settings (`useElectronFeatureFlagBridge`).
 *
 * The constant's name and the key it holds spell the feature differently: the
 * symbols around it say Watch, everything a person reads says Teach. A flag key
 * is one of the things a person reads, in the LaunchDarkly dashboard.
 *
 * Here rather than in either client, because two clients read the same
 * evaluation for two halves of one gate: Electron main reads it to decide
 * whether the companion surface draws the Teach control at all, and the web
 * app's `toggleWatch` command reads it to decide whether a press may start a
 * session. A second copy of the string is a gate that can disagree with
 * itself, and both ways it can disagree are bad: a visible control that
 * nothing will start, or a command open with no control that says so.
 *
 * The evaluated value travels to the surface on
 * {@link CompanionSurfaceState.watchEnabled}; this is only the key it is
 * evaluated under.
 */
export const WATCH_FLAG = "teach";

/**
 * The beats of the surface's one-time introduction, in order.
 *
 * The companion is the only thing this app puts on a user's desktop rather than
 * in its own window, and it arrives already there rather than being opened. So
 * it says what it is once, on itself, where the thing being described actually
 * is: the alternative was describing it in the app window, which is the one
 * place the user is not looking when the surface matters.
 *
 * A list rather than a count, because each beat names the control it sits over
 * and the renderer spotlights that control by name. Two of them have no
 * control to spotlight: `meet` is the avatar itself, and `menu` is about a
 * press rather than a control drawn on the pill.
 *
 * `menu` is last and is the answer to "how do I make this go away" and "how do
 * I make it a different size". A surface that sits above every other window has
 * to say where its own off switch is, and the right-click menu it points at is
 * the only part of this the user cannot find by looking at the pill.
 */
export const COMPANION_INTRO_BEATS = ["meet", "talk", "type", "menu"] as const;

export type CompanionIntroBeat = (typeof COMPANION_INTRO_BEATS)[number];

/**
 * What a press on the introduction asks for.
 *
 * Two intents rather than a beat to jump to, because the renderer does not hold
 * the running position: main does, so the renderer says which way to go and
 * main resolves it against the beat it is actually on. A stale press from a
 * renderer a beat behind then lands where the user could see it would.
 */
export const COMPANION_INTRO_ACTIONS = ["next", "dismiss"] as const;

export type CompanionIntroAction = (typeof COMPANION_INTRO_ACTIONS)[number];

/** What main tells the companion renderer. */
export interface CompanionSurfaceState {
  growth: CompanionGrowth;
  /**
   * Which way the typing card unfurls, and with it where the avatar sits inside
   * the canvas. See {@link CompanionCardGrowth}: main owns the window position,
   * so main is the only side that can decide this.
   */
  cardGrowth: CompanionCardGrowth;
  /**
   * The avatar's box in points, which is the whole of the surface's scale.
   *
   * One number rather than the named size, because the name is a lookup both
   * sides would then have to hold the same copy of. Everything the surface
   * draws derives from this, so the renderer scales itself by this over the
   * size the layout is authored at. See {@link COMPANION_SIZE_BOXES}.
   */
  avatarBox: number;
  /**
   * The assistant's display name, for the composer's placeholder.
   *
   * Empty until the app's window publishes one, which the surface reads as
   * "not known yet" and covers with its own fallback wording.
   */
  assistantName: string;
  /**
   * The tail of the conversation the surface belongs to, most recent last, or
   * empty when there is none to show.
   *
   * Published by the renderer that owns the conversation and held here for the
   * same reason the session is: the surface's own renderer can reload, and a
   * card that came back blank would read as the conversation having been lost.
   * It is what lets an exchange started from Type be read without going back to
   * the app at all.
   */
  turns: CompanionTurn[];
  /**
   * Whether a turn is in flight, as the window holding it last reported.
   *
   * What the surface turns into a signal a glance can read, so the assistant
   * being busy does not have to be inferred from the words on the card. See
   * {@link CompanionContext.working}.
   */
  working: boolean;
  /**
   * Whether a watch session is running, from the toggle until it ends.
   *
   * Pushed by the window that owns the session for the same reason
   * {@link CompanionSurfaceState.working} is: the session lives in the app's
   * window and the surface is only where it was asked for. Held here rather
   * than kept in the surface's own renderer for the same reason the turns are,
   * and with more riding on it: the surface can reload mid-session, and a
   * screen being read with nothing on screen saying so is a capture the user
   * has no way to stop.
   *
   * Optional, and absence means not watching. Read it as `watching === true`
   * rather than for truthiness: every state that is not a positive answer is
   * the answer "no session", including a state pushed by a main process that
   * tracks no watch sessions. The same bargain `companion-window.ts` makes for
   * the surface flag, and for the same reason: not knowing has to read as not
   * running, because the alternative is drawing a capture indicator over a
   * machine that is not being captured.
   */
  watching?: boolean;
  /**
   * Where the last session's summary has got to, as the window that ran it
   * last reported. See {@link CompanionWatchRetro}.
   *
   * Held here rather than in the surface's own renderer for the reason the
   * turns are: the retrospective runs long enough that the surface can reload
   * inside it, and a prompt that came back empty would be a question the user
   * was asked and then never got to answer.
   *
   * Optional, and absence means there is nothing to draw.
   */
  watchRetro?: CompanionWatchRetro;

  /**
   * How many screen reads the running session has taken, from the window that
   * owns it. See {@link CompanionContext.captureCount}.
   *
   * {@link CompanionSurfaceState.watching} says a session is open, which is a
   * state that holds for minutes; this is what lets the surface mark the
   * discrete moments inside it. Each increment is one read that reached the
   * runtime's timeline, so a surface may treat a step in this number as proof
   * the screen was read and the flat stretches between as proof it was not.
   *
   * Optional, and absence reads as no reads yet, the same bargain
   * {@link CompanionSurfaceState.watching} makes with absence.
   */
  captureCount?: number;

  /**
   * Whether Watch is offered at all, as the flag was last evaluated for the
   * signed-in user.
   *
   * Carried on the state rather than read where it is drawn, because the
   * surface is a floating route: it has no session, no auth, and no flag store
   * that ever hydrates, so a value it read for itself would be the registry
   * default forever. Main reads the evaluation the app's window wrote into
   * settings and pushes it here with everything else, which is the same path
