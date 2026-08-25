/**
 * The always-on companion's phase vocabulary — design `C2`.
 *
 * **Why this is in the contract rather than in either app.** Main decides the
 * phase and the renderer draws it, which only works if both sides agree on
 * what the phases are and which one wins. Two copies of a precedence table
 * drifting apart is a creature showing one thing while main believes another —
 * and since main is also the side that decides who owns the clicks, that
 * disagreement lands as a window claiming a canvas for a surface it is not
 * drawing.
 */

export type CompanionPhase =
  /** Nothing to say. The dot is seated: it is your turn. */
  | "resting"
  /** The pointer is near — main's answer, never the renderer's guess. */
  | "hover"
  /** A mic is held open. The creature breathes. */
  | "listening"
  /** The dot has left the ring and is travelling. */
  | "working"
  /** The one phase that grows vertically (`C2`). */
  | "typing"
  /** Reading one window, once, while it is open (`Q5`). */
  | "watching"
  /** A run has finished and is reporting. */
  | "summary"
  /** Cue moved first (`C7`). The one entrance with a flourish. */
  | "nudge"
  /** Mirrors a real Notes / Halo / meeting session (`C11`). */
  | "recording"
  /** Waiting on an approval the app has been raised for (`C6`, `C9`). */
  | "waiting"
  /** A read that failed. The question is kept; the creature never shrugs. */
  | "couldnt"
  /** No signal. Notes still save (`C6`). */
  | "offline";

/**
 * Precedence, upstream's order kept.
 *
 * A half-typed sentence and a live call are both something you are in the
 * middle of, so they outrank a session that is merely reporting. `hover` is
 * bottom because it is a hint, and being outranked costs it nothing.
 *
 * `recording` and `watching` sit high for a reason that is not aesthetic: they
 * are the only visible evidence that audio or a screen is being read, so
 * nothing quieter may cover them (`C11`).
 */
export const COMPANION_PHASE_RANK: Record<CompanionPhase, number> = {
  typing: 100,
  recording: 95,
  listening: 90,
  waiting: 85,
  watching: 80,
  summary: 70,
  couldnt: 65,
  nudge: 60,
  working: 50,
  offline: 40,
  hover: 10,
  resting: 0,
};

/** Whichever of the two the user is more in the middle of. */
export function outrankPhase(
  a: CompanionPhase,
  b: CompanionPhase,
): CompanionPhase {
  return COMPANION_PHASE_RANK[a] >= COMPANION_PHASE_RANK[b] ? a : b;
}

/**
 * Everything main publishes to the companion window, as one message.
 *
 * Geometry is here alongside the phase because they change for the same
 * reasons and a renderer holding half of an update is a creature drawn at one
 * scale inside a canvas sized for another.
 */
export interface CompanionStatePayload {
  phase: CompanionPhase;
  /** The creature's box in points — the whole of the surface's scale. */
  avatarBox: number;
  /** Which way the pill unfurls. Only main knows the display. */
  growth: "right" | "left";
  /** Which way the typing card unfurls. Same reason. */
  cardGrowth: "up" | "down";
  /** The words beside the creature, where the finer phase lives. */
  line?: string;
  /** A second, quieter line — the consequence, or the source. */
  detail?: string;
  /** The answer in the typing card. */
  answer?: string;
  /** Where the answer came from. An unsourced answer never renders. */
  source?: string;
  /**
   * Quiet hours: the creature still sits there, but it never moves first.
   */
  quiet?: boolean;
  /**
   * An ignored nudge, held on the dot until the next hover (`C7`).
   *
   * Never lost, and never repeated out loud.
   */
  heldNudge?: string;
  /** Character, composed live (`C5`): three traits, one of them the accent. */
  blink?: "calm" | "lively";
  weight?: "fine" | "regular" | "bold";
  /**
   * The four-beat introduction, while main is offering it (`C4`).
   *
   * Absent from every publish that is not offering it — which is why the
   * renderer must replace this payload rather than merge it.
   */
  intro?: CompanionIntroBeat;
}

/** One beat of the introduction (`C4`). */
export interface CompanionIntroBeat {
  /** Which beat this is. Presses name it, so a stale one can be discarded. */
  beat: number;
  total: number;
  step: string;
  title: string;
  body: string;
  /** The last beat offers no `Next` — there is nothing after it. */
  last: boolean;
}
