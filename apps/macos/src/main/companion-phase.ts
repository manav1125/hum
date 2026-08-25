import {
  outrankPhase,
  type CompanionPhase,
} from "@vellumai/ipc-contract";

/**
 * What the creature is showing, and why — design `C2`, `C6`, `C7`, `C9`.
 *
 * **Main decides the phase; the renderer only draws it.** Several of the
 * inputs are things only main can see (whether a capture is live, whether the
 * app has been raised for an approval, whether the pointer is near a window
 * that has not claimed its canvas), and a renderer that resolved its own
 * phase would have to be told all of them anyway. Resolving in one place also
 * means precedence is applied once rather than twice with two chances to
 * disagree.
 *
 * The resolver is a pure function of the signals, which is what makes the
 * interesting cases — a nudge suppressed by quiet hours, a recording that
 * cannot be covered by a summary — checkable without a window.
 */

/** Everything the phase depends on. Absent signals are the quiet defaults. */
export interface CompanionSignals {
  /** The pointer is over something drawn. Main's answer, not a guess. */
  hover: boolean;
  /** A run is in progress: the dot leaves the ring and travels. */
  busy: boolean;
  /** Signal. Its absence is a phase, not an error (`C6`). */
  online: boolean;
  /** Reading one window, once, while it is open (`Q5`). */
  watching: boolean;
  /** A live Notes / Halo / meeting session this mirrors (`C11`). */
  recording: { label: string; elapsed: string } | null;
  /** An approval the app has been raised for (`C6`, `C9`). */
  awaitingApproval: boolean;
  /**
   * Whether the protocol has been explained once already (`C9`).
   *
   * The first window-raise reads as a glitch; said once it becomes protocol.
   * Said every time it becomes noise.
   */
  approvalExplained: boolean;
  /** A read that failed. The question is kept — never an empty answer. */
  couldnt: boolean;
  /** Cue moving first (`C7`). Suppressed entirely during quiet hours. */
  nudge: { line: string; itemId: string } | null;
  /** The typing card is open. */
  typing: boolean;
  /** A mic is held open. */
  listening: boolean;
  /** Quiet hours: the creature sits there, but it never moves first. */
  quiet: boolean;
  /**
   * Something was dropped and is being held, unstored (`C10`).
   *
   * High in the order because it expires on its own in ten seconds — anything
   * that covered it would drop the item rather than defer it.
   */
  caught: boolean;
}

export const QUIET_SIGNALS: CompanionSignals = {
  hover: false,
  busy: false,
  online: true,
  watching: false,
  recording: null,
  awaitingApproval: false,
  approvalExplained: false,
  couldnt: false,
  nudge: null,
  typing: false,
  listening: false,
  quiet: false,
  caught: false,
};

export interface ResolvedPhase {
  phase: CompanionPhase;
  line?: string;
  detail?: string;
}

/**
 * The copy, stated once.
 *
 * Kept here rather than in the renderer because the sentence and the decision
 * to say it are the same decision — `C9`'s long line exists only on the first
 * raise, and a renderer choosing between two strings would need to be told
 * that anyway.
 */
const COULDNT_LINE = "I couldn't read that just now — your question is kept.";

/** `C9`, once: the raise reads as a glitch until it is named as protocol. */
const APPROVAL_FIRST_LINE =
  "That needs your okay, so I've opened the app — I'll always bring you there for anything that acts.";
const APPROVAL_FIRST_DETAIL = "I never approve things from here.";

/** `C6`, every time after. */
const APPROVAL_LINE = "That one needs your okay — I've raised the window.";
const APPROVAL_DETAIL = "Nothing runs until you answer.";

/** `C6`: the creature dims to slate — alive, not asleep. */
const OFFLINE_LINE = "Notes still save.";
const OFFLINE_DETAIL = "Questions wait for signal — I'll say when I'm back.";

/**
 * Which phase wins, and what it says.
 *
 * Precedence comes from the contract both processes share, so the creature
 * can never be showing one thing while main believes another.
 */
export function resolveCompanionPhase(
  signals: CompanionSignals,
): ResolvedPhase {
  const active: CompanionPhase[] = ["resting"];
  if (signals.hover) active.push("hover");
  if (!signals.online) active.push("offline");
  if (signals.busy) active.push("working");
  // Quiet hours suppress the nudge at the source rather than hiding it later:
  // a nudge that resolved and was then covered would still have spent its
  // budget, and the rule is that the creature never moves first.
  if (signals.nudge && !signals.quiet) active.push("nudge");
  if (signals.couldnt) active.push("couldnt");
  if (signals.watching) active.push("watching");
  if (signals.awaitingApproval) active.push("waiting");
  if (signals.caught) active.push("caught");
  if (signals.listening) active.push("listening");
  if (signals.recording) active.push("recording");
  if (signals.typing) active.push("typing");

  const phase = active.reduce(outrankPhase);

  switch (phase) {
    case "couldnt":
      return { phase, line: COULDNT_LINE };
    case "waiting":
      return signals.approvalExplained
        ? { phase, line: APPROVAL_LINE, detail: APPROVAL_DETAIL }
        : { phase, line: APPROVAL_FIRST_LINE, detail: APPROVAL_FIRST_DETAIL };
    case "offline":
      return { phase, line: OFFLINE_LINE, detail: OFFLINE_DETAIL };
    case "recording":
      return signals.recording
        ? {
            phase,
            line: `Recording · ${signals.recording.label} · ${signals.recording.elapsed}`,
          }
        : { phase };
    case "nudge":
      return signals.nudge ? { phase, line: signals.nudge.line } : { phase };
    default:
      // Hover draws its own affordances; working, listening, watching and
      // typing say what they are with the creature and the card. A line
      // repeating what the creature already expresses is noise.
      return { phase };
  }
}

const same = (a: ResolvedPhase, b: ResolvedPhase): boolean =>
  a.phase === b.phase && a.line === b.line && a.detail === b.detail;

/**
 * The signals, and a change notification when they resolve to something new.
 *
 * Signals change far more often than the phase does — every pointer move is a
 * hover report — so publishing on the resolved value rather than the input is
 * what keeps the renderer from redrawing on nothing.
 */
export class CompanionPhaseStore {
  private signals: CompanionSignals = { ...QUIET_SIGNALS };
  private resolved: ResolvedPhase = resolveCompanionPhase(QUIET_SIGNALS);

  constructor(private readonly onChange: (resolved: ResolvedPhase) => void) {}

  set(patch: Partial<CompanionSignals>): void {
    const next = { ...this.signals, ...patch };
    const resolved = resolveCompanionPhase(next);
    this.signals = next;
    if (same(this.resolved, resolved)) return;
    this.resolved = resolved;
    this.onChange(resolved);
  }

  current(): ResolvedPhase {
    return this.resolved;
  }

  read(): CompanionSignals {
    return this.signals;
  }
}
