/**
 * The single translation from stored state to the words a user reads.
 *
 * Design invariant (§3, §24): **no raw enum ever reaches a user.** `AWAITING
 * REVIEW`, `QUEUED` and `RUNNING` were rendering verbatim on All work — they
 * are database values, and they leak the schema into the product's voice. This
 * module is the one place that mapping lives, so a new state cannot be added
 * without deciding what it is called and which glyph carries it.
 *
 * Two rules are encoded here rather than left to each surface:
 *
 * **No colour-only state.** Every entry carries a glyph. Colour is an
 * accelerant, never the sole carrier — that is both the accessibility answer
 * and the reason these read correctly in a screenshot.
 *
 * **Queued and parked are different promises.** `queued` means Cue will run it
 * itself; parked means it is dormant until a human presses go. Collapsing them
 * would either imply work is about to happen when it is not, or hide work that
 * is about to spend money. Batch-added and bulk-loaded items arrive parked for
 * exactly that reason.
 */

/**
 * ⚠ UNRESOLVED — this module and `@vellumai/design-library`'s `work-state.ts`
 * both name work states, and on one label they disagree.
 *
 * `work-state.ts` implements deliverable 07 (autonomy-states): it resolves a
 * status to a loop state and owns the accent/text/wash tokens per state. This
 * module implements deliverable 01 §3, the work-surfaces vocabulary.
 *
 * They agree on `done`, and on the glyphs. They disagree here:
 *
 *   status             07 work-state      01 §3 (this file)
 *   awaiting_review    "Review"           "Needs you"
 *   running            "Running"          "Cue is doing"
 *   queued/pending     "Picked up"        "Waiting" (and "parked" is distinct)
 *
 * `awaiting_review` is the one that matters — it is the label on the deck's
 * primary lane and on the sidebar badge. The handoff README gives canonical
 * precedence over the packs for HQ and mobile Today, but says nothing about 07,
 * so this is a design ruling, not an engineering one.
 *
 * Until that ruling: this file owns the LABELS for the work surfaces (HQ, All
 * work), `work-state.ts` owns the TOKENS everywhere, and neither duplicates the
 * other's job. When the ruling lands, one of these should delegate to the other
 * so a third vocabulary can never appear.
 */

/** Stored states this app renders. Mirrors the daemon's work-item status. */
export type WorkState =
  | "awaiting_review"
  | "running"
  | "queued"
  | "parked"
  | "done"
  | "came_in"
  | "ready_for_review"
  | "blocked";

export interface WorkVocabularyEntry {
  /** What the user reads. Sentence case — these appear mid-sentence. */
  label: string;
  /** Carries the state without colour. Never omit. */
  glyph: string;
  /** Token name on the HQ palette (`C`), not a literal. */
  tone: "amber" | "blue" | "green" | "violet" | "muted";
  /** Short gloss for tooltips and screen readers. */
  hint: string;
}

const VOCABULARY: Record<WorkState, WorkVocabularyEntry> = {
  awaiting_review: {
    label: "Needs you",
    glyph: "‖",
    tone: "amber",
    hint: "Cue finished this and is waiting on your decision",
  },
  running: {
    label: "Cue is doing",
    glyph: "◐",
    tone: "blue",
    hint: "Cue is working on this right now",
  },
  queued: {
    label: "Waiting",
    glyph: "○",
    tone: "blue",
    hint: "Cue will start this on its own",
  },
  parked: {
    label: "Parked",
    glyph: "○",
    tone: "muted",
    hint: "Dormant until you start it — nothing runs or spends",
  },
  done: {
    label: "Done",
    glyph: "✓",
    tone: "green",
    hint: "Finished",
  },
  came_in: {
    label: "Came in",
    glyph: "↴",
    tone: "blue",
    hint: "Arrived from one of your sources",
  },
  ready_for_review: {
    label: "Ready for review",
    glyph: "◱",
    tone: "violet",
    hint: "Ready when you are",
  },
  blocked: {
    label: "Blocked",
    glyph: "◼",
    tone: "muted",
    hint: "Cannot proceed without something else",
  },
};

/**
 * Translate a stored state. Unknown values fall back to a humanised form of
 * the raw string rather than rendering the enum: an unmapped state is a bug,
 * but shipping `AWAITING_REVIEW` to a user is a worse one.
 */
export function describeWorkState(state: string): WorkVocabularyEntry {
  const known = VOCABULARY[state as WorkState];
  if (known) return known;
  return {
    label: humanise(state),
    glyph: "○",
    tone: "muted",
    hint: humanise(state),
  };
}

/** `awaiting_review` → `Awaiting review`. Last resort only. */
function humanise(raw: string): string {
  const words = raw.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!words) return "Unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every state, for surfaces that render a legend or a filter set. */
export function allWorkStates(): { state: WorkState; entry: WorkVocabularyEntry }[] {
  return (Object.keys(VOCABULARY) as WorkState[]).map((state) => ({
    state,
    entry: VOCABULARY[state],
  }));
}

// ---------------------------------------------------------------------------
// The eight verbs (§4)
// ---------------------------------------------------------------------------

/**
 * One verb set, everywhere — triage, the row `⋯`, task detail, and mobile
 * swipe/long-press. Muscle memory only transfers if the keys are identical
 * across surfaces, so the binding lives here rather than per-surface.
 */
export interface WorkVerb {
  id: WorkVerbId;
  label: string;
  /** Single key, as shown in the UI. */
  key: string;
  hint: string;
  /** True when the verb changes something the user may want back. */
  reversible: boolean;
}

export type WorkVerbId =
  | "approve"
  | "open"
  | "later"
  | "archive"
  | "done_elsewhere"
  | "file"
  | "hand_off"
  | "undo";

export const WORK_VERBS: WorkVerb[] = [
  {
    id: "approve",
    label: "Approve",
    key: "↵",
    hint: "Cue's proposal ships",
    reversible: true,
  },
  {
    id: "open",
    label: "Open",
    key: "O",
    hint: "Open the detail",
    reversible: true,
  },
  {
    id: "later",
    label: "Later",
    key: "L",
    hint: "Comes back with its reason",
    reversible: true,
  },
  {
    // Archive NEVER deletes and never completes. It teaches relevance — the
    // difference between "I don't need this" and "this is finished" is the
    // difference between a filter and a lie about what Cue achieved.
    id: "archive",
    label: "Archive",
    key: "⌫",
    hint: "Never deletes — teaches Cue what you don't need",
    reversible: true,
  },
  {
    // Completes for progress and ranking, and the ledger records "completed by
    // you". Cue must never take credit for work it did not do.
    id: "done_elsewhere",
    label: "Done elsewhere",
    key: "D",
    hint: "Completes it — credited to you, not Cue",
    reversible: true,
  },
  {
    id: "file",
    label: "File",
    key: "F",
    hint: "Move to another mission, or to Life",
    reversible: true,
  },
  {
    id: "hand_off",
    label: "Hand off",
    key: "H",
    hint: "Give it to an agent or a person",
    reversible: true,
  },
  {
    id: "undo",
    label: "Undo",
    key: "⌘Z",
    hint: "Always available, for the whole session",
    reversible: true,
  },
];

/** Lookup by the single key a surface received from the keyboard. */
export function verbForKey(key: string): WorkVerb | null {
  const normalised = key.length === 1 ? key.toUpperCase() : key;
  return (
    WORK_VERBS.find(
      (v) => v.key === normalised || v.key === key || v.id === key,
    ) ?? null
  );
}
