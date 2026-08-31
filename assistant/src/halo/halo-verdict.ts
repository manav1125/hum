/**
 * The serif line the day is remembered by.
 *
 * S6's first ruling is the whole specification: **the verdict is an
 * observation, never a grade.** It is the most-read sentence in the product —
 * the Day cover, the 9pm recap, the days shelf, the share card all open on it
 * — which makes it the easiest place to accidentally start scoring somebody's
 * life. So the register is chosen from the shape of the day, and the failure
 * mode is deliberately inventory rather than poetry.
 *
 * ## Four registers, chosen by shape
 *
 * | Shape | Register | Example |
 * |---|---|---|
 * | Something was settled | name the outcome | "The morning found Acme its number" |
 * | Chapters, no outcomes | name the texture, specifically | "Mostly errands, and a long call with Ma" |
 * | ≤2 chapters | name the one true thing, small is fine | "A quiet Tuesday — one good idea on the walk home" |
 * | >50% unheard | scope first, then the fragment | "Of the afternoon I heard: the sprint got its cut" |
 *
 * ## What is banned, and why it is checked in code
 *
 * Scoring words (`productive`, `slow`, `light`…), apology, and **any sentence
 * that could apply to every day**. The first two are a prompt instruction and
 * would survive there; the third will not, because "a day of conversations and
 * decisions" reads fine to a model and is worthless to a person. So the ban is
 * enforced after the model answers: a verdict that trips it is thrown away and
 * replaced with the inventory fallback, which is plain but never generic.
 *
 * The verdict may be plain. It may never be generic.
 */

import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("halo-verdict");

export type VerdictRegister = "outcome" | "texture" | "thin" | "gap_scoped";

export interface VerdictDayShape {
  chapters: Array<{
    title: string | null;
    summary: string | null;
    placeLabel: string | null;
    /** True when the chapter settled something — drives the outcome register. */
    hasOutcome: boolean;
  }>;
  /** Seconds actually heard, and the wall-clock the day spanned. */
  heardSeconds: number;
  wornSeconds: number;
  markCount: number;
  /** Local weekday name, for the thin register's "A quiet Tuesday". */
  weekday: string;
}

export interface HaloVerdict {
  text: string;
  register: VerdictRegister;
  /** True when the model was overruled and the inventory fallback used. */
  fallback: boolean;
}

/**
 * Words that grade a day rather than describe it. Checked as whole words so
 * "slowly" in a real sentence is not caught by "slow".
 */
const SCORING_WORDS = [
  "productive",
  "unproductive",
  "slow",
  "busy",
  "light",
  "heavy",
  "wasted",
  "efficient",
  "successful",
  "good day",
  "bad day",
];

const APOLOGY_PATTERNS = [
  /\bsorry\b/i,
  /\bunfortunately\b/i,
  /\bnot much\b/i,
  /\bafraid\b/i,
];

/**
 * Sentences that fit every day. This is the ban a prompt cannot hold, because
 * each of these reads as a perfectly good summary to the model that wrote it.
 */
const GENERIC_PATTERNS = [
  /^a day of\b/i,
  /^a mix of\b/i,
  /\bconversations and (?:decisions|meetings|tasks)\b/i,
  /\bvarious (?:topics|things|conversations)\b/i,
  /\bseveral (?:conversations|meetings|discussions)\b/i,
  /\bcaught up (?:on|with) (?:things|work)\b/i,
  /\ba (?:full|typical|normal|regular) day\b/i,
];

/** Which register the day's shape calls for. Decided here, not by the model. */
export function chooseRegister(shape: VerdictDayShape): VerdictRegister {
  const heardShare =
    shape.wornSeconds > 0 ? shape.heardSeconds / shape.wornSeconds : 1;
  // Scope first when most of the day was not heard — the verdict must not
  // read as though it covered hours nobody was wearing anything.
  if (heardShare < 0.5) return "gap_scoped";
  if (shape.chapters.length <= 2) return "thin";
  if (shape.chapters.some((c) => c.hasOutcome)) return "outcome";
  return "texture";
}

/**
 * True when a candidate verdict trips one of the three bans.
 *
 * Exported because this is the interesting half: it is the rule that keeps a
 * plausible sentence from becoming the line somebody reads every evening.
 */
export function isBannedVerdict(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();

  for (const word of SCORING_WORDS) {
    const pattern = new RegExp(`\\b${word}\\b`, "i");
    if (pattern.test(lower)) return true;
  }
  if (APOLOGY_PATTERNS.some((p) => p.test(trimmed))) return true;
  if (GENERIC_PATTERNS.some((p) => p.test(trimmed))) return true;
  return false;
}

/**
 * The fallback: inventory, not poetry.
 *
 * "4 conversations, nothing that needed keeping" is a true, specific,
 * unglamorous sentence, and it is a far better thing to read than a lyrical
 * line that describes nothing. This never calls a model, so it is also what
 * the day gets when there is no provider at all.
 */
export function inventoryVerdict(shape: VerdictDayShape): string {
  const chapters = shape.chapters.length;
  const hours = Math.round(shape.heardSeconds / 3600);

  if (chapters === 0) {
    return hours > 0
      ? `${hours} ${hours === 1 ? "hour" : "hours"} heard, nothing that needed keeping.`
      : "Nothing heard today.";
  }

  const noun = chapters === 1 ? "conversation" : "conversations";
  if (shape.markCount > 0) {
    const marks =
      shape.markCount === 1
        ? "one you marked"
        : `${shape.markCount} you marked`;
    return `${chapters} ${noun}, ${marks}.`;
  }
  return `${chapters} ${noun}, nothing that needed keeping.`;
}

const TOOL_SCHEMA = {
  name: "write_day_verdict",
  description:
    "Write the one line the wearer's day will be remembered by — an observation about what actually happened, never a judgement of how the day went.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string",
        description:
          "One sentence, under 90 characters, naming something specific that happened. No trailing full stop unless the sentence needs it.",
      },
    },
    required: ["verdict"],
  },
} as const;

const REGISTER_GUIDANCE: Record<VerdictRegister, string> = {
  outcome:
    'Something was settled today. Name the OUTCOME, concretely — e.g. "The morning found Acme its number".',
  texture:
    'Chapters happened but nothing was settled. Name the TEXTURE, specifically — e.g. "Mostly errands, and a long call with Ma". Specific beats pretty.',
  thin: 'Very little was heard. Name the ONE true thing, and small is fine — e.g. "A quiet Tuesday — one good idea on the walk home".',
  gap_scoped:
    'Most of the day was not heard. SCOPE FIRST, then the fragment — e.g. "Of the afternoon I heard: the sprint got its cut".',
};

const SYSTEM_PROMPT = `You are writing one line at the top of somebody's day, in a diary they will read every evening. Call write_day_verdict exactly once.

Rules, all absolute:
- It is an OBSERVATION, never a grade. Never say a day was productive, slow, busy, light, good or bad.
- Never apologise and never note an absence of things.
- Never write a sentence that could apply to any other day. If it would fit yesterday too, it is wrong.
- Name something that actually happened, using the real nouns from the chapters — the person, the deal, the place.
- Under 90 characters. Plain is fine; generic is not.`;

/**
 * Write the day's verdict.
 *
 * Falls back to inventory whenever the model is unavailable, unintelligible,
 * or says something banned — the day always gets a true sentence.
 */
export async function writeDayVerdict(
  shape: VerdictDayShape,
): Promise<HaloVerdict> {
  const register = chooseRegister(shape);
  const fallbackText = inventoryVerdict(shape);

  const provider = await getConfiguredProvider("meetingRecap");
  if (!provider) {
    return { text: fallbackText, register, fallback: true };
  }

  const chapterLines = shape.chapters
    .map((c) => {
      const place = c.placeLabel ? ` · ${c.placeLabel}` : "";
      return `- ${c.title ?? "(untitled)"}${place}${c.summary ? `: ${c.summary}` : ""}`;
    })
    .join("\n");

  const heardHours = (shape.heardSeconds / 3600).toFixed(1);

  try {
    const response = await provider.sendMessage(
      [
        userMessage(
          `Weekday: ${shape.weekday}\nHeard: ${heardHours}h\nMarked by the wearer: ${shape.markCount}\n\n## Chapters\n${chapterLines || "(none)"}`,
        ),
      ],
      {
        tools: [TOOL_SCHEMA],
        systemPrompt: `${SYSTEM_PROMPT}\n\n${REGISTER_GUIDANCE[register]}`,
        config: {
          callSite: "meetingRecap" as const,
          tool_choice: { type: "tool" as const, name: "write_day_verdict" },
        },
      },
    );

    const toolBlock = extractToolUse(response);
    const candidate =
      toolBlock &&
      typeof (toolBlock.input as { verdict?: unknown }).verdict === "string"
        ? (toolBlock.input as { verdict: string }).verdict.trim()
        : "";

    if (!candidate || isBannedVerdict(candidate)) {
      if (candidate) {
        log.info({ candidate }, "Verdict tripped a ban; using inventory");
      }
      return { text: fallbackText, register, fallback: true };
    }
    return { text: candidate, register, fallback: false };
  } catch (err) {
    log.warn({ err }, "Verdict provider call failed; using inventory");
    return { text: fallbackText, register, fallback: true };
  }
}
