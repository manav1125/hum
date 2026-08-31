/**
 * Turning a chapter's words into the page the design draws.
 *
 * The episode frame (E4) is a specific artefact, not a generic summary: a
 * scene header, a **pull-quote** somebody actually said, then **Key
 * Takeaways** as label/value pairs, then what came out of it. That two-block
 * rhythm — narrative, then scannable — is the design's, and it is why this
 * asks for those fields by name rather than for prose to be sliced up later.
 *
 * ## The pull-quote must be quoted, not written
 *
 * Half the product's credibility is that the big line on the page is a real
 * sentence a real person said at a real minute. So the tool asks for the
 * speaker and the quote together, and the caller checks the quote against the
 * transcript before it is stored — a model that paraphrases into the
 * quotation marks would turn the page's most convincing element into its most
 * dishonest one.
 *
 * ## Proposals name their destination
 *
 * The accept chip prints where a thing is going *before* you tap it ("▤ File
 * to Renew Acme"), so the extraction produces a verb and a destination label
 * rather than a bare task string. A destination decided later, on the way
 * out, would make the dock animation a claim rather than a description.
 *
 * ## Templates reshape, they do not re-decide
 *
 * `template` picks the summary's shape (Meeting · Lecture · Client call ·
 * Default) exactly as the ☰ chip does. It changes what the model is told to
 * emphasise; it never changes whether something becomes a proposal, which is
 * the gate's call and made before this runs.
 *
 * Never throws: an episode that cannot be understood is still an episode, and
 * the Day draws it with its words and no verdict rather than dropping it.
 */

import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("halo-understanding");

export type HaloTemplate = "default" | "meeting" | "lecture" | "client_call";

export interface HaloUnderstandingInput {
  /** `[{speaker, text, at}]` — the chapter's words, in order. */
  utterances: Array<{ speaker: string; text: string; at: number }>;
  placeLabel?: string | null;
  template?: HaloTemplate;
}

export interface HaloProposalDraft {
  title: string;
  owner: string | null;
  verb: "file" | "draft" | "schedule" | "note";
  destinationLabel: string | null;
  /** The sentence this came from — becomes the ◉ heard pill. */
  heardQuote: string | null;
  heardSpeaker: string | null;
}

export interface HaloUnderstanding {
  title: string;
  summary: string;
  pullQuote: string | null;
  pullQuoteSpeaker: string | null;
  keyTakeaways: Array<{ label: string; value: string }>;
  participants: string[];
  proposals: HaloProposalDraft[];
}

const TOOL_SCHEMA = {
  name: "capture_halo_episode",
  description:
    "Capture one chapter of the wearer's day as the page it will be read on: a title, a one-line summary, the single best quote, the key takeaways, and anything the wearer now owes or is owed.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description:
          "What happened, as a short declarative line in the past tense — 'Acme landed on 24 months'. Not a topic label, not a question, no trailing punctuation.",
      },
      summary: {
        type: "string",
        description:
          "One or two plain sentences saying what actually happened and what changed. No hedging, no 'the conversation covered'.",
      },
      pull_quote: {
        type: ["string", "null"],
        description:
          "The single most consequential sentence somebody said, copied VERBATIM from the transcript. Never paraphrase, never merge two sentences, never tidy the grammar. Null if nothing stands out.",
      },
      pull_quote_speaker: {
        type: ["string", "null"],
        description:
          "Who said the pull quote, exactly as they are named in the transcript.",
      },
      key_takeaways: {
        type: "array",
        description:
          "The scannable block: two to four label/value pairs of what was settled. Labels are short nouns ('Price', 'Term', 'You owe').",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
          },
          required: ["label", "value"],
        },
      },
      participants: {
        type: "array",
        description: "Names of the people heard, excluding the wearer.",
        items: { type: "string" },
      },
      proposals: {
        type: "array",
        description:
          "Things the wearer now owes or is owed — commitments, follow-ups, decisions needing an action. Empty when the chapter settled nothing.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "A self-contained imperative task, keeping names and dates.",
            },
            owner: {
              type: ["string", "null"],
              description: "Who owes it, or null when it is the wearer's.",
            },
            verb: {
              type: "string",
              enum: ["file", "draft", "schedule", "note"],
              description:
                "What accepting should do: file it as work, draft a message, put it on a date, or keep it as a note.",
            },
            destination_label: {
              type: ["string", "null"],
              description:
                "A short human name for where this belongs — a project, a person, a mission ('Renew Acme'). Null when unclear.",
            },
            heard_quote: {
              type: ["string", "null"],
              description:
                "The VERBATIM sentence this came from. Copied, never paraphrased — it is shown to the wearer as proof.",
            },
            heard_speaker: { type: ["string", "null"] },
          },
          required: [
            "title",
            "owner",
            "verb",
            "destination_label",
            "heard_quote",
            "heard_speaker",
          ],
        },
      },
    },
    required: [
      "title",
      "summary",
      "pull_quote",
      "pull_quote_speaker",
      "key_takeaways",
      "participants",
      "proposals",
    ],
  },
} as const;

/** What each template tells the model to emphasise. Shape only, never scope. */
const TEMPLATE_GUIDANCE: Record<HaloTemplate, string> = {
  default:
    "Write it as a diary entry about the wearer's day — what happened and what it changed.",
  meeting:
    "Treat it as a meeting: emphasise decisions, owners and dates over discussion.",
  lecture:
    "Treat it as something being taught: emphasise the ideas and what to remember, not commitments.",
  client_call:
    "Treat it as a client conversation: emphasise what was promised, by whom, and what the client is waiting for.",
};

const SYSTEM_PROMPT = `You are Cue, writing one chapter of the wearer's day from what a wearable microphone heard. Call capture_halo_episode exactly once.

The wearer will read this as a page written about them, so:
- title and summary are in plain past tense about what actually happened.
- pull_quote and every heard_quote must be copied VERBATIM from the transcript. Copying is the whole point — the wearer is shown these as proof of what was said. If you cannot find a sentence to copy, return null rather than writing one.
- key_takeaways are what was settled, not what was discussed.
- proposals are only real commitments or follow-ups. A chapter where nothing was settled returns an empty array; that is a normal and good answer.
- Never invent a name, a number, a date or an outcome that is not in the transcript.`;

/** True when `quote` really appears in the words, ignoring whitespace and case. */
export function isVerbatim(quote: string, transcript: string): boolean {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/[‘’“”]/g, "'")
      .replace(/[^a-z0-9' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const needle = normalise(quote);
  if (needle.length < 8) return false;
  return normalise(transcript).includes(needle);
}

function flatten(utterances: HaloUnderstandingInput["utterances"]): string {
  return utterances.map((u) => `${u.speaker}: ${u.text}`).join("\n");
}

/**
 * Understand one chapter.
 *
 * Returns `null` when no provider is configured or the call fails — the
 * caller keeps the episode and draws it with its words. Reuses the
 * `meetingRecap` call site so this adds no new provider configuration.
 */
export async function understandEpisode(
  input: HaloUnderstandingInput,
): Promise<HaloUnderstanding | null> {
  const words = flatten(input.utterances);
  if (!words.trim()) return null;

  const provider = await getConfiguredProvider("meetingRecap");
  if (!provider) {
    log.info("No provider for halo understanding; episode keeps its words");
    return null;
  }

  const template = input.template ?? "default";
  const scene = input.placeLabel ? `Place: ${input.placeLabel}\n` : "";

  let parsed: Record<string, unknown>;
  try {
    const response = await provider.sendMessage(
      [userMessage(`${scene}## Transcript\n\n${words}`)],
      {
        tools: [TOOL_SCHEMA],
        systemPrompt: `${SYSTEM_PROMPT}\n\n${TEMPLATE_GUIDANCE[template]}`,
        config: {
          callSite: "meetingRecap" as const,
          tool_choice: { type: "tool" as const, name: "capture_halo_episode" },
        },
      },
    );
    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.warn("No tool_use block understanding a halo episode");
      return null;
    }
    parsed = toolBlock.input as Record<string, unknown>;
  } catch (err) {
    log.warn({ err }, "Halo understanding failed; episode keeps its words");
    return null;
  }

  return normaliseUnderstanding(parsed, words);
}

/**
 * Shape and police the model's answer.
 *
 * Exported for testing because the policing is the interesting part: a quote
 * that is not actually in the transcript is DROPPED rather than shown. The
 * page survives without a pull-quote; it does not survive being caught
 * putting words in somebody's mouth.
 */
export function normaliseUnderstanding(
  raw: Record<string, unknown>,
  transcript: string,
): HaloUnderstanding {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const pullQuote = str(raw.pull_quote);
  const quoteIsReal = pullQuote ? isVerbatim(pullQuote, transcript) : false;
  if (pullQuote && !quoteIsReal) {
    log.warn("Halo pull-quote was not in the transcript; dropping it");
  }

  const takeaways = Array.isArray(raw.key_takeaways)
    ? raw.key_takeaways
        .map((t) => {
          // A null or a bare string in the array is not a takeaway. Models
          // produce both, and neither may take the page down.
          if (!t || typeof t !== "object") return null;
          const row = t as Record<string, unknown>;
          const label = str(row.label);
          const value = str(row.value);
          return label && value ? { label, value } : null;
        })
        .filter((t): t is { label: string; value: string } => t !== null)
    : [];

  const proposals = Array.isArray(raw.proposals)
    ? raw.proposals
        .map((p) => {
          if (!p || typeof p !== "object") return null;
          const row = p as Record<string, unknown>;
          const title = str(row.title);
          if (!title) return null;
          const heardQuote = str(row.heard_quote);
          const verb = str(row.verb);
          return {
            title,
            owner: str(row.owner),
            verb: (["file", "draft", "schedule", "note"] as const).includes(
              verb as never,
            )
              ? (verb as HaloProposalDraft["verb"])
              : "file",
            destinationLabel: str(row.destination_label),
            // Same rule as the pull-quote: an unverifiable quote is dropped,
            // and the proposal survives without its receipt.
            heardQuote:
              heardQuote && isVerbatim(heardQuote, transcript)
                ? heardQuote
                : null,
            heardSpeaker: str(row.heard_speaker),
          };
        })
        .filter((p): p is HaloProposalDraft => p !== null)
    : [];

  return {
    title: str(raw.title) ?? "",
    summary: str(raw.summary) ?? "",
    pullQuote: quoteIsReal ? pullQuote : null,
    pullQuoteSpeaker: quoteIsReal ? str(raw.pull_quote_speaker) : null,
    keyTakeaways: takeaways,
    participants: Array.isArray(raw.participants)
      ? raw.participants.filter((p): p is string => typeof p === "string")
      : [],
    proposals,
  };
}
