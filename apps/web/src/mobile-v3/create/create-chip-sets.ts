/**
 * Mobile v3 Create — N3, chip stage two (new in v29).
 *
 * ## Why this stage exists at all
 *
 * v27 had one elicitation shape: the fill screen, driven by a structured
 * template's typed inputs. That leaves a hole. Three Create types reach a real
 * generator through QUICK templates that declare no questions whatsoever:
 *
 *   video   — 9 templates, 0 elicit sets
 *   canvas  — 3 templates, 0 elicit sets
 *   audio   — 4 templates, 0 elicit sets
 *
 * (Counted from `CREATE_MODES` in `domains/create/create-templates.ts`; the
 * counts match design's own audit exactly.) Picking one of those built straight
 * from the template's prompt, guessing format, length and voice. Design's words
 * for why video leads: *"Nine templates, no questions today — so a wrong guess
 * burns a full render."*
 *
 * ## Why Sheets is not here, explicitly
 *
 * v29 corrected its own earlier grouping: **Sheets is out — it already has
 * elicit sets.** All three sheets templates declare their own questions, so
 * adding a type-scoped chip row would ask a second time. This is the one
 * type-conditional branch the v27 state machine did not have, and the reason
 * `create-spine.ts` can no longer describe itself as "the v27 rule".
 *
 * ## Why the questions are per TYPE and not per template
 *
 * Constraint 5 in v29: *"Remix loses intent on reload. Fine as-is — chips are
 * type-scoped."* Format, length and voiceover are properties of the medium, not
 * of "cinematic clip" versus "product reveal", so one authored set serves all
 * nine video templates and survives a remix. Per-template elicit sets remain the
 * better long-term answer for the registry itself (v29's authoring order is
 * Video → Canvas → Audio); this closes the hole in the meantime without
 * inventing nine sets of questions nobody has authored.
 *
 * Everything here is a QUESTION, never an answer: no chip is pre-selected, and
 * skipping the stage sends nothing rather than sending a default that would read
 * as the user's choice.
 */

/** One chip row on the stage-two screen. */
export interface ChipQuestion {
  /** Folded into the run's values under this key. */
  key: string;
  /** The question, as asked. */
  label: string;
  /** The choices. Never empty, and never pre-selected. */
  options: string[];
}

/**
 * The authored sets.
 *
 * Video's three are design's, verbatim from N3: format · length · voiceover.
 * Canvas and Audio "follow the same shape" — design named the axes ("Canvas asks
 * a source and an action. Audio asks a voice and a length") and the options are
 * drawn from what those modes' templates actually do, so every chip resolves to
 * something the generator can honour.
 */
const CHIP_SETS: Record<string, ChipQuestion[]> = {
  video: [
    {
      key: "format",
      label: "Live-action or animated?",
      options: ["Live-action", "Animated"],
    },
    { key: "length", label: "How long?", options: ["15s", "30s", "60s"] },
    {
      key: "voiceover",
      label: "Voiceover?",
      options: ["No, text on screen", "Yes"],
    },
  ],
  canvas: [
    {
      key: "source",
      label: "What are we starting from?",
      options: ["An image I'll upload", "Something you already made", "A photo I'll describe"],
    },
    {
      key: "action",
      label: "What should I do to it?",
      options: ["Restyle it", "Retouch it", "Replace something in it"],
    },
  ],
  audio: [
    {
      key: "voice",
      label: "What should it sound like?",
      options: ["A spoken voice", "Music, no vocals", "A single sound effect"],
    },
    { key: "length", label: "How long?", options: ["15s", "30s", "A minute or more"] },
  ],
};

/**
 * The chip questions for a type, or `[]` when the type asks none.
 *
 * `[]` is the answer for seven of the ten types, and for Sheets it is the answer
 * *because* Sheets already elicits — not because nobody got to it.
 */
export function chipQuestionsFor(typeId: string): ChipQuestion[] {
  return CHIP_SETS[typeId] ?? [];
}

/** True when this type carries a stage two. */
export function hasChipStage(typeId: string): boolean {
  return chipQuestionsFor(typeId).length > 0;
}

/**
 * The reason shown above the chips, in design's own framing: the stage has to
 * justify itself or it reads as one more screen between the user and the thing.
 */
export function chipStageReason(typeId: string): string {
  switch (typeId) {
    case "video":
      return "Three things before I spend the render — video is the expensive one to get wrong.";
    case "canvas":
      return "Two things first, so I work on the right image in the right way.";
    case "audio":
      return "Two things first — the wrong voice or length means starting over.";
    default:
      return "A couple of things before I start.";
  }
}

/** "Build the video →" — the CTA names what it will make. */
export function chipStageCta(noun: string): string {
  return `Build the ${noun} →`;
}
