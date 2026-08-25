/**
 * The nudge — design `C7`. Cue moving first, and the rules that keep it from
 * becoming Clippy.
 *
 * **The gate is the feature.** A companion that can speak unprompted is one
 * bad rule away from being the thing people switch off, so every condition
 * under which it may not speak is stated here as a pure function and checked.
 * The failure mode is not a crash — it is a creature that interrupts once too
 * often, which nobody files a bug about; they just hide it.
 *
 * The budget is **shared with push, and replaced rather than doubled**: when
 * the desktop is active a nudge takes the interruption instead of the
 * notification, never as well as it. That only works if one side decides, so
 * the app asks and this answers, rather than both making their own judgement.
 */

/** Three a day, shared with push. */
export const NUDGE_DAILY_BUDGET = 3;

/**
 * How recently the user has touched anything before a nudge is held back.
 *
 * Design says "never while you're typing anywhere", watching cadence rather
 * than content. What is actually available without a system-wide keyboard
 * hook is *any* input — `powerMonitor.getSystemIdleTime()` — so this is
 * deliberately broader than typing. Interrupting somebody mid-drag is no
 * better than interrupting them mid-sentence.
 */
export const NUDGE_INPUT_QUIET_MS = 4_000;

/** How long a nudge stands before it retracts on its own (`C7`). */
export const NUDGE_RETRACT_MS = 8_000;

/**
 * What the valve actually learns on (`C7`, "✕ teaches the valve").
 *
 * Not the item — the valve learns about the sender, channel or rule the item
 * came through, so a nudge that carried only an item id would dismiss into
 * nothing. Optional because not everything worth nudging about has a subject
 * the valve can generalise from.
 */
export interface NudgeSubject {
  kind: "sender" | "channel" | "rule";
  key: string;
}

export interface NudgeRequest {
  /** The work item this is about. Never nudged for twice. */
  itemId: string;
  subject?: NudgeSubject;
  /** The one line. A nudge is one line, one Open, one ✕ — never more. */
  line: string;
  /**
   * Where it came from.
   *
   * Only two things qualify: an item the valve has already decided needs you,
   * and Cue correcting itself. Everything else is Cue talking about its own
   * work, which is what a companion must never do unprompted.
   */
  source: "needs-you" | "correction" | (string & {});
}

export interface NudgeConditions {
  /** Interruptions already spent today, shared with push. */
  spentToday: number;
  /** Items already nudged for. */
  alreadyNudged: ReadonlySet<string>;
  /** Milliseconds since the user last touched anything. */
  sinceInputMs: number;
  quiet: boolean;
  /** Whether the creature is on screen to be nudged from (`C11`). */
  visible: boolean;
}

export type NudgeRefusal =
  | "source"
  | "repeat"
  | "budget"
  | "quiet"
  | "typing"
  | "hidden";

export type NudgeVerdict =
  | { allowed: true }
  | { allowed: false; reason: NudgeRefusal };

const QUALIFIES = new Set(["needs-you", "correction"]);

/**
 * May Cue speak first about this?
 *
 * Ordered so the answer names the most fundamental reason rather than the
 * first one checked: something that never qualified is not "over budget", and
 * telling the caller it was over budget would have them retry tomorrow.
 */
export function mayNudge(
  request: NudgeRequest,
  conditions: NudgeConditions,
): NudgeVerdict {
  if (!QUALIFIES.has(request.source)) {
    return { allowed: false, reason: "source" };
  }
  if (conditions.alreadyNudged.has(request.itemId)) {
    return { allowed: false, reason: "repeat" };
  }
  if (!conditions.visible) return { allowed: false, reason: "hidden" };
  if (conditions.quiet) return { allowed: false, reason: "quiet" };
  if (conditions.sinceInputMs < NUDGE_INPUT_QUIET_MS) {
    return { allowed: false, reason: "typing" };
  }
  if (conditions.spentToday >= NUDGE_DAILY_BUDGET) {
    return { allowed: false, reason: "budget" };
  }
  return { allowed: true };
}

/**
 * A nudge that was never answered.
 *
 * It retracts to a glint held on the dot rather than disappearing: an ignored
 * nudge is never lost, and never repeats itself out loud. The item is in HQ
 * regardless — this is only about whether Cue says it again.
 */
export interface HeldNudge {
  itemId: string;
  line: string;
  subject?: NudgeSubject;
}

export interface NudgeHost {
  /** Show it, or take it away. */
  present(nudge: HeldNudge | null): void;
  /** Hold the glint on the dot, or clear it. */
  hold(nudge: HeldNudge | null): void;
  /** A dismissal teaches the valve, like everywhere else. */
  taught(nudge: HeldNudge): void;
  /** Wall clock, injected so the day boundary is testable. */
  now(): number;
}

/**
 * The live nudge, the held one, and the day's spend.
 *
 * The day boundary is computed from the local date rather than a timer,
 * because a timer that fires at midnight is a timer that does not fire when
 * the machine was asleep at midnight — which is most nights.
 */
export class CompanionNudges {
  private live: HeldNudge | null = null;
  private held: HeldNudge | null = null;
  private nudged = new Set<string>();
  /**
   * Nudges that never got the chance to be shown (`C11`).
   *
   * Refused only because there was no creature on screen — hidden, or yielded
   * to a fullscreen app. They spent nothing, so they are not lost; the menu
   * bar counts them and they can be replayed. Anything refused for a reason
   * about the nudge itself (budget, quiet hours, a repeat) is not held: those
   * are decisions, not accidents.
   */
  private withheld: HeldNudge[] = [];
  private spent = 0;
  private day: string;
  private retract: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: NudgeHost,
    /**
     * How long a nudge stands. Injectable so the retraction can be checked
     * without a test that sleeps for the real eight seconds — a suite nobody
     * wants to run is a suite that stops being run.
     */
    private readonly retractMs: number = NUDGE_RETRACT_MS,
  ) {
    this.day = this.today();
  }

  private today(): string {
    return new Date(this.host.now()).toDateString();
  }

  /** Roll the day over if it has changed since anything was last counted. */
  private rollDay(): void {
    const today = this.today();
    if (today === this.day) return;
    this.day = today;
    this.spent = 0;
    this.nudged.clear();
    // Yesterday's withheld nudges are yesterday's news. Replaying them a day
    // later is the thing that makes people hide the creature.
    this.withheld = [];
  }

  conditions(rest: {
    sinceInputMs: number;
    quiet: boolean;
    visible: boolean;
  }): NudgeConditions {
    this.rollDay();
    return {
      spentToday: this.spent,
      alreadyNudged: this.nudged,
      ...rest,
    };
  }

  /**
   * Offer a nudge. The verdict is the answer to "did you take the
   * interruption?", so the caller knows whether to push instead.
   */
  offer(
    request: NudgeRequest,
    rest: { sinceInputMs: number; quiet: boolean; visible: boolean },
  ): NudgeVerdict {
    const verdict = mayNudge(request, this.conditions(rest));
    if (!verdict.allowed) {
      if (verdict.reason === "hidden") this.withhold(request);
      return verdict;
    }

    this.spent += 1;
    this.nudged.add(request.itemId);
    this.live = {
      itemId: request.itemId,
      line: request.line,
      ...(request.subject ? { subject: request.subject } : {}),
    };
    this.held = null;
    this.host.hold(null);
    this.host.present(this.live);
    this.arm();
    return verdict;
  }

  private arm(): void {
    this.disarm();
    this.retract = setTimeout(() => this.retractNow(), this.retractMs);
  }

  private disarm(): void {
    if (!this.retract) return;
    clearTimeout(this.retract);
    this.retract = null;
  }

  /** Nobody answered. It becomes a glint rather than nothing. */
  private retractNow(): void {
    this.disarm();
    if (!this.live) return;
    this.held = this.live;
    this.live = null;
    this.host.present(null);
    this.host.hold(this.held);
  }

  /**
   * The pointer arrived. A held glint replays its line — once, and silently.
   */
  hover(): void {
    if (!this.held || this.live) return;
    this.live = this.held;
    this.held = null;
    this.host.hold(null);
    this.host.present(this.live);
    this.arm();
  }

  /** `✕`. Teaches the valve, and the glint goes with it. */
  dismiss(): void {
    const item = this.live ?? this.held;
    this.disarm();
    this.live = null;
    this.held = null;
    this.host.present(null);
    this.host.hold(null);
    if (item) this.host.taught(item);
  }

  /** `Open ›` — the app takes it from here. Nothing acts from the nudge. */
  open(): string | null {
    const item = this.live ?? this.held;
    this.disarm();
    this.live = null;
    this.held = null;
    this.host.present(null);
    this.host.hold(null);
    return item?.itemId ?? null;
  }

  current(): HeldNudge | null {
    return this.live;
  }

  holding(): HeldNudge | null {
    return this.held;
  }

  private withhold(request: NudgeRequest): void {
    if (this.withheld.some((n) => n.itemId === request.itemId)) return;
    this.withheld.push({
      itemId: request.itemId,
      line: request.line,
      ...(request.subject ? { subject: request.subject } : {}),
    });
  }

  /** How many are waiting for a surface to show them on. */
  heldCount(): number {
    return this.withheld.length;
  }

  /**
   * Show the oldest withheld nudge, now that there is somewhere to show it.
   *
   * One at a time: they were withheld because nothing could speak, and
   * answering that by saying three things at once is worse than having said
   * nothing.
   */
  replayWithheld(rest: {
    sinceInputMs: number;
    quiet: boolean;
    visible: boolean;
  }): boolean {
    const next = this.withheld[0];
    if (!next) return false;
    this.withheld.shift();
    this.disarm();
    this.live = next;
    this.held = null;
    this.host.hold(null);
    this.host.present(this.live);
    this.arm();
    void rest;
    return true;
  }

  /** Teardown. */
  stop(): void {
    this.disarm();
  }
}
