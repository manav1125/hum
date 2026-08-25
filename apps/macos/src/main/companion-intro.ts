/**
 * The introduction — design `C4`. Four beats, shown once.
 *
 * **Main owns the beat position, and that is the whole reason this is a
 * module.** The card is drawn by a renderer that is one IPC message behind,
 * so a press can arrive describing a beat that is no longer on screen — a
 * double-tap on "Next", or a click that lands while a beat is being replaced.
 * If the renderer owned the index, that stale press would advance from
 * wherever the renderer happened to be, skipping a beat or replaying one. So
 * every press names the beat it was made against, and a press against a beat
 * that has moved on is discarded.
 *
 * Two actions only, `Next` and `Dismiss`, for the same reason: every action
 * that is not one of those is one more thing a stale press could do wrongly.
 */

export interface IntroBeat {
  /** The eyebrow: `1 · MEET`. */
  step: string;
  title: string;
  body: string;
}

/**
 * The four beats, in design's words.
 *
 * The order is the argument: what it is, then the two things you can do with
 * it, then how to make it go away. Nobody is told how to dismiss something
 * before they have been told what it is.
 */
export const COMPANION_INTRO_BEATS: readonly IntroBeat[] = [
  {
    step: "1 · MEET",
    title: "I'm Cue.",
    body: "I stay on your desktop, even when the app is closed. I don't watch anything unless you ask.",
  },
  {
    step: "2 · TALK",
    title: "◎ Hold me to talk",
    body: "The mic listens only while you hold — let go and it's off. Ask anything; I answer right here.",
  },
  {
    step: "3 · TYPE",
    title: "✎ Click me to type",
    body: "One question, one sourced answer. ⌘↵ keeps what you typed as a note instead.",
  },
  {
    step: "4 · MENU",
    title: "Right-click me",
    body: "That's where you resize me, quiet me, or tuck me away. I never mind.",
  },
] as const;

export interface IntroState {
  beat: number;
  total: number;
  step: string;
  title: string;
  body: string;
  /** The last beat offers no `Next` — there is nothing after it. */
  last: boolean;
}

export class CompanionIntro {
  private beat = 0;
  private done: boolean;

  constructor(
    alreadySeen: boolean,
    /** Called when the introduction ends, however it ends. */
    private readonly onFinished: () => void,
  ) {
    this.done = alreadySeen;
  }

  current(): IntroState | null {
    if (this.done) return null;
    const beat = COMPANION_INTRO_BEATS[this.beat];
    if (!beat) return null;
    return {
      beat: this.beat,
      total: COMPANION_INTRO_BEATS.length,
      step: beat.step,
      title: beat.title,
      body: beat.body,
      last: this.beat === COMPANION_INTRO_BEATS.length - 1,
    };
  }

  /**
   * Advance, but only from the beat the press was actually made against.
   *
   * Returns whether anything moved, so the caller can tell a real advance
   * from a press it discarded and avoid republishing on nothing.
   */
  next(fromBeat: number): boolean {
    if (this.done || fromBeat !== this.beat) return false;
    if (this.beat >= COMPANION_INTRO_BEATS.length - 1) {
      this.finish();
      return true;
    }
    this.beat += 1;
    return true;
  }

  /** `Dismiss`, and also what the last beat's press does. */
  dismiss(): boolean {
    if (this.done) return false;
    this.finish();
    return true;
  }

  private finish(): void {
    this.done = true;
    this.onFinished();
  }

  isDone(): boolean {
    return this.done;
  }
}
