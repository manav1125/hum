/**
 * Voice notes — the same note, entered by speaking.
 *
 * ## The one thing a recorded note must never do
 *
 * **Launder a summary as a transcript.** What was said and what Cue made of
 * it are two different artefacts, and collapsing them is how someone ends up
 * quoting a sentence back to a colleague that nobody actually said. So they
 * are stored in two columns and rendered as two things: `transcript` is
 * quotes, `body` is Cue's prose, and `bodyIsSummary` is what makes every
 * surface say which is which.
 *
 * A summary is also checkable rather than asking to be believed:
 * {@link alignSummaryToTranscript} maps each summary sentence back to the
 * moment in the recording it came from, so tapping a sentence plays that
 * moment. A summary you cannot check against its source is an assertion.
 *
 * ## Audio is local
 *
 * The recording stays on the device. Only the transcript and the summary
 * travel, and `audioPath` is nullable precisely so **"delete audio, keep
 * note"** is always available — the escape people need before they will
 * record anything at all.
 *
 * ## Capture never blocks on the model
 *
 * A voice note is saved the moment the transcript exists. Summarising happens
 * after, and if it fails the note still stands with the owner's own words in
 * it — the same order as everywhere else: the record first, the intelligence
 * second.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { resolveBatchTranscriber } from "../providers/speech-to-text/resolve.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { normalizeSttError } from "../stt/daemon-batch-transcriber.js";
import { getLogger } from "../util/logger.js";
import { createNote, deriveNoteTitle, type Note } from "./note-store.js";

const log = getLogger("note-voice");

const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SUMMARY_TIMEOUT_MS = 15_000;

/** Below this a recording is a slip of the thumb, not a note. */
const MIN_TRANSCRIPT_CHARS = 8;

/**
 * Short recordings are not summarised at all.
 *
 * "Don't lead with price" needs no summary — it IS the summary, and replacing
 * it with Cue's paraphrase would take the owner's words away for nothing.
 * Below this the transcript becomes the body verbatim.
 */
const SUMMARISE_ABOVE_CHARS = 400;

export type VoiceNoteResult =
  | { status: "created"; note: Note }
  /** Nothing intelligible in the audio. Not an error — people misfire. */
  | { status: "empty" }
  | { status: "no_provider"; reason: string }
  | { status: "failed"; reason: string };

/**
 * One sentence of a summary, tied to where it came from in the recording.
 *
 * `atMs` is null when the sentence could not be located — which is honest and
 * renders as a sentence you cannot tap, rather than one that plays the wrong
 * moment. Guessing here would be worse than admitting it.
 */
export interface SummarySentence {
  text: string;
  atMs: number | null;
}

/**
 * Map summary sentences back to moments in the recording.
 *
 * Deliberately crude and deliberately honest: each summary sentence is
 * matched to the transcript position sharing the most distinctive words with
 * it, and the position is scaled to the duration. It is an approximation, and
 * it is signposted as one in the UI ("tap a sentence to hear that moment"),
 * not sold as a precise index.
 *
 * A sentence with no confident match gets `null` rather than a guess. The
 * whole point of tap-to-hear is checking Cue's claim against the source; a
 * link that plays the wrong moment would defeat it.
 */
export function alignSummaryToTranscript(
  summary: string,
  transcript: string,
  durationMs: number | null,
): SummarySentence[] {
  const sentences = summary
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!transcript.trim() || !durationMs || durationMs <= 0) {
    return sentences.map((text) => ({ text, atMs: null }));
  }

  const haystack = transcript.toLowerCase();
  return sentences.map((text) => {
    // The longest words carry the most signal about where this came from;
    // "the" and "and" match everywhere and locate nothing.
    const terms = text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((word) => word.length > 4)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);

    const positions = terms
      .map((term) => haystack.indexOf(term))
      .filter((index) => index >= 0);
    if (positions.length === 0) return { text, atMs: null };

    const at = positions.reduce((a, b) => a + b, 0) / positions.length;
    return {
      text,
      atMs: Math.max(0, Math.round((at / haystack.length) * durationMs)),
    };
  });
}

type SummariseFn = (transcript: string) => Promise<string | null>;

let summariseOverride: SummariseFn | null = null;

export function _setNoteVoiceOverridesForTests(overrides: {
  summarise?: SummariseFn;
}): void {
  summariseOverride = overrides.summarise ?? null;
}

async function summariseWithLlm(transcript: string): Promise<string | null> {
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) return null;
    const config = getConfig();
    const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
    const result = await runBtwSidechain({
      content: [
        "Below is a transcript of somebody talking to themselves. Write what they said, in their own register, as short prose.",
        "Do not add anything that is not in the transcript, and do not soften or tidy their judgements. Keep names, numbers and dates exactly.",
        "Reply with ONLY the prose.",
        "",
        '"""',
        transcript,
        '"""',
      ].join("\n"),
      provider,
      systemPrompt:
        "You write up what somebody said, faithfully, without adding to it. You never invent detail and you never change a number.",
      messages: [],
      tools: [],
      callSite: "conversationTitle",
      maxTokens: resolved.maxTokens,
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });
    return result.text.trim() || null;
  } catch (err) {
    log.debug({ err: String(err) }, "voice summary failed");
    return null;
  }
}

export interface CreateVoiceNoteInput {
  audio: Buffer;
  mimeType: string;
  /** Where the recording lives on this device. Never uploaded. */
  audioPath?: string | null;
  audioDurationMs?: number | null;
  occurredAt?: number;
  projectId?: string | null;
}

/**
 * Turn a recording into a note.
 *
 * The order matters and is the same everywhere in this feature: get the
 * owner's words, save the note, and only then ask a model to make something
 * of them. A summary that fails leaves a note containing what was actually
 * said, which is the more valuable half anyway.
 */
export async function createVoiceNote(
  input: CreateVoiceNoteInput,
): Promise<VoiceNoteResult> {
  const transcriber = await resolveBatchTranscriber();
  if (!transcriber) {
    return {
      status: "no_provider",
      reason:
        "No speech-to-text provider is configured, so I couldn't turn that recording into words. The audio is still on your device.",
    };
  }

  let transcript: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const result = await transcriber.transcribe({
        audio: input.audio,
        mimeType: input.mimeType,
        signal: controller.signal,
      });
      transcript = result.text.trim();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const sttErr = normalizeSttError(err);
    log.warn({ err }, "voice note transcription failed");
    return {
      status: "failed",
      reason:
        sttErr.category === "timeout"
          ? "That recording took too long to transcribe. The audio is still on your device."
          : sttErr.message,
    };
  }

  if (transcript.length < MIN_TRANSCRIPT_CHARS) return { status: "empty" };

  // Short recordings ARE their own summary. Replacing "don't lead with price"
  // with a paraphrase takes the owner's words away for nothing.
  const shouldSummarise = transcript.length > SUMMARISE_ABOVE_CHARS;
  const summary = shouldSummarise
    ? await (summariseOverride ?? summariseWithLlm)(transcript)
    : null;

  const body = summary ?? transcript;
  const note = createNote({
    title: deriveNoteTitle(body),
    body,
    source: "voice",
    // Always kept, even when it IS the body: it is the quotable record, and
    // a later re-summarise must have the original words to work from.
    transcript,
    // Only true when the body really is Cue's prose. A transcript labelled a
    // summary is the same lie in the other direction.
    bodyIsSummary: summary !== null,
    ...(input.audioPath !== undefined ? { audioPath: input.audioPath } : {}),
    ...(input.audioDurationMs !== undefined
      ? { audioDurationMs: input.audioDurationMs }
      : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });

  return { status: "created", note };
}
